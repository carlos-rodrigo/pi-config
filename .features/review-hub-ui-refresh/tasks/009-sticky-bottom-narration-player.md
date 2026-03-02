---
id: 009
status: open
depends: [004,003]
parent: null
created: 2026-02-27
---

# Build sticky bottom narration player with sync controls and audio-state UX

Implement a persistent bottom audio player integrated with existing `/audio` and section timestamps.

## What to do

- Build compact sticky bottom player bar.
- Add icon controls: play/pause, skip, speed, sync toggle.
- Keep section/time display and section-sync behavior.
- Show audio-state UX for generating/ready/failed/not-requested.

## Acceptance criteria

- [ ] Player remains visible while scrolling.
- [ ] Audio controls work as expected.
- [ ] Sync toggle behavior is functional.
- [ ] Audio failure/no-audio states are clearly explained.

## Files

- `extensions/review-hub/web-app/src/components/audio/*`
- `extensions/review-hub/web-app/src/hooks/useAudioSync.ts`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# Test with audio-enabled review and visual-only review.
# Confirm sticky player behavior + state messaging.
```
