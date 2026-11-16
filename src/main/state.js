(() => {
  'use strict';
  if (window.__SCXF__) return;

  const CHANNEL_TO_MAIN = 'scxf:v1:to-main';
  const CHANNEL_TO_ISO = 'scxf:v1:to-iso';
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, fadeSeconds: 6, trimSilence: true, handoffMode: 'swap', smartMix: true });

  let debug = false;
  try { debug = window.localStorage.getItem('scxfDebug') === '1'; } catch (_) { }

  const S = {
    version: '0.2.0',
    settings: DEFAULT_SETTINGS,
    get debug() { return debug; },
    set debug(v) {
      debug = !!v;
      try { window.localStorage.setItem('scxfDebug', debug ? '1' : '0'); } catch (_) { }
    },
    log(...a) { if (debug) console.debug('[PreGradien]', ...a); },
    warn(...a) { console.warn('[PreGradien]', ...a); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  const handlers = new Map();
  S.on = (evt, fn) => {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt).delete(fn);
  };
  S.emit = (evt, ...args) => {
    const set = handlers.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { S.warn(`handler for "${evt}" failed`, e); }
    }
  };

  const STATES = Object.freeze({ IDLE: 'idle', PRELOAD: 'preload', FADE: 'fade', HANDOFF: 'handoff' });
  const FORWARD = Object.freeze({ idle: ['preload'], preload: ['fade'], fade: ['handoff'], handoff: [] });

  const machine = {
    STATES,
    state: STATES.IDLE,
    epoch: 0,
    enteredAt: performance.now(),
    history: [],
    is(...names) { return names.includes(this.state); },
    can(next) { return next === STATES.IDLE || FORWARD[this.state].includes(next); },
    to(next, reason = '') {
      if (!this.can(next)) {
        S.warn(`illegal transition ${this.state} -> ${next} (${reason})`);
        return false;
      }
      const prev = this.state;
      if (next === STATES.IDLE) this.epoch++;
      if (prev === next) return true;
      this.state = next;
      this.enteredAt = performance.now();
      this.history.push({ at: new Date().toISOString(), from: prev, to: next, reason });
      if (this.history.length > 50) this.history.shift();
      S.log(`state ${prev} -> ${next}`, reason);
      S.emit('state', next, prev, reason);
      return true;
    },
    reset(reason = 'reset') { return this.to(STATES.IDLE, reason); },
  };

  const pending = new Map();
  let seq = 0;
  const bridge = {
    post(type, payload, transfer) {
      try {
        window.postMessage({ channel: CHANNEL_TO_ISO, type, payload }, window.location.origin, transfer || []);
      } catch (e) {
        S.warn('bridge post failed', e);
      }
    },
    request(type, payload, timeoutMs = 30000) {
      const id = `${Date.now().toString(36)}-${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge "${type}" timed out (is the extension loaded?)`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        bridge.post(type, { ...payload, id });
      });
    },
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.channel !== CHANNEL_TO_MAIN) return;
    switch (d.type) {
      case 'response': {
        const id = d.payload && d.payload.id;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(d.payload);
        break;
      }
      default:
        break;
    }
  });

  class HttpError extends Error {
    constructor(status) { super(`HTTP ${status}`); this.name = 'HttpError'; this.status = status; }
  }

  const rawFetch = window.fetch;
  const corsByHost = Object.create(null);

  const net = {
    corsByHost,
    fetch: (...args) => rawFetch.apply(window, args),
    hostOf(url) {
      try { return new URL(url, window.location.href).host; } catch (_) { return ''; }
    },
    async probeCors(url) {
      const host = net.hostOf(url);
      if (host in corsByHost) return corsByHost[host];
      try {
        const r = await net.fetch(url, { headers: { Range: 'bytes=0-1' }, credentials: 'omit', cache: 'no-store' });
        corsByHost[host] = true;
        try { await r.body?.cancel(); } catch (_) { }
      } catch (_) {
        corsByHost[host] = false;
      }
      S.log(`CORS ${host}: ${corsByHost[host] ? 'ok (direct)' : 'missing (proxy)'}`);
      return corsByHost[host];
    },
    async fetchBytes(url, { range = null, forceProxy = false, timeoutMs = 60000 } = {}) {
      const host = net.hostOf(url);
      if (!forceProxy && corsByHost[host] !== false) {
        try {
          const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined;
          const r = await net.fetch(url, { headers, credentials: 'omit' });
          corsByHost[host] = true;
          if (!r.ok) throw new HttpError(r.status);
          return { buffer: await r.arrayBuffer(), status: r.status, contentType: r.headers.get('content-type') || '', via: 'direct' };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          corsByHost[host] = false;
          S.log(`direct fetch blocked for ${host}; using proxy`);
        }
      }
      const res = await bridge.request('proxy-fetch', { url, range }, timeoutMs);
      if (!res.ok) throw new Error(res.error || `proxy HTTP ${res.status}`);
      return { buffer: res.buffer, status: res.status, contentType: res.contentType || '', via: 'proxy' };
    },
  };

  const REASONS = Object.freeze({
    OFF: 'PreGradien is off',
    AD: 'Ad active',
    WAITING: 'Waiting for playback',
    NO_WEBAUDIO: 'Web Audio is not available',
    LONG_MIX: 'Long mix (>25 min) — skipped',
    REPEAT_ONE: 'Repeat-one is on',
    NEXT_UNKNOWN: 'Next track unknown',
    DETECTING: 'Looking for the next track…',
  });

  function makeStatus(fields) {
    const f = fields || {};
    return {
      available: f.available !== false,
      reason: f.reason || null,
      phase: f.phase || machine.state,
      currentTitle: f.currentTitle || null,
      nextTitle: f.nextTitle || null,
      via: f.via || null,
      kind: f.kind || null,
      mode: f.mode || S.settings.handoffMode,
      mix: f.mix || null,
    };
  }

  Object.assign(S, { CHANNEL_TO_MAIN, CHANNEL_TO_ISO, DEFAULT_SETTINGS, REASONS, makeStatus, machine, bridge, net, HttpError });
  Object.defineProperty(window, '__SCXF__', { value: S, enumerable: false, configurable: false, writable: false });
})();
