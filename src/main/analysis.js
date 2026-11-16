(() => {
  'use strict';
  const S = window.__SCXF__;
  if (!S || S.analysis) return;

  const OPTS = Object.freeze({
    fps: 200,
    lowHz: 150,
    highHz: 2500,
    lowWinHops: 4,
    highWinHops: 2,
    compress: 1000,
    highWeight: 0.6,
    detrendSec: 0.5,
    minBpm: 70,
    maxBpm: 170,
    priorBpm: 120,
    priorOctaves: 1.2,
    minSec: 8,
    periodSpan: 0.015,
    periodSteps: 61,
    minConfidence: 0.45,
    tempoTolerance: 0.04,
    loudHpHz: 100,
    loudFrameSec: 0.1,
    loudGateDb: -60,
  });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function onsetEnvelope(buf, s0, s1) {
    const sr = buf.sampleRate;
    const hop = Math.max(1, Math.round(sr / OPTS.fps));
    const n = Math.floor((s1 - s0) / hop);
    const chans = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
    const stereo = chans.length > 1;
    const kLow = 1 - Math.exp((-2 * Math.PI * OPTS.lowHz) / sr);
    const kHigh = 1 - Math.exp((-2 * Math.PI * OPTS.highHz) / sr);
    const eLow = new Float32Array(n);
    const eHigh = new Float32Array(n);
    let lp = 0;
    let lp2 = 0;
    for (let f = 0; f < n; f++) {
      let sl = 0;
      let sh = 0;
      const end = s0 + (f + 1) * hop;
      for (let i = s0 + f * hop; i < end; i++) {
        const x = stereo ? 0.5 * (chans[0][i] + chans[1][i]) : chans[0][i];
        lp += kLow * (x - lp);
        lp2 += kHigh * (x - lp2);
        const h = x - lp2;
        sl += lp * lp;
        sh += h * h;
      }
      eLow[f] = sl / hop;
      eHigh[f] = sh / hop;
    }

    const compressed = (e, w) => {
      const out = new Float32Array(n);
      let acc = 0;
      for (let f = 0; f < n; f++) {
        acc += e[f];
        if (f >= w) acc -= e[f - w];
        out[f] = Math.log1p((OPTS.compress * Math.max(acc, 0)) / Math.min(f + 1, w));
      }
      return out;
    };
    const L = compressed(eLow, OPTS.lowWinHops);
    const H = compressed(eHigh, OPTS.highWinHops);

    const raw = new Float32Array(n);
    for (let f = 1; f < n; f++) {
      raw[f] = Math.max(0, L[f] - L[f - 1]) + OPTS.highWeight * Math.max(0, H[f] - H[f - 1]);
    }
    const W = Math.max(1, Math.round((OPTS.detrendSec * sr) / hop / 2));
    const pre = new Float64Array(n + 1);
    for (let f = 0; f < n; f++) pre[f + 1] = pre[f] + raw[f];
    const det = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const a = Math.max(0, f - W);
      const b = Math.min(n, f + W + 1);
      det[f] = Math.max(0, raw[f] - (pre[b] - pre[a]) / (b - a));
    }
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      env[f] = 0.5 * det[f] + 0.25 * (det[f - 1] || 0) + 0.25 * (det[f + 1] || 0);
    }
    return { env, fps: sr / hop, hopSec: hop / sr };
  }

  function autocorrelation(env, maxLag) {
    const n = env.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n;
    const z = new Float32Array(n);
    let r0 = 0;
    for (let i = 0; i < n; i++) {
      z[i] = env[i] - mean;
      r0 += z[i] * z[i];
    }
    r0 /= n;
    const rho = new Float32Array(maxLag + 2);
    if (!(r0 > 0)) return rho;
    for (let lag = 1; lag <= maxLag + 1 && lag < n; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += z[i] * z[i + lag];
      rho[lag] = s / (n - lag) / r0;
    }
    return rho;
  }

  const at = (arr, x) => {
    const i = Math.floor(x);
    if (i < 0 || i >= arr.length) return 0;
    if (i + 1 >= arr.length) return arr[i];
    const t = x - i;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  };

  function comb(env, p, ph) {
    const K = Math.floor((env.length - 1 - ph) / p) + 1;
    if (K < 1) return 0;
    let s = 0;
    for (let k = 0; k < K; k++) s += at(env, ph + k * p);
    return s / K;
  }

  function fitGrid(env, lag) {
    let best = { score: -Infinity, p: lag, ph: 0 };
    for (let s = 0; s < OPTS.periodSteps; s++) {
      const p = lag * (1 - OPTS.periodSpan + (2 * OPTS.periodSpan * s) / (OPTS.periodSteps - 1));
      if ((env.length - 1) / p < 4) continue;
      for (let ph = 0; ph < p; ph += 0.5) {
        const v = comb(env, p, ph);
        if (v > best.score) best = { score: v, p, ph };
      }
    }
    let tot = 0;
    let cnt = 0;
    for (let ph = 0; ph < best.p; ph += 0.5) { tot += comb(env, best.p, ph); cnt++; }
    best.mean = cnt ? tot / cnt : 0;
    return best;
  }

  function barPhase(env, p, ph) {
    const sums = [0, 0, 0, 0];
    for (let k = 0; ph + k * p < env.length; k++) {
      const x = ph + k * p;
      sums[k % 4] += Math.max(at(env, x - 1), at(env, x), at(env, x + 1));
    }
    let bestI = 0;
    for (let i = 1; i < 4; i++) if (sums[i] > sums[bestI]) bestI = i;
    return bestI;
  }

  function analyze(buf, { fromSec = 0, toSec = Infinity } = {}) {
    const sr = buf.sampleRate;
    const s0 = clamp(Math.round(fromSec * sr), 0, buf.length);
    const s1 = clamp(Math.round(Math.min(toSec, buf.length / sr) * sr), s0, buf.length);
    const out = {
      bpm: null, beatPeriodSec: null, firstBeatSec: null, downbeatSec: null,
      confidence: 0, reason: null, analyzedSec: (s1 - s0) / sr,
    };
    if (out.analyzedSec < OPTS.minSec) { out.reason = 'too little audio'; return out; }

    const { env, fps, hopSec } = onsetEnvelope(buf, s0, s1);
    const minLag = Math.floor((60 / OPTS.maxBpm) * fps);
    const maxLag = Math.ceil((60 / OPTS.minBpm) * fps);
    const rho = autocorrelation(env, Math.min(2 * maxLag + 2, env.length - 2));

    let bestLag = -1;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * fps) / lag;
      const oct = Math.log2(bpm / OPTS.priorBpm) / OPTS.priorOctaves;
      const prior = Math.exp(-0.5 * oct * oct);
      const score = (rho[lag] + 0.5 * at(rho, 2 * lag)) * prior;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (bestLag < 0 || !(rho[bestLag] > 0)) { out.reason = 'no periodic beat'; return out; }

    const y0 = rho[bestLag - 1] || 0;
    const y1 = rho[bestLag];
    const y2 = rho[bestLag + 1] || 0;
    const denom = y0 - 2 * y1 + y2;
    const lagF = bestLag + (denom < 0 ? clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5) : 0);
    const grid = fitGrid(env, lagF);

    const bpm = (60 * fps) / grid.p;
    if (!(bpm >= OPTS.minBpm * 0.98 && bpm <= OPTS.maxBpm * 1.02)) { out.reason = 'tempo out of range'; return out; }

    const c1 = clamp((at(rho, grid.p) - 0.08) / 0.35, 0, 1);
    const ratio = grid.mean > 0 ? grid.score / grid.mean : 0;
    const c2 = clamp((ratio - 1.3) / 1.7, 0, 1);
    const confidence = Math.sqrt(c1 * c2);

    const beatPeriodSec = grid.p * hopSec;
    const firstBeatSec = fromSec + grid.ph * hopSec;
    Object.assign(out, {
      bpm,
      beatPeriodSec,
      firstBeatSec,
      downbeatSec: firstBeatSec + barPhase(env, grid.p, grid.ph) * beatPeriodSec,
      confidence,
      reason: confidence < OPTS.minConfidence ? 'low beat confidence' : null,
    });
    S.log(`beats: ${bpm.toFixed(2)} BPM, first ${firstBeatSec.toFixed(3)}s, conf ${confidence.toFixed(2)} (rho ${at(rho, grid.p).toFixed(2)}, comb ${ratio.toFixed(2)})`);
    return out;
  }

  function rms(buf, fromSec, toSec) {
    const sr = buf.sampleRate;
    const a = clamp(Math.round(fromSec * sr), 0, buf.length);
    const b = clamp(Math.round(toSec * sr), a, buf.length);
    if (b <= a) return 0;
    let s = 0;
    const nc = buf.numberOfChannels;
    for (let c = 0; c < nc; c++) {
      const d = buf.getChannelData(c);
      for (let i = a; i < b; i++) s += d[i] * d[i];
    }
    return Math.sqrt(s / ((b - a) * nc));
  }

  function loudness(buf, fromSec = 0, toSec = Infinity) {
    const sr = buf.sampleRate;
    const a = clamp(Math.round(fromSec * sr), 0, buf.length);
    const b = clamp(Math.round(Math.min(toSec, buf.length / sr) * sr), a, buf.length);
    if (b <= a) return null;
    const nc = buf.numberOfChannels;
    if (!(nc > 0)) return null;
    const chans = [];
    for (let c = 0; c < nc; c++) chans.push(buf.getChannelData(c));
    const rc = 1 / (2 * Math.PI * OPTS.loudHpHz);
    const alpha = rc / (rc + 1 / sr);
    const frame = Math.max(1, Math.min(b - a, Math.round(OPTS.loudFrameSec * sr)));
    const gate = Math.pow(10, OPTS.loudGateDb / 10);
    const xPrev = new Float64Array(nc);
    const yPrev = new Float64Array(nc);
    for (let c = 0; c < nc; c++) xPrev[c] = chans[c][a];
    let sum = 0;
    let kept = 0;
    for (let f0 = a; f0 + frame <= b; f0 += frame) {
      let s = 0;
      for (let c = 0; c < nc; c++) {
        const d = chans[c];
        let xp = xPrev[c];
        let yp = yPrev[c];
        for (let i = f0; i < f0 + frame; i++) {
          const x = d[i];
          yp = alpha * (yp + x - xp);
          xp = x;
          s += yp * yp;
        }
        xPrev[c] = xp;
        yPrev[c] = yp;
      }
      const ms = s / (frame * nc);
      if (ms >= gate) { sum += ms; kept++; }
    }
    if (!kept) return null;
    return 10 * Math.log10(sum / kept);
  }

  function matchTempo(a, b, { tolerance = OPTS.tempoTolerance, minConfidence = OPTS.minConfidence } = {}) {
    if (!a || !a.bpm) return { ok: false, reason: `this track: ${(a && a.reason) || 'no beat found'}` };
    if (!b || !b.bpm) return { ok: false, reason: `next track: ${(b && b.reason) || 'no beat found'}` };
    if (a.confidence < minConfidence) return { ok: false, reason: 'this track: low beat confidence' };
    if (b.confidence < minConfidence) return { ok: false, reason: 'next track: low beat confidence' };
    let best = null;
    for (const mult of [1, 2, 0.5]) {
      const rate = a.bpm / (b.bpm * mult);
      const dev = Math.abs(rate - 1);
      if (!best || dev < best.dev) best = { rate, mult, dev };
    }
    if (best.dev > tolerance) {
      return { ok: false, reason: `tempos too far apart (${Math.round(a.bpm)} vs ${Math.round(b.bpm)} BPM)` };
    }
    return { ok: true, rate: best.rate, mult: best.mult };
  }

  function recommendFade({ userSec, tailRms, headRms, beatPeriodSec, minSec = 1, maxSec = 12 }) {
    let contrastDb = 0;
    let factor = 1;
    if (tailRms > 0 || headRms > 0) {
      contrastDb = 20 * Math.log10((headRms + 1e-6) / (tailRms + 1e-6));
      const c = Math.abs(contrastDb);
      factor = c <= 2 ? 0.9 : c >= 12 ? 1.25 : 0.9 + ((c - 2) / 10) * 0.35;
    }
    let sec = clamp(userSec * factor, minSec, maxSec);
    const P = beatPeriodSec;
    if (P > 0) {
      const beats = sec / P;
      const bars = Math.round(beats / 4) * 4;
      let n = bars >= 4 && Math.abs(bars * P - sec) <= 0.25 * sec ? bars : Math.max(1, Math.round(beats));
      while (n > 1 && n * P > maxSec) n--;
      while (n * P < minSec) n++;
      sec = n * P;
    }
    return { fadeSec: sec, contrastDb, factor };
  }

  S.analysis = { OPTS, analyze, rms, loudness, matchTempo, recommendFade };
})();
