// Overlay window: renders Twitch chat (or a web widget), handles hover fade,
// edit-mode chrome and live config updates. Also runs inside the manager as a
// live preview (overlay.html?preview), where it gets config via postMessage.

import { invoke, listen, emit, currentWindow, withDefaults, rgba, hexToRgb, GOOGLE_FONTS } from './shared.js';
import { TwitchChat, parseIRC, nickFromPrefix, normalizeChannel, fetchHistory } from './twitch.js';
import * as E from './emotes.js';

const params = new URLSearchParams(location.search);
const PREVIEW = params.has('preview');
const ID = params.get('id');

const $ = (s) => document.querySelector(s);
const chat = $('#chat');
const content = $('#content');
const emptyEl = $('#empty');
const body = document.body;

let ov = withDefaults({});
let settings = { hoverFadeEnabled: true };
let client = null;
let currentChannels = '';
let status = { state: 'idle', text: '' };
const channelState = new Map(); // login -> { ready, queue, roomId, resolveRoom, roomPromise }

// ================================================================ look

const SHADOWS = {
  none: 'none',
  soft: '0 1px 2px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.6)',
  strong: '0 0 2px #000, 0 1px 3px #000, 0 0 6px rgba(0,0,0,.7)',
  outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000, 0 2px 4px rgba(0,0,0,.6)',
};

function setBodyClass(prefix, value) {
  for (const c of [...body.classList]) if (c.startsWith(prefix)) body.classList.remove(c);
  if (value) body.classList.add(prefix + value);
}

