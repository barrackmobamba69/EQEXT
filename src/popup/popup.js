'use strict';

// Action-popup UI, styled after Ableton Live's EQ Eight (mid-gray theme).
// Talks to background (capture start) and directly to the offscreen document
// (everything else) via extension-wide runtime messages. The response curve
// is computed locally from the same shared band->filter mapping the offscreen
// doc uses, so it always matches the audible EQ.
// NOTE: popups close on blur — clicking the page to test audio closes this
// popup; the offscreen capture keeps running, just reopen it (expected, not a bug).

/* ---------------- state ---------------- */

const state = {
  bands: EQ.DEFAULT_BANDS.map((b) => ({ ...b })),
  globals: { ...EQ.DEFAULT_GLOBALS },
};
let selected = 2; // first default-enabled bell
let preset = { name: 'Default', dirty: false }; // shown in the title bar
const capture = { running: false, tabId: null, tabTitle: '', sampleRate: 48000 };

let spectrum = null;     // latest FFT frame from the offscreen doc
let showSpectrum = true; // analyzer display toggle (right column button)
let paintDirty = true;   // canvas repaint needed
let curveDirty = true;   // response curve recompute needed

function markDirty(curveToo) {
  paintDirty = true;
  if (curveToo) curveDirty = true;
}

/* ---------------- persistence ---------------- */

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ eqState: { v: 1, bands: state.bands, globals: state.globals, preset } });
  }, 250);
}

async function loadState() {
  const { eqState } = await chrome.storage.local.get('eqState');
  if (eqState?.v !== 1) return;
  // Wholesale replacement — never a field-by-field merge into the live array,
  // so no stale fields from a previous state can survive a load.
  if (Array.isArray(eqState.bands)) {
    state.bands = EQ.DEFAULT_BANDS.map((d, i) => EQ.sanitizeBand(eqState.bands[i], i));
  }
  state.globals = EQ.sanitizeGlobals({ ...state.globals, ...(eqState.globals || {}) });
  if (typeof eqState.preset?.name === 'string') {
    preset = { name: eqState.preset.name.slice(0, 40), dirty: !!eqState.preset.dirty };
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
  // While capture runs, the offscreen doc is the single source of truth for
  // the audible chain: adopt its echoed state wholesale so the popup can
  // never render nodes/curve from a copy the filters aren't actually using.
  if (capture.running && Array.isArray(s.state?.bands)) {
    state.bands = EQ.DEFAULT_BANDS.map((d, i) => EQ.sanitizeBand(s.state.bands[i], i));
    state.globals = EQ.sanitizeGlobals(s.state.globals);
    if (cells.length) {
      updateBandRow();
      updateBandUI();
      updateGlobalUI();
    }
    markDirty(true);
  }
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
    setStatusLine(res?.error || 'Capture failed.', true);
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
  if (!preset.dirty) { // any edit after loading a preset marks it modified (*)
    preset.dirty = true;
    updatePresetUI();
  }
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
  markDirty(true); // the selected-band overlay curve follows the selection
  updateBandRow();
  updateBandUI();
}

function setGlobals(patch) {
  Object.assign(state.globals, patch);
  markDirty(true); // scale/adaptive Q reshape the curve and move nodes
  pushGlobals();
  scheduleSave();
  updateGlobalUI();
}

/* ---------------- header / status ---------------- */

const powerBtn = document.getElementById('power');
const targetEl = document.getElementById('target');
const statusEl = document.getElementById('status');

function setStatusLine(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('err', !!isError);
}

let statusFlashTimer = null;
function flashStatus(text) {
  setStatusLine(text);
  clearTimeout(statusFlashTimer);
  statusFlashTimer = setTimeout(() => setStatusLine(''), 1800);
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

/* ---------------- filter-type icons ---------------- */

const TYPE_PATHS = {
  highpass:  'M2 12 C7 12 7 3 12 3 L22 3',
  lowshelf:  'M2 4 L8 4 C12 4 12 9 16 9 L22 9',
  peaking:   'M2 8 L6 8 C9 8 9 3 12 3 C15 3 15 8 18 8 L22 8',
  notch:     'M2 6 L7 6 C10 6 10 12 12 12 C14 12 14 6 17 6 L22 6',
  bandpass:  'M2 12 C8 12 8 4 12 4 C16 4 16 12 22 12',
  allpass:   'M2 7 L22 7 M9 12 C12 12 12 2 15 2',
  highshelf: 'M2 9 L8 9 C12 9 12 4 16 4 L22 4',
  lowpass:   'M2 3 L12 3 C17 3 17 12 22 12',
};

function typeIcon(typeId, w = 24, h = 15) {
  return '<svg viewBox="0 0 24 15" width="' + w + '" height="' + h + '" aria-hidden="true" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="' + TYPE_PATHS[typeId] + '"/></svg>';
}

/* ---------------- band row (type dropdown + checkbox + number) ---------------- */

const bandRowEl = document.getElementById('bandRow');
const cells = [];

function buildBandRow() {
  state.bands.forEach((band, i) => {
    const cell = document.createElement('div');
    cell.className = 'bandCell';

    const dd = document.createElement('button');
    dd.className = 'dd';
    dd.title = 'Filter type — band ' + (i + 1);
    dd.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBand(i);
      openTypeMenu(i, dd);
    });

    const cbrow = document.createElement('div');
    cbrow.className = 'cbrow';

    const cb = document.createElement('button');
    cb.className = 'cb';
    cb.title = 'Enable/disable band ' + (i + 1);
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBand(i);
      setBand(i, { on: !state.bands[i].on });
    });

    const num = document.createElement('span');
    num.className = 'bnum';
    num.textContent = String(i + 1);

    cbrow.appendChild(cb);
    cbrow.appendChild(num);
    cell.appendChild(dd);
    cell.appendChild(cbrow);
    cell.addEventListener('click', () => selectBand(i));
    bandRowEl.appendChild(cell);
    cells.push(cell);
  });
}

