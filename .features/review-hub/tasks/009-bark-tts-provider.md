---
id: 009
status: done
depends: [006, 007]
created: 2026-02-27
---

# Bark TTS provider (Spanish)

Implement the Bark TTS provider for Spanish podcast generation as the multilingual fallback.

## What to do

### Bark provider (`lib/tts/bark.ts`)

- Implement `BarkProvider` class implementing `TTSProvider`
- `name = "bark"`, `supportedLanguages = ["en", "es"]`
- Venv path: `~/.pi/review-hub/venv-bark/`

### `isAvailable()` implementation

- Check venv exists
- Check bark package importable: `{venv}/bin/python -c "from bark import generate_audio; print('ok')"`

### `install()` implementation

- Create venv
- Install pinned requirements:
  - `bark` (suno-bark)
  - `torch` (with Apple Silicon index URL)
  - `numpy`, `scipy`, `soundfile`
- Download bark models on first run (happens automatically in bark but large: ~5GB)
- Progress updates

### `generateAudio()` implementation

- Write DialogueScript segments to temp JSON
- Spawn Python script: `{venv}/bin/python python/generate_bark.py --script {path} --output {path} --lang es`
- Bark processes each segment individually (no native multi-speaker like Dia)
- Use different speaker presets for S1 and S2:
  - S1: `v2/es_speaker_0` (or appropriate Spanish voice)
  - S2: `v2/es_speaker_1`
  - For English: `v2/en_speaker_0`, `v2/en_speaker_1`
- Progress from stdout (JSON lines per segment)
- Read WAV + timestamps
- Convert to MP3
- Note: Bark is significantly slower than Dia — report estimated time remaining

### Python generation script (`python/generate_bark.py`)

- Load Bark model
- Read script segments from JSON
- For each segment:
  - Select speaker preset based on `speaker` field (S1/S2) and language
  - Handle emotion tags: `(laughs)` → `[laughter]`, `(pauses)` → add silence
  - Generate audio with `generate_audio(text, history_prompt=speaker_preset)`
  - Record timestamps
  - Print progress JSON line
- Concatenate all audio with silence gaps between sections
- Write WAV + timestamps JSON

### Speed considerations

- Bark generates at ~0.1-0.3x realtime on CPU, ~1-3x on GPU
- For a 10-minute podcast, generation could take 30-60 minutes on CPU
- Show clear time estimates in progress updates
- Consider: allow user to cancel and use visual-only review

## Acceptance criteria

- [ ] `BarkProvider` implements `TTSProvider` interface fully
- [ ] `isAvailable()` correctly detects installed state
- [ ] `install()` creates venv and installs Bark on Apple Silicon Mac
- [ ] `generateAudio()` produces an MP3 with two distinct Spanish voices
- [ ] Spanish language output sounds natural
- [ ] Section timestamps correctly map to audio positions
- [ ] Progress reporting includes estimated time remaining
- [ ] Cancellation via AbortSignal works
- [ ] Emotion tags handled: `(laughs)` → Bark laughter token, `(pauses)` → silence
- [ ] `generate_bark.py` alternates speaker presets correctly

## Files

- `~/.pi/agent/extensions/review-hub/lib/tts/bark.ts`
- `~/.pi/agent/extensions/review-hub/python/generate_bark.py`

## Verify

```bash
# After installation, generate short Spanish test audio
# Play output — verify two distinct voices in Spanish
# Check timestamps align with sections
```
