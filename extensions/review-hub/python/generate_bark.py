#!/usr/bin/env python3
"""
Bark TTS Generation Script — Generates multilingual dialogue audio.

Processes each dialogue segment individually using Bark's speaker presets,
alternating between S1 and S2 voices. Supports English and Spanish.

Usage:
    python generate_bark.py --script script.json --output output.wav --lang es

Progress is reported via JSON lines on stdout:
    {"phase": "loading"}
    {"phase": "generating", "segmentIndex": 0, "sectionId": "s-intro", "estRemainingSeconds": 120}
    {"phase": "saving"}
    {"phase": "done"}
"""

import argparse
import json
import sys
import os
import time
import numpy as np

def emit_progress(phase, **kwargs):
    """Print a JSON progress line to stdout."""
    event = {"phase": phase, **kwargs}
    print(json.dumps(event), flush=True)


# Map script direction annotations to Bark-compatible tokens
EMOTION_MAP = {
    "laughs": "[laughter]",
    "laughter": "[laughter]",
    "pauses": "",  # We'll add silence instead
    "pause": "",
    "sighs": "[sighs]",
    "sigh": "[sighs]",
    "gasps": "[gasps]",
    "gasp": "[gasps]",
}


def process_text(text, direction=None):
    """Process dialogue text and direction annotations for Bark."""
    result = text

    # Handle direction annotation
    if direction:
        bark_token = EMOTION_MAP.get(direction.lower(), "")
        if bark_token:
            result = f"{bark_token} {result}"

    return result


def generate(script_path, output_path, lang):
    emit_progress("loading")

    try:
        from bark import generate_audio, SAMPLE_RATE
        from bark import preload_models
    except ImportError:
        print("ERROR: bark package not found. Run installation first.", file=sys.stderr)
        sys.exit(1)

    # Preload models
    preload_models()
    sample_rate = SAMPLE_RATE  # 24000 for Bark

    # Read script
    with open(script_path, "r") as f:
        script_data = json.load(f)

    segments = script_data.get("segments", [])
    gap_ms = script_data.get("gapMs", 400)

    all_audio = []
    timestamps = []
    current_time = 0.0

    # Silence gap
    gap_samples = int(sample_rate * gap_ms / 1000)
    silence_gap = np.zeros(gap_samples, dtype=np.float32)

    # Track per-section timing
    current_section_id = None
    section_start_time = 0.0
    generation_times = []  # For ETA estimation

    for i, segment in enumerate(segments):
        section_id = segment.get("sectionId", "unknown")
        speaker_preset = segment.get("speakerPreset", "v2/en_speaker_0")
        text = segment.get("text", "")
        direction = segment.get("direction")

        # Track section boundaries
        if section_id != current_section_id:
            if current_section_id is not None:
                timestamps.append({
                    "sectionId": current_section_id,
                    "startTime": section_start_time,
                    "endTime": current_time,
                })
                # Add gap between sections
                all_audio.append(silence_gap)
                current_time += gap_ms / 1000

            current_section_id = section_id
            section_start_time = current_time

        # Estimate remaining time
        est_remaining = None
        if generation_times:
            avg_time = sum(generation_times) / len(generation_times)
            remaining_segments = len(segments) - i
            est_remaining = avg_time * remaining_segments

        emit_progress(
            "generating",
            segmentIndex=i,
            sectionId=section_id,
            estRemainingSeconds=est_remaining,
        )

        try:
            # Process text with emotion annotations
            processed_text = process_text(text, direction)

            if not processed_text.strip():
                continue

            # Generate audio for this segment
            gen_start = time.time()

            # Handle pause direction: add silence instead of generating
            if direction and direction.lower() in ("pauses", "pause"):
                pause_duration = 0.5  # 500ms pause
                pause_samples = int(sample_rate * pause_duration)
                audio = np.zeros(pause_samples, dtype=np.float32)
                # Still generate the text after the pause
                if text.strip():
                    text_audio = generate_audio(
                        processed_text,
                        history_prompt=speaker_preset,
                    )
                    if text_audio is not None:
                        audio = np.concatenate([audio, text_audio])
            else:
                audio = generate_audio(
                    processed_text,
                    history_prompt=speaker_preset,
                )

            gen_time = time.time() - gen_start
            generation_times.append(gen_time)

            if audio is not None and len(audio) > 0:
                if isinstance(audio, list):
                    audio = np.array(audio, dtype=np.float32)

                duration = len(audio) / sample_rate
                all_audio.append(audio)
                current_time += duration
            else:
                print(f"WARNING: No audio for segment {i} ({section_id})", file=sys.stderr)

        except Exception as e:
            print(f"WARNING: Failed segment {i} ({section_id}): {e}", file=sys.stderr)
            continue

    # Close the last section
    if current_section_id is not None:
        timestamps.append({
            "sectionId": current_section_id,
            "startTime": section_start_time,
            "endTime": current_time,
        })

    if not all_audio:
        print("ERROR: No audio was generated", file=sys.stderr)
        sys.exit(1)

    emit_progress("saving")

    # Concatenate all audio
    combined = np.concatenate(all_audio)

    # Normalize
    max_val = np.max(np.abs(combined))
    if max_val > 0:
        combined = combined / max_val * 0.95

    # Write WAV
    import soundfile as sf
    sf.write(output_path, combined, sample_rate)

    # Write timestamps
    ts_path = os.path.join(os.path.dirname(output_path), "timestamps.json")
    with open(ts_path, "w") as f:
        json.dump(timestamps, f, indent=2)

    emit_progress("done")
    total_duration = current_time
    print(
        f"Generated {len(timestamps)} sections, {total_duration:.1f}s total, "
        f"avg {sum(generation_times)/max(len(generation_times),1):.1f}s/segment",
        file=sys.stderr,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate dialogue audio with Bark TTS")
    parser.add_argument("--script", required=True, help="Path to script JSON file")
    parser.add_argument("--output", required=True, help="Path for output WAV file")
    parser.add_argument("--lang", default="es", help="Language code (en/es)")
    args = parser.parse_args()

    generate(args.script, args.output, args.lang)