const DD_ARROW =
  '<svg class="arrow" viewBox="0 0 6 4" width="6" height="4" aria-hidden="true">' +
  '<path d="M0 0 L6 0 L3 4 Z" fill="currentColor"/></svg>';

function updateBandRow() {
  cells.forEach((cell, i) => {
    cell.classList.toggle('sel', i === selected);
    cell.querySelector('.cb').classList.toggle('on', state.bands[i].on);
    cell.querySelector('.dd').innerHTML = typeIcon(state.bands[i].type, 19, 12) + DD_ARROW;
  });
}

/* ---------------- filter-type dropdown menu ---------------- */

const typeMenu = document.getElementById('typeMenu');
let menuFor = -1;

function openTypeMenu(i, anchor) {
  menuFor = i;
  typeMenu.innerHTML = '';
  EQ.FILTER_TYPES.forEach((t) => {
    const item = document.createElement('button');
    item.className = 'mitem' + (state.bands[i].type === t.id ? ' cur' : '');
    item.innerHTML = typeIcon(t.id) + '<span>' + t.label + '</span>';
    item.addEventListener('click', () => {
      setBand(menuFor, { type: t.id });
      closeTypeMenu();
    });
    typeMenu.appendChild(item);
  });
  typeMenu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = typeMenu.offsetWidth;
  const mh = typeMenu.offsetHeight;
  const x = Math.max(4, Math.min(r.left, window.innerWidth - mw - 4));
  let y = r.top - mh - 2; // open upward over the display, like Live
  if (y < 4) y = Math.min(r.bottom + 2, window.innerHeight - mh - 4);
  typeMenu.style.left = x + 'px';
  typeMenu.style.top = y + 'px';
}

function closeTypeMenu() {
  typeMenu.hidden = true;
  menuFor = -1;
}

