// Manager window: create / edit / hide / arrange overlays, layouts, trash, settings.

import {
  invoke, listen, clone, deepMerge, withDefaults, getPath, setPath, pathToPatch, debounce,
  LOOK_PRESETS, SYSTEM_FONTS, GOOGLE_FONTS, SHORTCUT_LABELS,
} from './shared.js';
import { normalizeChannel } from './twitch.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const main = $('#main');

const S = {
  state: null,
  sel: null,
  view: 'overlay',
  tab: 'source',
  statuses: {},
  previewBg: 'game',
  newKind: 'twitch',
  capturing: null,
};
const pending = {}; // overlay id -> patch not yet sent

// ================================================================ icons

const P = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const I = {
  chat: P('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  globe: P('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  eye: P('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: P('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/>'),
  lock: P('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  unlock: P('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  move: P('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>'),
  ghost: P('<path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>'),
  copy: P('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  trash: P('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'),
  play: P('<path d="m6 3 14 9-14 9V3z"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  restore: P('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  layout: P('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  dim: P('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>'),
  sparkle: P('<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>'),
};

// ================================================================ helpers

const ov = () => S.state?.overlays.find((o) => o.id === S.sel) || null;
const sc = (action) => S.state?.settings?.shortcuts?.[action] || 'not set';
const kbd = (action) => `<kbd>${esc(sc(action))}</kbd>`;

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('leave');
    setTimeout(() => t.remove(), 250);
  }, type === 'error' ? 4200 : 2200);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), 'error');
    throw e;
  }
}

