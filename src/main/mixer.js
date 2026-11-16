(() => {
  'use strict';
  const S = window.__SCXF__;
  if (!S || S.mixer || !S.audio || !S.queue || !S.silence) return;

  const M = S.machine;
  const Q = S.queue;
  const AU = S.audio;

  const TUNING = Object.freeze({
    tickMs: 100,
    preloadLeadSec: 25,
    lateMinRemainingSec: 1.2,
    lateLoadAllowanceSec: 1,
    naturalEndSec: 1,
    endGuardSec: 0.25,
    microFadeSec: 0.08,
    seekLeadSec: 0.12,
    maxLeadSec: 0.6,
    alignToleranceSec: 0.02,
    alignAttempts: 2,
    driftSamples: 5,
    navTimeoutMs: 8000,
    seekTimeoutMs: 5000,
    bLoadTimeoutMs: 20000,
    keepResyncSec: 0.35,
    keepResyncCooldownMs: 1000,
    aSettleMs: 250,
    syncVerifyMs: 600,
    syncSlackSec: 1,
    syncAttempts: 3,
    curvePoints: 256,
    hlsPrebufferExtraSec: 15,
    hlsBufferAheadSec: 30,
    hlsKeepBehindSec: 10,
    segmentRetries: 2,
    nextRetryMs: 3000,
    pauseConfirmMs: 350,
    userIntentMs: 1500,
    confirmLeadSec: 5,
    analysisSec: 20,
    analysisTailSec: 22,
    analysisHeadSec: 24,
    analysisHeadBytes: 420 * 1024,
    analysisMaxBytes: 2 * 1024 * 1024,
    progressiveBytesPerSec: 16000,
    tailSlackBytes: 4 * 1024 * 1024,
    beatLookaheadSec: 1.5,
    beatMinLeadSec: 0.2,
    bassCutDb: -20,
    rateRestoreSec: 2,
    pllTauSec: 1,
    pllMaxCorr: 0.03,
    pllSeekSec: 0.03,
    pllLostSec: 0.25,
    loudMinDb: -6,
    loudMaxDb: 5,
    trimRestoreSec: 3.5,
  });

  const makeCurve = (fn, end, u0 = 0) => {
    const n = TUNING.curvePoints;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = fn(u0 + ((1 - u0) * i) / (n - 1));
    c[n - 1] = end;
    return c;
  };
  const fadeOutFn = (t) => Math.cos((t * Math.PI) / 2);
  const fadeInFn = (t) => Math.sin((t * Math.PI) / 2);
  const FADE_OUT = makeCurve(fadeOutFn, 0);
  const FADE_IN = makeCurve(fadeInFn, 1);

  class Cancelled extends Error {}
  class AdInterrupt extends Error {}
  class SeekTimeout extends Error {}

  let bEl = null;
  let b = null;
  let job = null;
  let selfNav = false;
  let selfSeek = false;
  let keepMode = false;
  let keepClosing = false;
  let lastKey = null;
  let lastAd = false;
  let failure = null;
  let attachedA = null;
  let seekToken = 0;
  let lastKeepResyncAt = -Infinity;
  let lastUserInputAt = -Infinity;
  let spuriousRewinds = 0;
  let learnedLeadSec = TUNING.seekLeadSec;
  let fadeRemaining = Infinity;
  let recheckAt = 0;
  let rechecking = false;
  let retryPreloadAt = 0;
  let deferredKey = null;
  let lastShuffle = null;
  let aTail = null;
  let sync = null;
  let fadeMix = null;
  let fadeRun = null;
  let frozen = null;
  let loudTrim = 1;
  let loudTrimDb = 0;
  let trimRestoreUntil = 0;

  const guard = (epoch) => { if (M.epoch !== epoch) throw new Cancelled(); };

  async function waitFor(pred, timeoutMs, epoch, stepMs = 50) {
    const end = performance.now() + timeoutMs;
    for (;;) {
      if (epoch !== undefined) guard(epoch);
      const v = pred();
      if (v) return v;
      if (performance.now() >= end) return null;
      await S.sleep(stepMs);
    }
  }

  function waitEvent(el, type, timeoutMs, epoch) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      let poll = 0;
      const done = (fn, v) => {
        clearTimeout(timer);
        clearInterval(poll);
        el.removeEventListener(type, onOk);
        el.removeEventListener('error', onErr);
        fn(v);
      };
      const onOk = () => done(resolve, true);
      const onErr = () => done(reject, new Error(`media error ${(el.error && el.error.code) || ''}`.trim()));
      el.addEventListener(type, onOk);
      el.addEventListener('error', onErr);
      timer = setTimeout(() => done(resolve, false), timeoutMs);
      if (epoch !== undefined) poll = setInterval(() => { if (M.epoch !== epoch) done(reject, new Cancelled()); }, 100);
    });
  }

  function durationOf(a) {
    if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    const t = Q.currentTrack();
    return t ? (t.full_duration || t.duration || 0) / 1000 : NaN;
  }

  function computeLoudTrim() {
    const la = aTail && aTail.status === 'ok' && aTail.res ? aTail.res.loudnessDb : null;
    const lb = b ? b.loudnessDb : null;
    const db = Number.isFinite(la) && Number.isFinite(lb)
      ? Math.min(TUNING.loudMaxDb, Math.max(TUNING.loudMinDb, la - lb))
      : 0;
    loudTrimDb = db;
    loudTrim = Math.pow(10, db / 20);
    trimRestoreUntil = 0;
    if (db !== 0) S.log(`loudness trim for B: ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB (A ${la.toFixed(1)} dBFS, B ${lb.toFixed(1)} dBFS)`);
  }

  function clearLoudTrim() {
    loudTrim = 1;
    loudTrimDb = 0;
  }

  const restoringA = () => performance.now() < trimRestoreUntil;

  function cancelTrimRestore() {
    if (!restoringA()) return;
    trimRestoreUntil = 0;
    setGain(AU.gainA, 1);
  }

  const scaleCurve = (curve, k) => (k === 1 ? curve : curve.map((v) => v * k));

  const SAFETY_RAMP_SEC = 0.015;
  let holdAMuted = false;

  function holdAt(p, now) {
    if (typeof p.cancelAndHoldAtTime === 'function') {
      try { p.cancelAndHoldAtTime(now); return; } catch (_) { }
    }
    const cur = p.value;
    p.cancelScheduledValues(0);
    p.setValueAtTime(cur, now);
  }

  function setGain(gainNode, value, rampSec = 0.03) {
    if (!gainNode) return;
    const p = gainNode.gain;
    const now = gainNode.context.currentTime;
    holdAt(p, now);
    p.linearRampToValueAtTime(value, now + Math.max(rampSec, SAFETY_RAMP_SEC));
  }

  function scheduleCurve(gainNode, curve, delaySec, durationSec) {
    const p = gainNode.gain;
    const now = gainNode.context.currentTime;
    holdAt(p, now);
    const t0 = now + Math.max(delaySec, SAFETY_RAMP_SEC + 0.002);
    p.linearRampToValueAtTime(curve[0], t0 - 0.001);
    p.setValueCurveAtTime(curve, t0, durationSec);
    p.setValueAtTime(curve[curve.length - 1], t0 + durationSec + 0.001);
  }

  function setFilter(filterNode, db, rampSec = 0.03) {
    if (!filterNode) return;
    const p = filterNode.gain;
    const now = filterNode.context.currentTime;
    holdAt(p, now);
    p.linearRampToValueAtTime(db, now + Math.max(rampSec, SAFETY_RAMP_SEC));
  }

  function scheduleFilterRamp(filterNode, delaySec, from, to, durationSec) {
    if (!filterNode) return;
    const p = filterNode.gain;
    const now = filterNode.context.currentTime;
    holdAt(p, now);
    const t0 = now + Math.max(delaySec, SAFETY_RAMP_SEC + 0.002);
    p.linearRampToValueAtTime(from, t0);
    p.linearRampToValueAtTime(to, t0 + durationSec);
  }

  function neutralizeMix(rampSec = 0.03) {
    sync = null;
    fadeMix = null;
    setFilter(AU.filterA, 0, rampSec);
    setFilter(AU.filterB, 0, rampSec);
    if (bEl && bEl.playbackRate !== 1) bEl.playbackRate = 1;
  }

  async function muteA(epoch, rampSec) {
    const g = AU.gainA;
    if (!g) return;
    const audible = g.gain.value > 0.001;
    setGain(g, 0, rampSec);
    if (!audible) return;
    await S.sleep(Math.max(rampSec, SAFETY_RAMP_SEC) * 1000 + 20);
    guard(epoch);
  }

  async function microCrossfadeToA() {
    holdAMuted = false;
    if (!AU.gainA || !AU.gainB) return;
    setFilter(AU.filterA, 0, TUNING.microFadeSec);
    setGain(AU.gainA, loudTrim, TUNING.microFadeSec);
    setGain(AU.gainB, 0, TUNING.microFadeSec);
    await S.sleep((TUNING.microFadeSec + 0.04) * 1000);
  }

  function ensureB() {
    if (bEl) return bEl;
    bEl = AU.createOwnAudio();
    bEl.preservesPitch = true;
    const node = AU.createSource(bEl);
    node.connect(AU.filterB || AU.gainB);
    return bEl;
  }

  function releaseB(dying) {
    if (dying && dying.hls) dying.hls.alive = false;
    if (dying && dying.blobUrl) URL.revokeObjectURL(dying.blobUrl);
    if (!bEl || b) return;
    try {
      bEl.pause();
      bEl.removeAttribute('src');
      bEl.load();
    } catch (_) { }
  }

  function clearTimers() {
    if (job) for (const t of job.timers) clearTimeout(t);
    if (job) job.timers.length = 0;
  }

  function reset(reason) {
    const active = !M.is('idle') || !!b;
    if (b && b.hls) b.hls.alive = false;
    clearTimers();
    job = null;
    selfNav = false;
    selfSeek = false;
    keepMode = false;
    keepClosing = false;
    holdAMuted = false;
    aTail = null;
    clearPauseWatch();
    fadeRun = null;
    frozen = null;
    neutralizeMix();
    clearLoudTrim();
    if (!restoringA()) setGain(AU.gainA, 1);
    setGain(AU.gainB, 0);
    const dying = b;
    b = null;
    if (dying) setTimeout(() => releaseB(dying), 60);
    M.reset(reason);
    if (active) S.log('reset:', reason);
  }

  function finish(reason, aRestoreSec = 0) {
    if (b && b.hls) b.hls.alive = false;
    clearTimers();
    job = null;
    selfNav = false;
    selfSeek = false;
    keepMode = false;
    keepClosing = false;
    holdAMuted = false;
    aTail = null;
    clearPauseWatch();
    fadeRun = null;
    frozen = null;
    neutralizeMix(SAFETY_RAMP_SEC);
    const restore = aRestoreSec > 0 && loudTrim !== 1 && !!AU.gainA;
    clearLoudTrim();
    if (restore) {
      setGain(AU.gainA, 1, aRestoreSec);
      trimRestoreUntil = performance.now() + aRestoreSec * 1000;
    } else {
      trimRestoreUntil = 0;
      setGain(AU.gainA, 1, SAFETY_RAMP_SEC);
    }
    setGain(AU.gainB, 0, SAFETY_RAMP_SEC);
    const dying = b;
    b = null;
    setTimeout(() => releaseB(dying), SAFETY_RAMP_SEC * 1000 + 25);
    M.to('idle', reason);
  }

  function fail(key, reason) {
    failure = { key, reason };
    S.log('transition skipped:', reason);
    reset('skipped: ' + reason);
  }

  async function startPreload(key, why) {
    if (!M.to('preload', `${why} (${key})`)) return;
    const epoch = M.epoch;
    job = { epoch, aKey: key, timers: [] };
    recheckAt = performance.now() + DETECT.refreshMs;
    try {
      const next = await Q.getNextTrack();
      guard(epoch);
      startTailAnalysis(AU.a);
      if (next.durationSec > Q.config.maxTrackSeconds) throw new Error('Next track is a long mix (>25 min)');
      if (!next.path) throw new Error('Next track has no permalink');

      const stream = await Q.resolveStream(next.raw);
      guard(epoch);

      b = {
        track: next, kind: stream.kind, url: stream.url || stream.playlistUrl,
        blobUrl: null, offset: 0, via: null, ready: false, hls: null, beat: null, loudnessDb: null,
      };
      ensureB();
      if (stream.kind === 'hls') await loadHls(stream, epoch);
      else await loadProgressive(stream, epoch);
      guard(epoch);
      b.ready = true;
      S.log(`B ready: "${next.title}" (${b.kind}, ${b.via}), offset ${b.offset.toFixed(3)}s`);
    } catch (e) {
      if (e instanceof Cancelled || M.epoch !== epoch) return;
      if (e && e.retryable) {
        retryPreloadAt = performance.now() + TUNING.nextRetryMs;
        deferredKey = key;
        reset(`preload deferred: ${e.message}`);
        return;
      }
      fail(key, (e && e.message) || String(e));
    }
  }

  const smartWanted = () => S.settings.smartMix && !!S.analysis;

  async function scanHead(opts) {
    if (!S.settings.trimSilence && !smartWanted()) return;
    let decoded = null;
    try {
      const r = await S.silence.findHeadOffset(null, opts);
      b.offset = S.settings.trimSilence ? r.offset : 0;
      decoded = r.decoded;
    } catch (e) {
      S.log('head scan failed; no trim / beat analysis', e && e.message);
      b.offset = 0;
    }
    if (decoded && S.analysis && S.analysis.loudness) {
      try {
        b.loudnessDb = S.analysis.loudness(decoded, b.offset, b.offset + TUNING.analysisSec);
      } catch (e) {
        b.loudnessDb = null;
        S.warn('loudness analysis of B failed', e);
      }
    }
    if (!decoded || !smartWanted()) return;
    try {
      const res = S.analysis.analyze(decoded, { fromSec: b.offset, toSec: b.offset + TUNING.analysisSec });
      res.headRms = S.analysis.rms(decoded, b.offset, b.offset + S.settings.fadeSeconds);
      b.beat = res;
    } catch (e) {
      b.beat = { bpm: null, reason: 'analysis failed' };
      S.warn('beat analysis of B failed', e);
    }
  }

  function startTailAnalysis(a) {
    aTail = null;
    if (!smartWanted()) return;
    const at = { status: 'pending', res: null, reason: null };
    aTail = at;
    analyzeTail(a, () => aTail === at).then(
      (res) => { if (aTail === at) { at.res = res; at.status = 'ok'; } },
      (e) => {
        if (aTail !== at || e instanceof Cancelled) return;
        at.status = 'fail';
        at.reason = "this track's ending could not be read";
        S.log('A tail analysis failed:', (e && e.message) || e);
      },
    );
  }

  async function analyzeTail(a, alive) {
    const check = () => { if (!alive()) throw new Cancelled(); };
    const track = Q.currentTrack();
    const aDur = durationOf(a);
    if (!track || !Number.isFinite(aDur) || aDur < TUNING.analysisTailSec) throw new Error('A unknown or too short');
    const stream = await Q.resolveStream(track);
    check();
    let decoded;
    let startSec;
    if (stream.kind === 'hls') {
      const segs = stream.segments;
      let i = segs.length;
      let sec = 0;
      while (i > 0 && sec < TUNING.analysisTailSec) sec += segs[--i].duration || 0;
      if (!(sec > 0)) throw new Error('HLS playlist without segment durations');
      startSec = segs.slice(0, i).reduce((n, s) => n + (s.duration || 0), 0);
      const ctl = { alive: true, via: null };
      const chunks = [];
      if (stream.init) chunks.push(await fetchChunk(ctl, stream.init));
      for (let j = i; j < segs.length; j++) {
        check();
        let buf = await fetchChunk(ctl, segs[j].url);
        if (segs[j].key) buf = await decryptChunk(buf, segs[j]);
        chunks.push(buf);
      }
      check();
      decoded = await S.silence.decodeHead(S.silence.concat(chunks));
    } else {
      const bps = TUNING.progressiveBytesPerSec;
      const est = Math.round(aDur * bps);
      const first = Math.max(0, est - TUNING.analysisTailSec * bps);
      const last = est + TUNING.tailSlackBytes;
      const r = await S.net.fetchBytes(stream.url, { range: [first, last] });
      check();
      let buf = r.buffer;
      if (r.status === 200) buf = buf.slice(Math.max(0, buf.byteLength - (TUNING.analysisTailSec + 2) * bps));
      else if (buf.byteLength >= last - first + 1) throw new Error("A's end of file not reached");
      decoded = await S.silence.decodeHead(buf);
      startSec = aDur - decoded.duration;
    }
    check();
    const res = S.analysis.analyze(decoded, { fromSec: 0, toSec: decoded.duration });
    const end = decoded.duration - TUNING.endGuardSec;
    res.tailRms = S.analysis.rms(decoded, end - S.settings.fadeSeconds, end);
    res.loudnessDb = S.analysis.loudness(decoded, 0, end);
    if (res.firstBeatSec != null) res.firstBeatSec += startSec;
    if (res.downbeatSec != null) res.downbeatSec += startSec;
    res.startSec = startSec;
    S.log(`A tail: ${decoded.duration.toFixed(1)}s from ${startSec.toFixed(2)}s, ${res.bpm ? res.bpm.toFixed(2) + ' BPM' : res.reason}`);
    return res;
  }

  async function waitPlayable(el, epoch) {
    if (el.readyState >= 3) return;
    const ok = await waitEvent(el, 'canplay', TUNING.bLoadTimeoutMs, epoch);
    guard(epoch);
    if (!ok) throw new Error('Next track did not load in time');
  }

  async function loadProgressive(stream, epoch) {
    const corsOk = await S.net.probeCors(stream.url);
    guard(epoch);
    let full = null;
    if (!corsOk) {
      full = (await S.net.fetchBytes(stream.url, { forceProxy: true })).buffer;
      guard(epoch);
    }
    if (S.settings.trimSilence || smartWanted()) {
      const headBytes = smartWanted() ? TUNING.analysisHeadBytes : S.silence.OPTS.headBytes;
      const headBuffer = full
        ? full.slice(0, headBytes)
        : (await S.net.fetchBytes(stream.url, { range: [0, headBytes - 1] }).catch(() => null))?.buffer;
      guard(epoch);
      if (headBuffer) await scanHead({ headBuffer });
      guard(epoch);
    }
    b.via = corsOk ? 'direct' : 'proxy';
    if (full) {
      b.blobUrl = URL.createObjectURL(new Blob([full], { type: stream.mime || 'audio/mpeg' }));
      bEl.removeAttribute('crossorigin');
      bEl.src = b.blobUrl;
    } else {
      bEl.crossOrigin = 'anonymous';
      bEl.src = stream.url;
    }
    bEl.load();
    await waitPlayable(bEl, epoch);
  }

  function updateEnd(sb) {
    return new Promise((resolve, reject) => {
      const ok = () => { sb.removeEventListener('error', bad); resolve(); };
      const bad = () => { sb.removeEventListener('updateend', ok); reject(new Error('SourceBuffer error')); };
      sb.addEventListener('updateend', ok, { once: true });
      sb.addEventListener('error', bad, { once: true });
    });
  }

  async function appendChunk(ctl, buf) {
    for (let attempt = 0; ; attempt++) {
      if (!ctl.alive) return;
      try {
        ctl.sb.appendBuffer(buf);
        await updateEnd(ctl.sb);
        return;
      } catch (e) {
        if (!e || e.name !== 'QuotaExceededError' || attempt >= 2) throw e;
        const cut = bEl.currentTime - TUNING.hlsKeepBehindSec;
        if (cut <= 0) throw e;
        ctl.sb.remove(0, cut);
        await updateEnd(ctl.sb);
      }
    }
  }

  const hlsKeyCache = new Map();

  async function fetchHlsKey(uri) {
    if (hlsKeyCache.has(uri)) return hlsKeyCache.get(uri);
    const { buffer } = await S.net.fetchBytes(uri);
    const raw = new Uint8Array(buffer);
    if (raw.length !== 16) throw new Error(`AES-128 key is ${raw.length} bytes, expected 16`);
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    hlsKeyCache.set(uri, key);
    if (hlsKeyCache.size > 20) hlsKeyCache.delete(hlsKeyCache.keys().next().value);
    return key;
  }

  function segmentIv(seg) {
    if (seg.key && seg.key.iv) {
      const hex = seg.key.iv;
      const bytes = new Uint8Array(16);
      for (let i = 0; i < Math.min(hex.length, 32); i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      return bytes;
    }
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, (seg.seq || 0) >>> 0);
    return iv;
  }

  async function decryptChunk(buf, seg) {
    if (!seg.key || seg.key.method === 'NONE') return buf;
    if (seg.key.method !== 'AES-128' || !seg.key.uri) throw new Error(`Unsupported encryption: ${seg.key.method}`);
    const key = await fetchHlsKey(seg.key.uri);
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(seg) }, key, buf);
  }

  async function fetchChunk(ctl, url) {
    let lastErr = null;
    for (let attempt = 0; attempt <= TUNING.segmentRetries; attempt++) {
      if (!ctl.alive) throw new Cancelled();
      try {
        const r = await S.net.fetchBytes(url);
        if (r.via === 'proxy' || !ctl.via) ctl.via = r.via;
        return r.buffer;
      } catch (e) {
        lastErr = e;
        await S.sleep(300 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  function bufferedAhead(el) {
    const t = el.currentTime;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= t + 0.1 && el.buffered.end(i) > t) return el.buffered.end(i) - t;
    }
    return 0;
  }

  async function pump(ctl) {
    try {
      while (ctl.alive && ctl.next < ctl.segments.length) {
        if (bufferedAhead(bEl) > TUNING.hlsBufferAheadSec) {
          await S.sleep(500);
          continue;
        }
        const seg = ctl.segments[ctl.next];
        let buf = await fetchChunk(ctl, seg.url);
        if (!ctl.alive) return;
        if (seg.key) buf = await decryptChunk(buf, seg);
        if (!ctl.alive) return;
        await appendChunk(ctl, buf);
        ctl.next++;
      }
      if (ctl.alive && ctl.ms.readyState === 'open' && !ctl.sb.updating) ctl.ms.endOfStream();
    } catch (e) {
      if (!ctl.alive || e instanceof Cancelled) return;
      ctl.error = e;
      S.warn('HLS pump stopped:', (e && e.message) || e);
    }
  }

  async function loadHls(stream, epoch) {
    const ms = new MediaSource();
    b.blobUrl = URL.createObjectURL(ms);
    bEl.removeAttribute('crossorigin');
    bEl.src = b.blobUrl;
    if (!(await waitEvent(ms, 'sourceopen', 5000, epoch))) throw new Error('MediaSource did not open');
    guard(epoch);

    const sb = ms.addSourceBuffer(stream.mime);
    if (/^audio\/mpeg/i.test(stream.mime)) sb.mode = 'sequence';
    if (stream.durationSec > 0) {
      try { ms.duration = stream.durationSec; } catch (_) { }
    }
    const ctl = { ms, sb, segments: stream.segments, next: 0, alive: true, error: null, via: null };
    b.hls = ctl;

    const head = [];
    let headBytes = 0;
    let headSec = 0;
    const headWantSec = smartWanted() ? TUNING.analysisHeadSec : 0;
    const wantHead = () => headBytes < TUNING.analysisMaxBytes
      && (headBytes < S.silence.OPTS.headBytes || headSec < headWantSec);
    if (stream.init) {
      const init = await fetchChunk(ctl, stream.init);
      guard(epoch);
      await appendChunk(ctl, init);
      head.push(init);
    }
    const wantSec = S.silence.OPTS.maxTrimSec + S.settings.fadeSeconds + TUNING.hlsPrebufferExtraSec;
    let haveSec = 0;
    while (ctl.next < ctl.segments.length && (haveSec < wantSec || wantHead())) {
      const seg = ctl.segments[ctl.next];
      let buf = await fetchChunk(ctl, seg.url);
      guard(epoch);
      if (seg.key) buf = await decryptChunk(buf, seg);
      guard(epoch);
      await appendChunk(ctl, buf);
      guard(epoch);
      if (wantHead()) {
        head.push(buf);
        headBytes += buf.byteLength;
        headSec += seg.duration || 0;
      }
      haveSec += seg.duration || 0;
      ctl.next++;
      if (!seg.duration && ctl.next >= 4) break;
    }
    b.via = ctl.via || 'direct';
    await scanHead({ chunks: head });
    guard(epoch);

    pump(ctl);
    await waitPlayable(bEl, epoch);
  }

  const simple = (why) => ({ ok: false, label: why ? `Simple fade · ${why}` : 'Simple fade' });

  function smartPlan() {
    if (!S.settings.smartMix) return simple('Smart Mix off');
    if (!S.analysis) return simple('analyzer unavailable');
    if (b && b.ready && !aTail) return simple('turned on after this track was loaded');
    if (!b || !b.ready || !aTail || aTail.status === 'pending') return { ok: false, pending: true, label: 'Analyzing beats…' };
    if (aTail.status !== 'ok') return simple(aTail.reason);
    if (!b.beat) return simple('next track not analyzed');
    const ra = aTail.res;
    const rb = b.beat;
    const m = S.analysis.matchTempo(ra, rb);
    if (!m.ok) return simple(m.reason);
    if (!(rb.downbeatSec >= 0)) return simple('next track: no start beat');
    const fade = S.analysis.recommendFade({
      userSec: S.settings.fadeSeconds,
      tailRms: ra.tailRms,
      headRms: rb.headRms,
      beatPeriodSec: ra.beatPeriodSec,
      minSec: 1,
      maxSec: 12,
    });
    const tag = m.mult === 2 ? ' (half-time)' : m.mult === 0.5 ? ' (double-time)' : '';
    return {
      ok: true,
      label: `${Math.round(ra.bpm)} → ${Math.round(rb.bpm)} BPM${tag}`,
      rate: m.rate,
      aFirst: ra.firstBeatSec,
      aPeriod: ra.beatPeriodSec,
      bStart: rb.downbeatSec,
      fadeSec: fade.fadeSec,
      contrastDb: fade.contrastDb,
    };
  }

  function pickBeat(a, plan) {
    const now = a.currentTime;
    const earliest = now + TUNING.beatMinLeadSec;
    const latest = Math.min(durationOf(a) - TUNING.endGuardSec - plan.fadeSec, now + TUNING.beatLookaheadSec);
    if (!(latest >= earliest) || !(plan.aPeriod > 0)) return null;
    const t = plan.aFirst + Math.ceil((earliest - plan.aFirst) / plan.aPeriod) * plan.aPeriod;
    return t <= latest ? t : null;
  }

  function startFade(a, remaining, plan) {
    if (plan && plan.ok && bEl) {
      const aBeat = pickBeat(a, plan);
      if (aBeat != null) { startSmartFade(a, remaining, plan, aBeat); return; }
    }
    const fadeDur = Math.min(S.settings.fadeSeconds, remaining - TUNING.endGuardSec);
    if (remaining < TUNING.lateMinRemainingSec || !(fadeDur > 0)) return;
    if (!M.to('fade', `${fadeDur.toFixed(2)}s${fadeDur < S.settings.fadeSeconds ? ' (shortened)' : ''}`)) return;
    if (!plan) fadeMix = simple().label;
    else if (plan.ok) fadeMix = simple('no beat in time').label;
    else if (plan.pending) fadeMix = simple('analysis not ready').label;
    else fadeMix = plan.label;
    startSimpleFade(a, remaining, fadeDur);
  }

  async function startSimpleFade(a, remaining, fadeDur) {
    fadeRemaining = remaining;
    computeLoudTrim();
    const epoch = M.epoch;
    try {
      bEl.volume = a.volume;
      bEl.muted = a.muted;
      setGain(AU.gainB, 0, SAFETY_RAMP_SEC);
      setFilter(AU.filterA, 0, SAFETY_RAMP_SEC);
      setFilter(AU.filterB, 0, SAFETY_RAMP_SEC);
      bEl.playbackRate = 1;
      bEl.currentTime = b.offset;
      await bEl.play();
      guard(epoch);
      fadeRun = {
        startA: a.currentTime + 0.02, dur: fadeDur, smart: false, swapAt: 0, width: 0,
        bAtStart: bEl.currentTime + 0.02,
      };
      scheduleFadeFrom(0, 0.02, 0.02, epoch);
    } catch (e) {
      if (e instanceof Cancelled || M.epoch !== epoch) return;
      fail(job.aKey, `Could not start B: ${(e && e.message) || e}`);
    }
  }

  async function startSmartFade(a, remaining, plan, aBeat) {
    const fadeDur = plan.fadeSec;
    const rate = plan.rate;
    if (!M.to('fade', `smart ${fadeDur.toFixed(2)}s on beat ${aBeat.toFixed(3)}s, B rate ${rate.toFixed(4)}`)) return;
    fadeRemaining = remaining;
    fadeMix = plan.label;
    computeLoudTrim();
    const epoch = M.epoch;
    try {
      bEl.volume = a.volume;
      bEl.muted = a.muted;
      setGain(AU.gainB, 0, SAFETY_RAMP_SEC);
      setFilter(AU.filterA, 0, SAFETY_RAMP_SEC);
      setFilter(AU.filterB, TUNING.bassCutDb, SAFETY_RAMP_SEC);
      bEl.preservesPitch = true;
      bEl.playbackRate = rate;
      const lead = aBeat - a.currentTime;
      const preroll = Math.max(0, Math.min(lead, plan.bStart / rate));
      bEl.currentTime = plan.bStart - preroll * rate;
      sync = {
        aBeat, bStart: plan.bStart, rate, fadeDur,
        restoreSec: Math.min(TUNING.rateRestoreSec, fadeDur / 2),
        err: null, seeks: 0, lost: false,
      };
      const wait = lead - preroll;
      if (wait > 0.03) await S.sleep((wait - 0.02) * 1000);
      guard(epoch);
      await bEl.play();
      guard(epoch);

      const delayA = Math.max(0.02, aBeat - a.currentTime);
      const delayB = Math.max(0.02, delayA + latencySkew());
      const width = Math.min(Math.max(2 * plan.aPeriod, 0.2 * fadeDur, 0.25), 0.6 * fadeDur);
      fadeRun = { startA: aBeat, dur: fadeDur, smart: true, swapAt: fadeDur / 2 - width / 2, width, bAtStart: plan.bStart };
      scheduleFadeFrom(0, delayA, delayB, epoch);
    } catch (e) {
      if (e instanceof Cancelled || M.epoch !== epoch) return;
      fail(job.aKey, `Could not start B: ${(e && e.message) || e}`);
    }
  }

  function scheduleFadeFrom(from, delayA, delayB, epoch) {
    const run = fadeRun;
    const left = run.dur - from;
    const u0 = Math.min(Math.max(from / run.dur, 0), 0.999);
    scheduleCurve(AU.gainA, u0 > 0 ? makeCurve(fadeOutFn, 0, u0) : FADE_OUT, delayA, left);
    scheduleCurve(AU.gainB, scaleCurve(u0 > 0 ? makeCurve(fadeInFn, 1, u0) : FADE_IN, loudTrim), delayB, left);
    if (run.smart) {
      const cut = TUNING.bassCutDb;
      const swapEnd = run.swapAt + run.width;
      if (from < run.swapAt) {
        const wait = run.swapAt - from;
        scheduleFilterRamp(AU.filterA, delayA + wait, 0, cut, run.width);
        scheduleFilterRamp(AU.filterB, delayB + wait, cut, 0, run.width);
      } else if (from < swapEnd) {
        const u = (from - run.swapAt) / run.width;
        scheduleFilterRamp(AU.filterA, delayA, cut * u, cut, swapEnd - from);
        scheduleFilterRamp(AU.filterB, delayB, cut * (1 - u), 0, swapEnd - from);
      } else {
        setFilter(AU.filterA, cut, SAFETY_RAMP_SEC);
        setFilter(AU.filterB, 0, SAFETY_RAMP_SEC);
      }
    }
    job.timers.push(setTimeout(() => handoff(epoch, 'fade complete'), (delayA + left) * 1000 + 30));
  }

  function expectedB(s, into) {
    const restoreFrom = s.fadeDur - s.restoreSec;
    if (into <= restoreFrom) return s.bStart + into * s.rate;
    const x = Math.min(into, s.fadeDur) - restoreFrom;
    return s.bStart + restoreFrom * s.rate + x * s.rate + ((1 - s.rate) * x * x) / (2 * s.restoreSec);
  }

  function syncTick(a) {
    const s = sync;
    if (!s || !bEl || !a || a.seeking || bEl.paused || bEl.seeking || bEl.readyState < 2) return;
    const into = a.currentTime - latencySkew() - s.aBeat;
    const restoreFrom = s.fadeDur - s.restoreSec;
    if (into >= restoreFrom) {
      const u = Math.min(1, (into - restoreFrom) / s.restoreSec);
      bEl.playbackRate = s.rate + (1 - s.rate) * u;
      return;
    }
    if (s.lost) return;
    const err = bEl.currentTime - (s.bStart + into * s.rate);
    if (!Number.isFinite(err)) return;
    if (into < -0.12 && Math.abs(err) > TUNING.pllSeekSec && s.seeks < 2 && bEl.currentTime - err > 0) {
      s.seeks++;
      s.err = null;
      bEl.currentTime -= err;
      return;
    }
    if (into > 0 && Math.abs(err) > TUNING.pllLostSec) {
      s.lost = true;
      bEl.playbackRate = s.rate;
      S.warn(`beat sync lost (B off by ${(err * 1000).toFixed(0)} ms); holding tempo`);
      return;
    }
    s.err = s.err == null ? err : s.err + 0.5 * (err - s.err);
    const corr = Math.min(TUNING.pllMaxCorr, Math.max(-TUNING.pllMaxCorr, -s.err / TUNING.pllTauSec));
    bEl.playbackRate = s.rate * (1 + corr);
  }

  function bPosition() {
    if (!b || !bEl || bEl.readyState < 2 || bEl.seeking || bEl.ended) return NaN;
    const t = bEl.currentTime;
    return Number.isFinite(t) && t > 0.5 ? t : NaN;
  }

  function outLatency(node) {
    const c = node && node.context;
    if (!c) return 0;
    const v = (c.baseLatency || 0) + (c.outputLatency || 0);
    return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0;
  }

  function latencySkew() {
    if (!AU.gainA || !AU.gainB || AU.gainA.context === AU.gainB.context) return 0;
    return outLatency(AU.gainA) - outLatency(AU.gainB);
  }

  function driftOf(a) {
    const pos = bPosition();
    return Number.isFinite(pos) ? a.currentTime - (pos + latencySkew()) : NaN;
  }

  async function measureDrift(a, epoch) {
    const s = [];
    for (let i = 0; i < TUNING.driftSamples; i++) {
      if (i) await S.sleep(20);
      guard(epoch);
      const d = driftOf(a);
      if (!Number.isFinite(d)) return NaN;
      s.push(d);
    }
    s.sort((x, y) => x - y);
    return s[s.length >> 1];
  }

  function syncTarget(a, lead = learnedLeadSec) {
    const pos = bPosition();
    if (!Number.isFinite(pos)) return NaN;
    const maxT = Number.isFinite(a.duration) ? a.duration - 0.5 : Infinity;
    const t = Math.min(pos + latencySkew() + lead, maxT);
    return t > 0.5 ? t : NaN;
  }

  function seekA(a, t) {
    const token = ++seekToken;
    selfSeek = true;
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      a.removeEventListener('seeked', done);
      a.removeEventListener('emptied', done);
      if (seekToken === token) selfSeek = false;
    };
    timer = setTimeout(done, TUNING.seekTimeoutMs);
    a.addEventListener('seeked', done);
    a.addEventListener('emptied', done);
    a.currentTime = t;
  }

  function waitAStable(a, epoch) {
    let src = a.currentSrc;
    let last = a.currentTime;
    let since = performance.now();
    return waitFor(() => {
      if (Q.isAdActive(a)) throw new AdInterrupt();
      const now = performance.now();
      const t = a.currentTime;
      if (a.currentSrc !== src || a.seeking || a.paused || a.readyState < 3 || t < last) {
        src = a.currentSrc;
        since = now;
      }
      last = t;
      return now - since >= TUNING.aSettleMs;
    }, TUNING.seekTimeoutMs, epoch);
  }

  async function syncAToB(a, epoch) {
    let lead = learnedLeadSec;
    let resets = 0;
    let corrections = 0;
    for (;;) {
      if (!(await waitAStable(a, epoch))) throw new SeekTimeout('A did not settle on the new track');
      const target = syncTarget(a, lead);
      if (!Number.isFinite(target)) throw new Error('B position unavailable for sync');
      let reloaded = false;
      const onReload = () => { reloaded = true; };
      a.addEventListener('emptied', onReload);
      a.addEventListener('loadstart', onReload);
      try {
        seekA(a, target);
        if (!(await waitEvent(a, 'seeked', TUNING.seekTimeoutMs, epoch))) throw new SeekTimeout('seek timed out');
        const ready = await waitFor(() => !a.paused && !a.seeking && a.readyState >= 3, TUNING.seekTimeoutMs, epoch);
        if (!ready) throw new SeekTimeout('A did not resume after seek');
        const pulledBack = await waitFor(
          () => reloaded || a.currentTime < target - TUNING.syncSlackSec,
          TUNING.syncVerifyMs, epoch,
        );
        if (pulledBack) {
          if (++resets >= TUNING.syncAttempts) throw new SeekTimeout('SoundCloud kept resetting A');
          S.warn(`A was reset to ${a.currentTime.toFixed(2)}s after sync (attempt ${resets}); re-syncing`);
          continue;
        }
      } finally {
        a.removeEventListener('emptied', onReload);
        a.removeEventListener('loadstart', onReload);
      }

      const d = await measureDrift(a, epoch);
      if (!Number.isFinite(d)) throw new Error('B position unavailable for sync');
      const ideal = Math.min(Math.max(lead - d, 0), TUNING.maxLeadSec);
      learnedLeadSec = 0.5 * learnedLeadSec + 0.5 * ideal;
      if (Math.abs(d) <= TUNING.alignToleranceSec) {
        S.log(`A synced to B, audible offset ${(d * 1000).toFixed(0)} ms (skew ${(latencySkew() * 1000).toFixed(0)} ms)`);
        return;
      }
      if (++corrections > TUNING.alignAttempts) {
        S.warn(`A/B residual offset ${(d * 1000).toFixed(0)} ms after ${corrections - 1} corrections`);
        return;
      }
      S.log(`A off by ${(d * 1000).toFixed(0)} ms; correcting with lead ${(ideal * 1000).toFixed(0)} ms`);
      lead = ideal;
    }
  }

  async function handoff(epoch, why) {
    if (M.epoch !== epoch || !M.is('fade') || !b) return;
    clearTimers();
    if (!M.to('handoff', why)) return;
    selfNav = true;
    holdAMuted = true;
    spuriousRewinds = 0;
    swapSettled = false;
    lastKeepResyncAt = -Infinity;
    const target = b;
    const aKey = job.aKey;
    const aBefore = AU.a;
    sync = null;
    fadeRun = null;
    frozen = null;
    if (bEl && bEl.playbackRate !== 1) bEl.playbackRate = 1;
    try {
      setGain(AU.gainB, loudTrim, 0.15);
      setFilter(AU.filterB, 0, 0.15);
      const needNext = Q.currentPath() === aKey && !(AU.a && AU.a.ended);
      if (needNext) {
        await muteA(epoch, 0.15);
        if (Q.isAdActive(AU.a)) throw new AdInterrupt();
        if (!Q.clickNext()) throw new Error('Next button not found');
      } else {
        setGain(AU.gainA, 0, 0.15);
      }

      const advanced = await waitFor(() => {
        if (Q.isAdActive(AU.a)) throw new AdInterrupt();
        const a = AU.a;
        const fresh = a !== aBefore || a.currentTime < 5;
        return Q.currentPath() !== aKey && a && fresh && !a.paused && a.readyState >= 2;
      }, TUNING.navTimeoutMs, epoch);
      if (!advanced) throw new Error('SoundCloud did not advance to the next track');
      swapSettled = true;

      const newKey = Q.currentPath();
      if (newKey !== target.track.path) {
        dropMismatchedB(newKey, target);
        return;
      }

      const a = AU.a;
      if (!AU.isWired(a)) {
        reset('new A element is not routed');
        return;
      }
      await muteA(epoch, SAFETY_RAMP_SEC);
      setFilter(AU.filterA, 0, SAFETY_RAMP_SEC);
      if (Q.currentPath() !== target.track.path) {
        dropMismatchedB(Q.currentPath(), target);
        return;
      }

      try {
        await syncAToB(a, epoch);
      } catch (e) {
        if (!(e instanceof SeekTimeout)) throw e;
        S.warn('handoff seek failed; falling back to keep mode:', e.message);
        enterKeep();
        return;
      }
      guard(epoch);

      if (S.settings.handoffMode === 'keep') {
        enterKeep();
        S.log('keep mode: B stays audible until its end');
        return;
      }
      const last = await measureDrift(a, epoch);
      if (!(Math.abs(last) <= TUNING.alignToleranceSec * 2)) {
        S.warn(`A slipped ${Number.isFinite(last) ? (last * 1000).toFixed(0) + ' ms' : '(B unusable)'} before crossfade; re-aligning`);
        try {
          await syncAToB(a, epoch);
        } catch (e) {
          if (!(e instanceof SeekTimeout)) throw e;
          enterKeep();
          return;
        }
        guard(epoch);
      }
      await microCrossfadeToA();
      guard(epoch);
      finish('handoff complete', TUNING.trimRestoreSec);
    } catch (e) {
      if (e instanceof Cancelled || M.epoch !== epoch) return;
      if (e instanceof AdInterrupt) {
        reset('ad during handoff');
        return;
      }
      S.warn('handoff aborted:', (e && e.message) || e);
      clearLoudTrim();
      await microCrossfadeToA().catch(() => {});
      if (M.epoch === epoch) finish('handoff aborted');
    }
  }

  function dropMismatchedB(newKey, target) {
    S.warn(`handoff: track mismatch — SoundCloud is playing ${newKey || '(unknown)'}, but B was ${target.track.path}; dropping B`);
    holdAMuted = false;
    sync = null;
    setGain(AU.gainB, 0, SAFETY_RAMP_SEC);
    if (bEl) bEl.playbackRate = 1;
    setFilter(AU.filterA, 0, SAFETY_RAMP_SEC);
    setFilter(AU.filterB, 0, SAFETY_RAMP_SEC);
    setGain(AU.gainA, 1, SAFETY_RAMP_SEC);
    finish('handoff: track mismatch');
  }

  function enterKeep() {
    keepMode = true;
    if (loudTrim === 1) return;
    clearLoudTrim();
    setGain(AU.gainB, 1, TUNING.trimRestoreSec);
  }

  async function closeKeep(reason) {
    if (keepClosing) return;
    keepClosing = true;
    const epoch = M.epoch;
    try { await waitFor(() => !AU.a || !AU.a.seeking, 1000, epoch); } catch (_) { return; }
    await microCrossfadeToA();
    if (M.epoch === epoch) finish(reason);
  }

  function keepTick(a, key) {
    if (!b || !bEl) { finish('keep: B gone'); return; }
    if (keepClosing) return;
    if (key !== b.track.path) { closeKeep('keep: SoundCloud moved on'); return; }
    if (b.hls && b.hls.error) { closeKeep('keep: B stream failed'); return; }
    const bLeft = (Number.isFinite(bEl.duration) ? bEl.duration : Infinity) - bEl.currentTime;
    if (bEl.ended || bLeft < TUNING.microFadeSec + 0.12) { closeKeep('keep: B ended'); return; }
    if (!a || a.seeking || selfSeek || a.readyState < 2) return;
    if (performance.now() - lastKeepResyncAt < TUNING.keepResyncCooldownMs) return;
    const d = driftOf(a);
    if (!Number.isFinite(d) || Math.abs(d) <= TUNING.keepResyncSec) return;
    const target = syncTarget(a);
    if (!Number.isFinite(target)) return;
    lastKeepResyncAt = performance.now();
    seekA(a, target);
  }

  function inOwnHandoff() { return M.is('handoff') && !keepMode; }

  function isSpuriousRewind(a) {
    if (!keepMode || !M.is('handoff') || !a) return false;
    if (performance.now() - lastUserInputAt < 1000) return false;
    const pos = bPosition();
    if (!(a.currentTime < 1 && pos > 3)) return false;
    return spuriousRewinds++ < TUNING.syncAttempts;
  }

  function bCoversOffset() {
    if (!bEl || !b) return false;
    const r = bEl.buffered;
    for (let i = 0; i < r.length; i++) if (r.start(i) <= b.offset + 0.05 && r.end(i) > b.offset + 1) return true;
    return false;
  }

  function rearmFade(reason) {
    const aKey = job.aKey;
    const kept = b;
    clearTimers();
    neutralizeMix(SAFETY_RAMP_SEC);
    clearLoudTrim();
    fadeRun = null;
    frozen = null;
    setGain(AU.gainA, 1, SAFETY_RAMP_SEC);
    setGain(AU.gainB, 0, SAFETY_RAMP_SEC);
    M.to('idle', reason);
    M.to('preload', 'B kept after seek');
    const epoch = M.epoch;
    job = { epoch, aKey, timers: [] };
    job.timers.push(setTimeout(() => {
      if (M.epoch === epoch && M.is('preload') && b === kept && bEl) bEl.pause();
    }, SAFETY_RAMP_SEC * 1000 + 25));
  }

  function onSeeking() {
    if (selfSeek) return;
    if (frozen) { seekWhileFrozen(AU.a); return; }
    if (inOwnHandoff()) return;
    if (isSpuriousRewind(AU.a)) {
      S.warn('ignored SoundCloud rewind of A during keep mode; re-aligning');
      lastKeepResyncAt = -Infinity;
      return;
    }
    if (M.is('preload')) return;
    if (M.is('fade') && b && b.ready && job && bCoversOffset()) { rearmFade('user seek during fade'); return; }
    if (!M.is('idle')) reset('user seek');
  }

  const PLAY_BUTTON = '.playControls__play';
  let lastMediaPauseAt = -Infinity;
  let uiPlayingSeen = false;
  let pauseCheckTimer = 0;
  let aPausedSince = 0;
  let swapSettled = true;

  function uiShowsPaused() {
    const btn = document.querySelector(PLAY_BUTTON);
    if (!btn) return false;
    if (btn.classList.contains('playing')) { uiPlayingSeen = true; return false; }
    return uiPlayingSeen;
  }

  function pauseEvidence({ strongOnly = false } = {}) {
    const now = performance.now();
    if (now - lastMediaPauseAt < TUNING.userIntentMs) return 'media key';
    const midSwap = M.is('handoff') && !keepMode && !swapSettled;
    if (!midSwap && uiShowsPaused()) return 'player shows paused';
    if (!strongOnly && now - lastUserInputAt < TUNING.userIntentMs) return 'user input';
    return null;
  }

  const aHeldPaused = (a) => !!a && a.paused && !a.ended && !a.seeking;

  function clearPauseWatch() {
    clearTimeout(pauseCheckTimer);
    pauseCheckTimer = 0;
    aPausedSince = 0;
  }

  function holdNode(node) {
    if (node) holdAt(node.gain, node.context.currentTime);
  }

  function freezeFade(why) {
    if (frozen || !M.is('fade')) return;
    if (!fadeRun) {
      rearmFade(`pause before the fade began (${why})`);
      return;
    }
    clearTimers();
    clearPauseWatch();
    if (bEl) { try { bEl.pause(); } catch (_) { } }
    for (const n of [AU.gainA, AU.gainB, AU.filterA, AU.filterB]) holdNode(n);
    const a = AU.a;
    frozen = { kind: 'fade', el: a, why };
    cueBForResume(a, 'fade');
    S.log(`fade frozen (${why}) at ${a ? (a.currentTime - fadeRun.startA).toFixed(2) : '?'}s of ${fadeRun.dur.toFixed(2)}s`);
  }

  function freezeKeep(why) {
    if (frozen || !M.is('handoff') || !keepMode) return;
    clearPauseWatch();
    if (bEl) { try { bEl.pause(); } catch (_) { } }
    frozen = { kind: 'keep', el: AU.a, why };
    cueBForResume(AU.a, 'keep');
    S.log(`keep mode frozen (${why})`);
  }

  function userPaused(why) {
    if (frozen) return;
    if (M.is('fade')) freezeFade(why);
    else if (M.is('handoff') && keepMode) freezeKeep(why);
    else if (M.is('handoff')) stopForUserPause(why);
  }

  function cueBForResume(a, kind) {
    if (!bEl || !a || a.seeking) return;
    let target = NaN;
    if (kind === 'keep') {
      target = a.currentTime - latencySkew();
    } else if (fadeRun && fadeRun.smart && sync) {
      target = expectedB(sync, a.currentTime - latencySkew() - sync.aBeat);
    } else if (fadeRun) {
      target = fadeRun.bAtStart + Math.max(0, a.currentTime - fadeRun.startA);
    }
    if (Number.isFinite(target) && target >= 0 && Math.abs(bEl.currentTime - target) > 0.02) bEl.currentTime = target;
  }

  function wakeOwnContext() {
    const c = AU.ctx;
    if (c && c.state === 'suspended') { try { c.resume().catch(() => {}); } catch (_) { } }
  }

  function resumeFrozen(why) {
    const f = frozen;
    if (!f) return;
    const a = AU.a;
    const run = fadeRun;
    if (!bEl || !a || (f.kind === 'fade' && !run)) { frozen = null; reset('resume: fade state lost'); return; }
    frozen = null;
    const epoch = M.epoch;
    wakeOwnContext();
    cueBForResume(a, f.kind);
    if (f.kind === 'fade' && sync) { sync.err = null; sync.lost = false; sync.seeks = 2; }
    let p;
    try { p = bEl.play(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).catch((e) => {
      if (M.epoch !== epoch || frozen || (e && e.name === 'AbortError')) return;
      S.warn('could not resume the transition:', (e && e.message) || e);
      reset('resume failed');
    });
    if (f.kind === 'keep') {
      lastKeepResyncAt = -Infinity;
      S.log(`keep mode resumed (${why})`);
      return;
    }
    const into = a.currentTime - run.startA;
    if (into >= run.dur - 0.05) { handoff(epoch, 'resumed at the end of the fade'); return; }
    const delayA = Math.max(0.02, -into);
    const from = Math.max(0, into + 0.02);
    const delayB = Math.max(0.02, delayA + (run.smart ? latencySkew() : 0));
    scheduleFadeFrom(from, delayA, delayB, epoch);
    S.log(`fade resumed (${why}) at ${from.toFixed(2)}s of ${run.dur.toFixed(2)}s`);
  }

  function tryResumeFrozen(why, needPlaying) {
    const a = AU.a;
    if (!frozen || a !== frozen.el || Q.isAdActive(a)) return;
    if (Q.currentPath() !== lastKey) return;
    if (!needPlaying && (a.seeking || a.readyState < 3)) return;
    resumeFrozen(why);
  }

  function onPlay() { tryResumeFrozen('A play', false); }
  function onPlaying() { tryResumeFrozen('A playing', true); }

  function frozenTick(a, keyChanged) {
    if (keyChanged) { reset('track changed while paused'); return; }
    if (!a || a !== frozen.el) { reset('player changed while paused'); return; }
    if (!a.paused && !a.seeking && a.readyState >= 3) resumeFrozen('A playing (poll)');
  }

  function seekWhileFrozen(a) {
    if (frozen.kind === 'fade' && fadeRun && a) {
      const t = a.currentTime;
      if (t >= fadeRun.startA - 0.05 && t <= fadeRun.startA + fadeRun.dur) {
        const pending = a.seeking;
        if (pending) {
          a.addEventListener('seeked', () => { if (frozen && frozen.el === a) cueBForResume(a, 'fade'); }, { once: true });
        } else {
          cueBForResume(a, 'fade');
        }
        return;
      }
    }
    reset('seek outside the fade window while paused');
  }

  function stopForUserPause(why) {
    if (M.is('idle', 'preload')) return;
    S.log(`user pause (${why}) during ${M.state}${keepMode ? ' (keep)' : ''}: stopping B`);
    if (bEl) {
      try { bEl.pause(); } catch (_) { }
      bEl.playbackRate = 1;
    }
    finish(`user pause: ${why}`);
  }

  function armPauseCheck() {
    clearTimeout(pauseCheckTimer);
    const epoch = M.epoch;
    pauseCheckTimer = setTimeout(() => {
      pauseCheckTimer = 0;
      if (M.epoch !== epoch || !M.is('fade', 'handoff')) return;
      if (!aHeldPaused(AU.a)) return;
      const ev = pauseEvidence();
      if (ev) userPaused(ev);
    }, TUNING.pauseConfirmMs);
  }

  function watchUserPause(a) {
    if (!aHeldPaused(a)) { aPausedSince = 0; return false; }
    const now = performance.now();
    if (!aPausedSince) aPausedSince = now;
    if (now - aPausedSince < TUNING.pauseConfirmMs) return false;
    const ev = pauseEvidence();
    if (!ev) return false;
    userPaused(`${ev}, A stayed paused`);
    return true;
  }

  function onPause() {
    const a = AU.a;
    if (M.is('idle') || frozen) return;
    if (Q.isAdActive(a)) { reset('ad active'); return; }
    if (M.is('preload')) { reset('pause'); return; }
    if (M.is('fade')) {
      const strong = pauseEvidence({ strongOnly: true });
      if (a && (a.ended || (!strong && durationOf(a) - a.currentTime < 0.5))) {
        handoff(M.epoch, 'A reached its end');
        return;
      }
      freezeFade(strong || 'pause during fade');
      return;
    }
    if (keepMode) {
      if (a && a.ended) return;
      freezeKeep(pauseEvidence() || 'pause during keep mode');
      return;
    }
    if (performance.now() - lastMediaPauseAt < TUNING.userIntentMs) userPaused('media key');
    else armPauseCheck();
  }

  function onEnded() {
    if (M.is('fade')) handoff(M.epoch, 'A ended');
  }

  function attachA(a) {
    if (!a || a === attachedA) return;
    if (attachedA) {
      attachedA.removeEventListener('seeking', onSeeking);
      attachedA.removeEventListener('pause', onPause);
      attachedA.removeEventListener('ended', onEnded);
      attachedA.removeEventListener('playing', onPlaying);
      attachedA.removeEventListener('play', onPlay);
    }
    attachedA = a;
    a.addEventListener('seeking', onSeeking);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('play', onPlay);
  }

  function step() {
    const a = AU.a;
    if (a) attachA(a);
    const key = Q.currentPath();
    const keyChanged = key !== lastKey;
    lastKey = key;
    if (keyChanged && failure && failure.key !== key) failure = null;
    if (keyChanged) { retryPreloadAt = 0; deferredKey = null; }
    const shuffle = Q.isShuffle();
    const shuffleToggled = lastShuffle !== null && shuffle !== lastShuffle;
    lastShuffle = shuffle;
    if (shuffleToggled) {
      Q.resetPeekBudget();
      scheduleDetect(DETECT.afterTrackChangeMs, true);
      if (b && M.is('preload', 'fade')) {
        reset(`shuffle turned ${shuffle ? 'on' : 'off'}: next track changed`);
        return;
      }
    }
    if (keyChanged && key) scheduleDetect(DETECT.afterTrackChangeMs, true);

    if (b && bEl && a) {
      bEl.volume = a.volume;
      bEl.muted = a.muted;
    }

    lastAd = Q.isAdActive(a);
    if (restoringA() && (keyChanged || lastAd || !S.settings.enabled)) cancelTrimRestore();
    if (!S.settings.enabled) { if (!M.is('idle')) reset('disabled'); return; }
    if (lastAd) { if (!M.is('idle')) reset('ad active'); return; }

    if (a && !a.paused && !uiPlayingSeen) uiShowsPaused();
    if (frozen) { frozenTick(a, keyChanged); return; }
    if (M.is('fade', 'handoff') && watchUserPause(a)) return;

    if (M.is('handoff')) {
      if (keepMode) keepTick(a, key);
      return;
    }
    if (M.is('fade')) {
      if (keyChanged) {
        const natural = fadeRemaining <= TUNING.naturalEndSec;
        if (natural && b && key === b.track.path && selfNav === false) handoff(M.epoch, 'SoundCloud advanced');
        else reset(natural ? 'track changed during fade' : 'manual skip during fade');
      } else if (a && !a.seeking) {
        fadeRemaining = durationOf(a) - a.currentTime;
        syncTick(a);
      }
      return;
    }
    if (M.is('preload') && keyChanged) {
      reset('track changed during preload');
      return;
    }

    if (!a || !AU.isWired(a) || a.paused || a.seeking || !key) return;
    const dur = durationOf(a);
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (dur > Q.config.maxTrackSeconds) {
      if (!M.is('idle')) reset('long mix');
      return;
    }
    const remaining = dur - a.currentTime;
    const fade = S.settings.fadeSeconds;

    if (M.is('idle')) {
      if (failure && failure.key === key) return;
      if (performance.now() - lastDetectAt > DETECT.refreshMs) runDetect(false);
      if (remaining <= TUNING.lateMinRemainingSec + TUNING.lateLoadAllowanceSec) return;
      if (performance.now() < retryPreloadAt) return;
      if (retryPreloadAt && deferredKey === key) startPreload(key, 'retry: confirm next track');
      else if (nextKnownFor(key)) startPreload(key, 'next track known');
      else if (remaining <= fade + TUNING.preloadLeadSec) startPreload(key, 'near end');
      return;
    }
    if (M.is('preload')) {
      const plan = b && b.ready ? smartPlan() : null;
      const fadeWindow = plan && plan.ok
        ? plan.fadeSec + TUNING.endGuardSec + TUNING.beatLookaheadSec
        : fade + TUNING.endGuardSec;
      if (b && b.ready && !b.finalCheck && remaining <= fadeWindow + TUNING.confirmLeadSec) finalCheck(key);
      if (b && b.ready && remaining <= fadeWindow) {
        if (!b.track.confirmed) {
          const live = Q.domNextPath(key);
          if (live && live !== b.track.path) {
            reset(`Next up says ${live}, not preloaded ${b.track.path}; no crossfade`);
            return;
          }
        }
        if (remaining >= TUNING.lateMinRemainingSec) startFade(a, remaining, plan);
      } else if (b) {
        recheckNext(key);
      }
    }
  }

  function nextKnownFor(key) {
    const n = Q.lastNext;
    return n.forPath === key && !n.error && !!n.title;
  }

  function finalCheck(key) {
    const target = b;
    target.finalCheck = 'pending';
    Q.confirmNext().then((path) => {
      if (b !== target || !M.is('preload', 'fade') || Q.currentPath() !== key) return;
      target.finalCheck = 'done';
      if (!path) return;
      if (path === target.track.path) {
        target.track.confirmed = true;
        S.log('final Next up check: B confirmed');
      } else {
        reset(`Next up now says ${path}, not preloaded ${target.track.path}`);
      }
    }, () => { if (b === target) target.finalCheck = 'done'; });
  }

  function recheckNext(key) {
    if (rechecking || !b || performance.now() < recheckAt) return;
    rechecking = true;
    recheckAt = performance.now() + DETECT.refreshMs;
    const epoch = M.epoch;
    const want = b.track.path;
    Q.detectNext({ allowPeek: false })
      .then((r) => {
        if (M.epoch !== epoch || !M.is('preload') || !b || !r || r.cur !== key || !r.path) return;
        if (r.path === want) {
          if (r.confirmed) b.track.confirmed = true;
          return;
        }
        if (r.confirmed || !b.track.confirmed) reset(`queue changed: next is now ${r.title || r.path}`);
      }, () => { })
      .finally(() => { rechecking = false; });
  }

  const DETECT = Object.freeze({ afterTrackChangeMs: 2000, refreshMs: 15000 });
  let detectTimer = 0;
  let detecting = false;
  let lastDetectAt = 0;

  async function runDetect(allowPeek) {
    if (detecting || !S.settings.enabled || lastAd || !M.is('idle')) return;
    detecting = true;
    lastDetectAt = performance.now();
    try {
      await Q.detectNext({ allowPeek });
    } catch (_) {
    } finally {
      detecting = false;
    }
  }

  function scheduleDetect(delayMs, allowPeek) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => runDetect(allowPeek), delayMs);
  }

  function computeStatus() {
    const a = AU.a;
    const s = S.settings;
    const R = S.REASONS;
    const ln = Q.lastNext;
    const known = ln.forPath && ln.forPath === lastKey ? ln : null;
    const nextTitle = (b && b.track.title) || (known && known.confirmed && known.title) || null;
    const unconfirmed = !!(known && known.title && !known.confirmed);
    const wired = !!a && AU.isWired(a);

    let available = true;
    let reason;
    if (!s.enabled) reason = R.OFF;
    else if (!AU.supported) { available = false; reason = R.NO_WEBAUDIO; }
    else if (AU.blockReason) { available = false; reason = AU.blockReason; }
    else if (lastAd) { available = false; reason = R.AD; }
    else if (a && durationOf(a) > Q.config.maxTrackSeconds) { available = false; reason = R.LONG_MIX; }
    else if (Q.isRepeatOne()) { available = false; reason = R.REPEAT_ONE; }
    else if (failure && failure.key === lastKey) { available = false; reason = failure.reason; }
    else if (M.is('preload')) reason = b && b.ready ? `Ready: ${nextTitle || 'next track'} (buffered)` : `Loading: ${nextTitle || '…'}`;
    else if (frozen) reason = `Paused mid-crossfade into ${nextTitle || 'next track'} — resumes on Play`;
    else if (M.is('fade')) reason = `Crossfading into ${nextTitle || 'next track'}`;
    else if (M.is('handoff')) reason = `Handing off to ${nextTitle || 'next track'}`;
    else if (!wired) reason = nextTitle ? `${R.WAITING} · next: ${nextTitle}` : R.WAITING;
    else if (nextTitle) reason = `Ready: ${nextTitle}`;
    else if (known && known.error) { available = false; reason = known.error; }
    else if (unconfirmed) reason = 'Checking the Next up queue…';
    else reason = R.DETECTING;

    return S.makeStatus({
      available,
      reason,
      phase: M.state,
      currentTitle: Q.currentTitle(),
      nextTitle,
      via: b ? b.via : known && known.via,
      kind: b ? b.kind : null,
      mode: s.handoffMode,
      mix: available && s.enabled ? mixLabel() : null,
    });
  }

  function mixLabel() {
    if (fadeMix && M.is('fade', 'handoff')) return fadeMix;
    if (!b || !M.is('preload')) return null;
    return smartPlan().label;
  }

  function tick() {
    try {
      step();
    } catch (e) {
      S.warn('tick failed', e);
      reset('error');
    }
  }

  S.on('a-changed', attachA);
  const noteInput = () => { lastUserInputAt = performance.now(); };
  window.addEventListener('pointerdown', noteInput, true);
  window.addEventListener('keydown', noteInput, true);
  S.on('media-action', (action) => {
    noteInput();
    if (action === 'pause' || action === 'stop') {
      lastMediaPauseAt = performance.now();
      if (M.is('fade', 'handoff')) userPaused(`media key ${action}`);
    } else if (action === 'play' && frozen) {
      wakeOwnContext();
    }
  });
  S.on('wired', () => {
    if (holdAMuted && M.is('handoff') && AU.gainA && AU.gainA.gain.value > 0.001) {
      setGain(AU.gainA, 0, SAFETY_RAMP_SEC);
    }
  });

  setInterval(tick, TUNING.tickMs);

  S.mixer = {
    TUNING,
    reset: () => reset('manual (console)'),
    status: computeStatus,
    get preloaded() {
      return b ? {
        title: b.track.title, path: b.track.path, kind: b.kind, via: b.via, offset: b.offset, ready: b.ready,
        segments: b.hls ? `${b.hls.next}/${b.hls.segments.length}` : null,
        streamError: b.hls && b.hls.error ? String(b.hls.error.message || b.hls.error) : null,
      } : null;
    },
    get bElement() { return bEl; },
    get smart() {
      return {
        tail: aTail ? { status: aTail.status, reason: aTail.reason, res: aTail.res } : null,
        head: b ? b.beat : null,
        plan: b ? smartPlan() : null,
        sync: sync ? { ...sync, playbackRate: bEl && bEl.playbackRate } : null,
        loudness: {
          tailDb: aTail && aTail.res ? aTail.res.loudnessDb : null,
          headDb: b ? b.loudnessDb : null,
          trimDb: loudTrimDb,
          trim: loudTrim,
          restoring: restoringA(),
        },
      };
    },
  };
})();