document.addEventListener('pointerdown', (e) => {
  if (!typeMenu.hidden && !typeMenu.contains(e.target)) closeTypeMenu();
  if (!presetMenu.hidden && !presetMenu.contains(e.target) && !presetNameBtn.contains(e.target)) closePresetMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeTypeMenu(); closePresetMenu(); }
});

/* ---------------- presets ---------------- */

// Each preset lists its active bands in order (low to high); unused slots
// fall back to that slot's default type and are switched off.
const PRESETS = [
  { name: '3 bands', bands: [
    { type: 'lowshelf', freq: 120, gain: 0, q: 0.71 },
    { type: 'peaking', freq: 1000, gain: 0, q: 0.7 },
    { type: 'highshelf', freq: 8000, gain: 0, q: 0.71 },
  ] },
  { name: '20Hz + 18kHz cut', bands: [
    { type: 'highpass', freq: 20, q: 0.71 },
    { type: 'lowpass', freq: 18000, q: 0.71 },
  ] },
  { name: '30Hz + 18kHz cut', bands: [
    { type: 'highpass', freq: 30, q: 0.71 },
    { type: 'lowpass', freq: 18000, q: 0.71 },
  ] },
  { name: '40Hz + 18kHz cut', bands: [
    { type: 'highpass', freq: 40, q: 0.71 },
    { type: 'lowpass', freq: 18000, q: 0.71 },
  ] },
  { name: '40Hz cut', bands: [
    { type: 'highpass', freq: 40, q: 0.71 },
  ] },
  { name: 'Default', bands: null },
  { name: 'Kick', bands: [
    { type: 'highpass', freq: 30, q: 0.71 },
    { type: 'peaking', freq: 60, gain: 4, q: 1.2 },
    { type: 'peaking', freq: 350, gain: -4, q: 1.4 },
    { type: 'peaking', freq: 3500, gain: 3, q: 1.5 },
    { type: 'lowpass', freq: 12000, q: 0.71 },
  ] },
  { name: 'Old Telephone', bands: [
    { type: 'highpass', freq: 400, q: 1 },
    { type: 'peaking', freq: 1500, gain: 6, q: 1 },
    { type: 'lowpass', freq: 3400, q: 1 },
  ] },
  { name: 'Peaking only', bands: [50, 120, 300, 700, 1500, 3500, 7000, 14000]
    .map((freq) => ({ type: 'peaking', freq, gain: 0, q: 1 })) },
  { name: 'Quick Low Roll-Off', bands: [
    { type: 'highpass', freq: 100, q: 0.71 },
  ] },
  { name: 'Radio', bands: [
    { type: 'highpass', freq: 250, q: 0.8 },
    { type: 'peaking', freq: 2500, gain: 4, q: 1.2 },
    { type: 'lowpass', freq: 6000, q: 0.8 },
  ] },
  { name: 'Tight Drum Sizzle', bands: [
    { type: 'highpass', freq: 40, q: 0.71 },
    { type: 'peaking', freq: 300, gain: -3, q: 1.2 },
    { type: 'peaking', freq: 5000, gain: 3, q: 1 },
    { type: 'highshelf', freq: 10000, gain: 4, q: 0.71 },
  ] },
  { name: 'Vocal Presence', bands: [
    { type: 'highpass', freq: 90, q: 0.71 },
    { type: 'peaking', freq: 250, gain: -2, q: 1.2 },
    { type: 'peaking', freq: 3000, gain: 3, q: 1 },
    { type: 'highshelf', freq: 10000, gain: 2, q: 0.71 },
  ] },
];

function presetBands(p) {
  if (!p.bands) return EQ.DEFAULT_BANDS.map((b) => ({ ...b }));
  return EQ.DEFAULT_BANDS.map((d, i) => (p.bands[i]
    ? EQ.sanitizeBand({ gain: 0, ...p.bands[i], on: true }, i)
    : { ...d, on: false, gain: 0 }));
}

