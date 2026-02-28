---
id: 008
status: open
depends: [006, 007]
created: 2026-02-27
---

# Dia TTS provider (English)

Implement the Dia TTS provider for high-quality, expressive English podcast generation.

## What to do

### Dia provider (`lib/tts/dia.ts`)

- Implement `DiaProvider` class implementing `TTSProvider`
- `name = "dia"`, `supportedLanguages = ["en"]`
- Venv path: `~/.pi/review-hub/venv-dia/`

### `isAvailable()` implementation

- Check venv exists at venv path
- Check `dia` package is importable: run `{venv}/bin/python -c "import dia; print('ok')"`
- Return true only if both pass

### `install()` implementation

- Create venv: `python3 -m venv {venvPath}`
- Install pinned requirements:
  - `dia-tts` (or `nari-labs-dia` — verify correct package name)
  - `torch` (with Apple Silicon index URL if applicable)
  - `numpy`, `soundfile`
- Progress updates during install
- Verify installation by importing the package

### `generateAudio()` implementation

- Write the `DialogueScript` segments to a temp JSON file
- Group consecutive segments with the same `sectionId` into chunks
- Format each chunk with `[S1]`/`[S2]` tags as Dia expects
- Spawn Python script: `{venv}/bin/python python/generate_dia.py --script {path} --output {path}`
- Read progress from stdout (JSON lines: `{"progress": "sectionId", "pct": 0.5}`)
- On completion: read the WAV file + timestamps JSON
- Convert WAV → MP3 via `convertToMp3()`
- Return `TTSResult` with audio buffer and section timestamps
- Support cancellation via `AbortSignal` → kill Python process

### Python generation script (`python/generate_dia.py`)

- Load Dia model (auto-downloads on first use)
- Read script segments from JSON input file
- Process section-by-section:
  - Concatenate all dialogue lines for a section into one `[S1]`/`[S2]` block
  - Generate audio with `model.generate(text)`
  - Record section timestamp (start time, end time based on audio length)
  - Add small silence gap (300ms) between sections
  - Print progress JSON line to stdout
- Concatenate all section audio into a single WAV
- Write output WAV file
- Write timestamps JSON alongside

### Error handling

- Model download failure → clear error message with manual steps
- Generation failure on specific section → skip section, log warning, continue
- Memory pressure → catch OOM, suggest closing other apps
- Timeout → configurable, default 10 minutes per section

## Acceptance criteria

- [ ] `DiaProvider` implements `TTSProvider` interface fully
- [ ] `isAvailable()` correctly detects installed vs not-installed state
- [ ] `install()` creates venv and installs Dia successfully on Apple Silicon Mac
- [ ] `generateAudio()` produces an MP3 file with two distinct voices
- [ ] Audio sounds expressive — not monotone (reactions, pauses, emphasis)
- [ ] Section timestamps in the output correctly map to audio positions
- [ ] Progress reporting shows per-section progress
- [ ] Cancellation via AbortSignal kills the Python process
- [ ] WAV → MP3 conversion works via ffmpeg
- [ ] `generate_dia.py` handles `[S1]`/`[S2]` speaker tags correctly
- [ ] Silence gaps between sections create natural pacing

## Files

- `~/.pi/agent/extensions/review-hub/lib/tts/dia.ts`
- `~/.pi/agent/extensions/review-hub/python/generate_dia.py`

## Verify

```bash
# After installation, generate a short test audio:
# 1. Create a test script JSON with 2-3 short sections
# 2. Run generate_dia.py directly
# 3. Play the output audio file
# 4. Verify timestamps JSON matches audio sections
```
