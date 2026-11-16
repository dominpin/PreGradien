(() => {
  'use strict';
  const S = window.__SCXF__;
  if (!S || S.silence) return;

  const OPTS = Object.freeze({
    thresholdDb: -50,
    headBytes: 256 * 1024,
    maxTrimSec: 10,
    safetySec: 0.02,
  });

  function scanBuffer(audioBuffer, { thresholdDb = OPTS.thresholdDb, maxSec = OPTS.maxTrimSec } = {}) {
    const threshold = Math.pow(10, thresholdDb / 20);
    const limit = Math.min(audioBuffer.length, Math.floor(maxSec * audioBuffer.sampleRate));
    let first = -1;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const end = first >= 0 ? first : limit;
      for (let i = 0; i < end; i++) {
        const v = data[i];
        if (v > threshold || v < -threshold) {
          first = i;
          break;
        }
      }
    }
    return first < 0 ? null : first / audioBuffer.sampleRate;
  }

  function decodeHead(buffer) {
    const ctx = (S.audio && S.audio.ctx) || new OfflineAudioContext(1, 1, 44100);
    return ctx.decodeAudioData(buffer.slice(0));
  }

  function concat(buffers) {
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of buffers) {
      out.set(new Uint8Array(b), at);
      at += b.byteLength;
    }
    return out.buffer;
  }

  async function findHeadOffset(url, { headBuffer = null, chunks = null } = {}) {
    let buf = headBuffer;
    if (!buf && chunks && chunks.length) buf = concat(chunks);
    if (!buf) {
      if (!url) throw new Error('nothing to scan');
      buf = (await S.net.fetchBytes(url, { range: [0, OPTS.headBytes - 1] })).buffer;
    }
    const decoded = await decodeHead(buf);
    const firstSoundSec = scanBuffer(decoded);
    const offset = firstSoundSec == null ? 0 : Math.max(0, firstSoundSec - OPTS.safetySec);
    S.log(`silence scan: first sound at ${firstSoundSec == null ? 'n/a' : firstSoundSec.toFixed(3)}s of ${decoded.duration.toFixed(2)}s -> offset ${offset.toFixed(3)}s`);
    return { offset, firstSoundSec, scannedSec: decoded.duration, decoded };
  }

  S.silence = { OPTS, scanBuffer, decodeHead, concat, findHeadOffset };
})();
