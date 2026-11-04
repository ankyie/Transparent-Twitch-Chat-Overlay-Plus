// Minimal anonymous Twitch IRC-over-WebSocket client (read-only, no login needed).

const TAG_ESCAPES = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
const unescapeTag = (v) => v.replace(/\\(.?)/g, (_, c) => (c in TAG_ESCAPES ? TAG_ESCAPES[c] : c));

export function parseIRC(line) {
  const msg = { raw: line, tags: {}, prefix: '', command: '', params: [] };
  let i = 0;
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const part of line.slice(1, sp).split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) msg.tags[part] = '';
      else msg.tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    i = sp + 1;
  }
  while (line[i] === ' ') i++;
  if (line[i] === ':') {
    const sp = line.indexOf(' ', i);
    msg.prefix = line.slice(i + 1, sp);
    i = sp + 1;
  }
  while (line[i] === ' ') i++;
  let sp = line.indexOf(' ', i);
  if (sp === -1) {
    msg.command = line.slice(i);
    return msg;
  }
  msg.command = line.slice(i, sp);
  i = sp + 1;
  while (i < line.length) {
    if (line[i] === ':') {
      msg.params.push(line.slice(i + 1));
      break;
    }
    sp = line.indexOf(' ', i);
    if (sp === -1) {
      msg.params.push(line.slice(i));
      break;
    }
    msg.params.push(line.slice(i, sp));
    i = sp + 1;
  }
  return msg;
}

export const nickFromPrefix = (p) => (p || '').split('!')[0];
export const normalizeChannel = (c) => String(c || '').trim().toLowerCase().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').split(/[/?#]/)[0];

export class TwitchChat {
  /**
   * @param {{onMessage:(m)=>void, onStatus:(state:string, text:string)=>void}} handlers
   */
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.channels = new Set();
    this.ws = null;
    this.closed = false;
    this.backoff = 1000;
    this.lastData = 0;
    this.watchdog = setInterval(() => {
      // Twitch PINGs about every 5 minutes; if we hear nothing for 7, reconnect.
      if (this.ws && this.lastData && Date.now() - this.lastData > 7 * 60 * 1000) this.reconnect();
    }, 30 * 1000);
  }

  setChannels(list) {
    const next = new Set(list.map(normalizeChannel).filter(Boolean));
    const open = this.ws && this.ws.readyState === WebSocket.OPEN;
    const toPart = [...this.channels].filter((c) => !next.has(c));
    const toJoin = [...next].filter((c) => !this.channels.has(c));
    this.channels = next;
    if (!next.size) {
      this.disconnect();
      this.onStatus('idle', 'No channel set');
      return { joined: [], parted: toPart };
    }
    if (!this.ws) this.connect();
    else if (open) {
      if (toPart.length) this.send(`PART ${toPart.map((c) => '#' + c).join(',')}`);
      if (toJoin.length) this.send(`JOIN ${toJoin.map((c) => '#' + c).join(',')}`);
    }
    return { joined: toJoin, parted: toPart };
  }

  send(line) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line + '\r\n');
  }

  connect() {
    this.closed = false;
    this.onStatus('connecting', 'Connecting…');
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.send('PASS SCHMOOPIIE');
      this.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      if (this.channels.size) this.send(`JOIN ${[...this.channels].map((c) => '#' + c).join(',')}`);
    };
    ws.onmessage = (ev) => {
      this.lastData = Date.now();
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        const m = parseIRC(line);
        switch (m.command) {
          case 'PING':
            this.send(`PONG :${m.params[0] || 'tmi.twitch.tv'}`);
            break;
          case 'RECONNECT':
            this.reconnect();
            break;
          case '001':
            this.onStatus('connected', `Connected · ${[...this.channels].map((c) => '#' + c).join(' ')}`);
            break;
          case 'NOTICE':
            if (/login|auth/i.test(m.params[1] || '')) this.onStatus('error', m.params[1]);
            this.onMessage(m);
            break;
          default:
            this.onMessage(m);
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || !this.channels.size) return;
      this.onStatus('reconnecting', `Reconnecting in ${Math.round(this.backoff / 1000)}s…`);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }

  reconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch {}
    }
    this.connect();
  }

  disconnect() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  destroy() {
    this.disconnect();
    clearInterval(this.watchdog);
  }
}

/** Fetch recent chat history (robotty recent-messages service). Returns raw IRC lines. */
export async function fetchHistory(channel, limit) {
  if (!limit) return [];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(
      `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?limit=${limit}&hide_moderated_messages=true&clearchat_to_notice=false`,
      { signal: ctl.signal }
    );
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}