function modal({ title, text = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-back"><form class="modal">
      <h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}
      ${input !== null ? `<input id="modal-input" value="${esc(input)}" spellcheck="false">` : ''}
      <div class="actions"><button type="button" class="btn ghost" data-r="0">${esc(cancel)}</button>
      <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></form></div>`;
    const done = (v) => {
      root.innerHTML = '';
      resolve(v);
    };
    const form = $('form', root);
    const inp = $('#modal-input', root);
    (inp || $('button[type=submit]', root)).focus();
    inp?.select();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(inp ? inp.value.trim() || null : true);
    });
    $('[data-r="0"]', root).addEventListener('click', () => done(inp ? null : false));
    $('.modal-back', root).addEventListener('mousedown', (e) => e.target.classList.contains('modal-back') && done(inp ? null : false));
    form.addEventListener('keydown', (e) => e.key === 'Escape' && done(inp ? null : false));
  });
}

function subtitle(o) {
  const f = withDefaults(o);
  if (f.kind === 'web') {
    const u = (f.web.url || '').trim();
    if (/^(file:|[a-z]:[\\/])/i.test(u)) return 'Local file · ' + decodeURIComponent(u.split(/[#?]/)[0].split(/[\\/]/).pop());
    try {
      return new URL(u).host;
    } catch {
      return 'no URL yet';
    }
  }
  const ch = (f.twitch.channels || []).map((c) => '#' + c).join(' ');
  return ch || 'no channel yet';
}

// ================================================================ control builders

const R = (label, control, { hint = '', showIf = '', block = false } = {}) =>
  `<div class="row${block ? ' block' : ''}"${showIf ? ` data-show-if="${showIf}"` : ''}>
    ${label || hint ? `<div class="row-label"><div>${label}</div>${hint ? `<small>${hint}</small>` : ''}</div>` : ''}
    <div class="row-control">${control}</div></div>`;

const C = {
  toggle: (p) => `<label class="switch"><input type="checkbox" data-path="${p}" data-kind="bool"><span></span></label>`,
  range: (p, min, max, step = 1, { unit = '', scale = 1, fmt = '' } = {}) =>
    `<div class="slider"><input type="range" min="${min}" max="${max}" step="${step}" data-path="${p}" data-kind="num" data-scale="${scale}" data-unit="${unit}" data-fmt="${fmt}"><output></output></div>`,
  seg: (p, opts, type = '') =>
    `<div class="seg" data-path="${p}" data-kind="seg" data-type="${type}">${opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>`,
  text: (p, ph = '', list = '') =>
    `<input type="text" data-path="${p}" data-kind="text" placeholder="${esc(ph)}" spellcheck="false"${list ? ` list="${list}"` : ''}>`,
  color: (p) => `<span class="color"><input type="color" data-path="${p}" data-kind="color"><code></code></span>`,
  coloropt: (p) => `<span class="color" data-path="${p}" data-kind="coloropt"><label class="switch"><input type="checkbox"><span></span></label><input type="color" value="#ffffff"></span>`,
  tags: (p, ph, norm = '') =>
    `<div class="tags" data-path="${p}" data-kind="tags" data-norm="${norm}"><span class="chips"></span><input placeholder="${esc(ph)}" spellcheck="false"></div>`,
  int: (p, label) => `<label>${label}<input type="number" data-path="${p}" data-kind="int"></label>`,
  textarea: (p, ph) => `<textarea rows="7" data-path="${p}" data-kind="text" placeholder="${esc(ph)}" spellcheck="false"></textarea>`,
};

const card = (title, desc, body) =>
  `<section class="card">${title ? `<div class="card-head"><div><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div></div>` : ''}<div class="card-body">${body}</div></section>`;

// ---------------------------------------------------------------- binding: fill

function sliderOutput(el) {
  const out = el.parentElement.querySelector('output');
  const v = Number(el.value);
  const min = Number(el.min), max = Number(el.max);
  el.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  if (!out) return;
  if (el.dataset.fmt === 'never0' && v === 0) out.textContent = 'Never';
  else if (el.dataset.fmt === 'off0' && v === 0) out.textContent = 'Off';
  else out.textContent = `${Number.isInteger(v) ? v : v.toFixed(2)}${el.dataset.unit || ''}`;
}

function renderChips(wrap, arr) {
  wrap._value = [...(arr || [])];
  $('.chips', wrap).innerHTML = wrap._value
    .map((v, i) => `<span class="chip">${esc(v)}<button type="button" data-chip="${i}" title="Remove">${I.x}</button></span>`)
    .join('');
}

function fillBindings(root, obj) {
  const active = document.activeElement;
  for (const el of $$('[data-path]', root)) {
    if (el === active || (el.contains(active) && el.dataset.kind !== 'tags')) continue;
    const v = getPath(obj, el.dataset.path);
    switch (el.dataset.kind) {
      case 'bool':
        el.checked = !!v;
        break;
      case 'num':
        el.value = String((Number(v) || 0) * Number(el.dataset.scale || 1));
        sliderOutput(el);
        break;
      case 'int':
        el.value = v == null ? '' : String(v);
        break;
      case 'color':
        el.value = v || '#000000';
        el.parentElement.querySelector('code').textContent = el.value;
        break;
      case 'coloropt': {
        const [cb, col] = $$('input', el);
        cb.checked = !!v;
        if (v) col.value = v;
        col.style.opacity = v ? '1' : '.35';
        break;
      }
      case 'seg':
        for (const b of $$('button', el)) b.classList.toggle('active', b.dataset.v === String(v));
        break;
      case 'tags':
        renderChips(el, v);
        break;
      default:
        el.value = v ?? '';
    }
  }
}

function updateConditionals(root = main) {
  const scope = root.querySelector('[data-scope]')?.dataset.scope || 'overlay';
  const obj = scope === 'settings' ? S.state.settings : withDefaults(ov());
  for (const el of $$('[data-show-if]', root)) {
    const [path, vals] = el.dataset.showIf.split('=');
    el.hidden = !vals.split('|').includes(String(getPath(obj, path)));
  }
}

// ---------------------------------------------------------------- binding: commit

const flushPatches = debounce(async () => {
  for (const id of Object.keys(pending)) {
    const patch = pending[id];
    delete pending[id];
    try {
      await invoke('update_overlay', { id, patch });
    } catch (e) {
      toast(String(e), 'error');
    }
  }
}, 110);

let pendingSettings = {};
const flushSettings = debounce(async () => {
  const patch = pendingSettings;
  pendingSettings = {};
  try {
    await invoke('update_settings', { patch });
  } catch (e) {
    toast(String(e), 'error');
  }
}, 120);

function patchOverlay(patch) {
  const o = ov();
  if (!o) return;
  deepMerge(o, patch);
  deepMerge((pending[o.id] = pending[o.id] || {}), patch);
  flushPatches();
  sendPreview();
  updateConditionals();
}

function commit(el, value) {
  const scope = el.closest('[data-scope]')?.dataset.scope || 'overlay';
  const path = el.dataset.path;
  const patch = pathToPatch(path, value);
  if (scope === 'settings') {
    deepMerge(S.state.settings, patch);
    deepMerge(pendingSettings, patch);
    flushSettings();
    updateConditionals();
    return;
  }
  patchOverlay(patch);
  if (path.startsWith('look.') && path !== 'look.preset') {
    const o = ov();
    if (o.look?.preset) {
      o.look.preset = '';
      deepMerge((pending[o.id] = pending[o.id] || {}), { look: { preset: '' } });
      $$('.preset').forEach((p) => p.classList.remove('active'));
    }
  }
  if (['name', 'twitch.channels', 'web.url'].includes(path)) renderSidebar();
}

function readValue(el) {
  switch (el.dataset.kind) {
    case 'bool':
      return el.checked;
    case 'num':
      sliderOutput(el);
      return Number(el.value) / Number(el.dataset.scale || 1);
    case 'int':
      return el.value === '' ? undefined : Math.round(Number(el.value));
    case 'color':
      el.parentElement.querySelector('code').textContent = el.value;
      return el.value;
    case 'coloropt': {
      const [cb, col] = $$('input', el);
      col.style.opacity = cb.checked ? '1' : '.35';
      return cb.checked ? col.value : '';
    }
    default:
      return el.value;
  }
}

function onFieldEvent(e) {
  const el = e.target.closest('[data-path]');
  if (!el || !main.contains(el) || el.dataset.kind === 'tags' || el.dataset.kind === 'seg') return;
  const t = e.target;
  // Checkboxes / selects / number inputs commit on change; sliders, text and colours live on input.
  const changeOnly = t.type === 'checkbox' || t.tagName === 'SELECT' || el.dataset.kind === 'int';
  if (e.type !== (changeOnly ? 'change' : 'input')) return;
  const v = readValue(el);
  if (v === undefined) return;
  commit(el, v);
}

function normTag(v, norm) {
  v = v.trim();
  if (norm === 'channel') return normalizeChannel(v);
  if (norm === 'lower') return v.toLowerCase().replace(/^@/, '');
  return v;
}

function addTags(wrap, raw) {
  const vals = raw.split(',').map((v) => normTag(v, wrap.dataset.norm)).filter(Boolean);
  if (!vals.length) return false;
  const next = [...(wrap._value || [])];
  for (const v of vals) if (!next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v);
  renderChips(wrap, next);
  if (wrap.dataset.path) commit(wrap, next);
  return true;
}

function bindTags(root) {
  root.addEventListener('keydown', (e) => {
    const wrap = e.target.closest('.tags');
    if (!wrap || e.target.tagName !== 'INPUT') return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (addTags(wrap, e.target.value)) e.target.value = '';
    } else if (e.key === 'Backspace' && !e.target.value && wrap._value?.length) {
      const next = wrap._value.slice(0, -1);
      renderChips(wrap, next);
      if (wrap.dataset.path) commit(wrap, next);
    }
  });
  root.addEventListener('focusout', (e) => {
    const wrap = e.target.closest?.('.tags');
    if (wrap && e.target.tagName === 'INPUT' && e.target.value.trim()) {
      if (addTags(wrap, e.target.value)) e.target.value = '';
    }
  });
  root.addEventListener('paste', (e) => {
    const wrap = e.target.closest?.('.tags');
    if (!wrap || e.target.tagName !== 'INPUT') return;
    const text = e.clipboardData.getData('text');
    if (text.includes(',') || text.includes('\n')) {
      e.preventDefault();
      addTags(wrap, text.replace(/\n/g, ','));
    }
  });
  root.addEventListener('click', (e) => {
    const x = e.target.closest('[data-chip]');
    const wrap = e.target.closest('.tags');
    if (!wrap) return;
    if (x) {
      const next = wrap._value.filter((_, i) => i !== Number(x.dataset.chip));
      renderChips(wrap, next);
      if (wrap.dataset.path) commit(wrap, next);
    } else $('input', wrap).focus();
  });
}

// ================================================================ preview

let previewReady = false;
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== $('#preview')?.contentWindow) return;
  if (e.data?.type === 'preview-ready') {
    previewReady = true;
    sendPreview();
  }
});
function sendPreview() {
  const f = $('#preview');
  const o = ov();
  if (!f || !previewReady || !o) return;
  f.contentWindow.postMessage({ type: 'config', overlay: clone(o), settings: S.state.settings, localBase: S.state.localBase }, location.origin);
}

// ================================================================ sidebar

function renderSidebar() {
  const st = S.state;
  const set = st.settings;
  const vis = st.overlays.filter((o) => o.visible !== false);
  const hid = st.overlays.filter((o) => o.visible === false);
  const editOn = vis.some((o) => !o.locked);
  const qt = (id, icon, label, action, on, cls = '') =>
    `<button class="qt ${cls} ${on ? 'on' : ''}" data-q="${id}" title="${esc(SHORTCUT_LABELS[action][1])}">${icon}<span>${label}</span><small>${esc(sc(action))}</small></button>`;
  $('#quick').innerHTML =
    qt('editMode', I.move, editOn ? 'Editing' : 'Edit mode', 'toggleEditMode', editOn) +
    qt('fade', I.dim, set.dimmed ? 'Faded' : 'Fade now', 'toggleFade', set.dimmed) +
    qt('hoverFade', I.ghost, 'Hover fade', 'toggleHoverFade', set.hoverFadeEnabled) +
    qt('allHidden', I.eyeOff, set.allHidden ? 'All hidden' : 'Hide all', 'toggleAllVisible', set.allHidden, 'warn');

  $('#banner').innerHTML = set.allHidden
    ? `<div class="banner">${I.eyeOff}<span>All overlays are hidden</span><button class="btn sm" data-q="allHidden">Show</button></div>`
    : '';

  const item = (o) => {
    const st2 = S.statuses[o.id];
    const dot = o.visible !== false && !set.allHidden && st2 ? st2.state : '';
    const kind = withDefaults(o).kind;
    return `<div class="item ${o.id === S.sel && S.view === 'overlay' ? 'selected' : ''} ${o.visible === false ? 'hidden-item' : ''}" data-id="${o.id}" draggable="true">
      <div class="kind">${kind === 'web' ? I.globe : I.chat}<span class="dot ${dot}"></span></div>
      <div class="meta"><div class="name">${esc(o.name || 'Untitled')}</div>
        <div class="sub">${o.visible !== false && !o.locked ? '<span class="pill">EDIT</span>' : ''}<span>${esc(subtitle(o))}</span></div></div>
      <button class="icon-btn" data-eye="${o.id}" title="${o.visible === false ? 'Show on screen' : 'Hide (keeps it here)'}">${o.visible === false ? I.eye : I.eyeOff}</button>
    </div>`;
  };
  $('#list-visible').innerHTML = vis.map(item).join('') || '<div class="list-empty">Nothing on screen right now</div>';
  $('#list-hidden').innerHTML = hid.map(item).join('') || '<div class="list-empty">Hide an overlay to park it here — it keeps all its settings.</div>';
  $('#hidden-count').textContent = hid.length ? `· ${hid.length}` : '';
  $('#trash-count').textContent = st.trash.length || '';
  for (const b of $$('.nav button, .brand')) b.classList.toggle('active', b.dataset.view === S.view);
}

function bindSidebar() {
  const side = $('#sidebar');
  side.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-q]');
    if (q) {
      const set = S.state.settings;
      const what = q.dataset.q;
      if (what === 'editMode') {
        const editOn = S.state.overlays.some((o) => o.visible !== false && !o.locked);
        await call('toggle', { what, on: !editOn });
      } else if (what === 'allHidden') await call('toggle', { what, on: !set.allHidden });
      else await call('toggle', { what });
      return;
    }
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      e.stopPropagation();
      const o = S.state.overlays.find((x) => x.id === eye.dataset.eye);
      if (!o) return;
      await call('update_overlay', { id: o.id, patch: { visible: o.visible === false } });
      return;
    }
    const it = e.target.closest('.item');
    if (it) return select(it.dataset.id);
    const nav = e.target.closest('[data-view]');
    if (nav) {
      S.view = nav.dataset.view;
      render();
    }
  });
  $('#btn-new').addEventListener('click', () => {
    S.view = 'new';
    S.newKind = 'twitch';
    render();
  });

  // Drag to reorder — or drop into the other list to show / hide.
  let dragId = null;
  side.addEventListener('dragstart', (e) => {
    const it = e.target.closest('.item');
    if (!it) return;
    dragId = it.dataset.id;
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  side.addEventListener('dragend', () => {
    dragId = null;
    $$('.dragging, .drop', side).forEach((x) => x.classList.remove('dragging', 'drop'));
  });
  for (const list of $$('.list', side)) {
    list.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      list.classList.add('drop');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop');
      if (!dragId) return;
      const dragged = $(`.item[data-id="${dragId}"]`, side);
      const target = e.target.closest('.item');
      if (target && target !== dragged) list.insertBefore(dragged, target);
      else if (!target) list.appendChild(dragged);
      const ids = $$('.item', side).map((x) => x.dataset.id);
      const wantVisible = list.dataset.list === 'visible';
      const o = S.state.overlays.find((x) => x.id === dragId);
      await call('reorder_overlays', { ids });
      if (o && (o.visible !== false) !== wantVisible) await call('update_overlay', { id: o.id, patch: { visible: wantVisible } });
    });
  }
}

function select(id) {
  if (S.sel !== id || S.view !== 'overlay') {
    S.sel = id;
    S.view = 'overlay';
    const o = ov();
    if (o && withDefaults(o).kind === 'web' && !['source', 'behavior'].includes(S.tab)) S.tab = 'source';
    render();
  }
}

// ================================================================ main views

function render() {
  if (S.view === 'overlay' && !ov()) {
    if (S.state.overlays.length) S.sel = S.state.overlays[0].id;
    else S.view = 'welcome';
  }
  renderSidebar();
  previewReady = false;
  const views = { overlay: viewOverlay, welcome: viewWelcome, new: viewNew, layouts: viewLayouts, trash: viewTrash, settings: viewSettings };
  views[S.view]();
  main.scrollTop = 0;
}

// ---------------------------------------------------------------- overlay editor

function tabsFor(kind) {
  return kind === 'web'
    ? [['source', 'Source'], ['behavior', 'Behavior']]
    : [['source', 'Source'], ['look', 'Look'], ['behavior', 'Behavior'], ['filters', 'Filters']];
}

function viewOverlay() {
  const o = ov();
  const f = withDefaults(o);
  const tabs = tabsFor(f.kind);
  if (!tabs.some(([k]) => k === S.tab)) S.tab = 'source';
  main.innerHTML = `<div class="page">
    <div class="page-head">
      <input class="title-input" data-path="name" data-kind="text" data-scope="overlay" spellcheck="false" maxlength="60" title="Rename">
      <span class="badge-kind">${f.kind === 'web' ? 'Web widget' : 'Twitch chat'}</span>
      <span class="state-chip" id="state-chip"></span>
      <div class="spacer"></div>
      <div class="btn-group" id="head-actions"></div>
    </div>
    <div class="editor-grid">
      <div data-scope="overlay">
        <div class="tabs" id="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === S.tab ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div id="tab-body"></div>
      </div>
      <div class="preview-col">
        <div class="preview-card">
          <div class="preview-top"><b>Live preview</b>
            <div class="seg" id="bg-seg">${[['game', 'Game'], ['light', 'Light'], ['checker', 'Grid']].map(([k, l]) => `<button type="button" data-bg="${k}" class="${S.previewBg === k ? 'active' : ''}">${l}</button>`).join('')}</div>
          </div>
          <div class="preview-frame bg-${S.previewBg}" id="preview-frame"><iframe id="preview" src="overlay.html?preview=1" title="Preview"></iframe></div>
          <div class="preview-foot"><span>Hover the preview to try the fade</span>${f.kind === 'twitch' ? `<button class="btn sm" id="more-samples">${I.plus} Samples</button>` : ''}</div>
        </div>
      </div>
    </div></div>`;
  fillBindings($('.page-head'), f);
  renderHead();
  renderTab();
}

function renderHead() {
  const o = ov();
  if (!o || !$('#head-actions')) return;
  const f = withDefaults(o);
  const visible = o.visible !== false;
  const st = S.statuses[o.id];
  const allHidden = S.state.settings.allHidden;
  $('#state-chip').innerHTML = !visible
    ? `<span class="dot"></span>Hidden`
    : allHidden
      ? `<span class="dot"></span>Hidden (hide all)`
      : `<span class="dot ${st?.state || ''}"></span>${esc(st?.text || (f.kind === 'web' ? 'Web widget' : 'Starting…'))}`;
  $('#head-actions').innerHTML = `
    <button class="btn ${visible ? '' : 'primary'}" data-act="visible">${visible ? I.eyeOff + 'Hide' : I.eye + 'Show on screen'}</button>
    <button class="btn ${o.locked ? '' : 'active'}" data-act="lock" ${visible ? '' : 'disabled'} title="${o.locked ? 'Unlock to drag & resize it on screen' : 'Lock: click-through, hover fade active'}">${o.locked ? I.unlock + 'Unlock to move' : I.lock + 'Lock'}</button>
    ${f.kind === 'twitch' ? `<button class="btn" data-act="test" ${visible ? '' : 'disabled'} title="Send sample messages to the overlay">${I.play}Test</button>` : ''}
    <button class="btn" data-act="duplicate" title="Make a copy (e.g. to try a different style)">${I.copy}Duplicate</button>
    <button class="btn danger" data-act="delete" title="Move to trash">${I.trash}</button>`;
}

function renderTab() {
  const f = withDefaults(ov());
  const body = $('#tab-body');
  body.innerHTML = TABS[S.tab](f);
  fillBindings(body, f);
  updateConditionals();
  for (const p of $$('.preset', body)) p.classList.toggle('active', p.dataset.preset === f.look.preset);
}

const TABS = {
  source(f) {
    if (f.kind === 'web') {
      return (
        card('Widget URL', 'Any page with a transparent background works great: StreamElements / Streamlabs overlays, jChat, alert boxes, viewer counters… Local HTML widgets work too — paste a file:/// link or a C:\\ path.',
          R('', C.text('web.url', 'https://…  or  file:///C:/…/overlay.html'), { block: true }) +
          R('Zoom', C.range('web.zoom', 25, 300, 5, { scale: 100, unit: '%' }), { hint: 'Scale the page up or down to fit the overlay' })) +
        card('Good to know', '', `<p class="muted" style="margin:6px 0 10px">Some sites (twitch.tv itself, for example) refuse to be embedded and will show up blank. For Twitch chat, use a <b>Twitch chat</b> overlay instead — it has emotes, badges and filters built in.</p>`)
      );
    }
    return (
      card('Channels', 'Messages from every channel listed here are merged into this overlay.',
        R('Twitch channels', C.tags('twitch.channels', 'Type a channel and press Enter', 'channel'), { hint: 'Pasting a twitch.tv link works too' }) +
        R('Channel label', C.seg('twitch.channelTag', [['auto', 'Auto'], ['always', 'Always'], ['never', 'Never']]), { hint: 'Small channel tag before each message (Auto = only when merging channels)' }) +
        R('Recent history', C.range('twitch.history', 0, 100, 5, { fmt: 'off0', unit: ' msgs' }), { hint: 'Messages shown right away when the overlay opens' })) +
      card('Content', '',
        R('7TV / BTTV / FFZ emotes', C.toggle('twitch.thirdPartyEmotes')) +
        R('Badges', C.toggle('twitch.badges'), { hint: 'Subscriber, moderator, VIP…' }) +
        R('Sub / raid / announcement notices', C.toggle('twitch.showNotices')))
    );
  },

  look() {
    const presets = Object.entries(LOOK_PRESETS)
      .map(([k, p]) => `<button type="button" class="preset" data-preset="${k}"><div class="mini s-${p.look.style} p-${k}"><i></i><i></i><i></i></div><b>${p.label}</b></button>`)
      .join('');
    return (
      card('Style presets', 'Start from a preset, then fine-tune anything below.', `<div class="presets" style="padding:8px 0 6px">${presets}</div>`) +
      card('Text', '',
        R('Font', C.text('look.fontFamily', 'Segoe UI', 'font-list'), { hint: 'Any installed font, or pick a Google font from the list' }) +
        R('Size', C.range('look.fontSize', 10, 40, 1, { unit: 'px' })) +
        R('Weight', C.seg('look.fontWeight', [[400, 'Regular'], [500, 'Medium'], [600, 'Semi'], [700, 'Bold'], [800, 'Heavy']], 'num')) +
        R('Name weight', C.seg('look.nameWeight', [[500, 'Medium'], [600, 'Semi'], [700, 'Bold'], [800, 'Heavy']], 'num')) +
        R('Line height', C.range('look.lineHeight', 1, 2, 0.05)) +
        R('Text colour', C.color('look.textColor')) +
        R('Shadow / outline', C.seg('look.outline', [['none', 'None'], ['soft', 'Soft'], ['strong', 'Strong'], ['outline', 'Outline']]), { hint: 'Keeps text readable on bright scenes' })) +
      card('Messages', '',
        R('Background', C.seg('look.style', [['plain', 'None'], ['bubble', 'Bubbles'], ['rows', 'Rows'], ['panel', 'Panel']])) +
        R('Bubble colour', C.color('look.msgBg'), { showIf: 'look.style=bubble|rows' }) +
        R('Bubble opacity', C.range('look.msgBgAlpha', 0, 100, 1, { scale: 100, unit: '%' }), { showIf: 'look.style=bubble|rows' }) +
        R('Panel colour', C.color('look.panelBg'), { showIf: 'look.style=panel' }) +
        R('Panel opacity', C.range('look.panelAlpha', 0, 100, 1, { scale: 100, unit: '%' }), { showIf: 'look.style=panel' }) +
        R('Corner radius', C.range('look.radius', 0, 24, 1, { unit: 'px' }), { showIf: 'look.style=bubble|rows|panel' }) +
        R('Spacing', C.range('look.gap', 0, 16, 1, { unit: 'px' })) +
        R('Edge padding', C.range('look.padding', 0, 32, 1, { unit: 'px' })) +
        R('Emote size', C.range('look.emoteSize', 16, 72, 1, { unit: 'px' }))) +
      card('Layout & details', '',
        R('Newest messages', C.seg('look.direction', [['bottom', 'At bottom'], ['top', 'At top']])) +
        R('Alignment', C.seg('look.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])) +
        R('Entry animation', C.seg('look.animation', [['slide', 'Slide'], ['fade', 'Fade'], ['pop', 'Pop'], ['none', 'None']])) +
        R('Badges', C.toggle('look.showBadges')) +
        R('Timestamps', C.toggle('look.timestamps')) +
        R('Colon after names', C.toggle('look.colon')) +
        R('Readable name colours', C.toggle('look.readableNames'), { hint: 'Brightens dark username colours so they stay legible over games' }) +
        R('Single name colour', C.coloropt('look.nameColor'), { hint: 'Use one colour for every username' })) +
      `<details class="adv"><summary>Advanced — custom CSS</summary>` +
      card('', '', R('', C.textarea('look.customCss', '/* Classes: .msg .name .text .emote .badge .notice .hl */\n.msg .name { text-transform: uppercase; }'), { block: true, hint: 'Applied inside this overlay only' })) +
      `</details>`
    );
  },

  behavior(f) {
    return (
      card('Visibility', '',
        R('Opacity', C.range('opacity', 10, 100, 1, { scale: 100, unit: '%' }), { hint: 'How see-through the overlay is normally' }) +
        R('Locked (click-through)', C.toggle('locked'), { hint: `Unlock to drag & resize on screen. All overlays: ${kbd('toggleEditMode')}` })) +
      card('Fade', `Fade the overlay away to see — and click — whatever is underneath: press ${kbd('toggleFade')} any time, or just hover a locked overlay.`,
        R('Fade to', C.range('hover.opacity', 0, 90, 1, { scale: 100, unit: '%' }), { hint: '0% = vanish completely' }) +
        R('Fade speed', C.range('hover.fadeMs', 0, 1000, 10, { unit: ' ms' })) +
        R('Fade with the shortcut', C.toggle('hover.manual'), { hint: `${kbd('toggleFade')} fades every overlay that has this on` }) +
        R('Fade on hover', C.toggle('hover.enabled'), { hint: `Turn hover fading on/off everywhere: ${kbd('toggleHoverFade')}` }) +
        R('Delay before fading', C.range('hover.delayMs', 0, 1000, 10, { unit: ' ms' }), { hint: 'Avoids flicker when the mouse just passes over', showIf: 'hover.enabled=true' }) +
        R('Stay faded after leaving', C.range('hover.restoreDelayMs', 0, 2000, 20, { unit: ' ms' }), { showIf: 'hover.enabled=true' })) +
      (f.kind === 'twitch'
        ? card('Messages', '',
            R('Max messages kept', C.range('behavior.maxMessages', 10, 200, 5), { hint: 'Lower = lighter on resources' }) +
            R('Fade out old messages', C.range('behavior.fadeOutSec', 0, 300, 5, { fmt: 'never0', unit: ' s' }), { hint: 'Messages disappear after this long' }) +
            R('Deleted / timed-out messages', C.seg('behavior.removeDeleted', [['true', 'Remove'], ['false', 'Strike through']], 'bool')) +
            R('Clear when chat is cleared', C.toggle('behavior.clearOnClearChat'), { hint: 'When a mod uses /clear' }))
        : '') +
      card('Position & size', 'In screen pixels. Easier: unlock and drag / resize the overlay directly.',
        `<div class="num-grid" style="padding:8px 0 6px">${C.int('x', 'X')}${C.int('y', 'Y')}${C.int('w', 'Width')}${C.int('h', 'Height')}</div>`)
    );
  },

  filters() {
    return (
      card('Highlights', 'Make important messages stand out.',
        R('Highlight words', C.tags('filters.highlightWords', 'your name, keywords…'), { hint: 'Case-insensitive. Channel-point highlights are always highlighted.' }) +
        R('Highlight colour', C.color('filters.highlightColor')) +
        R('Play a sound', C.toggle('filters.highlightSound'), { hint: 'A soft ping when a highlight arrives' })) +
      card('Hide messages', '',
        R('Hide !commands', C.toggle('filters.hideCommands')) +
        R('Hide bots', C.toggle('filters.hideBots')) +
        R('Bot accounts', C.tags('filters.bots', 'bot name', 'lower'), { showIf: 'filters.hideBots=true' }) +
        R('Blocked users', C.tags('filters.blockedUsers', 'username', 'lower')) +
        R('Blocked words', C.tags('filters.blockedWords', 'word or phrase'), { hint: 'Messages containing any of these are hidden' }))
    );
  },
};

function bindMain() {
  main.addEventListener('input', onFieldEvent);
  main.addEventListener('change', onFieldEvent);
  bindTags(main);
  main.addEventListener('click', async (e) => {
    const t = e.target;
    const segBtn = t.closest('.seg[data-path] button');
    if (segBtn) {
      const seg = segBtn.parentElement;
      let v = segBtn.dataset.v;
      if (seg.dataset.type === 'num') v = Number(v);
      if (seg.dataset.type === 'bool') v = v === 'true';
      $$('button', seg).forEach((b) => b.classList.toggle('active', b === segBtn));
      commit(seg, v);
      return;
    }
    const tab = t.closest('[data-tab]');
    if (tab) {
      S.tab = tab.dataset.tab;
      $$('#tabs button').forEach((b) => b.classList.toggle('active', b === tab));
      renderTab();
      return;
    }
    const preset = t.closest('[data-preset]');
    if (preset) {
      const p = LOOK_PRESETS[preset.dataset.preset];
      patchOverlay({ look: { ...p.look, preset: preset.dataset.preset } });
      renderTab();
      return;
    }
    const bg = t.closest('[data-bg]');
    if (bg) {
      S.previewBg = bg.dataset.bg;
      $('#preview-frame').className = `preview-frame bg-${S.previewBg}`;
      $$('#bg-seg button').forEach((b) => b.classList.toggle('active', b === bg));
      return;
    }
    if (t.closest('#more-samples')) {
      $('#preview')?.contentWindow.postMessage({ type: 'samples' }, location.origin);
      return;
    }
    const scClear = t.closest('[data-sc-clear]');
    if (scClear) return saveShortcut(scClear.dataset.scClear, '', null);
    const act = t.closest('[data-act]');
    if (act) return overlayAction(act.dataset.act);
  });
}

async function overlayAction(act) {
  const o = ov();
  if (!o) return;
  if (act === 'visible') await call('update_overlay', { id: o.id, patch: { visible: o.visible === false } });
  if (act === 'lock') await call('update_overlay', { id: o.id, patch: { locked: !o.locked } });
  if (act === 'test') {
    await call('overlay_action', { id: o.id, action: 'test' });
    toast('Sent sample messages');
  }
  if (act === 'duplicate') {
    const copy = clone(o);
    delete copy.id;
    copy.name = `${o.name} (copy)`;
    copy.x = (o.x ?? 0) + 40;
    copy.y = (o.y ?? 0) + 40;
    const created = await call('create_overlay', { overlay: copy });
    S.sel = created.id;
    render();
    toast('Duplicated — the copy is on screen, slightly offset');
  }
  if (act === 'delete') {
    const ok = await modal({
      title: `Delete “${o.name}”?`,
      text: 'It goes to the Trash, where you can restore it. Tip: use <b>Hide</b> if you just want it off screen.',
      ok: 'Move to trash',
      danger: true,
    });
    if (ok) {
      await call('delete_overlay', { id: o.id });
      toast('Moved to trash');
    }
  }
}

// ---------------------------------------------------------------- welcome

// Shown automatically while there are no overlays, and any time via the logo (Home).
function viewWelcome() {
  const count = S.state.overlays.length;
  const first = count === 0;
  main.innerHTML = `<div class="page">
    <div class="hero">
      <h1>${first ? 'Welcome to TTCO+' : 'Home'}</h1>
      <p>${first
        ? 'Your Twitch chat floating transparently on top of your game. Enter your channel to create your first overlay — it appears on screen right away so you can drag it into place.'
        : `You have ${count} overlay${count === 1 ? '' : 's'} — pick one on the left to edit it. Add another Twitch chat in one step here, or use <b>+ New</b> for web widgets and copying an existing style.`}</p>
      <form class="hero-form" id="welcome-form">
        <input id="welcome-channel" placeholder="${first ? 'Your Twitch channel name' : 'Twitch channel for the new overlay'}" spellcheck="false" autofocus>
        <button class="btn primary" type="submit">${first ? 'Create overlay' : 'Add overlay'}</button>
      </form>
    </div>
    <div class="tips">
      ${tip(I.ghost, 'Fade on demand', `Press ${kbd('toggleFade')} to fade every overlay instantly — or just hover a locked overlay to see and click what's underneath.`)}
      ${tip(I.move, 'Edit mode', `Press ${kbd('toggleEditMode')} to unlock overlays, drag them anywhere and resize from the edges. Press again to lock.`)}
      ${tip(I.eyeOff, "Hide, don't delete", 'Keep several versions of your chat. Hidden overlays wait in the sidebar with all their settings.')}
      ${tip(I.layout, 'Layouts', `Save which overlays are on screen and where, then switch instantly with ${kbd('nextLayout')}.`)}
    </div></div>`;
  $('#welcome-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ch = normalizeChannel($('#welcome-channel').value);
    const name = first ? 'Main chat' : ch ? `#${ch}` : `Chat ${count + 1}`;
    const overlay = withDefaults({ name, twitch: { channels: ch ? [ch] : [] } });
    const created = await call('create_overlay', { overlay });
    if (first) await call('mark_initialized');
    S.sel = created.id;
    S.view = 'overlay';
    S.tab = 'look';
    render();
    toast('Overlay created — drag it into place, then press Lock');
  });
}

