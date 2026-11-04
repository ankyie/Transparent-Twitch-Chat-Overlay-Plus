// Shared helpers + the overlay schema (defaults & look presets).
// The Rust side stores overlays verbatim; this file is the single source of
// truth for what an overlay looks like.

export const TAURI = window.__TAURI__ || null;
export const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
export const currentWebview = () => TAURI.webviewWindow.getCurrentWebviewWindow();
export const currentWindow = () => TAURI.window.getCurrentWindow();
/** Listen to events addressed to this window (and global broadcasts). */
export const listen = (event, cb) => currentWebview().listen(event, (e) => cb(e.payload));
export const emit = (event, payload) => TAURI.event.emit(event, payload);

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Deep-merge `patch` into `target` (mutates + returns target). Arrays replace. */
export function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

/** Defaults with `obj` merged on top — never mutates either argument. */
export const withDefaults = (obj, defaults = DEFAULT_OVERLAY) => deepMerge(clone(defaults), obj || {});

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}
export const pathToPatch = (path, value) => setPath({}, path, value);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const DEFAULT_BOTS = [
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot',
  'sery_bot', 'soundalerts', 'kofistreambot', 'botrixoficial', 'pokemoncommunitygame',
];

export const DEFAULT_OVERLAY = {
  name: 'Main chat',
  kind: 'twitch', // 'twitch' | 'web'
  visible: true,
  locked: false,
  opacity: 1,
  // `opacity` is the faded level used by both hover fade and the fade shortcut.
  hover: { enabled: true, manual: true, opacity: 0.12, delayMs: 80, fadeMs: 160, restoreDelayMs: 220 },
  twitch: {
    channels: [],
    thirdPartyEmotes: true,
    badges: true,
    history: 25,
    showNotices: true,
    channelTag: 'auto', // auto | always | never
  },
  web: { url: '', zoom: 1 },
  look: {
    preset: 'bubble',
    fontFamily: 'Segoe UI',
    fontSize: 15,
    fontWeight: 500,
    nameWeight: 700,
    lineHeight: 1.35,
    textColor: '#ffffff',
    outline: 'soft', // none | soft | strong | outline
    style: 'bubble', // plain | bubble | rows | panel
    msgBg: '#0a0a12',
    msgBgAlpha: 0.55,
    radius: 10,
    panelBg: '#0a0a12',
    panelAlpha: 0.4,
    gap: 4,
    padding: 8,
    emoteSize: 28,
    showBadges: true,
    timestamps: false,
    colon: false,
    animation: 'slide', // slide | fade | pop | none
    direction: 'bottom', // bottom = newest at bottom, top = newest at top
    align: 'left',
    readableNames: true,
    nameColor: '',
    customCss: '',
  },
  behavior: {
    maxMessages: 60,
    fadeOutSec: 0,
    removeDeleted: true,
    clearOnClearChat: true,
  },
  filters: {
    hideCommands: false,
    hideBots: false,
    bots: DEFAULT_BOTS,
    blockedUsers: [],
    blockedWords: [],
    highlightWords: [],
    highlightColor: '#a970ff',
    highlightSound: false,
  },
};

export const LOOK_PRESETS = {
  bubble: {
    label: 'Bubbles',
    look: { style: 'bubble', msgBg: '#0a0a12', msgBgAlpha: 0.55, radius: 10, outline: 'soft', fontSize: 15, fontWeight: 500, gap: 4, animation: 'slide' },
  },
  clean: {
    label: 'Clean text',
    look: { style: 'plain', outline: 'strong', fontSize: 16, fontWeight: 600, gap: 2, animation: 'fade' },
  },
  outline: {
    label: 'Outlined',
    look: { style: 'plain', outline: 'outline', fontSize: 17, fontWeight: 700, nameWeight: 800, gap: 2, animation: 'slide' },
  },
  panel: {
    label: 'Glass panel',
    look: { style: 'panel', panelBg: '#0a0a12', panelAlpha: 0.45, radius: 14, outline: 'none', fontSize: 14, fontWeight: 500, gap: 3, animation: 'fade' },
  },
  rows: {
    label: 'Striped rows',
    look: { style: 'rows', msgBg: '#000000', msgBgAlpha: 0.4, radius: 6, outline: 'none', fontSize: 14, gap: 2, animation: 'slide' },
  },
  compact: {
    label: 'Compact',
    look: { style: 'bubble', msgBg: '#000000', msgBgAlpha: 0.45, radius: 6, outline: 'soft', fontSize: 13, fontWeight: 500, gap: 2, emoteSize: 22, lineHeight: 1.25, animation: 'none' },
  },
  big: {
    label: 'Big & bold',
    look: { style: 'bubble', msgBg: '#000000', msgBgAlpha: 0.6, radius: 14, outline: 'soft', fontSize: 20, fontWeight: 700, nameWeight: 800, emoteSize: 36, gap: 6, animation: 'pop' },
  },
};

export const SYSTEM_FONTS = [
  'Segoe UI', 'Segoe UI Variable Display', 'Bahnschrift', 'Arial', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Calibri', 'Georgia', 'Consolas', 'Cascadia Code', 'Comic Sans MS', 'Impact',
];
// Loaded on demand from Google Fonts when picked.
export const GOOGLE_FONTS = [
  'Inter', 'Roboto', 'Poppins', 'Nunito', 'Montserrat', 'Lato', 'Rubik', 'Outfit',
  'Comfortaa', 'Baloo 2', 'Press Start 2P', 'Indie Flower', 'Source Code Pro',
];

export const SHORTCUT_LABELS = {
  toggleFade: ['Fade overlays now', 'Instantly fades every overlay to its “Fade to” level — no hovering needed. Press again to restore'],
  toggleHoverFade: ['Turn hover fade on / off', 'Enables or disables the fade-while-hovering feature for all overlays'],
  toggleEditMode: ['Toggle edit mode', 'Unlock overlays to drag / resize them, lock to make them click-through'],
  toggleAllVisible: ['Show / hide all overlays', 'Quickly hides everything (each overlay keeps its own visibility)'],
  openManager: ['Open this manager', 'Brings this window to the front'],
  nextLayout: ['Next layout', 'Cycles through your saved layouts'],
};

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex, a) {
  const c = hexToRgb(hex) || [0, 0, 0];
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
