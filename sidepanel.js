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

let spectrum = null;   // latest FFT frame from the offscreen doc
let paintDirty = true; // canvas repaint needed
let curveDirty = true; // response curve recompute needed

function markDirty(curveToo) {
  paintDirty = true;
  if (curveToo) curveDirty = true;
}

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
  else if (msg.type === 'spectrum') spectrum = msg;
});

function applyStatus(s) {
  capture.running = !!s.running;
  capture.tabId = s.tabId ?? null;
  capture.tabTitle = s.tabTitle || '';
  if (s.sampleRate) {
    capture.sampleRate = s.sampleRate;
    if (s.sampleRate !== curve.sampleRate) curve.setSampleRate(s.sampleRate);
  }
  if (!capture.running) spectrum = null;
  updateHeader();
  markDirty(false);
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
  markDirty(true);
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
  markDirty(true); // selected-band overlay curve changes
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

/* ---------------- response curve ---------------- */

class ResponseCurve {
  constructor(points = 256) {
    this.n = points;
    this.mag = new Float32Array(points);
    this.phase = new Float32Array(points);
    this.total = new Float32Array(points);  // summed dB of all enabled bands
    this.single = new Float32Array(points); // selected band's own dB
    this.setSampleRate(48000);
  }

  // Throwaway OfflineAudioContext: getFrequencyResponse only needs a node,
  // not a running graph. Rebuilt if the offscreen context reports a different
  // sample rate so the drawn curve matches the audible one near Nyquist.
  setSampleRate(sr) {
    this.sampleRate = sr;
    this.ctx = new OfflineAudioContext(1, 1, sr);
    this.filter = this.ctx.createBiquadFilter();
    this.freqs = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.freqs[i] = EQ.FREQ_MIN * Math.pow(EQ.FREQ_MAX / EQ.FREQ_MIN, i / (this.n - 1));
    }
    curveDirty = true;
  }

  compute(bands, globals, selectedIdx) {
    this.total.fill(0);
    this.single.fill(0);
    bands.forEach((band, bi) => {
      if (!band.on) return;
      EQ.applyBand(this.filter, band, globals);
      this.filter.getFrequencyResponse(this.freqs, this.mag, this.phase);
      for (let i = 0; i < this.n; i++) {
        const db = 20 * Math.log10(Math.max(this.mag[i], 1e-6));
        this.total[i] += db;
        if (bi === selectedIdx) this.single[i] = db;
      }
    });
  }
}

const curve = new ResponseCurve();

/* ---------------- canvas rendering ---------------- */

const canvas = document.getElementById('graph');
const g2d = canvas.getContext('2d');
let dpr = 1;

const DB_RANGE = 18;
const NODE_R = 8;

const xForFreq = (f, W) => W * (Math.log10(f / EQ.FREQ_MIN) / Math.log10(EQ.FREQ_MAX / EQ.FREQ_MIN));
const freqForX = (x, W) => EQ.FREQ_MIN * Math.pow(EQ.FREQ_MAX / EQ.FREQ_MIN, x / W);
const yForDb = (db, H) => H / 2 - (db / DB_RANGE) * (H / 2);
const dbForY = (y, H) => ((H / 2 - y) / (H / 2)) * DB_RANGE;

function nodePos(band, W, H) {
  return {
    x: xForFreq(EQ.clamp(band.freq, EQ.FREQ_MIN, EQ.FREQ_MAX), W),
    y: yForDb(EQ.bandGainDb(band, state.globals), H),
  };
}

function fitCanvas() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    markDirty(false);
  }
}