const tip = (icon, title, text) => `<div class="tip"><div class="ic">${icon}</div><h4>${title}</h4><p>${text}</p></div>`;

// ---------------------------------------------------------------- new overlay

function viewNew() {
  const k = S.newKind;
  const opts = S.state.overlays.filter((o) => withDefaults(o).kind === k);
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>New overlay</h1><p>Make as many as you like — hide the ones you're not using instead of deleting them.</p></div></div>
    <div class="kind-cards">
      <button type="button" class="kind-card ${k === 'twitch' ? 'active' : ''}" data-kind="twitch"><div class="ic">${I.chat}</div><div><h4>Twitch chat</h4><p>Built-in renderer: 7TV / BTTV / FFZ emotes, badges, history, highlights and filters. Merge several channels.</p></div></button>
      <button type="button" class="kind-card ${k === 'web' ? 'active' : ''}" data-kind="web"><div class="ic">${I.globe}</div><div><h4>Web widget</h4><p>Any URL — StreamElements / Streamlabs widgets, jChat, alerts, viewer counts…</p></div></button>
    </div>
    ${card('', '',
      R('Name', `<input id="new-name" placeholder="${k === 'web' ? 'e.g. Alerts' : 'e.g. Gaming chat'}" spellcheck="false" maxlength="60">`) +
      (k === 'twitch'
        ? R('Channels', `<div class="tags" id="new-channels" data-norm="channel"><span class="chips"></span><input placeholder="channel name, Enter to add" spellcheck="false"></div>`, { hint: 'Add several to merge their chats' })
        : R('URL', `<input id="new-url" placeholder="https://…" spellcheck="false">`)) +
      R('Start from', `<select id="new-from"><option value="">Default settings</option>${opts.map((o) => `<option value="${o.id}">Copy settings of “${esc(o.name)}”</option>`).join('')}</select>`, { hint: 'Reuse the look, filters and behaviour of an existing overlay' }))}
    <div class="btn-group"><button class="btn primary" id="new-create">${I.plus}Create overlay</button><button class="btn ghost" id="new-cancel">Cancel</button></div>
  </div>`;
  $('#new-name').focus();
  const chWrap = $('#new-channels');
  if (chWrap) renderChips(chWrap, []);
  for (const c of $$('.kind-card')) c.addEventListener('click', () => { S.newKind = c.dataset.kind; viewNew(); });
  $('#new-cancel').addEventListener('click', () => { S.view = 'overlay'; render(); });
  $('#new-create').addEventListener('click', async () => {
    if (chWrap) {
      const inp = $('input', chWrap);
      if (inp.value.trim()) addTags(chWrap, inp.value);
    }
    const fromId = $('#new-from').value;
    const from = fromId ? clone(S.state.overlays.find((o) => o.id === fromId)) : {};
    for (const key of ['id', 'x', 'y', 'w', 'h', 'name', 'visible', 'locked']) delete from[key];
    const name = $('#new-name').value.trim() || (k === 'web' ? 'Web widget' : 'Chat');
    const overlay = withDefaults({ ...from, kind: k, name, visible: true, locked: false });
    if (k === 'twitch') overlay.twitch.channels = chWrap._value || [];
    else overlay.web.url = $('#new-url').value.trim();
    const created = await call('create_overlay', { overlay });
    S.sel = created.id;
    S.view = 'overlay';
    S.tab = k === 'web' ? 'source' : 'look';
    render();
    toast('Created — drag it into place, then press Lock');
  });
}

// ---------------------------------------------------------------- layouts

function viewLayouts() {
  const st = S.state;
  const active = st.settings.activeLayout;
  const ids = new Set(st.overlays.map((o) => o.id));
  const rows = st.layouts.map((l) => {
    const items = Object.entries(l.items || {}).filter(([id]) => ids.has(id));
    const on = items.filter(([, v]) => v.visible !== false).length;
    const when = l.savedAt ? new Date(l.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<div class="trow ${l.id === active ? 'active' : ''}" data-lid="${l.id}">
      <div class="grow"><div class="t1">${esc(l.name)}${l.id === active ? ' <span class="badge-kind" style="margin-left:6px">Active</span>' : ''}</div>
      <div class="t2">${on} overlay${on === 1 ? '' : 's'} on screen · saved ${esc(when)}</div></div>
      <button class="btn sm primary" data-la="apply">Apply</button>
      <button class="btn sm" data-la="update" title="Overwrite with the current arrangement">Update</button>
      <button class="btn sm ghost" data-la="rename">Rename</button>
      <button class="btn sm ghost danger" data-la="delete">${I.trash}</button></div>`;
  }).join('');
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Layouts</h1><p>Snapshots of which overlays are on screen and where. Switch in one click, or cycle with ${kbd('nextLayout')}.</p></div>
      <div class="spacer"></div><button class="btn primary" id="layout-save">${I.plus}Save current as layout</button></div>
    <section class="card"><div class="table">${rows || `<div class="empty-state">${I.layout}<div>No layouts yet. Arrange your overlays, then save the arrangement here —<br>for example “Gaming” and “Just chatting”.</div></div>`}</div></section>
  </div>`;
  $('#layout-save').addEventListener('click', async () => {
    const name = await modal({ title: 'Save layout', text: 'Saves which overlays are visible and their positions.', input: `Layout ${st.layouts.length + 1}`, ok: 'Save' });
    if (name) {
      await call('capture_layout', { id: null, name });
      toast(`Saved “${name}”`);
    }
  });
  main.querySelector('.table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-la]');
    if (!b) return;
    const lid = b.closest('[data-lid]').dataset.lid;
    const l = st.layouts.find((x) => x.id === lid);
    if (b.dataset.la === 'apply') await call('apply_layout', { id: lid });
    if (b.dataset.la === 'update') {
      await call('capture_layout', { id: lid, name: l.name });
      toast(`Updated “${l.name}”`);
    }
    if (b.dataset.la === 'rename') {
      const name = await modal({ title: 'Rename layout', input: l.name, ok: 'Rename' });
      if (name) await call('set_layouts', { layouts: st.layouts.map((x) => (x.id === lid ? { ...x, name } : x)) });
    }
    if (b.dataset.la === 'delete') {
      if (await modal({ title: `Delete layout “${l.name}”?`, text: 'Overlays themselves are not affected.', ok: 'Delete', danger: true })) {
        await call('set_layouts', { layouts: st.layouts.filter((x) => x.id !== lid) });
      }
    }
  });
}

// ---------------------------------------------------------------- trash

function viewTrash() {
  const t = S.state.trash;
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Trash</h1><p>Deleted overlays are kept here (up to 50) so nothing is lost by accident.</p></div>
      <div class="spacer"></div>${t.length ? `<button class="btn danger" id="trash-empty">${I.trash}Empty trash</button>` : ''}</div>
    <section class="card"><div class="table">${t.map((o) => `<div class="trow" data-tid="${o.id}">
        <div class="kind" style="width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--surface-3);color:var(--muted)">${withDefaults(o).kind === 'web' ? I.globe : I.chat}</div>
        <div class="grow"><div class="t1">${esc(o.name)}</div><div class="t2">${esc(subtitle(o))} · deleted ${o.deletedAt ? esc(new Date(o.deletedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : ''}</div></div>
        <button class="btn sm primary" data-ta="restore">${I.restore}Restore</button>
        <button class="btn sm ghost danger" data-ta="purge">Delete forever</button></div>`).join('') || `<div class="empty-state">${I.trash}<div>Trash is empty</div></div>`}</div></section></div>`;
  $('#trash-empty')?.addEventListener('click', async () => {
    if (await modal({ title: 'Empty trash?', text: 'These overlays will be permanently deleted.', ok: 'Empty trash', danger: true })) await call('purge_trash', { id: null });
  });
  main.querySelector('.table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ta]');
    if (!b) return;
    const id = b.closest('[data-tid]').dataset.tid;
    if (b.dataset.ta === 'restore') {
      await call('restore_overlay', { id });
      toast('Restored');
    } else if (await modal({ title: 'Delete forever?', text: 'This cannot be undone.', ok: 'Delete', danger: true })) {
      await call('purge_trash', { id });
    }
  });
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const st = S.state;
  const errors = st.shortcutErrors || {};
  const scRows = Object.entries(SHORTCUT_LABELS).map(([action, [label, hint]]) =>
    R(label, `<input class="shortcut-input" readonly data-shortcut="${action}" value="${esc(st.settings.shortcuts?.[action] || '')}" placeholder="Not set">
      <button type="button" class="btn sm ghost" data-sc-clear="${action}">Clear</button>
      ${errors[action] ? `<div class="err">${esc(errors[action])}</div>` : ''}`, { hint })).join('');
  main.innerHTML = `<div class="page" data-scope="settings">
    <div class="page-head"><div><h1>Settings</h1><p>Global options for every overlay.</p></div></div>
    ${card('Global shortcuts', 'Work everywhere, even while a game has focus. Click a box, then press the new key combination (Backspace clears, Esc cancels).', scRows)}
    ${card('Hover fade', '',
      R('Hover fade (all overlays)', C.toggle('hoverFadeEnabled'), { hint: 'Each overlay can also opt out in its Behavior tab' }) +
      R('Ignore when the cursor is hidden', C.toggle('ignoreHiddenCursor'), { hint: "Games that capture the mouse (shooters etc.) hide the cursor — don't fade then" }) +
      R('Detection rate', C.seg('hoverPollMs', [[20, 'Instant'], [40, 'Balanced'], [100, 'Battery saver']], 'num'), { hint: 'How often the cursor position is checked' }))}
    ${card('App', '',
      R('Pop-up notices on overlays', C.toggle('showToasts'), { hint: 'Short confirmation when you use a shortcut' }) +
      R('Start in the tray', C.toggle('startHidden'), { hint: "Launch without opening this window (overlays still appear)" }))}
    ${card('Data', 'Everything is stored locally — nothing leaves your PC except the connection to Twitch & emote providers.',
      R('Data folder', `<code style="font-size:12px;color:var(--muted);word-break:break-all">${esc(st.dataDir)}</code><button type="button" class="btn sm" id="open-data">Open</button>`) +
      R('Backup', `<button type="button" class="btn sm" id="copy-config">${I.copy}Copy config to clipboard</button>`, { hint: 'config.json in the data folder is the full backup' }))}
    ${card('About', '', `<p class="muted" style="margin:6px 0 12px">TTCO+ — a custom take on baffler's Transparent Twitch Chat Overlay, rebuilt with Tauri + WebView2.<br>Closing this window keeps the overlays running in the tray.</p>
      <button type="button" class="btn danger" id="quit" style="margin-bottom:8px">Quit TTCO+</button>`)}
  </div>`;
  fillBindings(main, st.settings);
  $('#open-data').addEventListener('click', () => call('open_data_folder'));
  $('#copy-config').addEventListener('click', async () => {
    const { dataDir, ...rest } = S.state;
    await navigator.clipboard.writeText(JSON.stringify(rest, null, 2));
    toast('Config copied to clipboard');
  });
  $('#quit').addEventListener('click', async () => {
    if (await modal({ title: 'Quit TTCO+?', text: 'All overlays will close.', ok: 'Quit', danger: true })) call('quit_app');
  });
  bindShortcutInputs();
}

