'use strict';

// Offscreen document: the only extension context with Web Audio access.
// Captures the tab's MediaStream and (step 1) passes it straight through to
// the speakers — tabCapture mutes the tab's direct output, so without this
// reconnect the tab would go silent.

let ctx = null;
let media = null;
let source = null;
let running = false;
let tabId = null;
let tabTitle = '';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg).then(sendResponse);
      return true; // async sendResponse
    case 'stop':
      stop(true);
      sendResponse({ ok: true });
      break;
    case 'query':
      sendResponse(status());
      break;
  }
});

function status() {
  return { ok: true, running, tabId, tabTitle, sampleRate: ctx ? ctx.sampleRate : null };
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ target: 'panel', type: 'status', ...status() }).catch(() => {});
}

async function start({ streamId, tabId: tid, tabTitle: title }) {
  try {
    stop(false);
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(media);
    source.connect(ctx.destination);
    await ctx.resume();

    media.getAudioTracks()[0].addEventListener('ended', () => stop(true));

    running = true;
    tabId = tid ?? null;
    tabTitle = title || '';
    broadcastStatus();
    return status();
  } catch (e) {
    stop(true);
    return { ok: false, error: e.message || String(e) };
  }
}

function stop(notify) {
  if (media) media.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close().catch(() => {});
  ctx = source = media = null;
  running = false;
  tabId = null;
  tabTitle = '';
  if (notify) broadcastStatus();
}
