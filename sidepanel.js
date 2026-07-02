'use strict';

// Side panel UI. Talks to background (capture start) and directly to the
// offscreen document (everything else) via extension-wide runtime messages.

const capture = { running: false, tabId: null, tabTitle: '', sampleRate: 48000 };

const powerBtn = document.getElementById('power');
const targetEl = document.getElementById('target');
const statusEl = document.getElementById('status');

function setStatusLine(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('err', !!isError);
}

function updateHeader() {
  powerBtn.classList.toggle('on', capture.running);
  targetEl.textContent = capture.running
    ? '● ' + (capture.tabTitle || 'tab ' + capture.tabId)
    : 'not capturing';
}

function toOffscreen(msg) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

function applyStatus(s) {
  capture.running = !!s.running;
  capture.tabId = s.tabId ?? null;
  capture.tabTitle = s.tabTitle || '';
  if (s.sampleRate) capture.sampleRate = s.sampleRate;
  updateHeader();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'status') applyStatus(msg);
});

async function queryStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'query' });
    if (s?.ok) applyStatus(s);
  } catch (e) { /* offscreen not created yet */ }
}

async function startCapture() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) { setStatusLine('No active tab found.', true); return; }
  setStatusLine('Starting capture…');
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'startCapture',
      tabId: tab.id,
      tabTitle: tab.title || '',
      state: null,
    });
  } catch (e) {
    res = { ok: false, error: e.message || String(e) };
  }
  if (!res?.ok) {
    setStatusLine(
      (res?.error || 'Capture failed.') +
      ' — if this says the extension was not invoked, click the toolbar icon while on that tab, then try again.',
      true
    );
    return;
  }
  applyStatus(res);
  setStatusLine('');
}

function stopCapture() {
  toOffscreen({ type: 'stop' });
}

powerBtn.addEventListener('click', () => {
  if (capture.running) stopCapture();
  else startCapture();
});

updateHeader();
queryStatus();
