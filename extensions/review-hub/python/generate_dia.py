#!/usr/bin/env python3
"""
Dia TTS Generation Script — Generates multi-speaker dialogue audio.

Reads a script JSON with [S1]/[S2] speaker-tagged dialogue chunks,
generates audio using the Dia model, and outputs a WAV file with
per-section timestamps.

Usage:
    python generate_dia.py --script script.json --output output.wav

Progress is reported via JSON lines on stdout:
    {"phase": "loading"}
    {"phase": "generating", "sectionIndex": 0, "sectionId": "s-intro"}
    {"phase": "saving"}
    {"phase": "done"}
"""

import argparse
import json
import sys
import os
import numpy as np

def emit_progress(phase, **kwargs):
    """Print a JSON progress line to stdout."""
    event = {"phase": phase, **kwargs}
    print(json.dumps(event), flush=True)


def generate(script_path, output_path):
    emit_progress("loading")

    try:
        from dia.model import Dia
    except ImportError:
        print("ERROR: dia package not found. Run installation first.", file=sys.stderr)
        sys.exit(1)

    # Load model (auto-downloads on first use)
    model = Dia("nari-labs/Dia-1.6B")

    # Read script
    with open(script_path, "r") as f:
        script_data = json.load(f)

    chunks = script_data.get("chunks", [])
    gap_ms = script_data.get("gapMs", 300)
    sample_rate = 44100

    all_audio = []
    timestamps = []
    current_time = 0.0

    # Silence gap between sections
    gap_samples = int(sample_rate * gap_ms / 1000)
    silence_gap = np.zeros(gap_samples, dtype=np.float32)

    for i, chunk in enumerate(chunks):
        section_id = chunk["sectionId"]
        text = chunk["text"]

        emit_progress("generating", sectionIndex=i, sectionId=section_id)

        try:
            # Generate audio for this dialogue chunk
            # Dia natively handles [S1]/[S2] tags
            audio = model.generate(text)

            if audio is not None and len(audio) > 0:
                if isinstance(audio, list):
                    audio = np.array(audio, dtype=np.float32)

                duration = len(audio) / sample_rate
                timestamps.append({
                    "sectionId": section_id,
                    "startTime": current_time,
                    "endTime": current_time + duration,
                })

                all_audio.append(audio)
                current_time += duration

                # Add silence gap between sections
                if i < len(chunks) - 1:
                    all_audio.append(silence_gap)
                    current_time += gap_ms / 1000
            else:
                print(f"WARNING: No audio generated for section {section_id}", file=sys.stderr)

        except Exception as e:
            print(f"WARNING: Failed to generate section {section_id}: {e}", file=sys.stderr)
            # Skip this section but continue
            continue

    if not all_audio:
        print("ERROR: No audio was generated", file=sys.stderr)
        sys.exit(1)

    emit_progress("saving")

    # Concatenate all audio
    combined = np.concatenate(all_audio)

    # Normalize to prevent clipping
    max_val = np.max(np.abs(combined))
    if max_val > 0:
        combined = combined / max_val * 0.95

    # Write WAV
    import soundfile as sf
    sf.write(output_path, combined, sample_rate)

    # Write timestamps
    timestamps_path = output_path + ".timestamps.json" if not output_path.endswith(".timestamps.json") else output_path
    if not timestamps_path.endswith(".timestamps.json"):
        timestamps_path = output_path.rsplit(".", 1)[0] + ".timestamps.json" if "." in output_path else output_path + ".timestamps.json"

    # Actually just use the path next to the output
    ts_path = os.path.splitext(output_path)[0] + ".timestamps.json"
    # But the TypeScript code expects it at output_dir/timestamps.json
    ts_path = os.path.join(os.path.dirname(output_path), "timestamps.json")
    with open(ts_path, "w") as f:
        json.dump(timestamps, f, indent=2)

    emit_progress("done")
    print(f"Generated {len(timestamps)} sections, {current_time:.1f}s total", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate dialogue audio with Dia TTS")
    parser.add_argument("--script", required=True, help="Path to script JSON file")
    parser.add_argument("--output", required=True, help="Path for output WAV file")
    args = parser.parse_args()

    generate(args.script, args.output)
