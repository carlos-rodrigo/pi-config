---
id: 007
status: open
depends: [001]
created: 2026-02-27
---

# TTS provider interface and auto-installer

Define the pluggable TTS provider interface and implement the auto-installation system for Python-based TTS models.

## What to do

### Provider interface (`lib/tts/provider.ts`)

- Define and export `TTSProvider` interface:
  - `name: string`
  - `supportedLanguages: string[]`
  - `isAvailable(): Promise<boolean>`
  - `install(onProgress, onConfirm): Promise<void>`
  - `generateAudio(script, onProgress, signal?): Promise<TTSResult>`
- Define and export `TTSResult`:
  - `audioBuffer: Buffer`
  - `format: "wav" | "mp3"`
  - `sectionTimestamps: SectionTimestamp[]`
- Define and export `SectionTimestamp`:
  - `sectionId: string`
  - `startTime: number`
  - `endTime: number`
- Implement `selectProvider(language: string): TTSProvider` — returns Dia for "en", Bark for "es"

### Auto-installer (`lib/tts/installer.ts`)

- Implement `ensureTTSAvailable(provider, ui): Promise<boolean>`:
  1. Check `provider.isAvailable()`
  2. If not → show confirmation dialog via `ui.confirm()` with download size estimate
  3. Run pre-flight checks
  4. Call `provider.install()` with progress callback
  5. Return success/failure
- Implement pre-flight checks:
  - `checkPythonVersion()` — verify Python ≥ 3.10 via `python3 --version`
  - `checkPlatformCompatibility()` — detect Apple Silicon, set appropriate torch index URL
  - `checkDiskSpace()` — warn if < 5GB free in home directory
- Implement venv management:
  - `createVenv(venvPath)` — `python3 -m venv {path}`
  - `installPackages(venvPath, requirements)` — `{venv}/bin/pip install -r requirements.txt`
  - `isVenvValid(venvPath)` — check venv exists and python binary works
- Venv location: `~/.pi/review-hub/venv-{provider-name}/`
- Requirements pinning: each provider specifies exact versions in a requirements dict
- Cache installation status in `~/.pi/review-hub/install-status.json`

### WAV → MP3 conversion utility

- Implement `convertToMp3(wavPath, mp3Path): Promise<void>`
  - Uses ffmpeg: `ffmpeg -i input.wav -codec:a libmp3lame -qscale:a 2 output.mp3`
  - Fallback: serve WAV if ffmpeg not available (larger file, but works)
  - Detect ffmpeg availability via `which ffmpeg`

## Acceptance criteria

- [ ] `TTSProvider` interface is exported and well-documented
- [ ] `selectProvider("en")` returns a Dia-type provider, `selectProvider("es")` returns Bark-type
- [ ] `ensureTTSAvailable()` shows confirmation dialog before installing
- [ ] Pre-flight checks detect Python version correctly
- [ ] Pre-flight checks detect Apple Silicon and set appropriate torch URL
- [ ] Venv creation works: `python3 -m venv` produces a working venv
- [ ] `isVenvValid()` correctly reports whether a venv is usable
- [ ] Installation status is cached and re-checked on subsequent calls
- [ ] `convertToMp3()` converts WAV to MP3 using ffmpeg
- [ ] `convertToMp3()` falls back gracefully if ffmpeg is missing
- [ ] No hardcoded paths — all configurable via provider config

## Files

- `~/.pi/agent/extensions/review-hub/lib/tts/provider.ts`
- `~/.pi/agent/extensions/review-hub/lib/tts/installer.ts`

## Verify

```bash
# Test venv creation
python3 -m venv /tmp/test-review-hub-venv && /tmp/test-review-hub-venv/bin/python --version && rm -rf /tmp/test-review-hub-venv

# Test ffmpeg availability
which ffmpeg && echo "ffmpeg available" || echo "ffmpeg not found"
```