const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

function bindShortcutInputs() {
  for (const inp of $$('[data-shortcut]')) {
    const action = inp.dataset.shortcut;
    inp.addEventListener('focus', () => {
      S.capturing = action;
      inp.classList.add('capturing');
      inp.dataset.prev = inp.value;
      inp.value = '';
      inp.placeholder = 'Press keys…';
    });
    inp.addEventListener('blur', () => {
      S.capturing = null;
      inp.classList.remove('capturing');
      if (!inp.value) inp.value = inp.dataset.prev || '';
      inp.placeholder = 'Not set';
    });
    inp.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (MOD_CODES.has(e.code)) {
        inp.value = mods.join('+') + '+…';
        return;
      }
      if (!mods.length && e.code === 'Escape') return inp.blur();
      if (!mods.length && (e.code === 'Backspace' || e.code === 'Delete')) return saveShortcut(action, '', inp);
      const key = e.code.replace(/^Key/, '').replace(/^Digit/, '');
      const isF = /^F\d{1,2}$/.test(e.code);
      if (!mods.length && !isF) {
        inp.value = '';
        inp.placeholder = 'Add Ctrl / Alt / Shift…';
        return;
      }
      saveShortcut(action, [...mods, key].join('+'), inp);
    });
  }
}

async function saveShortcut(action, combo, inp) {
  if (inp) {
    inp.dataset.prev = combo;
    inp.value = combo;
    inp.blur();
  }
  const res = await call('update_settings', { patch: { shortcuts: { [action]: combo } } });
  const err = res.shortcutErrors?.[action];
  if (err) toast(`${combo}: ${err}`, 'error');
  else toast(combo ? `${SHORTCUT_LABELS[action][0]}: ${combo}` : 'Shortcut cleared');
}

