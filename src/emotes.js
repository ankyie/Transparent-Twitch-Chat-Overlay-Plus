// Third-party emotes (7TV, BTTV, FFZ) + Twitch badges. Everything is cached
// per room and failures are silent — chat keeps working without them.

const globalEmotes = new Map(); // name -> { url, zw }
const roomEmotes = new Map(); // roomId -> Map(name -> emote)
const roomLoads = new Map(); // roomId -> Promise
const globalBadges = new Map(); // "set/version" -> { url, title }
const roomBadges = new Map(); // roomId -> Map
let globalsPromise = null;

// BTTV zero-width emotes that are flagged by name only.
const BTTV_ZW = new Set(['SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat']);

async function getJSON(url, ms = 8000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const abs = (u) => (u && u.startsWith('//') ? 'https:' + u : u);

function addSeventv(map, emotes) {
  for (const e of emotes || []) {
    const host = e.data && e.data.host;
    if (!host) continue;
    const zw = (e.flags & 1) === 1 || ((e.data.flags || 0) & 256) === 256;
    map.set(e.name, { url: `${abs(host.url)}/2x.webp`, zw, p: '7tv' });
  }
}
function addBttv(map, emotes) {
  for (const e of emotes || []) {
    map.set(e.code, { url: `https://cdn.betterttv.net/emote/${e.id}/2x.webp`, zw: BTTV_ZW.has(e.code), p: 'bttv' });
  }
}
function addFfz(map, sets) {
  for (const set of Object.values(sets || {})) {
    for (const e of set.emoticons || []) {
      const u = e.urls && (e.urls['2'] || e.urls['1']);
      if (u) map.set(e.name, { url: abs(u), zw: false, p: 'ffz' });
    }
  }
}
function addBadges(map, list) {
  for (const set of list || []) {
    const id = set.set_id || set.setID;
    for (const v of set.versions || []) {
      map.set(`${id}/${v.id}`, { url: v.image_url_2x || v.image_url_1x, title: v.title || id });
    }
  }
}

export function loadGlobals({ thirdParty = true, badges = true } = {}) {
  if (globalsPromise) return globalsPromise;
  globalsPromise = Promise.all([
    badges ? getJSON('https://api.ivr.fi/v2/twitch/badges/global').then((j) => addBadges(globalBadges, j)) : null,
    thirdParty ? getJSON('https://7tv.io/v3/emote-sets/global').then((j) => j && addSeventv(globalEmotes, j.emotes)) : null,
    thirdParty ? getJSON('https://api.betterttv.net/3/cached/emotes/global').then((j) => addBttv(globalEmotes, j)) : null,
    thirdParty
      ? getJSON('https://api.frankerfacez.com/v1/set/global').then((j) => {
          if (!j) return;
          const sets = {};
          for (const id of j.default_sets || []) if (j.sets[id]) sets[id] = j.sets[id];
          addFfz(globalEmotes, sets);
        })
      : null,
  ]);
  return globalsPromise;
}

export function loadRoom(roomId, { thirdParty = true, badges = true } = {}) {
  if (!roomId) return Promise.resolve();
  if (roomLoads.has(roomId)) return roomLoads.get(roomId);
  const emotes = new Map();
  const bmap = new Map();
  roomEmotes.set(roomId, emotes);
  roomBadges.set(roomId, bmap);
  // Load order matters: later providers win on name clashes (7TV last, as most streamers expect).
  const p = (async () => {
    const [ffz, bttv, stv, b] = await Promise.all([
      thirdParty ? getJSON(`https://api.frankerfacez.com/v1/room/id/${roomId}`) : null,
      thirdParty ? getJSON(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`) : null,
      thirdParty ? getJSON(`https://7tv.io/v3/users/twitch/${roomId}`) : null,
      badges ? getJSON(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`) : null,
    ]);
    if (ffz) addFfz(emotes, ffz.sets);
    if (bttv) addBttv(emotes, [...(bttv.channelEmotes || []), ...(bttv.sharedEmotes || [])]);
    if (stv && stv.emote_set) addSeventv(emotes, stv.emote_set.emotes);
    if (b) addBadges(bmap, b);
  })();
  roomLoads.set(roomId, p);
  return p;
}

export function findEmote(roomId, word) {
  const r = roomEmotes.get(roomId);
  return (r && r.get(word)) || globalEmotes.get(word) || null;
}

export function findBadge(roomId, set, version) {
  const key = `${set}/${version}`;
  const r = roomBadges.get(roomId);
  return (r && r.get(key)) || globalBadges.get(key) || null;
}

export const twitchEmoteUrl = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