const FREQ_LABELS = [
  [50, '50'], [100, '100'], [200, '200'], [500, '500'],
  [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'],
];

function drawGrid(W, H) {
  g2d.lineWidth = 1;
  for (let dec = 10; dec < EQ.FREQ_MAX; dec *= 10) {
    for (let m = 1; m <= 9; m++) {
      const f = dec * m;
      if (f < EQ.FREQ_MIN || f > EQ.FREQ_MAX) continue;
      const x = Math.round(xForFreq(f, W)) + 0.5;
      g2d.strokeStyle = m === 1 ? '#333333' : '#242424';
      g2d.beginPath(); g2d.moveTo(x, 0); g2d.lineTo(x, H); g2d.stroke();
    }
  }
  for (const db of [-12, -6, 6, 12]) {
    const y = Math.round(yForDb(db, H)) + 0.5;
    g2d.strokeStyle = '#242424';
    g2d.beginPath(); g2d.moveTo(0, y); g2d.lineTo(W, y); g2d.stroke();
  }
  const y0 = Math.round(yForDb(0, H)) + 0.5;
  g2d.strokeStyle = '#3d3d3d';
  g2d.beginPath(); g2d.moveTo(0, y0); g2d.lineTo(W, y0); g2d.stroke();

  g2d.fillStyle = '#6a6a6a';
  g2d.font = '9px "Segoe UI", sans-serif';
  g2d.textAlign = 'center';
  for (const [f, label] of FREQ_LABELS) g2d.fillText(label, xForFreq(f, W), H - 3);
  g2d.textAlign = 'left';
  for (const db of [-12, -6, 0, 6, 12]) {
    g2d.fillText((db > 0 ? '+' : '') + db, 3, yForDb(db, H) - 2);
  }
}

function drawSpectrum(W, H) {
  if (!spectrum || !capture.running) return;
  const { sr, fft, data } = spectrum;
  const binHz = sr / fft;
  g2d.beginPath();
  g2d.moveTo(0, H);
  let prevBin = Math.max(1, Math.floor(EQ.FREQ_MIN / binHz));
  for (let x = 0; x <= W; x += 2) {
    const f = freqForX(x, W);
    const bin = Math.min(data.length - 1, Math.max(1, Math.round(f / binHz)));
    // max over the bin range one pixel covers, so HF peaks survive the log axis
    let v = 0;
    for (let b = Math.min(prevBin, bin); b <= bin; b++) v = Math.max(v, data[b]);
    prevBin = bin + 1;
    g2d.lineTo(x, H - (v / 255) * H);
  }
  g2d.lineTo(W, H);
  g2d.closePath();
  g2d.fillStyle = 'rgba(255, 255, 255, 0.07)';
  g2d.fill();
  g2d.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  g2d.lineWidth = 1;
  g2d.stroke();
}

function curveY(arr, i, H) {
  return yForDb(EQ.clamp(arr[i], -DB_RANGE * 1.6, DB_RANGE * 1.6), H);
}

function drawCurve(W, H) {
  const n = curve.n;
  const xAt = (i) => (i / (n - 1)) * W;

  // shaded area between the summed curve and the 0 dB line
  g2d.beginPath();
  g2d.moveTo(0, curveY(curve.total, 0, H));
  for (let i = 1; i < n; i++) g2d.lineTo(xAt(i), curveY(curve.total, i, H));
  g2d.lineTo(W, yForDb(0, H));
  g2d.lineTo(0, yForDb(0, H));
  g2d.closePath();
  g2d.fillStyle = 'rgba(255, 255, 255, 0.06)';
  g2d.fill();

  // selected band's individual response
  if (state.bands[selected]?.on) {
    g2d.beginPath();
    g2d.moveTo(0, curveY(curve.single, 0, H));
    for (let i = 1; i < n; i++) g2d.lineTo(xAt(i), curveY(curve.single, i, H));
    g2d.strokeStyle = 'rgba(255, 176, 46, 0.55)';
    g2d.lineWidth = 1;
    g2d.stroke();
  }

  // summed curve
  g2d.beginPath();
  g2d.moveTo(0, curveY(curve.total, 0, H));
  for (let i = 1; i < n; i++) g2d.lineTo(xAt(i), curveY(curve.total, i, H));
  g2d.strokeStyle = '#f2f2f2';
  g2d.lineWidth = 1.5;
  g2d.stroke();
}

function drawNodes(W, H) {
  const order = state.bands.map((_, i) => i).filter((i) => i !== selected);
  order.push(selected); // selected drawn on top
  g2d.font = 'bold 10px "Segoe UI", sans-serif';
  g2d.textAlign = 'center';
  g2d.textBaseline = 'middle';
  for (const i of order) {
    const band = state.bands[i];
    const { x, y } = nodePos(band, W, H);
    const isSel = i === selected;
    g2d.beginPath();
    g2d.arc(x, y, NODE_R, 0, Math.PI * 2);
    g2d.fillStyle = isSel ? '#ffb02e' : (band.on ? '#2d2d2d' : '#202020');
    g2d.fill();
    g2d.strokeStyle = isSel ? '#ffb02e' : (band.on ? '#cfcfcf' : '#5a5a5a');
    g2d.lineWidth = 1.2;
    g2d.stroke();
    g2d.fillStyle = isSel ? '#111' : (band.on ? '#e8e8e8' : '#777');
    g2d.fillText(String(i + 1), x, y + 0.5);
  }
  g2d.textBaseline = 'alphabetic';
}

function drawReadout() {
  const band = state.bands[selected];
  const gainTxt = EQ.USES_GAIN[band.type] ? EQ.formatDb(band.gain) : '—';
  g2d.fillStyle = '#9a9a9a';
  g2d.font = '10px "Segoe UI", sans-serif';
  g2d.textAlign = 'left';
  g2d.fillText(
    (selected + 1) + '   ' + EQ.formatHz(band.freq) + '   ' + gainTxt + '   Q ' + band.q.toFixed(2),
    6, 12
  );
}

function draw() {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2d.clearRect(0, 0, W, H);
  drawGrid(W, H);
  drawSpectrum(W, H);
  if (curveDirty) {
    curve.compute(state.bands, state.globals, selected);
    curveDirty = false;
  }
  drawCurve(W, H);
  drawNodes(W, H);
  drawReadout();
}

function frame() {
  requestAnimationFrame(frame);
  fitCanvas();
  if (paintDirty || (capture.running && spectrum)) {
    draw();
    paintDirty = false;
  }
}

/* ---------------- node hit-testing / selection ---------------- */

function evtPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
}

function hitNode(x, y, W, H) {
  let best = -1;
  let bestDist = NODE_R + 6; // px tolerance
  state.bands.forEach((band, i) => {
    const p = nodePos(band, W, H);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  const { x, y, W, H } = evtPos(e);
  const hit = hitNode(x, y, W, H);
  if (hit >= 0) selectBand(hit);
});

/* ---------------- init ---------------- */

(async function init() {
  await loadState();
  buildBandRow();
  updateBandRow();
  updateBandUI();
  updateHeader();
  requestAnimationFrame(frame);
  queryStatus();
})();