// Replaces all 8 bands wholesale, so nothing from the previous preset survives.
function applyPreset(i) {
  const p = PRESETS[i];
  state.bands = presetBands(p);
  preset = { name: p.name, dirty: false };
  const firstOn = state.bands.findIndex((b) => b.on);
  selected = firstOn >= 0 ? firstOn : 0;
  state.bands.forEach((_, j) => pushBand(j));
  scheduleSave();
  markDirty(true);
  updateBandRow();
  updateBandUI();
  updatePresetUI();
}

function stepPreset(dir) {
  let i = PRESETS.findIndex((p) => p.name === preset.name);
  if (i < 0) i = PRESETS.findIndex((p) => p.name === 'Default');
  applyPreset((i + dir + PRESETS.length) % PRESETS.length);
}

const presetMenu = document.getElementById('presetMenu');
const presetNameBtn = document.getElementById('presetName');
const presetLabel = document.getElementById('presetLabel');

function updatePresetUI() {
  presetLabel.textContent = preset.name + (preset.dirty ? ' *' : '');
}

function openPresetMenu() {
  presetMenu.innerHTML = '';
  PRESETS.forEach((p, i) => {
    const item = document.createElement('button');
    item.className = 'mitem' + (p.name === preset.name ? ' cur' : '');
    item.textContent = p.name;
    item.addEventListener('click', () => {
      applyPreset(i);
      closePresetMenu();
    });
    presetMenu.appendChild(item);
  });
  presetMenu.hidden = false;
  const r = presetNameBtn.getBoundingClientRect();
  const x = Math.max(4, Math.min(r.left, window.innerWidth - presetMenu.offsetWidth - 4));
  presetMenu.style.left = x + 'px';
  presetMenu.style.top = (r.bottom + 2) + 'px';
}

function closePresetMenu() {
  presetMenu.hidden = true;
}

presetNameBtn.addEventListener('click', () => {
  if (presetMenu.hidden) openPresetMenu();
  else closePresetMenu();
});
document.getElementById('presetPrev').addEventListener('click', () => stepPreset(-1));
document.getElementById('presetNext').addEventListener('click', () => stepPreset(1));

/* ---------------- rotary knobs (Live style: dark cap, light notch) ------- */

