(() => {
  'use strict';

  const token = Math.random().toString(36).slice(2);
  document.documentElement.dataset.scxfBridge = token;
  const isCurrent = () => document.documentElement.dataset.scxfBridge === token;

  const CHANNEL_TO_MAIN = 'scxf:v1:to-main';
  const CHANNEL_TO_ISO = 'scxf:v1:to-iso';
  const PROXY_MESSAGE_TYPE = 'scxf:proxy-fetch';
  const ALLOWED_PROXY_HOST = /(^|\.)(sndcdn\.com|soundcloud\.cloud)$/i;

  const warn = (...a) => console.warn('[PreGradien]', ...a);

  function toMain(type, payload, transfer) {
    try {
      window.postMessage({ channel: CHANNEL_TO_MAIN, type, payload }, window.location.origin, transfer || []);
    } catch (e) {
      warn('postMessage to MAIN failed', e);
    }
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function isAllowedProxyUrl(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' && ALLOWED_PROXY_HOST.test(u.hostname);
    } catch (_) {
      return false;
    }
  }

  async function proxyFetch(payload) {
    const { id, url, range } = payload || {};
    if (!id) return;
    const reply = (body, transfer) => toMain('response', { id, ...body }, transfer);
    if (typeof url !== 'string' || !isAllowedProxyUrl(url)) {
      reply({ ok: false, status: 0, error: 'URL not allowed' });
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: PROXY_MESSAGE_TYPE, url, range: range || null });
      if (!res || !res.ok) {
        reply({ ok: false, status: (res && res.status) || 0, error: (res && res.error) || 'proxy failed' });
        return;
      }
      const buffer = base64ToArrayBuffer(res.base64);
      reply({ ok: true, status: res.status, contentType: res.contentType || '', buffer }, [buffer]);
    } catch (err) {
      reply({ ok: false, status: 0, error: String((err && err.message) || err) });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin || !isCurrent()) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.channel !== CHANNEL_TO_ISO) return;
    if (d.type === 'proxy-fetch') proxyFetch(d.payload);
  });
})();