// ================================================================ live updates

function applySnapshot(snap) {
  S.state = snap;
  for (const [id, patch] of Object.entries(pending)) {
    const o = snap.overlays.find((x) => x.id === id);
    if (o) deepMerge(o, patch);
  }
}

function onState(snap) {
  applySnapshot(snap);
  if (S.view === 'overlay' && !ov()) return render();
  renderSidebar();
  const typing = main.contains(document.activeElement) && document.activeElement !== document.body;
  if (S.view === 'overlay') {
    renderHead();
    const f = withDefaults(ov());
    fillBindings(main, f);
    updateConditionals();
    sendPreview();
  } else if (S.view === 'settings') {
    if (!S.capturing && !typing) viewSettings();
    else fillBindings(main, S.state.settings);
  } else if (S.view === 'layouts' || S.view === 'trash') {
    if (!document.querySelector('.modal')) render();
  }
}

function fillFontList() {
  $('#font-list').innerHTML = [...SYSTEM_FONTS, ...GOOGLE_FONTS.map((f) => f)]
    .map((f) => `<option value="${esc(f)}">${GOOGLE_FONTS.includes(f) ? 'Google font' : 'System font'}</option>`)
    .join('');
}

async function init() {
  fillFontList();
  bindSidebar();
  bindMain();
  await listen('state', onState);
  await listen('geometry', (g) => {
    const o = S.state?.overlays.find((x) => x.id === g.id);
    if (!o) return;
    Object.assign(o, { x: g.x, y: g.y, w: g.w, h: g.h });
    if (S.view === 'overlay' && S.sel === g.id) {
      const grid = $('.num-grid');
      if (grid) fillBindings(grid, o);
    }
  });
  await listen('overlay-status', (s) => {
    S.statuses[s.id] = s;
    renderSidebar();
    if (S.view === 'overlay' && S.sel === s.id) renderHead();
  });
  await listen('select-overlay', (id) => {
    if (S.state.overlays.some((o) => o.id === id)) {
      S.sel = null;
      select(id);
    }
  });
  S.state = await invoke('get_state');
  if (!S.state.overlays.length) S.view = 'welcome';
  else S.sel = S.state.overlays[0].id;
  render();
  await invoke('manager_ready');
}

init().catch((e) => {
  main.innerHTML = `<div class="page"><h1>Something went wrong</h1><pre>${esc(e?.stack || e)}</pre></div>`;
  invoke('manager_ready').catch(() => {});
});