let loadedFont = '';
function loadGoogleFont(name) {
  if (!GOOGLE_FONTS.includes(name) || loadedFont === name) return;
  loadedFont = name;
  let link = document.getElementById('gfont');
  if (!link) {
    link = document.createElement('link');
    link.id = 'gfont';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const fam = encodeURIComponent(name).replace(/%20/g, '+');
  const axis = ['Press Start 2P', 'Indie Flower'].includes(name) ? '' : ':wght@400;700';
  link.href = `https://fonts.googleapis.com/css2?family=${fam}${axis}&display=swap`;
}

function applyLook() {
  const L = ov.look;
  const r = document.documentElement.style;
  loadGoogleFont(L.fontFamily);
  r.setProperty('--font', `'${String(L.fontFamily).replace(/'/g, '')}', 'Segoe UI', system-ui, sans-serif`);
  r.setProperty('--size', `${L.fontSize}px`);
  r.setProperty('--weight', L.fontWeight);
  r.setProperty('--name-weight', L.nameWeight);
  r.setProperty('--line', L.lineHeight);
  r.setProperty('--text', L.textColor);
  r.setProperty('--shadow', SHADOWS[L.outline] || 'none');
  r.setProperty('--msg-bg', rgba(L.msgBg, L.msgBgAlpha));
  r.setProperty('--radius', `${L.radius}px`);
  r.setProperty('--panel-bg', rgba(L.panelBg, L.panelAlpha));
  r.setProperty('--gap', `${L.gap}px`);
  r.setProperty('--pad', `${L.padding}px`);
  r.setProperty('--emote', `${L.emoteSize}px`);
  r.setProperty('--hl', ov.filters.highlightColor);
  r.setProperty('--fade-ms', `${ov.hover.fadeMs}ms`);
  setBodyClass('style-', L.style);
  setBodyClass('anim-', L.animation);
  setBodyClass('align-', L.align);
  body.classList.toggle('dir-top', L.direction === 'top');
  $('#custom-css').textContent = L.customCss || '';
  colorCache.clear();
}

// ================================================================ config

function apply(o, s) {
  const prevKind = ov.kind;
  ov = withDefaults(o);
  if (s) settings = s;
  body.classList.toggle('editing', !ov.locked && !PREVIEW);
  setBodyClass('kind-', ov.kind);
  $('#bar-name').textContent = ov.name;
  document.title = `TTCO+ · ${ov.name}`;
  applyLook();

  if (ov.kind === 'web') {
    if (prevKind !== 'web') teardownTwitch();
    setupWeb();
  } else {
    teardownWeb();
    if (!PREVIEW) setupTwitch();
  }
  if (!hoverActive()) faded = false;
  applyOpacity();
  prune();
  updateEmpty();
}

// ================================================================ hover fade

let faded = false;
let hoverTimer = 0;
const hoverActive = () =>
  settings.hoverFadeEnabled !== false && ov.hover.enabled && (ov.locked || PREVIEW);

function onHover(inside) {
  clearTimeout(hoverTimer);
  if (inside && hoverActive()) {
    hoverTimer = setTimeout(() => {
      faded = true;
      applyOpacity();
    }, ov.hover.delayMs);
  } else {
    hoverTimer = setTimeout(() => {
      faded = false;
      applyOpacity();
    }, inside ? 0 : ov.hover.restoreDelayMs);
  }
}

/** Fade shortcut (Ctrl+Alt+H by default): dims without hovering, even in edit mode. */
const dimActive = () => !!settings.dimmed && ov.hover.manual !== false;

function applyOpacity() {
  const editing = body.classList.contains('editing');
  let op = editing ? 1 : ov.opacity;
  if (dimActive() || (!editing && faded && hoverActive())) op = ov.hover.opacity;
  content.style.opacity = String(op);
}

// ================================================================ status / empty state

function setStatus(state, text) {
  status = { state, text };
  const dot = $('#bar-status');
  dot.className = `status ${state}`;
  dot.title = text;
  if (!PREVIEW && ID) emit('overlay-status', { id: ID, state, text }).catch(() => {});
  updateEmpty();
}

function updateEmpty() {
  let msg = '';
  if (ov.kind === 'twitch' && !chat.firstElementChild && !PREVIEW && !ov.locked) {
    const chans = (ov.twitch.channels || []).map(normalizeChannel).filter(Boolean);
    msg = chans.length
      ? `${status.text || 'Connecting…'}\nWaiting for messages in ${chans.map((c) => '#' + c).join(', ')}`
      : 'No channel set yet.\nClick ⚙ above to add your Twitch channel.';
  }
  if (ov.kind === 'web' && !ov.web.url && !PREVIEW) msg = 'No URL set.\nClick ⚙ above to add a widget URL.';
  emptyEl.hidden = !msg;
  emptyEl.style.whiteSpace = 'pre-line';
  emptyEl.textContent = msg;
}

// ================================================================ web widget

/**
 * WebView2 won't show file:/// pages inside the overlay, so local widgets are
 * served by the app's loopback server instead (same files, relative paths work).
 * Pages from there are treated as external by Tauri, so they can't call the app.
 */
let localBase = '';
function frameUrl(url) {
  if (!localBase) return url;
  if (/^file:\/\//i.test(url)) return localBase + url.replace(/^file:\/\/\/?/i, '');
  if (/^[a-z]:[\\/]/i.test(url)) return localBase + encodeURI(url.replace(/\\/g, '/'));
  return url;
}

let webFrame = null;
function setupWeb() {
  chat.hidden = true;
  const url = frameUrl((ov.web.url || '').trim());
  if (!webFrame) {
    webFrame = document.createElement('iframe');
    webFrame.id = 'web';
    webFrame.setAttribute('allow', 'autoplay');
    webFrame.setAttribute('allowtransparency', 'true');
    // Widgets may run scripts and keep their own storage, but can't open popups,
    // navigate this overlay away, or start downloads.
    webFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
    webFrame.setAttribute('referrerpolicy', 'no-referrer');
    content.appendChild(webFrame);
  }
  if (webFrame.dataset.src !== url) {
    webFrame.dataset.src = url;
    webFrame.src = url || 'about:blank';
  }
  const z = Math.max(0.25, Number(ov.web.zoom) || 1);
  webFrame.style.width = `${100 / z}%`;
  webFrame.style.height = `${100 / z}%`;
  webFrame.style.transform = `scale(${z})`;
  if (!PREVIEW) setStatus(url ? 'connected' : 'idle', url ? 'Web widget' : 'No URL');
}
function teardownWeb() {
  chat.hidden = false;
  if (webFrame) {
    webFrame.remove();
    webFrame = null;
  }
}

// ================================================================ twitch

function setupTwitch() {
  const chans = (ov.twitch.channels || []).map(normalizeChannel).filter(Boolean);
  E.loadGlobals({ thirdParty: ov.twitch.thirdPartyEmotes, badges: ov.twitch.badges });
  if (!client) client = new TwitchChat({ onMessage: (m) => handleIRC(m, false), onStatus: setStatus });
  const key = chans.join(',');
  if (key === currentChannels) return;
  currentChannels = key;
  const { joined, parted } = client.setChannels(chans);
  for (const c of parted) channelState.delete(c);
  for (const c of joined) prepareChannel(c);
}

function teardownTwitch() {
  if (client) client.destroy();
  client = null;
  currentChannels = '';
  channelState.clear();
  chat.replaceChildren();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load history + emotes for a newly joined channel, buffering live messages meanwhile. */
async function prepareChannel(login) {
  const st = { ready: false, queue: [], roomId: '' };
  st.roomPromise = new Promise((r) => (st.resolveRoom = r));
  channelState.set(login, st);
  const opts = { thirdParty: ov.twitch.thirdPartyEmotes, badges: ov.twitch.badges };

  const lines = await fetchHistory(login, Math.min(100, Number(ov.twitch.history) || 0));
  const parsed = lines.map(parseIRC);
  let roomId = parsed.find((m) => m.tags['room-id'])?.tags['room-id'] || st.roomId;
  if (!roomId) roomId = await Promise.race([st.roomPromise, sleep(3000)]);
  if (roomId) await Promise.race([E.loadRoom(roomId, opts), sleep(2500)]);
  if (channelState.get(login) !== st) return; // channel was removed meanwhile

  for (const m of parsed) handleIRC(m, true);
  st.ready = true;
  for (const m of st.queue) handleIRC(m, false);
  st.queue = [];
}

function handleIRC(m, historical) {
  const ch = (m.params[0] || '').replace(/^#/, '');
  const t = m.tags;
  switch (m.command) {
    case 'PRIVMSG':
    case 'USERNOTICE': {
      if (!historical) {
        const st = channelState.get(ch);
        if (st && !st.ready) {
          st.queue.push(m);
          return;
        }
      }
      const el = m.command === 'PRIVMSG' ? renderPrivmsg(m, ch, historical) : renderNotice(m, ch, historical);
      if (el) queueRender(el);
      break;
    }
    case 'ROOMSTATE': {
      const st = channelState.get(ch);
      if (t['room-id'] && st) {
        st.roomId = t['room-id'];
        st.resolveRoom(t['room-id']);
        E.loadRoom(t['room-id'], { thirdParty: ov.twitch.thirdPartyEmotes, badges: ov.twitch.badges });
      }
      break;
    }
    case 'CLEARCHAT': {
      if (historical) return;
      if (m.params[1]) removeWhere(`[data-uid="${CSS.escape(t['target-user-id'] || '')}"]`);
      else if (ov.behavior.clearOnClearChat) chat.replaceChildren();
      break;
    }
    case 'CLEARMSG':
      if (!historical) removeWhere(`[data-mid="${CSS.escape(t['target-msg-id'] || '')}"]`);
      break;
  }
}

function removeWhere(sel) {
  for (const el of chat.querySelectorAll(sel)) {
    if (ov.behavior.removeDeleted) el.remove();
    else el.classList.add('deleted');
  }
  updateEmpty();
}

// ================================================================ rendering

const DEFAULT_COLORS = ['#FF4A4A', '#4A7CFF', '#2FBF71', '#C46BFF', '#FF7F50', '#9ACD32', '#FF69B4', '#1E90FF', '#DAA520', '#5F9EA0', '#2EC4B6', '#FFB347', '#B19CD9', '#00BFFF', '#E9967A'];
const colorCache = new Map();

function hashName(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Lift very dark name colours so they stay readable on top of games. */
function readable(hex) {
  if (colorCache.has(hex)) return colorCache.get(hex);
  const c = hexToRgb(hex);
  let out = hex;
  if (c) {
    let [r, g, b] = c.map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 0.33) {
      l = Math.min(0.78, l + (0.33 - lum) * 1.4 + 0.12);
      out = `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
    }
  }
  colorCache.set(hex, out);
  return out;
}

function nameColor(tagColor, login) {
  if (ov.look.nameColor) return ov.look.nameColor;
  const base = tagColor || DEFAULT_COLORS[hashName(login) % DEFAULT_COLORS.length];
  return ov.look.readableNames ? readable(base) : base;
}

const lc = (a) => (a || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);

function passesFilters(login, text) {
  const f = ov.filters;
  if (lc(f.blockedUsers).includes(login)) return false;
  if (f.hideBots && lc(f.bots).includes(login)) return false;
  if (f.hideCommands && text.trimStart().startsWith('!')) return false;
  const lower = text.toLowerCase();
  if (lc(f.blockedWords).some((w) => lower.includes(w))) return false;
  return true;
}

function isHighlight(t, text) {
  if (t['msg-id'] === 'highlighted-message') return true;
  const lower = text.toLowerCase();
  return lc(ov.filters.highlightWords).some((w) => lower.includes(w));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildHeader(container, t, ch, login, historical) {
  if (ov.look.timestamps) {
    const d = new Date(Number(t['tmi-sent-ts']) || Date.now());
    container.appendChild(el('span', 'ts', d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  }
  const multi = (ov.twitch.channels || []).length > 1;
  if (ov.twitch.channelTag === 'always' || (ov.twitch.channelTag === 'auto' && multi)) {
    container.appendChild(el('span', 'chan', ch));
  }
  if (ov.look.showBadges && ov.twitch.badges && t.badges) {
    const roomId = t['room-id'];
    const wrap = el('span', 'badges');
    for (const b of t.badges.split(',')) {
      const [set, ver] = b.split('/');
      const badge = E.findBadge(roomId, set, ver);
      if (!badge) continue;
      const img = el('img', 'badge');
      img.src = badge.url;
      img.alt = badge.title;
      img.decoding = 'async';
      wrap.appendChild(img);
    }
    if (wrap.firstChild) container.appendChild(wrap);
  }
}

function renderPrivmsg(m, ch, historical) {
  const t = m.tags;
  const login = (t.login || nickFromPrefix(m.prefix)).toLowerCase();
  let text = m.params[1] || '';
  let action = false;
  if (text.startsWith('\u0001ACTION ')) {
    action = true;
    text = text.slice(8).replace(/\u0001$/, '');
  }
  if (!passesFilters(login, text)) return null;

  const row = el('div', 'msg');
  row.dataset.uid = t['user-id'] || '';
  row.dataset.mid = t.id || '';
  if (historical) row.classList.add('historical');
  if (action) row.classList.add('action');
  if (t['first-msg'] === '1' && !historical) row.classList.add('first');
  if (isHighlight(t, text)) {
    row.classList.add('hl');
    if (!historical && ov.filters.highlightSound) beep();
  }

  buildHeader(row, t, ch, login, historical);
  const color = nameColor(t.color, login);
  const name = el('span', 'name', t['display-name'] || login);
  name.style.color = color;
  row.style.setProperty('--name-color', color);
  row.appendChild(name);
  row.appendChild(el('span', 'sep', action ? ' ' : ov.look.colon ? ':' : ''));
  const span = el('span', 'text');
  span.appendChild(buildText(text, t.emotes, t['room-id']));
  row.appendChild(span);
  return row;
}

const NOTICE_IDS = new Set(['sub', 'resub', 'subgift', 'submysterygift', 'giftpaidupgrade', 'anongiftpaidupgrade', 'primepaidupgrade', 'rewardgift', 'raid', 'bitsbadgetier', 'announcement', 'viewermilestone', 'standardpayforward', 'communitypayforward', 'onetapgiftredeemed']);
const ANNOUNCE_COLORS = { BLUE: '#4a8cff', GREEN: '#2fd27a', ORANGE: '#ff9f43', PURPLE: '#a970ff' };

function renderNotice(m, ch, historical) {
  const t = m.tags;
  const id = t['msg-id'];
  if (!NOTICE_IDS.has(id)) return null;
  if (!ov.twitch.showNotices && id !== 'announcement') return null;
  const login = (t.login || '').toLowerCase();
  const text = m.params[1] || '';
  if (text && !passesFilters(login, text)) return null;

  const row = el('div', 'msg notice');
  row.dataset.uid = t['user-id'] || '';
  row.dataset.mid = t.id || '';
  if (historical) row.classList.add('historical');
  if (id === 'announcement') row.style.setProperty('--accent', ANNOUNCE_COLORS[t['msg-param-color']] || 'var(--accent)');
  buildHeader(row, t, ch, login, historical);

  if (id === 'announcement') {
    row.appendChild(el('span', 'sys', '📣 '));
    const name = el('span', 'name', t['display-name'] || login);
    name.style.color = nameColor(t.color, login);
    row.appendChild(name);
    row.appendChild(el('span', 'sep', ov.look.colon ? ':' : ''));
    const span = el('span', 'text');
    span.appendChild(buildText(text, t.emotes, t['room-id']));
    row.appendChild(span);
    return row;
  }
  row.appendChild(el('span', 'sys', t['system-msg'] || id));
  if (text) {
    const span = el('span', 'text');
    span.appendChild(buildText(text, t.emotes, t['room-id']));
    row.appendChild(span);
  }
  return row;
}

/** Turn message text + Twitch emote ranges into DOM nodes (no innerHTML). */
function buildText(text, emotesTag, roomId) {
  const frag = document.createDocumentFragment();
  const chars = Array.from(text); // Twitch emote ranges are in code points
  const ranges = [];
  if (emotesTag) {
    for (const part of emotesTag.split('/')) {
      const [id, pos] = part.split(':');
      if (!pos) continue;
      for (const r of pos.split(',')) {
        const [s, e] = r.split('-').map(Number);
        if (Number.isFinite(s) && Number.isFinite(e)) ranges.push({ s, e, id });
      }
    }
    ranges.sort((a, b) => a.s - b.s);
  }
  const ctx = { frag, buf: '', roomId };
  let i = 0;
  for (const r of ranges) {
    if (r.s < i) continue;
    if (r.s > i) appendWords(ctx, chars.slice(i, r.s).join(''));
    appendEmote(ctx, E.twitchEmoteUrl(r.id), chars.slice(r.s, r.e + 1).join(''), false);
    i = r.e + 1;
  }
  if (i < chars.length) appendWords(ctx, chars.slice(i).join(''));
  flushText(ctx);
  return frag;
}

function flushText(ctx) {
  if (ctx.buf) {
    ctx.frag.appendChild(document.createTextNode(ctx.buf));
    ctx.buf = '';
  }
}

function appendWords(ctx, str) {
  const third = ov.twitch.thirdPartyEmotes;
  for (const word of str.split(/(\s+)/)) {
    if (!word) continue;
    if (/^\s+$/.test(word)) {
      ctx.buf += word;
      continue;
    }
    const em = third ? E.findEmote(ctx.roomId, word) : null;
    if (em) {
      appendEmote(ctx, em.url, word, em.zw);
    } else if (word[0] === '@' && word.length > 1) {
      flushText(ctx);
      ctx.frag.appendChild(el('span', 'mention', word));
    } else {
      ctx.buf += word;
    }
  }
}

function appendEmote(ctx, url, name, zw) {
  const img = el('img', 'emote');
  img.src = url;
  img.alt = name;
  img.decoding = 'async';
  if (zw) {
    // Stack zero-width emotes on top of the previous emote (ignoring the space between).
    const trailingSpace = /^\s*$/.test(ctx.buf);
    let prev = ctx.frag.lastChild;
    if (trailingSpace && prev && (prev.classList?.contains('emote') || prev.classList?.contains('emote-stack'))) {
      ctx.buf = '';
      if (prev.classList.contains('emote')) {
        const stack = el('span', 'emote-stack');
        prev.replaceWith(stack);
        stack.appendChild(prev);
        prev = stack;
      }
      prev.appendChild(img);
      return;
    }
  }
  flushText(ctx);
  ctx.frag.appendChild(img);
}

// ---------------------------------------------------------------- batching / pruning / fading

let pending = [];
let flushScheduled = false;
function queueRender(row) {
  row._ts = Date.now();
  row.classList.add('new');
  pending.push(row);
  if (flushScheduled) return;
  flushScheduled = true;
  // rAF batches bursts into a single layout; the timeout is a fallback if rAF is throttled.
  const go = () => {
    if (!flushScheduled) return;
    flushScheduled = false;
    flush();
  };
  requestAnimationFrame(go);
  setTimeout(go, 50);
}

function flush() {
  const max = Math.max(5, Number(ov.behavior.maxMessages) || 60);
  if (pending.length > max) pending = pending.slice(-max);
  const frag = document.createDocumentFragment();
  for (const r of pending) frag.appendChild(r);
  pending = [];
  chat.appendChild(frag);
  prune();
  if (!emptyEl.hidden) updateEmpty();
}

function prune() {
  const max = Math.max(5, Number(ov.behavior.maxMessages) || 60);
  let extra = chat.childElementCount - max;
  while (extra-- > 0) chat.firstElementChild.remove();
}

chat.addEventListener('animationend', (e) => e.target.classList?.remove('new'));
// Broken emote / badge images fall back to their text instead of a broken-image icon.
chat.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  if (img.classList.contains('emote')) img.replaceWith(document.createTextNode(img.alt));
  else img.remove();
}, true);

setInterval(() => {
  const sec = Number(ov.behavior.fadeOutSec) || 0;
  if (sec <= 0) return;
  const cutoff = Date.now() - sec * 1000;
  for (let row = chat.firstElementChild; row; row = row.nextElementSibling) {
    if (row._ts > cutoff) break;
    if (row.classList.contains('leaving')) continue;
    row.classList.add('leaving');
    setTimeout(() => {
      row.remove();
      updateEmpty();
    }, 650);
  }
}, 1000);

// ---------------------------------------------------------------- highlight sound

let actx = null;
let lastBeep = 0;
function beep() {
  const now = Date.now();
  if (now - lastBeep < 900) return;
  lastBeep = now;
  try {
    actx = actx || new AudioContext();
    const t0 = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t0);
    o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.09);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + 0.3);
  } catch {}
}

// ================================================================ sample / test messages

const SAMPLE_USERS = [
  ['PixelPanda', '#FF7F50', 'subscriber/12,premium/1'],
  ['nightowl_gg', '#1E90FF', 'moderator/1'],
  ['Kaeli', '#9ACD32', 'vip/1'],
  ['RetroRaccoon', '#DAA520', ''],
  ['stream_bean', '#FF69B4', 'subscriber/3'],
  ['MidnightMoth', '#5a2bd6', 'subscriber/24'],
  ['xX_Sn1per_Xx', '#2E8B57', 'turbo/1'],
  ['cozy_cat', '', ''],
];
const SAMPLE_TEXT = [
  ['that play was actually insane Kappa', { 25: 'Kappa' }],
  ['hello chat HeyGuys', { 30259: 'HeyGuys' }],
  ['LUL LUL LUL', { 425618: 'LUL' }],
  ['can you show the settings again?', {}],
  ['monkaS that was close', {}],
  ['GG <3 <3', { 9: '<3' }],
  ['what keyboard is that? looks clean SeemsGood', { 64138: 'SeemsGood' }],
  ['first time watching, love the vibe here', {}],
  ['@nightowl_gg no way that worked EZ', {}],
  ['NotLikeThis why did he do that', { 58765: 'NotLikeThis' }],
  ['this overlay is so smooth Kreygasm', { 41: 'Kreygasm' }],
];
let sampleN = 0;

function emoteTag(text, map) {
  const out = {};
  let idx = 0;
  for (const word of text.split(' ')) {
    const len = Array.from(word).length;
    for (const [id, w] of Object.entries(map)) if (w === word) (out[id] = out[id] || []).push(`${idx}-${idx + len - 1}`);
    idx += len + 1;
  }
  return Object.entries(out).map(([id, r]) => `${id}:${r.join(',')}`).join('/');
}

function sampleMessage(i = sampleN++) {
  const [name, color, badges] = SAMPLE_USERS[i % SAMPLE_USERS.length];
  let [text, map] = SAMPLE_TEXT[i % SAMPLE_TEXT.length];
  const hw = lc(ov.filters.highlightWords)[0];
  if (hw && i % 7 === 3) text = `hey ${hw}, how long have you been streaming?`;
  const action = i % 13 === 5;
  const tags = {
    'display-name': name, color, badges, emotes: emoteTag(text, map), id: `sample-${i}-${Date.now()}`,
    'user-id': String(1000 + (i % SAMPLE_USERS.length)), 'tmi-sent-ts': String(Date.now()),
    'first-msg': i % 17 === 9 ? '1' : '0', 'room-id': '',
  };
  return {
    command: 'PRIVMSG', tags, prefix: `${name.toLowerCase()}!x@x`,
    params: ['#preview', action ? `\u0001ACTION ${text}\u0001` : text],
  };
}
function sampleNotice() {
  return {
    command: 'USERNOTICE',
    tags: { 'msg-id': 'resub', 'system-msg': 'MidnightMoth subscribed at Tier 1. They\'ve subscribed for 24 months!', login: 'midnightmoth', 'display-name': 'MidnightMoth', id: `n-${Date.now()}`, 'tmi-sent-ts': String(Date.now()) },
    prefix: 'tmi.twitch.tv', params: ['#preview', 'two years already PogChamp'],
  };
}

function pushSamples(n) {
  for (let k = 0; k < n; k++) {
    const m = k === Math.floor(n / 2) ? sampleNotice() : sampleMessage();
    handleIRC(m, false);
  }
}

// ================================================================ toast

let toastTimer = 0;
function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1700);
}

// ================================================================ edit-mode chrome

function wireChrome() {
  const win = currentWindow();
  $('#bar').addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) win.startDragging();
  });
  content.addEventListener('mousedown', (e) => {
    if (e.button === 0 && body.classList.contains('editing') && ov.kind === 'twitch') win.startDragging();
  });
  for (const h of document.querySelectorAll('.rz')) {
    h.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        e.preventDefault();
        win.startResizeDragging(h.dataset.dir);
      }
    });
  }
  $('#bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'settings') invoke('open_manager', { select: ID });
    if (act === 'hide') invoke('update_overlay', { id: ID, patch: { visible: false } });
    if (act === 'lock') invoke('update_overlay', { id: ID, patch: { locked: true } });
  });
  let hintTimer = 0;
  const hint = $('#size-hint');
  window.addEventListener('resize', () => {
    hint.textContent = `${innerWidth} × ${innerHeight}`;
    hint.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint.style.opacity = '0'), 1200);
  });
}

// ================================================================ boot

async function init() {
  if (PREVIEW) {
    body.classList.add('preview');
    let started = false;
    window.addEventListener('message', (e) => {
      // Only the manager (same origin, our parent) may configure the preview.
      if (e.origin !== location.origin || e.source !== parent) return;
      const d = e.data || {};
      if (d.type === 'config') {
        if (d.localBase) localBase = d.localBase;
        apply(d.overlay, d.settings);
        if (!started && ov.kind === 'twitch') {
          started = true;
          E.loadGlobals({ thirdParty: true, badges: false }).then(() => pushSamples(9));
          setInterval(() => ov.kind === 'twitch' && !document.hidden && handleIRC(sampleMessage(), false), 2200);
        }
      }
      if (d.type === 'samples') pushSamples(6);
    });
    document.documentElement.addEventListener('mouseenter', () => onHover(true));
    document.documentElement.addEventListener('mouseleave', () => onHover(false));
    parent.postMessage({ type: 'preview-ready' }, location.origin);
    return;
  }

  wireChrome();
  const { overlay, settings: s, localBase: lb } = await invoke('get_overlay', { id: ID });
  localBase = lb || '';
  apply(overlay, s);
  listen('overlay-updated', (o) => apply(o));
  listen('settings-updated', (s2) => {
    settings = s2;
    if (!hoverActive()) faded = false;
    applyOpacity();
  });
  listen('hover', onHover);
  listen('toast', showToast);
  listen('action', (a) => {
    if (a === 'test') pushSamples(8);
    if (a === 'clear') {
      chat.replaceChildren();
      updateEmpty();
    }
  });
}

init().catch((e) => {
  emptyEl.hidden = false;
  emptyEl.textContent = `Overlay failed to start: ${e}`;
});
