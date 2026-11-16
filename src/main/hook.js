(() => {
  'use strict';
  const S = window.__SCXF__;
  if (!S || S.audio) return;

  const NativeAC = window.AudioContext || window.webkitAudioContext;
  const NativeAudio = window.Audio;

  const audio = {
    supported: !!NativeAC,
    ctx: null,
    gainA: null,
    gainB: null,
    filterA: null,
    filterB: null,
    a: null,
    blockReason: null,
    pageContexts: 0,
    own: new WeakSet(),
    captured: new WeakSet(),
    wired: new WeakMap(),
    pageWired: new WeakSet(),
    pending: new Set(),
  };
  S.audio = audio;

  if (!NativeAC) {
    audio.blockReason = 'Web Audio is not available';
    return;
  }

  try {
    const MS = window.MediaSession;
    const nativeSetHandler = MS && MS.prototype.setActionHandler;
    if (typeof nativeSetHandler === 'function') {
      MS.prototype.setActionHandler = function setActionHandler(action, handler) {
        let wrapped = handler;
        if (typeof handler === 'function') {
          wrapped = function mediaActionHandler(...args) {
            try { S.emit('media-action', action); } catch (_) { }
            return handler.apply(this, args);
          };
        }
        return nativeSetHandler.call(this, action, wrapped);
      };
    }
  } catch (e) {
    S.warn('could not patch MediaSession', e);
  }

  let internalWiring = false;
  const nativeCreateMES = NativeAC.prototype.createMediaElementSource;
  NativeAC.prototype.createMediaElementSource = function createMediaElementSource(el) {
    if (!internalWiring && el && audio.wired.has(el)) {
      S.warn('page tried to wire an element already routed by the extension');
    }
    const node = nativeCreateMES.call(this, el);
    if (!internalWiring && el) {
      audio.pageWired.add(el);
      try { adoptPageSource(this, el, node); } catch (e) { S.warn('could not adopt page source', e); }
    }
    return node;
  };

  function adoptPageSource(ctx, el, node) {
    if (!(el instanceof HTMLAudioElement) || audio.own.has(el) || audio.wired.has(el)) return;
    const g = ctx.createGain();
    if (audio.gainA) {
      try { g.gain.value = audio.gainA.gain.value; } catch (_) { }
    }
    const f = createBassShelf(ctx);
    const origConnect = node.connect.bind(node);
    origConnect(f);
    f.connect(g);
    node.connect = (dest, ...rest) => { g.connect(dest, ...rest); return dest; };
    node.disconnect = (...args) => { try { g.disconnect(...args); } catch (_) { } };
    audio.wired.set(el, node);
    audio.gainA = g;
    audio.filterA = f;
    audio.aCtx = ctx;
    audio.blockReason = null;
    S.log('A adopted from page graph: source -> lowshelfA -> gainA -> (page chain)');
    S.emit('wired', el);
  }

  class AudioContext extends NativeAC {
    constructor(...args) {
      super(...args);
      audio.pageContexts++;
    }
  }
  try {
    window.AudioContext = AudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = AudioContext;
  } catch (e) {
    S.warn('could not patch AudioContext constructor', e);
  }

  function createBassShelf(ctx) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowshelf';
    f.frequency.value = 160;
    f.gain.value = 0;
    return f;
  }

  audio.ensureContext = () => {
    if (audio.ctx) return audio.ctx;
    const ctx = new NativeAC({ latencyHint: 'playback' });
    const ownA = ctx.createGain();
    const ownFilterA = createBassShelf(ctx);
    audio.gainB = ctx.createGain();
    audio.filterB = createBassShelf(ctx);
    ownA.gain.value = 1;
    audio.gainB.gain.value = 0;
    ownFilterA.connect(ownA);
    ownA.connect(ctx.destination);
    audio.ownGainA = ownA;
    audio.ownFilterA = ownFilterA;
    if (!audio.gainA) {
      audio.gainA = ownA;
      audio.filterA = ownFilterA;
    }
    audio.filterB.connect(audio.gainB);
    audio.gainB.connect(ctx.destination);
    ctx.addEventListener('statechange', flushPending);
    audio.ctx = ctx;
    S.log('AudioContext created', ctx.sampleRate, 'Hz, state', ctx.state);
    return ctx;
  };

  audio.createSource = (el) => {
    internalWiring = true;
    try {
      return audio.ensureContext().createMediaElementSource(el);
    } finally {
      internalWiring = false;
    }
  };

  audio.createOwnAudio = () => {
    const el = new NativeAudio();
    audio.own.add(el);
    el.preload = 'auto';
    return el;
  };

  audio.isWired = (el) => !!el && audio.wired.has(el);

  function flushPending() {
    if (!audio.ctx || audio.ctx.state !== 'running') return;
    for (const el of [...audio.pending]) {
      audio.pending.delete(el);
      tryWire(el);
    }
  }

  const resumeCtx = () => {
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().then(flushPending, () => {});
  };
  window.addEventListener('pointerdown', resumeCtx, true);
  window.addEventListener('keydown', resumeCtx, true);

  const srcOf = (el) => el.currentSrc || el.src || '';

  function isSafeSource(el) {
    const src = srcOf(el);
    if (!src) return false;
    if (/^(blob|data|mediastream):/i.test(src)) return true;
    try {
      if (new URL(src, window.location.href).origin === window.location.origin) return true;
    } catch (_) {
      return false;
    }
    return el.crossOrigin !== null;
  }

  function wire(el) {
    if (audio.wired.has(el) || audio.pageWired.has(el)) return;
    try {
      const node = audio.createSource(el);
      node.connect(audio.ownFilterA || audio.ownGainA || audio.gainA);
      audio.wired.set(el, node);
      audio.blockReason = null;
      el.addEventListener('loadstart', () => {
        if (srcOf(el) && !isSafeSource(el)) {
          audio.blockReason = 'Cross-origin media without CORS';
          S.warn('A switched to a non-CORS source after wiring; output may be silent');
        }
      });
      S.log('A wired: source -> lowshelfA -> gainA -> destination');
      S.emit('wired', el);
    } catch (e) {
      audio.pageWired.add(el);
      audio.blockReason = 'Audio element already routed elsewhere';
      S.warn('could not wire A', e);
    }
  }

  function tryWire(el) {
    if (audio.wired.has(el) || audio.pageWired.has(el)) return;
    if (S.queue && S.queue.isAdActive(el)) return;
    if (!srcOf(el)) return;
    if (!isSafeSource(el)) {
      audio.blockReason = 'Cross-origin media without CORS';
      return;
    }
    const ctx = audio.ensureContext();
    if (ctx.state === 'running') {
      wire(el);
    } else {
      audio.pending.add(el);
      ctx.resume().then(flushPending, () => {});
    }
  }

  function onPagePlay(el) {
    if (!(el instanceof HTMLAudioElement) || audio.own.has(el)) return;
    capture(el);
    if (audio.a !== el) {
      audio.a = el;
      S.emit('a-changed', el);
    }
    tryWire(el);
  }

  function capture(el) {
    if (!el || audio.own.has(el) || audio.captured.has(el)) return;
    audio.captured.add(el);
    el.addEventListener('play', () => onPagePlay(el));
    el.addEventListener('playing', () => onPagePlay(el));
  }

  function noticeLate(el) {
    if (!(el instanceof HTMLAudioElement) || audio.own.has(el)) return;
    capture(el);
    if (!el.paused) onPagePlay(el);
  }

  try {
    window.Audio = function Audio(src) {
      const el = src === undefined ? new NativeAudio() : new NativeAudio(src);
      capture(el);
      return el;
    };
    window.Audio.prototype = NativeAudio.prototype;
  } catch (e) {
    S.warn('could not patch Audio constructor', e);
  }

  const nativeCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function createElement(...args) {
    const el = nativeCreateElement.apply(this, args);
    if (el instanceof HTMLAudioElement) capture(el);
    return el;
  };

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    try {
      if (this instanceof HTMLAudioElement && !audio.own.has(this)) onPagePlay(this);
    } catch (e) {
      S.warn('play hook failed', e);
    }
    return nativePlay.apply(this, args);
  };

  const notAudio = new WeakSet();
  const ctDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  if (ctDesc && ctDesc.get && ctDesc.set && ctDesc.configurable) {
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      enumerable: ctDesc.enumerable,
      get() {
        const v = ctDesc.get.call(this);
        if (!audio.captured.has(this) && !audio.own.has(this) && !notAudio.has(this)) {
          if (this instanceof HTMLAudioElement) {
            try { noticeLate(this); } catch (_) { }
          } else {
            notAudio.add(this);
          }
        }
        return v;
      },
      set(v) { ctDesc.set.call(this, v); },
    });
  }

  function scan(root) {
    if (!root) return;
    if (root instanceof HTMLAudioElement) { noticeLate(root); return; }
    if (root.getElementsByTagName) for (const el of root.getElementsByTagName('audio')) noticeLate(el);
  }

  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'AUDIO' || node.firstElementChild) scan(node);
      }
    }
  });
  domObserver.observe(document, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  } else {
    scan(document);
  }
})();
