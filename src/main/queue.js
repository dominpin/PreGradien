(() => {
  'use strict';
  const S = window.__SCXF__;
  if (!S || S.queue) return;

  const CONFIG = {
    clientId: null,
    apiOrigin: 'https://api-v2.soundcloud.com',
    apiHost: 'api-v2.soundcloud.com',
    siteOrigin: 'https://soundcloud.com',
    mediaHostSuffixes: ['.sndcdn.com', '.soundcloud.cloud'],
    hlsMimePreference: [/^audio\/mpeg/i, /^audio\/mp4/i],
    defaultMp4Codecs: 'audio/mp4; codecs="mp4a.40.2"',
    queuePeekTimeoutMs: 3000,
    queuePeekSettleMs: 350,
    queuePeekQuietMs: 250,
    confirmedReuseMs: 5000,
    maxTrackSeconds: 25 * 60,
    maxJsonChars: 8000000,
    maxContexts: 40,
    maxTracks: 3000,
    adMetaWindowMs: 60000,
    adUrlPattern: /\/(audio-ads?|ads|adswizz|promoted\/audio)(\/|\?|$)/i,
    adKindPattern: /(^|_)ads?($|_)/i,
    adTextPattern: /\b(advertisement|sponsored)\b/i,
    reservedRoots: [
      'you', 'discover', 'stream', 'stations', 'charts', 'upload', 'search', 'settings',
      'notifications', 'messages', 'pages', 'people', 'tags', 'jobs', 'terms-of-use', 'imprint',
      'creators', 'pro', 'go', 'artists', 'signin', 'logout', 'feed', 'home', 'mobile', 'apps',
      'premium', 'community-guidelines', 'popular', 'playlists',
    ],
    profileSubpages: [
      'tracks', 'albums', 'sets', 'reposts', 'likes', 'followers', 'following',
      'popular-tracks', 'comments', 'spotlight', 'toptracks', 'recommended',
    ],
    selectors: {
      playControls: '.playControls',
      currentTitleLink: '.playbackSoundBadge__titleLink',
      currentTrackScopes: ['.playbackSoundBadge', '.playControls'],
      soundBadge: '.playbackSoundBadge',
      nextButton: '.skipControl__next',
      prevButton: '.skipControl__previous',
      shuffleActive: '.shuffleControl.m-shuffling',
      repeatOneActive: '.repeatControl.m-one',
      queueToggle: '.playbackSoundBadge__showQueue, [title="Next up" i], [aria-label="Next up" i]',
      queueContainer: '.queue',
      queueOpenClass: 'm-visible',
      queueItems: '.queue__itemsContainer',
      queueRow: '.queue__itemWrapper',
      queueRowView: '.queueItemView',
      queueActiveItem: '.m-active, .m-playing, [aria-current]:not([aria-current="false"])',
      queuePlayingItem: '.m-playing',
      queueHistoryItem: '.m-dimmed',
      adIndicators: [
        '.playControls .playbackSoundBadge__adBadge',
        '.playControls .audibleAd',
        '.playControls [class*="adBadge" i]',
        '.playControls [class*="AdLabel" i]',
        '.playControls__ad',
      ],
    },
  };

  const SEL = CONFIG.selectors;
  const tracks = new Map();
  const byPath = new Map();
  const contexts = [];
  const RESERVED = new Set(CONFIG.reservedRoots);
  const SUBPAGES = new Set(CONFIG.profileSubpages);
  let capturedClientId = null;
  let adMetaAt = 0;

  function toUrl(raw) {
    try { return new URL(raw, window.location.href); } catch (_) { return null; }
  }
  function pathOf(raw) {
    const u = raw ? toUrl(raw) : null;
    if (!u) return null;
    let p = u.pathname.replace(/\/+$/, '');
    try { p = decodeURIComponent(p); } catch (_) { }
    return p.toLowerCase() || null;
  }
  function isTrackPath(p) {
    const m = /^\/([^/]+)\/([^/]+)$/.exec(p || '');
    return !!m && !RESERVED.has(m[1]) && !SUBPAGES.has(m[2]);
  }
  function isApi(raw) {
    const u = toUrl(raw);
    return !!u && u.host === CONFIG.apiHost;
  }
  function isMediaHost(raw) {
    const u = toUrl(raw);
    return !!u && u.protocol === 'https:' && CONFIG.mediaHostSuffixes.some((s) => u.hostname.endsWith(s));
  }
  const getClientId = () => CONFIG.clientId || capturedClientId;

  function noteUrl(raw) {
    const u = raw ? toUrl(raw) : null;
    if (!u || u.host !== CONFIG.apiHost) return;
    const cid = u.searchParams.get('client_id');
    if (cid && cid !== capturedClientId) {
      capturedClientId = cid;
      S.log('client_id captured');
    }
  }

  function markAdMeta(why) {
    adMetaAt = Date.now();
    S.log('ad metadata seen:', why);
  }

  function storeTrack(t) {
    const prev = tracks.get(t.id);
    const merged = prev ? { ...prev } : {};
    for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== null) merged[k] = v;
    if (prev) tracks.delete(t.id);
    tracks.set(t.id, merged);
    const p = pathOf(merged.permalink_url);
    if (p) byPath.set(p, t.id);
    if (tracks.size > CONFIG.maxTracks) tracks.delete(tracks.keys().next().value);
  }

  function trackOf(x) {
    if (!x || typeof x !== 'object') return null;
    if (x.kind === 'track' && x.id != null) return x;
    if (x.track && typeof x.track === 'object' && x.track.kind === 'track' && x.track.id != null) return x.track;
    return null;
  }

  const sameEntry = (a, b) => (a.id != null && a.id === b.id) || (!!a.path && a.path === b.path);

  const NON_ORDER = /^\/tracks\/?$|play-history|\/history\b|\/activities|\/comments|\/likers|\/favoriters|\/reposters/i;

  function pushContext(entries, key) {
    if (NON_ORDER.test(String(key || ''))) return;
    const last = contexts[contexts.length - 1];
    if (last && last.entries.length === entries.length && last.entries.every((e, i) => sameEntry(e, entries[i]))) {
      last.at = Date.now();
      return;
    }
    contexts.push({ entries, key, at: Date.now() });
    if (contexts.length > CONFIG.maxContexts) contexts.shift();
  }

  function appendContext(entries, key) {
    if (NON_ORDER.test(String(key || ''))) return;
    for (let i = contexts.length - 1; i >= 0; i--) {
      const c = contexts[i];
      if (c.key !== key) continue;
      for (const e of entries) if (!c.entries.some((x) => sameEntry(x, e))) c.entries.push(e);
      c.at = Date.now();
      contexts.splice(i, 1);
      contexts.push(c);
      return;
    }
    pushContext(entries, key);
  }

  function walk(node, depth, src) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const entries = [];
      for (const el of node) {
        const t = trackOf(el);
        if (t) entries.push({ id: t.id, path: pathOf(t.permalink_url) });
      }
      if (entries.length >= 2 || (entries.length && node === src.root && src.append)) {
        if (node === src.root && src.append) appendContext(entries, src.key);
        else pushContext(entries, src.key);
      }
      for (const el of node) walk(el, depth + 1, src);
      return;
    }
    if (typeof node.kind === 'string' && CONFIG.adKindPattern.test(node.kind)) markAdMeta(`kind=${node.kind}`);
    if (node.kind === 'track' && node.id != null) storeTrack(node);
    for (const key in node) {
      const v = node[key];
      if (v && typeof v === 'object') walk(v, depth + 1, src);
    }
  }

  function ingest(json, url) {
    if (!json || typeof json !== 'object') return;
    const u = toUrl(url);
    if (u && CONFIG.adUrlPattern.test(u.pathname)) {
      const nonEmpty = Array.isArray(json)
        ? json.length > 0
        : Object.values(json).some((v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object'));
      if (nonEmpty) markAdMeta(`api ${u.pathname}`);
    }
    const offset = u ? u.searchParams.get('offset') || u.searchParams.get('cursor') : null;
    walk(json, 0, {
      key: u ? u.pathname : String(url || ''),
      root: Array.isArray(json.collection) ? json.collection : null,
      append: !!offset && offset !== '0',
    });
  }

  function ingestText(text, url) {
    if (typeof text !== 'string' || !text || text.length > CONFIG.maxJsonChars) return;
    const c = text.charCodeAt(0);
    if (c !== 123 && c !== 91) return;
    try { ingest(JSON.parse(text), url); } catch (_) { }
  }

  function readHydration() {
    const h = window.__sc_hydration;
    if (!Array.isArray(h)) return;
    for (const entry of h) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.hydratable === 'apiClient' && entry.data && entry.data.id && !capturedClientId) {
        capturedClientId = String(entry.data.id);
        S.log('client_id read from hydration');
      }
      if (entry.data && typeof entry.data === 'object') {
        walk(entry.data, 0, { key: `hydration:${entry.hydratable || '?'}`, root: null, append: false });
      }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readHydration, { once: true });
  } else {
    readHydration();
  }

  const pageFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      noteUrl(url);
    } catch (_) { }
    const p = pageFetch.apply(window, arguments);
    if (url && isApi(url)) {
      p.then((res) => {
        if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) return undefined;
        return res.clone().text().then((t) => ingestText(t, url));
      }).catch(() => {});
    }
    return p;
  };

  const xhrUrls = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    try {
      const s = String(url);
      xhrUrls.set(this, s);
      noteUrl(s);
    } catch (_) { }
    return nativeOpen.call(this, method, url, ...rest);
  };

  function onXhrLoad() {
    try {
      if (this.status < 200 || this.status >= 300) return;
      const url = xhrUrls.get(this);
      const rt = this.responseType;
      if (rt === '' || rt === 'text') ingestText(this.responseText, url);
      else if (rt === 'json') ingest(this.response, url);
    } catch (_) { }
  }

  XMLHttpRequest.prototype.send = function send(...args) {
    try {
      const url = xhrUrls.get(this);
      if (url && isApi(url)) this.addEventListener('load', onXhrLoad);
    } catch (_) { }
    return nativeSend.apply(this, args);
  };

  async function apiGet(pathOrUrl, params = {}) {
    const cid = getClientId();
    if (!cid) throw new Error('client_id not captured yet');
    const u = new URL(pathOrUrl, CONFIG.apiOrigin);
    if (u.host !== CONFIG.apiHost) throw new Error('refusing non-api-v2 request');
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    u.searchParams.set('client_id', cid);
    const res = await S.net.fetch(u.href, { credentials: 'omit' });
    if (!res.ok) throw new Error(`api-v2 ${u.pathname} -> HTTP ${res.status}`);
    const json = await res.json();
    ingest(json, u.href);
    return json;
  }

  async function resolvePath(path) {
    const json = await apiGet('/resolve', { url: CONFIG.siteOrigin + path });
    return json && json.kind === 'track' ? tracks.get(json.id) || json : null;
  }

  async function hydrate(id) {
    const t = tracks.get(id);
    if (t && t.permalink_url && t.media && Array.isArray(t.media.transcodings)) return t;
    await apiGet('/tracks', { ids: id });
    const full = tracks.get(id);
    if (!full || !full.media) throw new Error(`could not load metadata for track ${id}`);
    return full;
  }

  const linkPath = (a) => pathOf(a.getAttribute('href'));

  function queueContainer() {
    return document.querySelector(SEL.queueContainer);
  }

  function currentPath() {
    const bar = document.querySelector(SEL.playControls) || document;
    const title = bar.querySelector(SEL.currentTitleLink);
    const p = title ? linkPath(title) : null;
    if (p && isTrackPath(p)) return p;
    const queue = queueContainer();
    for (const scopeSel of SEL.currentTrackScopes) {
      const scope = document.querySelector(scopeSel);
      if (!scope) continue;
      for (const a of scope.querySelectorAll('a[href]')) {
        if (queue && queue.contains(a)) continue;
        const q = linkPath(a);
        if (q && isTrackPath(q)) return q;
      }
    }
    return null;
  }

  function currentTrack() {
    const p = currentPath();
    const id = p ? byPath.get(p) : null;
    return id != null ? tracks.get(id) || null : null;
  }

  function currentTitle() {
    const t = currentTrack();
    if (t && t.title) return t.title;
    const a = document.querySelector(SEL.currentTitleLink);
    if (!a) return null;
    return (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim() || null;
  }
  const isShuffle = () => !!document.querySelector(SEL.shuffleActive);
  const isRepeatOne = () => !!document.querySelector(SEL.repeatOneActive);

  function clickNext() {
    const btn = document.querySelector(SEL.nextButton);
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    btn.click();
    return true;
  }

  function findQueueToggle() {
    const bar = document.querySelector(SEL.playControls);
    if (!bar) return null;
    const queue = queueContainer();
    for (const el of bar.querySelectorAll(SEL.queueToggle)) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`;
      if (/\b(add|play next|remove|clear)\b/i.test(label)) continue;
      if (queue && queue.contains(el)) continue;
      return el;
    }
    return null;
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
    let opacity = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none') return false;
      opacity *= Number(cs.opacity);
      if (opacity <= 0.05) return false;
    }
    return getComputedStyle(el).visibility !== 'hidden';
  }

  function queueOpenState() {
    const c = queueContainer();
    if (!c) return false;
    if (c.classList.contains(SEL.queueOpenClass)) return true;
    const toggle = findQueueToggle();
    const aria = toggle && toggle.getAttribute('aria-expanded');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    return onScreen(c) ? null : false;
  }

  function transformY(row) {
    const st = (row.style && row.style.transform) || row.getAttribute('style') || '';
    const m = /translate(?:3d|Y)?\(\s*(?:(-?[\d.]+)px\s*,\s*)?(-?[\d.]+)px/i.exec(st);
    return m ? parseFloat(m[2]) : null;
  }

  function queueRows(container = queueContainer()) {
    if (!container) return [];
    const box = container.querySelector(SEL.queueItems);
    if (!box) return [];
    const els = [...box.querySelectorAll(SEL.queueRow)];
    const ys = els.map(transformY);
    const useRect = ys.some((y) => y == null);
    const rows = els.map((row, i) => {
      const view = row.querySelector(SEL.queueRowView) || row;
      const link = [...row.querySelectorAll('a[href]')].find((a) => isTrackPath(linkPath(a)));
      return {
        y: useRect ? row.getBoundingClientRect().top : ys[i],
        path: link ? linkPath(link) : null,
        active: view.matches(SEL.queueActiveItem) || row.matches(SEL.queueActiveItem),
        playing: view.matches(SEL.queuePlayingItem),
        history: view.matches(SEL.queueHistoryItem),
      };
    });
    return rows.sort((a, b) => a.y - b.y);
  }

  function domNextPath(cur) {
    if (!cur || queueOpenState() !== true) return null;
    const rows = queueRows();
    if (rows.length < 2) return null;
    const atY = (y) => rows.filter((r) => Math.abs(r.y - y) < 0.5);
    const below = (r) => {
      const n = rows.find((x) => x.y > r.y + 0.5);
      if (!n) return null;
      return atY(n.y).every((x) => x.path === n.path) ? n : null;
    };
    const actives = rows.filter((r) => r.active);
    let idx = -1;
    if (actives.length && actives.every((r) => r.path === cur)) {
      let cands = actives;
      if (cands.length > 1 && cands.filter((r) => r.playing).length === 1) cands = cands.filter((r) => r.playing);
      if (cands.length > 1) {
        cands = cands.filter((r) => {
          const n = below(r);
          return n && !n.history;
        });
      }
      if (cands.length !== 1) {
        S.log(`queue: ${actives.length} rows of ${cur} look active; can't tell which is playing`);
        return null;
      }
      idx = rows.indexOf(cands[0]);
    } else if (actives.length) {
      S.log(`queue: active row(s) ${actives.map((r) => r.path).join(', ')} vs player ${cur}; skipping`);
      return null;
    } else {
      const cands = rows.filter((r) => r.path === cur && !r.history);
      if (cands.length !== 1) return null;
      idx = rows.indexOf(cands[0]);
    }
    const act = rows[idx];
    if (atY(act.y).some((r) => r.path !== act.path)) return null;
    const next = below(act);
    if (!next || !next.path || next.history || next.active) return null;
    let h = Infinity;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].y - rows[i - 1].y;
      if (d > 0.5 && d < h) h = d;
    }
    if (Number.isFinite(h) && next.y - act.y > 1.5 * h) return null;
    if (next.path === cur) return null;
    return next.path;
  }

  async function confirmNext() {
    const cur = currentPath();
    if (!cur) return null;
    return domNextPath(cur) || (await peekQueue(cur));
  }

  function resetPeekBudget() {
    const cur = currentPath();
    if (cur) peekedFor.delete(cur);
    lastNext = { ...lastNext, confirmed: false, at: 0 };
  }

  let peeking = false;
  async function peekQueue(cur) {
    for (let waited = 0; peeking && waited < CONFIG.queuePeekTimeoutMs + 1000; waited += 100) await S.sleep(100);
    const direct = domNextPath(cur);
    if (direct || peeking) return direct;
    if (queueOpenState() === true) return null;
    const toggle = findQueueToggle();
    if (!toggle) return null;
    peeking = true;
    const style = document.createElement('style');
    style.textContent = `${SEL.queueContainer}{opacity:0!important;pointer-events:none!important;transition:none!important;animation:none!important}`;
    (document.head || document.documentElement).append(style);
    const focused = document.activeElement;
    let next = null;
    let lastMutation = performance.now();
    const box = (queueContainer() || document).querySelector(SEL.queueItems);
    const mo = box ? new MutationObserver(() => { lastMutation = performance.now(); }) : null;
    if (mo) mo.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    try {
      toggle.click();
      const opened = performance.now();
      lastMutation = opened;
      const deadline = opened + CONFIG.queuePeekTimeoutMs;
      await S.sleep(CONFIG.queuePeekSettleMs);
      let prev = null;
      while (!next && performance.now() < deadline) {
        if (performance.now() - lastMutation >= CONFIG.queuePeekQuietMs) {
          const read = domNextPath(cur);
          if (read && read === prev) next = read;
          prev = read;
        }
        if (!next) await S.sleep(100);
      }
    } finally {
      if (mo) mo.disconnect();
      const closer = findQueueToggle() || toggle;
      if (queueOpenState() !== false) closer.click();
      if (focused && typeof focused.focus === 'function') focused.focus({ preventScroll: true });
      setTimeout(() => { style.remove(); peeking = false; }, 500);
    }
    S.log('queue peek:', next || 'nothing found');
    return next;
  }

  function isAdActive(aEl) {
    for (const sel of SEL.adIndicators) {
      try { if (document.querySelector(sel)) return true; } catch (_) { }
    }
    const badge = document.querySelector(SEL.soundBadge);
    if (badge && CONFIG.adTextPattern.test(badge.textContent || '')) return true;
    if (aEl) {
      const src = aEl.currentSrc || aEl.src || '';
      if (src && !/^blob:/i.test(src) && !isMediaHost(src)) return true;
    }
    return Date.now() - adMetaAt < CONFIG.adMetaWindowMs;
  }

  function describe(t) {
    return {
      id: t.id,
      path: pathOf(t.permalink_url),
      title: t.title || String(t.id),
      durationSec: (t.full_duration || t.duration || 0) / 1000,
      raw: t,
    };
  }

  const GUESS_LIST = /\/(related|stations?|recommended|recommendations|mixed-selections|personalized|discover|suggested)(\/|$)|station/i;
  const isGuessList = (key) => GUESS_LIST.test(String(key || ''));

  function contextNext(curId, cur) {
    const isCur = (e) => (curId != null && e.id === curId) || (!!e.path && e.path === cur);
    let guess = null;
    for (let i = contexts.length - 1; i >= 0; i--) {
      const { entries, key } = contexts[i];
      const idx = entries.findIndex(isCur);
      if (idx < 0) continue;
      let hit = null;
      for (let j = idx + 1; j < entries.length && !hit; j++) {
        if (!isCur(entries[j])) hit = { entry: entries[j], key, guess: isGuessList(key) };
      }
      if (!hit) continue;
      if (!hit.guess) return hit;
      if (!guess) guess = hit;
    }
    return guess;
  }

  function hasPlaybackContext(curId, cur) {
    const isCur = (e) => (curId != null && e.id === curId) || (!!e.path && e.path === cur);
    return contexts.some((c) => !isGuessList(c.key) && c.entries.some(isCur));
  }

  const titleFromPath = (p) => (p ? p.split('/').pop().replace(/-/g, ' ') : null);

  let lastNext = { forPath: null, title: null, via: null, error: null, at: 0 };
  const MAX_PEEKS = 6;
  const peekedFor = new Map();
  const peeksLeft = (cur) => MAX_PEEKS - (peekedFor.get(cur) || 0);

  class NextPending extends Error {
    constructor(msg) { super(msg); this.name = 'NextPending'; this.retryable = true; }
  }

  async function detectNext({ allowPeek = true } = {}) {
    const cur = currentPath();
    try {
      if (!cur) throw new Error('No current track in the player');
      if (isRepeatOne()) throw new Error('Repeat-one is on');

      let curId = byPath.get(cur);
      if (curId == null && getClientId()) {
        try { curId = (await resolvePath(cur))?.id ?? null; } catch (e) { S.log('resolve current failed', e.message); }
      }

      let id = null;
      let path = domNextPath(cur);
      if (!path && lastNext.confirmed && lastNext.forPath === cur && lastNext.path
        && Date.now() - lastNext.at < CONFIG.confirmedReuseMs) {
        path = lastNext.path;
      }
      if (!path && allowPeek && peeksLeft(cur) > 0) {
        if (peekedFor.size > 200) peekedFor.clear();
        peekedFor.set(cur, (peekedFor.get(cur) || 0) + 1);
        path = await peekQueue(cur);
      }
      const confirmed = !!path;
      let via = confirmed ? 'queue panel' : null;
      let guess = false;
      if (!path && !isShuffle()) {
        const hit = contextNext(curId, cur);
        if (hit) {
          id = hit.entry.id ?? null;
          path = hit.entry.path || null;
          guess = hit.guess;
          via = `api ${hit.key}${guess ? ' (guess)' : ''}`;
        }
      }
      if (id == null && path) {
        id = byPath.get(path) ?? null;
        if (id == null && getClientId()) id = (await resolvePath(path).catch(() => null))?.id ?? null;
      }
      if (id == null && !path) throw new Error(isShuffle() ? 'Next track unknown (shuffle: Next up queue not readable)' : 'Next track unknown');
      const t = id != null ? tracks.get(id) : null;
      if (!path && t) path = pathOf(t.permalink_url);
      const contextual = hasPlaybackContext(curId, cur);
      const result = { cur, id, path, title: (t && t.title) || titleFromPath(path), via, confirmed, guess, contextual };
      lastNext = { forPath: cur, title: result.title, path, via, confirmed, error: null, at: Date.now() };
      return result;
    } catch (e) {
      lastNext = { forPath: cur, title: null, via: null, error: e.message || String(e), at: Date.now() };
      throw e;
    }
  }

  async function getNextTrack() {
    let found = null;
    try {
      found = await detectNext({ allowPeek: true });
    } catch (e) {
      if (/repeat-one|no current track/i.test((e && e.message) || '')) throw e;
    }
    if (!found || !found.confirmed) {
      const cur = currentPath();
      if (cur && peeksLeft(cur) > 0) throw new NextPending('Waiting to confirm the next track in the Next up queue');
      throw new Error('Next track not confirmed by the Next up queue');
    }
    if (found.id == null) throw new Error('Next track unknown (no client_id to look it up yet)');
    const t = describe(await hydrate(found.id));
    t.via = found.via;
    t.confirmed = found.confirmed;
    lastNext = { forPath: found.cur, title: t.title, path: t.path, via: found.via, confirmed: true, error: null, at: Date.now() };
    S.log(`next track (${found.via}):`, t.title);
    return t;
  }

  async function streamEndpoint(track, tc) {
    const json = await apiGet(tc.url, { track_authorization: track.track_authorization || null });
    if (!json || !json.url || !isMediaHost(json.url)) throw new Error('Stream endpoint returned no media URL');
    return json.url;
  }

  function mseMime(mime) {
    if (typeof MediaSource === 'undefined') return null;
    let m = String(mime || '').trim();
    if (/^audio\/mpeg/i.test(m)) m = 'audio/mpeg';
    else if (/^audio\/mp4/i.test(m) && !/codecs=/i.test(m)) m = CONFIG.defaultMp4Codecs;
    return MediaSource.isTypeSupported(m) ? m : null;
  }

  function parseM3u8(text, baseUrl) {
    const out = { segments: [], variants: [], init: null, encrypted: false };
    let duration = null;
    let variantNext = false;
    let mediaSeq = 0;
    let currentKey = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) { duration = parseFloat(line.slice(8)); continue; }
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSeq = parseInt(line.split(':')[1], 10) || 0;
        continue;
      }
      if (line.startsWith('#EXT-X-KEY:')) {
        const mMethod = /METHOD=([^,\s]+)/.exec(line);
        const method = mMethod ? mMethod[1] : 'NONE';
        if (method === 'NONE') {
          currentKey = null;
        } else {
          const mUri = /URI="([^"]+)"/.exec(line);
          const mIv = /IV=0x([0-9a-fA-F]+)/i.exec(line);
          currentKey = {
            method,
            uri: mUri ? new URL(mUri[1], baseUrl).href : null,
            iv: mIv ? mIv[1] : null,
          };
          out.encrypted = true;
        }
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const m = /URI="([^"]+)"/.exec(line);
        if (m) out.init = new URL(m[1], baseUrl).href;
        continue;
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) { variantNext = true; continue; }
      if (line.startsWith('#')) continue;
      const abs = new URL(line, baseUrl).href;
      if (variantNext) {
        out.variants.push(abs);
        variantNext = false;
      } else {
        out.segments.push({
          url: abs,
          duration: Number.isFinite(duration) ? duration : 0,
          key: currentKey ? { ...currentKey } : null,
          seq: mediaSeq + out.segments.length,
        });
        duration = null;
      }
    }
    return out;
  }

  async function fetchPlaylist(url) {
    const { buffer } = await S.net.fetchBytes(url);
    return parseM3u8(new TextDecoder().decode(buffer), url);
  }

  async function resolveHls(track, tc, mime) {
    const playlistUrl = await streamEndpoint(track, tc);
    let pl = await fetchPlaylist(playlistUrl);
    if (!pl.segments.length && pl.variants.length) pl = await fetchPlaylist(pl.variants[0]);
    if (!pl.segments.length) throw new Error('HLS playlist has no segments');
    const urls = pl.segments.map((s) => s.url).concat(pl.init ? [pl.init] : []);
    if (!urls.every(isMediaHost)) throw new Error('HLS segments on an unexpected host');
    const durationSec = pl.segments.reduce((sum, s) => sum + s.duration, 0);
    return { kind: 'hls', mime, playlistUrl, init: pl.init, segments: pl.segments, durationSec };
  }

  async function resolveStream(track) {
    if (track.policy === 'BLOCK' || track.policy === 'SNIP') throw new Error(`Next track not fully playable (${track.policy})`);
    const all = ((track.media && track.media.transcodings) || []).filter((tc) => tc && tc.url && tc.format && !tc.snipped);
    let lastErr = null;

    const progressive = all.filter((tc) => tc.format.protocol === 'progressive');
    if (progressive.length) {
      const tc = progressive.find((x) => /mpeg/i.test(x.format.mime_type || '')) || progressive[0];
      try {
        return { kind: 'progressive', url: await streamEndpoint(track, tc), mime: tc.format.mime_type || 'audio/mpeg' };
      } catch (e) {
        lastErr = e;
        S.log('progressive failed, trying HLS:', e.message);
      }
    }

    const hls = all.filter((tc) => tc.format.protocol === 'hls');
    const rank = (tc) => {
      const i = CONFIG.hlsMimePreference.findIndex((re) => re.test(tc.format.mime_type || ''));
      return i < 0 ? Infinity : i;
    };
    for (const tc of hls.filter((x) => rank(x) !== Infinity).sort((x, y) => rank(x) - rank(y))) {
      const mime = mseMime(tc.format.mime_type);
      if (!mime) continue;
      try {
        return await resolveHls(track, tc, mime);
      } catch (e) {
        lastErr = e;
        S.log(`HLS ${tc.format.mime_type} failed:`, e.message);
      }
    }
    if (lastErr) throw lastErr;
    if (all.some((tc) => /encrypted/i.test(tc.format.protocol || ''))) throw new Error('DRM-only stream');
    throw new Error('No playable stream for the next track');
  }

  S.queue = {
    config: CONFIG,
    getClientId,
    currentPath,
    currentTrack,
    currentTitle,
    detectNext,
    get lastNext() { return { ...lastNext }; },
    getNextTrack,
    isTrackPath,
    domNextPath,
    confirmNext,
    resetPeekBudget,
    queueRows: () => queueRows(),
    resolveStream,
    parseM3u8,
    isMediaHost,
    isAdActive,
    isShuffle,
    isRepeatOne,
    clickNext,
    pathOf,
    stats: () => ({ tracks: tracks.size, contexts: contexts.length, hasClientId: !!getClientId(), adMetaAgeMs: adMetaAt ? Date.now() - adMetaAt : null }),
  };
})();
