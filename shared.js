'use strict';

// Shared between the side panel and the offscreen document (plain script, no
// modules — MV3, no build step). Keeping the band->BiquadFilter mapping in one
// place guarantees the panel's computed curve matches the audible filters.

const EQ = (() => {
  const FILTER_TYPES = [
    { id: 'highpass',  label: 'High-pass',  usesGain: false },
    { id: 'lowshelf',  label: 'Low shelf',  usesGain: true  },
    { id: 'peaking',   label: 'Bell',       usesGain: true  },
    { id: 'notch',     label: 'Notch',      usesGain: false },
    { id: 'bandpass',  label: 'Band-pass',  usesGain: false },
    { id: 'allpass',   label: 'All-pass',   usesGain: false },
    { id: 'highshelf', label: 'High shelf', usesGain: true  },
    { id: 'lowpass',   label: 'Low-pass',   usesGain: false },
  ];
  const USES_GAIN = { lowshelf: true, highshelf: true, peaking: true };

  const FREQ_MIN = 20, FREQ_MAX = 20000;
  const GAIN_MAX = 15;          // band gain, dB (EQ Eight range)
  const Q_MIN = 0.1, Q_MAX = 18;
  const OUT_GAIN_MAX = 12;      // master output gain, dB
  const SCALE_MIN = 0, SCALE_MAX = 2;

  const DEFAULT_BANDS = [
    { on: false, type: 'highpass',  freq: 60,    gain: 0, q: 0.71 },
    { on: false, type: 'lowshelf',  freq: 150,   gain: 0, q: 0.71 },
    { on: true,  type: 'peaking',   freq: 400,   gain: 0, q: 1 },
    { on: true,  type: 'peaking',   freq: 1000,  gain: 0, q: 1 },
    { on: true,  type: 'peaking',   freq: 2500,  gain: 0, q: 1 },
    { on: true,  type: 'peaking',   freq: 6000,  gain: 0, q: 1 },
    { on: false, type: 'highshelf', freq: 12000, gain: 0, q: 0.71 },
    { on: false, type: 'lowpass',   freq: 18000, gain: 0, q: 0.71 },
  ];
  const DEFAULT_GLOBALS = { adaptiveQ: false, scale: 1, outGain: 0 };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Effective gain in dB after the global Scale control (gain-type bands only).
  function bandGainDb(band, globals) {
    if (!USES_GAIN[band.type]) return 0;
    return clamp(band.gain, -GAIN_MAX, GAIN_MAX) * clamp(globals.scale, SCALE_MIN, SCALE_MAX);
  }

  // Adaptive Q (Ableton-style): Q narrows as boost/cut grows and widens as the
  // band's gain approaches 0 dB. Only meaningful for bells — WebAudio shelves
  // ignore Q entirely.
  function effectiveQ(band, globals) {
    let q = clamp(band.q, Q_MIN, Q_MAX);
    if (globals.adaptiveQ && band.type === 'peaking') {
      q = clamp(q * (0.5 + Math.abs(bandGainDb(band, globals)) / 12), Q_MIN, Q_MAX);
    }
    return q;
  }

  // Configure one BiquadFilterNode from a band. A disabled band becomes a
  // 0 dB peaking filter, which is an exact identity (no graph rebuild needed).
  // WebAudio quirk: for lowpass/highpass the Q AudioParam is a resonance in dB
  // rather than a linear Q, so convert (0.707 linear -> ~-3 dB, Butterworth).
  function applyBand(filter, band, globals, time) {
    const enabled = !!band.on;
    const type = enabled ? band.type : 'peaking';
    const gainDb = enabled ? bandGainDb(band, globals) : 0;
    let q = effectiveQ(band, globals);
    if (type === 'lowpass' || type === 'highpass') q = 20 * Math.log10(q);
    const freq = clamp(band.freq, FREQ_MIN, FREQ_MAX);
    filter.type = type;
    if (time !== undefined) {
      filter.frequency.setTargetAtTime(freq, time, 0.02);
      filter.Q.setTargetAtTime(q, time, 0.02);
      filter.gain.setTargetAtTime(gainDb, time, 0.02);
    } else {
      filter.frequency.value = freq;
      filter.Q.value = q;
      filter.gain.value = gainDb;
    }
  }

  // Rebuild a band/globals object from untrusted input (storage, messages):
  // unknown fields dropped, bad values fall back to the slot's defaults. Both
  // contexts use these so every copy of the state has the exact same shape.
  function sanitizeBand(b, i) {
    const d = DEFAULT_BANDS[i] || DEFAULT_BANDS[0];
    const src = (b && typeof b === 'object') ? b : {};
    const num = (v, fb) => (Number.isFinite(v) ? v : fb);
    return {
      on: !!src.on,
      type: FILTER_TYPES.some((t) => t.id === src.type) ? src.type : d.type,
      freq: clamp(num(src.freq, d.freq), FREQ_MIN, FREQ_MAX),
      gain: clamp(num(src.gain, d.gain), -GAIN_MAX, GAIN_MAX),
      q: clamp(num(src.q, d.q), Q_MIN, Q_MAX),
    };
  }

  function sanitizeGlobals(g) {
    const src = (g && typeof g === 'object') ? g : {};
    const num = (v, fb) => (Number.isFinite(v) ? v : fb);
    return {
      adaptiveQ: !!src.adaptiveQ,
      scale: clamp(num(src.scale, 1), SCALE_MIN, SCALE_MAX),
      outGain: clamp(num(src.outGain, 0), -OUT_GAIN_MAX, OUT_GAIN_MAX),
    };
  }

  function formatHz(f) {
    return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz';
  }
  // Live-style value formatting: "6.67 kHz", "-0.62 dB" (no plus sign)
  function formatDb(g) {
    return g.toFixed(2) + ' dB';
  }

  return {
    FILTER_TYPES, USES_GAIN,
    FREQ_MIN, FREQ_MAX, GAIN_MAX, Q_MIN, Q_MAX, OUT_GAIN_MAX, SCALE_MIN, SCALE_MAX,
    DEFAULT_BANDS, DEFAULT_GLOBALS,
    clamp, bandGainDb, effectiveQ, applyBand, formatHz, formatDb,
    sanitizeBand, sanitizeGlobals,
  };
})();
