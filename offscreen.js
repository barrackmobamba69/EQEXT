'use strict';

// Offscreen document: the only extension context with Web Audio access.
// Captures the tab's MediaStream, chains 8 BiquadFilterNodes in series, and
// reconnects to the speakers — tabCapture mutes the tab's direct output, so
// without the reconnect the tab would go silent.

let ctx = null;
let media = null;
let source = null;
let filters = [];
let master = null;
let analyser = null;
let frameTimer = null;
let running = false;
let tabId = null;
let tabTitle = '';

let state = {
  bands: EQ.DEFAULT_BANDS.map((b) => ({ ...b })),
  globals: { ...EQ.DEFAULT_GLOBALS },
};

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
    case 'setBand':
      if (msg.band && state.bands[msg.index]) {
        state.bands[msg.index] = { ...msg.band };
        if (running) EQ.applyBand(filters[msg.index], state.bands[msg.index], state.globals, ctx.currentTime);
      }
      sendResponse({ ok: true });
      break;
    case 'setGlobals':
      Object.assign(state.globals, msg.globals || {});
      if (running) {
        master.gain.setTargetAtTime(Math.pow(10, state.globals.outGain / 20), ctx.currentTime, 0.02);
        // scale / adaptiveQ change every band's effective params
        state.bands.forEach((b, i) => EQ.applyBand(filters[i], b, state.globals, ctx.currentTime));
      }
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

async function start({ streamId, tabId: tid, tabTitle: title, state: incoming }) {
  try {
    stop(false);
    if (incoming?.bands && incoming?.globals) {
      state = {
        bands: incoming.bands.map((b) => ({ ...b })),
        globals: { ...incoming.globals },
      };
    }
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

    filters = state.bands.map(() => ctx.createBiquadFilter());
    state.bands.forEach((b, i) => EQ.applyBand(filters[i], b, state.globals));

    master = ctx.createGain();
    master.gain.value = Math.pow(10, state.globals.outGain / 20);

    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.8;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -15;

    let node = source;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(master);
    master.connect(ctx.destination);
    master.connect(analyser); // post-EQ tap for the spectrum display
    await ctx.resume();

    media.getAudioTracks()[0].addEventListener('ended', () => stop(true));

    running = true;
    tabId = tid ?? null;
    tabTitle = title || '';

    // ~30fps FFT frames for the panel's spectrum silhouette. Typed arrays
    // don't survive runtime messaging, hence Array.from. The catch swallows
    // "no receiver" errors while the panel is closed.
    const bins = new Uint8Array(analyser.frequencyBinCount);
    frameTimer = setInterval(() => {
      analyser.getByteFrequencyData(bins);
      chrome.runtime.sendMessage({
        target: 'panel',
        type: 'spectrum',
        sr: ctx.sampleRate,
        fft: analyser.fftSize,
        data: Array.from(bins),
      }).catch(() => {});
    }, 33);

    broadcastStatus();
    return status();
  } catch (e) {
    stop(true);
    return { ok: false, error: e.message || String(e) };
  }
}

function stop(notify) {
  clearInterval(frameTimer);
  frameTimer = null;
  if (media) media.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close().catch(() => {});
  ctx = source = media = master = analyser = null;
  filters = [];
  running = false;
  tabId = null;
  tabTitle = '';
  if (notify) broadcastStatus();
}
