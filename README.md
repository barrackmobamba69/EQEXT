# Tab EQ Eight

8-band parametric EQ for the current browser tab's audio, visually modeled on
Ableton Live's EQ Eight. Manifest V3, no build step, no external libraries —
all filtering is done with native `BiquadFilterNode`s in a `chrome.offscreen`
document; the UI lives in a `chrome.sidePanel`.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder

## Use

1. Go to a tab that plays audio (YouTube, etc.) and start playback.
2. Click the extension's toolbar icon — the side panel opens.
3. Click the round **power** button in the panel's title bar. The tab's audio
   is now routed through the EQ (it keeps playing through your speakers).
4. Drag the numbered nodes on the curve (drag = freq/gain, scroll = Q), or use
   the knobs and the filter-type buttons for the selected band.
5. Click power again to stop; the tab's audio returns to normal.

## Notes / limitations

- Chrome only allows capture of a tab the extension was **invoked** on: if
  "Start" fails with an invocation error, click the toolbar icon while that
  tab is active, then press power again.
- `chrome://` pages and the Web Store can't be captured.
- Only one tab is EQ'd at a time; starting capture on a new tab stops the old one.
- WebAudio shelf filters have a fixed slope, so Q has no effect on the two
  shelf types (the Q knob is disabled for them). For low/high-pass, Q acts as
  resonance at the cutoff.
