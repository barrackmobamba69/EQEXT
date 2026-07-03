'use strict';

// Broker only: keeps one offscreen document alive and resolves tabCapture
// stream ids. All audio processing lives in offscreen.js; the UI is the
// action popup, which re-grants activeTab on every toolbar click so
// getMediaStreamId always has a valid invocation for the current tab.

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Runs the Web Audio graph that applies an 8-band EQ to captured tab audio.',
  });
}

function getStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(streamId);
    });
  });
}

// createDocument resolves when the page loads, but retry briefly in case the
// offscreen listener isn't registered yet when the first message lands.
async function sendToOffscreen(msg) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res !== undefined) return res;
    } catch (e) { /* no receiver yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Offscreen document did not respond.');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'startCapture') {
    (async () => {
      try {
        await ensureOffscreen();
        const streamId = await getStreamId(msg.tabId);
        const res = await sendToOffscreen({
          target: 'offscreen',
          type: 'start',
          streamId,
          tabId: msg.tabId,
          tabTitle: msg.tabTitle,
          state: msg.state,
        });
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async sendResponse
  }
});
