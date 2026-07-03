# Tab EQ Eight

8-band parametric EQ for the current browser tab's audio, visually modeled on
Ableton Live's EQ Eight. Manifest V3, no build step, no external libraries —
all filtering is done with native `BiquadFilterNode`s in a `chrome.offscreen`
document; the UI is the toolbar action popup.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder

## Use

1. Go to a tab that plays audio (YouTube, etc.) and start playback.
2. Click the extension's toolbar icon — the EQ popup opens. Opening the popup
   is the toolbar-icon gesture Chrome needs to grant `activeTab`, so capture
   works on whichever tab you open it from.
3. Click the round **power** LED in the title bar. The tab's audio is now
   routed through the EQ (it keeps playing through your speakers).
4. Drag the numbered nodes on the curve (drag = freq/gain, scroll on a node
   = Q). Double-click empty graph space to add the next free band there;
   double-click a node to remove (disable) it. Per-band filter shapes are in
   each band cell's dropdown below the display.
5. The popup closes when it loses focus (clicking the page closes it) — the
   EQ keeps processing; reopen the popup to keep tweaking. Click the power
   LED again to stop; the tab's audio returns to normal.

## Notes / limitations

- `chrome://` pages and the Web Store can't be captured.
- Only one tab is EQ'd at a time; starting capture on a new tab stops the old one.
- WebAudio shelf filters have a fixed slope, so Q has no effect on the two
  shelf types. For low/high-pass, Q acts as resonance at the cutoff. Q is
  adjusted by scrolling on a node (no dedicated knob).
- The blue curve is the **sum** of all enabled bands. Nodes sit at their own
  band's frequency/gain, so with overlapping bands — or a band-pass/notch in
  the chain — nodes are not expected to lie on the summed curve. The faint
  orange line shows the selected band's own response.