class Knob {
  constructor(canvasEl, opts) {
    this.cv = canvasEl;
    this.o = Object.assign({ min: 0, max: 1, log: false, bipolar: false, def: 0, fine: 0.15 }, opts);
    this.value = this.o.def;
    this.dragging = null;
    this.cv.addEventListener('pointerdown', (e) => {
      this.dragging = { y0: e.clientY, p0: this.norm(this.value) };
      this.cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dp = ((this.dragging.y0 - e.clientY) / 140) * (e.shiftKey ? this.o.fine : 1);
      this.input(this.denorm(EQ.clamp(this.dragging.p0 + dp, 0, 1)));
    });
    this.cv.addEventListener('pointerup', () => { this.dragging = null; });
    this.cv.addEventListener('pointercancel', () => { this.dragging = null; });
    this.cv.addEventListener('dblclick', () => this.input(this.o.def));
    this.cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = 0.04 * (e.shiftKey ? this.o.fine : 1);
      const p = EQ.clamp(this.norm(this.value) + (e.deltaY < 0 ? step : -step), 0, 1);
      this.input(this.denorm(p));
    }, { passive: false });
    this.draw();
  }

  norm(v) {
    return this.o.log
      ? Math.log(v / this.o.min) / Math.log(this.o.max / this.o.min)
      : (v - this.o.min) / (this.o.max - this.o.min);
  }
  denorm(p) {
    return this.o.log
      ? this.o.min * Math.pow(this.o.max / this.o.min, p)
      : this.o.min + p * (this.o.max - this.o.min);
  }

  input(v) {
    this.set(v);
    if (this.o.onInput) this.o.onInput(this.value);
  }

  set(v) {
    this.value = EQ.clamp(v, this.o.min, this.o.max);
    this.draw();
  }

  draw() {
    const size = this.cv.clientWidth || 38;
    const k = window.devicePixelRatio || 1;
    if (this.cv.width !== Math.round(size * k)) {
      this.cv.width = Math.round(size * k);
      this.cv.height = Math.round(size * k);
    }
    const g = this.cv.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, size, size);
    const c = size / 2;
    const r = c - 2;
    const a0 = 0.75 * Math.PI;
    const a1 = 2.25 * Math.PI;
    const ang = a0 + this.norm(this.value) * (a1 - a0);

    // dark cap on the light chrome
    g.beginPath();
    g.arc(c, c, r - 2, 0, 2 * Math.PI);
    g.fillStyle = '#3d3d3d';
    g.fill();
    g.strokeStyle = '#262626';
    g.lineWidth = 1;
    g.stroke();

    // value arc along the rim
    g.lineCap = 'butt';
    g.lineWidth = 2;
    g.strokeStyle = '#e8e8e8';
    g.beginPath();
    if (this.o.bipolar) {
      const mid = (a0 + a1) / 2;
      if (ang >= mid) g.arc(c, c, r - 2, mid, ang);
      else g.arc(c, c, r - 2, ang, mid);
    } else {
      g.arc(c, c, r - 2, a0, ang);
    }
    g.stroke();

    // pointer notch
    g.lineCap = 'round';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(c + Math.cos(ang) * (r * 0.35), c + Math.sin(ang) * (r * 0.35));
    g.lineTo(c + Math.cos(ang) * (r - 4), c + Math.sin(ang) * (r - 4));
    g.stroke();

    // center-detent tick for bipolar knobs
    if (this.o.bipolar) {
      g.strokeStyle = '#555';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(c, c - r + 1);
      g.lineTo(c, c - r + 5);
      g.stroke();
    }
  }
}

const knobFreq = new Knob(document.getElementById('knobFreq'), {
  min: EQ.FREQ_MIN, max: EQ.FREQ_MAX, log: true, def: 1000,
  onInput: (v) => setBand(selected, { freq: v }),
});
const knobGain = new Knob(document.getElementById('knobGain'), {
  min: -EQ.GAIN_MAX, max: EQ.GAIN_MAX, bipolar: true, def: 0,
  onInput: (v) => setBand(selected, { gain: v }),
});
/* ---------------- drag value boxes (Live style) ---------------- */

class DragValue {
  constructor(el, opts) {
    this.el = el;
    this.o = Object.assign({ fine: 0.15 }, opts);
    this.value = this.o.def;
    this.dragging = null;
    el.addEventListener('pointerdown', (e) => {
      this.dragging = { y0: e.clientY, v0: this.value };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dv = ((this.dragging.y0 - e.clientY) / 140) * (this.o.max - this.o.min) *
        (e.shiftKey ? this.o.fine : 1);
      this.input(this.dragging.v0 + dv);
    });
    el.addEventListener('pointerup', () => { this.dragging = null; });
    el.addEventListener('pointercancel', () => { this.dragging = null; });
    el.addEventListener('dblclick', () => this.input(this.o.def));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = 0.02 * (this.o.max - this.o.min) * (e.shiftKey ? this.o.fine : 1);
      this.input(this.value + (e.deltaY < 0 ? step : -step));
    }, { passive: false });
  }

  input(v) {
    this.set(v);
    if (this.o.onInput) this.o.onInput(this.value);
  }

  set(v) {
    this.value = EQ.clamp(v, this.o.min, this.o.max);
  }
}

const dvScale = new DragValue(document.getElementById('boxScale'), {
  min: EQ.SCALE_MIN, max: EQ.SCALE_MAX, def: 1,
  onInput: (v) => setGlobals({ scale: v }),
});
const dvOut = new DragValue(document.getElementById('boxOut'), {
  min: -EQ.OUT_GAIN_MAX, max: EQ.OUT_GAIN_MAX, def: 0,
  onInput: (v) => setGlobals({ outGain: v }),
});

