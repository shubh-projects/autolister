import { API_BASE_URL } from './config.js';

async function ensureSession() {
  const stored = await chrome.storage.local.get(['deviceToken']);
  if (stored.deviceToken) return stored.deviceToken;

  const response = await fetch(`${API_BASE_URL}/api/session`, { method: 'POST' });
  if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
  const data = await response.json();
  await chrome.storage.local.set({ deviceToken: data.deviceToken, sessionId: data.sessionId });
  return data.deviceToken;
}

chrome.runtime.onInstalled.addListener(() => { ensureSession().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureSession().catch(() => {}); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'ensure-session') {
      sendResponse({ ok: true, deviceToken: await ensureSession() });
    } else {
      sendResponse({ ok: false, error: 'Unknown message.' });
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
