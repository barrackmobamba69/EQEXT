'use strict';

// Side panel UI. Talks to background (capture start) and directly to the
// offscreen document (everything else) via extension-wide runtime messages.

/* ---------------- state ---------------- */

const state = {
  bands: EQ.DEFAULT_BANDS.map((b) => ({ ...b })),
  globals: { ...EQ.DEFAULT_GLOBALS },
};
let selected = 2; // first default-enabled bell
const capture = { running: false, tabId: null, tabTitle: '', sampleRate: 48000 };

/* ---------------- persistence ---------------- */

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ eqState: { v: 1, bands: state.bands, globals: state.globals } });
  }, 250);
}

async function loadState() {
  const { eqState } = await chrome.storage.local.get('eqState');
  if (eqState?.v === 1) {
    (eqState.bands || []).forEach((b, i) => {
      if (state.bands[i]) state.bands[i] = { ...state.bands[i], ...b };
    });
    Object.assign(state.globals, eqState.globals || {});
  }
}

/* ---------------- messaging ---------------- */

function toOffscreen(msg) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}
function pushBand(i) {
  toOffscreen({ type: 'setBand', index: i, band: state.bands[i] });
}
function pushGlobals() {
  toOffscreen({ type: 'setGlobals', globals: state.globals });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'status') applyStatus(msg);
});

function applyStatus(s) {
  capture.running = !!s.running;
  capture.tabId = s.tabId ?? null;
  capture.tabTitle = s.tabTitle || '';
  if (s.sampleRate) capture.sampleRate = s.sampleRate;
  updateHeader();
}

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
      state: { bands: state.bands, globals: state.globals },
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

/* ---------------- mutations ---------------- */

function bandChanged(i) {
  pushBand(i);
  scheduleSave();
  if (i === selected) updateBandUI();
  updateBandRow();
}

function setBand(i, patch) {
  Object.assign(state.bands[i], patch);
  bandChanged(i);
}

function selectBand(i) {
  selected = i;
  updateBandRow();
  updateBandUI();
}

/* ---------------- header / status ---------------- */

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

powerBtn.addEventListener('click', () => {
  if (capture.running) stopCapture();
  else startCapture();
});

/* ---------------- band row ---------------- */

const bandRowEl = document.getElementById('bandRow');
const cells = [];

function buildBandRow() {
  state.bands.forEach((band, i) => {
    const cell = document.createElement('div');
    cell.className = 'bandCell';

    const num = document.createElement('button');
    num.className = 'num';
    num.textContent = String(i + 1);
    num.title = 'Enable/disable band ' + (i + 1);
    num.addEventListener('click', (e) => {
      e.stopPropagation();
      setBand(i, { on: !state.bands[i].on });
    });

    const sel = document.createElement('select');
    sel.className = 'tsel';
    for (const t of EQ.FILTER_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      sel.appendChild(opt);
    }
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      selectBand(i);
      setBand(i, { type: sel.value });
    });

    cell.appendChild(num);
    cell.appendChild(sel);
    cell.addEventListener('click', () => selectBand(i));
    bandRowEl.appendChild(cell);
    cells.push(cell);
  });
}

function updateBandRow() {
  cells.forEach((cell, i) => {
    cell.classList.toggle('sel', i === selected);
    cell.classList.toggle('on', state.bands[i].on);
    cell.querySelector('.tsel').value = state.bands[i].type;
  });
}

/* ---------------- selected-band edit ---------------- */

const selLabel = document.getElementById('selLabel');
const inFreq = document.getElementById('inFreq');
const inGain = document.getElementById('inGain');
const inQ = document.getElementById('inQ');

function updateBandUI() {
  const band = state.bands[selected];
  const type = EQ.FILTER_TYPES.find((t) => t.id === band.type);
  selLabel.textContent = 'Band ' + (selected + 1) + ' — ' + (type ? type.label : band.type);
  inFreq.value = Math.round(band.freq);
  inGain.value = band.gain;
  inQ.value = band.q;
  inGain.disabled = !EQ.USES_GAIN[band.type];
  inQ.disabled = band.type === 'lowshelf' || band.type === 'highshelf';
}

inFreq.addEventListener('input', () => {
  const v = parseFloat(inFreq.value);
  if (Number.isFinite(v)) setBand(selected, { freq: EQ.clamp(v, EQ.FREQ_MIN, EQ.FREQ_MAX) });
});
inGain.addEventListener('input', () => {
  const v = parseFloat(inGain.value);
  if (Number.isFinite(v)) setBand(selected, { gain: EQ.clamp(v, -EQ.GAIN_MAX, EQ.GAIN_MAX) });
});
inQ.addEventListener('input', () => {
  const v = parseFloat(inQ.value);
  if (Number.isFinite(v)) setBand(selected, { q: EQ.clamp(v, EQ.Q_MIN, EQ.Q_MAX) });
});

/* ---------------- init ---------------- */

(async function init() {
  await loadState();
  buildBandRow();
  updateBandRow();
  updateBandUI();
  updateHeader();
  queryStatus();
})();