/* ---------------- readouts / right column ---------------- */

const valFreq = document.getElementById('valFreq');
const valGain = document.getElementById('valGain');
const valScale = document.getElementById('valScale');
const valOut = document.getElementById('valOut');
const barScale = document.getElementById('barScale');
const barOut = document.getElementById('barOut');
const paramGain = document.getElementById('paramGain');
const adaptBtn = document.getElementById('adaptQ');
const specToggle = document.getElementById('specToggle');

adaptBtn.addEventListener('click', () => setGlobals({ adaptiveQ: !state.globals.adaptiveQ }));

specToggle.addEventListener('click', () => {
  showSpectrum = !showSpectrum;
  specToggle.classList.toggle('on', showSpectrum);
  markDirty(false);
});

function updateBandUI() {
  const band = state.bands[selected];
  knobFreq.set(band.freq);
  valFreq.textContent = EQ.formatHz(band.freq);
  knobGain.set(band.gain);
  valGain.textContent = EQ.formatDb(band.gain);
  // no Q knob: Q stays on the band model, adjusted by scrolling on a node
  paramGain.classList.toggle('disabled', !EQ.USES_GAIN[band.type]);
}

function updateGlobalUI() {
  adaptBtn.classList.toggle('on', state.globals.adaptiveQ);
  adaptBtn.textContent = state.globals.adaptiveQ ? 'On' : 'Off';
  dvScale.set(state.globals.scale);
  valScale.textContent = Math.round(state.globals.scale * 100) + ' %';
  barScale.style.width = (state.globals.scale / EQ.SCALE_MAX) * 100 + '%';
  dvOut.set(state.globals.outGain);
  valOut.textContent = EQ.formatDb(state.globals.outGain);
  barOut.style.width = ((state.globals.outGain + EQ.OUT_GAIN_MAX) / (2 * EQ.OUT_GAIN_MAX)) * 100 + '%';
}

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

/* ---------------- frequency region labels above the graph ---------------- */

const REGIONS = [
  [20, 60, 'Sub', 'Sub bass'],
  [60, 250, 'Bass', 'Bass'],
  [250, 500, 'Lo mid', 'Low mids'],
  [500, 2000, 'Mid', 'Mids'],
  [2000, 4000, 'Hi mid', 'High mids'],
  [4000, 6000, 'Prs', 'Presence'],
  [6000, 20000, 'Treble', 'Treble'],
];

function buildRegions() {
  const el = document.getElementById('regions');
  // same log scale as the graph, expressed as percentages of its width
  const pct = (f) => (Math.log10(f / EQ.FREQ_MIN) / Math.log10(EQ.FREQ_MAX / EQ.FREQ_MIN)) * 100;
  for (const [lo, hi, label, full] of REGIONS) {
    const s = document.createElement('span');
    s.textContent = label;
    s.title = full + ': ' + EQ.formatHz(lo) + ' to ' + EQ.formatHz(hi);
    s.style.left = pct(lo) + '%';
    s.style.width = (pct(hi) - pct(lo)) + '%';
    el.appendChild(s);
  }
}

/* ---------------- canvas rendering ---------------- */

const canvas = document.getElementById('graph');
const g2d = canvas.getContext('2d');
let dpr = 1;

const DB_RANGE = 18;
const NODE_R = 8.5;

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

const FREQ_LABELS = [[100, '100'], [1000, '1k'], [10000, '10k']];

