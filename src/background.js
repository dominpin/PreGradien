'use strict';

const PROXY = Object.freeze({
  messageType: 'scxf:proxy-fetch',
  allowedHostSuffixes: ['.sndcdn.com', '.soundcloud.cloud'],
  maxBytes: 48 * 1024 * 1024,
  timeoutMs: 60000,
});

async function injectIntoOpenTabs() {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['*://soundcloud.com/*'] });
  } catch (err) {
    console.warn('[PreGradien] tab query failed', err);
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    try {
      for (const cs of scripts) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: cs.js,
          world: cs.world || 'ISOLATED',
          injectImmediately: true,
        });
      }
    } catch (err) {
      console.warn(`[PreGradien] could not inject into tab ${tab.id}`, err);
    }
  }
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);

function isAllowedMediaUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && PROXY.allowedHostSuffixes.some((s) => u.hostname.endsWith(s));
  } catch (_) {
    return false;
  }
}

function isSoundCloudSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const url = sender.url || (sender.tab && sender.tab.url) || '';
  return /^https?:\/\/soundcloud\.com\//.test(url);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function normalizeRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [start, end] = range.map(Number);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  return [start, end];
}

async function proxyFetch({ url, range }) {
  if (!isAllowedMediaUrl(url)) return { ok: false, status: 0, error: 'URL not allowed' };
  const r = normalizeRange(range);
  const headers = r ? { Range: `bytes=${r[0]}-${r[1]}` } : undefined;
  const res = await fetch(url, {
    headers,
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(PROXY.timeoutMs),
  });
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > PROXY.maxBytes) return { ok: false, status: res.status, error: 'Response too large' };
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > PROXY.maxBytes) return { ok: false, status: res.status, error: 'Response too large' };
  return {
    ok: true,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    byteLength: buffer.byteLength,
    base64: arrayBufferToBase64(buffer),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== PROXY.messageType) return false;
  if (!isSoundCloudSender(sender)) {
    sendResponse({ ok: false, status: 0, error: 'Sender not allowed' });
    return false;
  }
  proxyFetch(msg).then(sendResponse, (err) =>
    sendResponse({ ok: false, status: 0, error: String((err && err.message) || err) })
  );
  return true;
});
