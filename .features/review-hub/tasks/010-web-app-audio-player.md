---
id: 010
status: done
depends: [003, 008]
created: 2026-02-27
---

# Web app audio player (wavesurfer.js) and sync

Integrate the podcast audio player with waveform visualization, timestamped commenting, and sync with the visual presenter.

## What to do

### Vendor wavesurfer.js

- Download wavesurfer.js (latest stable, v7+) and its Regions plugin
- Place in `web/vendor/wavesurfer.min.js`
- Include Regions plugin (either bundled or separate file)
- Add `/wavesurfer.js` and `/wavesurfer-regions.js` routes to server

### Audio player (`web/app.js` — AudioPlayer module)

- Initialize wavesurfer.js in the podcast player zone:
  - Waveform colors matching dark theme (wave: `#4a5568`, progress: `#805ad5`, cursor: `#e2e8f0`)
  - Height: 80px, bar width: 2, bar gap: 1
- Load audio from `/audio` endpoint
- Playback controls:
  - Play/pause button (spacebar shortcut)
  - Skip forward/back 10s buttons
  - Speed selector: 1x, 1.25x, 1.5x, 2x
  - Current time / total time display
  - Click waveform to seek

### Section regions

- Load section timestamps from manifest
- Create wavesurfer regions for each section:
  - Semi-transparent colored background
  - Region boundaries visible on waveform
- Show section title on hover over a region
- Current section label displayed below waveform

### Comment markers on waveform

- For each comment with an `audioTimestamp`:
  - Add a small colored marker on the waveform (color by comment type)
  - Click marker → jump to timestamp + show comment in panel
- When a new comment is added from the waveform:
  - Click on waveform outside playback → opens comment form
  - Section auto-detected from click position
  - `audioTimestamp` auto-filled

### Sync Manager integration

- `ws.on("timeupdate")` → `SyncManager.onAudioTime(currentTime)`
- SyncManager finds the current section based on audio time
- Updates:
  - Visual presenter: scrolls to current section (if in sync mode)
  - Comment panel: highlights comments for current section
  - Bottom bar: shows current section title
- Add sync toggle: "Sync visual to audio" checkbox
  - When on: visual auto-scrolls with audio
  - When off: visual scroll is independent (default)

### Conditional rendering

- If manifest has no `audio` property → hide podcast player zone entirely
- Show a message: "Audio not available — visual review only"
- Collapse the player zone to save space

## Acceptance criteria

- [ ] wavesurfer.js loads and renders waveform from the audio file
- [ ] Play/pause works (both button and spacebar)
- [ ] Speed control works (1x, 1.25x, 1.5x, 2x)
- [ ] Seek by clicking on waveform works
- [ ] Section regions visible on waveform with colored backgrounds
- [ ] Hover on region shows section title
- [ ] Current section label updates during playback
- [ ] Comment markers appear at correct positions on waveform
- [ ] Click on waveform (outside playback) opens comment form with timestamp
- [ ] Click comment marker jumps to timestamp and shows comment
- [ ] Sync toggle: when on, visual scrolls with audio playback
- [ ] When no audio available, player zone is hidden gracefully
- [ ] No JavaScript errors in console
- [ ] Audio plays without glitches or gaps

## Files

- `~/.pi/agent/extensions/review-hub/web/vendor/wavesurfer.min.js`
- `~/.pi/agent/extensions/review-hub/web/app.js` (AudioPlayer module, SyncManager updates)
- `~/.pi/agent/extensions/review-hub/web/styles.css` (player styles)
- `~/.pi/agent/extensions/review-hub/lib/server.ts` (add vendor routes)

## Verify

```bash
# Start server with a manifest that has audio
# Open browser — verify waveform renders
# Play audio — verify sync with visual sections
# Click waveform — verify comment form opens with timestamp
# Toggle sync — verify visual scrolls with audio when on
```