function drawGrid(W, H) {
  g2d.lineWidth = 1;
  for (let dec = 10; dec < EQ.FREQ_MAX; dec *= 10) {
    for (let m = 1; m <= 9; m++) {
      const f = dec * m;
      if (f < EQ.FREQ_MIN || f > EQ.FREQ_MAX) continue;
      const x = Math.round(xForFreq(f, W)) + 0.5;
      g2d.strokeStyle = m === 1 ? '#292929' : '#303030';
      g2d.beginPath(); g2d.moveTo(x, 0); g2d.lineTo(x, H); g2d.stroke();
    }
  }
  for (const db of [-12, -6, 6, 12]) {
    const y = Math.round(yForDb(db, H)) + 0.5;
    g2d.strokeStyle = '#303030';
    g2d.beginPath(); g2d.moveTo(0, y); g2d.lineTo(W, y); g2d.stroke();
  }
  const y0 = Math.round(yForDb(0, H)) + 0.5;
  g2d.strokeStyle = '#474747';
  g2d.beginPath(); g2d.moveTo(0, y0); g2d.lineTo(W, y0); g2d.stroke();

  g2d.fillStyle = '#8a8a8a';
  g2d.font = '10px "Century Gothic", "Segoe UI", sans-serif';
  g2d.textAlign = 'center';
  for (const [f, label] of FREQ_LABELS) g2d.fillText(label, xForFreq(f, W), H - 5);
  g2d.textAlign = 'left';
  for (const db of [12, 6, 0, -6, -12]) {
    g2d.fillText(String(db), 4, yForDb(db, H) - 3);
  }
}

function drawSpectrum(W, H) {
  if (!showSpectrum || !spectrum || !capture.running) return;
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
  // flat gray silhouette, no outline — like Live's analyzer
  g2d.fillStyle = 'rgba(215, 215, 215, 0.17)';
  g2d.fill();
}

function curveY(arr, i, H) {
  return yForDb(EQ.clamp(arr[i], -DB_RANGE * 1.6, DB_RANGE * 1.6), H);
}

function drawCurve(W, H) {
  const n = curve.n;
  // selected band's own response, faint — shows how a node relates to the
  // summed curve even when another band (e.g. a band-pass) dominates the sum
  if (state.bands[selected]?.on) {
    g2d.beginPath();
    g2d.moveTo(0, curveY(curve.single, 0, H));
    for (let i = 1; i < n; i++) g2d.lineTo((i / (n - 1)) * W, curveY(curve.single, i, H));
    g2d.strokeStyle = 'rgba(245, 166, 35, 0.45)';
    g2d.lineWidth = 1;
    g2d.stroke();
  }
  g2d.beginPath();
  g2d.moveTo(0, curveY(curve.total, 0, H));
  for (let i = 1; i < n; i++) g2d.lineTo((i / (n - 1)) * W, curveY(curve.total, i, H));
  g2d.strokeStyle = '#76c8ea';
  g2d.lineWidth = 2;
  g2d.lineJoin = 'round';
  g2d.stroke();
}

function drawNodes(W, H) {
  const order = state.bands.map((_, i) => i).filter((i) => i !== selected);
  order.push(selected); // selected drawn on top
  g2d.font = 'bold 10px "Century Gothic", "Segoe UI", sans-serif';
  g2d.textAlign = 'center';
  g2d.textBaseline = 'middle';
  for (const i of order) {
    const band = state.bands[i];
    if (!band.on) continue; // Live hides the dots of disabled bands
    const { x, y } = nodePos(band, W, H);
    const isSel = i === selected;
    g2d.beginPath();
    g2d.arc(x, y, NODE_R, 0, Math.PI * 2);
    g2d.fillStyle = isSel ? '#f5a623' : 'rgba(35, 35, 35, 0.6)';
    g2d.fill();
    g2d.strokeStyle = '#f5a623';
    g2d.lineWidth = 1.7;
    g2d.stroke();
    g2d.fillStyle = isSel ? '#333' : '#f5a623';
    g2d.fillText(String(i + 1), x, y + 0.5);
  }
  g2d.textBaseline = 'alphabetic';
}

function drawReadout() {
  const band = state.bands[selected];
  const gainTxt = EQ.USES_GAIN[band.type] ? EQ.formatDb(band.gain) : '—';
  g2d.fillStyle = '#9a9a9a';
  g2d.font = '10px "Century Gothic", "Segoe UI", sans-serif';
  g2d.textAlign = 'left';
  g2d.fillText(
    (selected + 1) + '   ' + EQ.formatHz(band.freq) + '   ' + gainTxt + '   Q ' + band.q.toFixed(2),
    6, 13
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
  if (paintDirty || (capture.running && spectrum && showSpectrum)) {
    draw();
    paintDirty = false;
  }
}

/* ---------------- node hit-testing / drag ---------------- */

function evtPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
}

function hitNode(x, y, W, H) {
  let best = -1;
  let bestDist = NODE_R + 6; // px tolerance
  state.bands.forEach((band, i) => {
    if (!band.on) return; // hidden nodes aren't grabbable
    const p = nodePos(band, W, H);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

let drag = null; // { index }

canvas.addEventListener('pointerdown', (e) => {
  const { x, y, W, H } = evtPos(e);
  const hit = hitNode(x, y, W, H);
  if (hit < 0) return;
  selectBand(hit);
  drag = { index: hit };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const { x, y, W, H } = evtPos(e);
    const band = state.bands[drag.index];
    const patch = { freq: EQ.clamp(freqForX(EQ.clamp(x, 0, W), W), EQ.FREQ_MIN, EQ.FREQ_MAX) };
    if (EQ.USES_GAIN[band.type]) {
      // node sits at the *scaled* gain, so invert Scale when dragging;
      // near scale 0 the node is pinned to 0 dB and vertical drag is a no-op
      const sc = state.globals.scale;
      if (Math.abs(sc) > 0.05) {
        patch.gain = EQ.clamp(dbForY(EQ.clamp(y, 0, H), H) / sc, -EQ.GAIN_MAX, EQ.GAIN_MAX);
      }
    }
    setBand(drag.index, patch);
    return;
  }
  // hover feedback: move cursor over a node
  const { x, y, W, H } = evtPos(e);
  canvas.style.cursor = hitNode(x, y, W, H) >= 0 ? 'move' : 'default';
});

canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });

// scroll on a node = adjust Q (up = narrower, like EQ Eight)
canvas.addEventListener('wheel', (e) => {
  const { x, y, W, H } = evtPos(e);
  const hit = drag ? drag.index : hitNode(x, y, W, H);
  if (hit < 0) return;
  e.preventDefault();
  const band = state.bands[hit];
  const q = EQ.clamp(band.q * Math.pow(1.15, -e.deltaY / 100), EQ.Q_MIN, EQ.Q_MAX);
  setBand(hit, { q });
}, { passive: false });

// double-click a node = remove it (disable the band, filter goes no-op);
// double-click empty space = add the next free band there as a bell
canvas.addEventListener('dblclick', (e) => {
  const { x, y, W, H } = evtPos(e);
  const hit = hitNode(x, y, W, H); // same radius as the drag hit-test
  if (hit >= 0) {
    setBand(hit, { on: false });
    return;
  }
  const free = state.bands.findIndex((b) => !b.on);
  if (free < 0) {
    flashStatus('All 8 bands are already in use.');
    return;
  }
  const freq = EQ.clamp(freqForX(EQ.clamp(x, 0, W), W), EQ.FREQ_MIN, EQ.FREQ_MAX);
  const sc = state.globals.scale;
  const gain = Math.abs(sc) > 0.05
    ? EQ.clamp(dbForY(EQ.clamp(y, 0, H), H) / sc, -EQ.GAIN_MAX, EQ.GAIN_MAX)
    : 0;
  setBand(free, { on: true, type: 'peaking', freq, gain });
  selectBand(free);
});

/* ---------------- init ---------------- */

(async function init() {
  await loadState();
  buildBandRow();
  buildRegions();
  updatePresetUI();
  updateBandRow();
  updateBandUI();
  updateGlobalUI();
  updateHeader();
  requestAnimationFrame(frame);
  queryStatus();
})();
