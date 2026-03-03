#!/usr/bin/env python3
"""
Persistent Dia worker process.

Keeps Dia model loaded across requests and supports:
- per-section audio generation
- per-section cache reuse
- fast mode parameters
- progress events streamed as JSON lines

Protocol (stdin JSONL / stdout JSONL):
- {"type":"generate_review","requestId":"...", ...}
- {"type":"cancel","requestId":"..."}
- {"type":"shutdown"}
"""

import hashlib
import json
import os
import sys
import traceback
from typing import Dict, Set

import numpy as np
import soundfile as sf

SAMPLE_RATE = 44100
MODEL_ID = "nari-labs/Dia-1.6B-0626"


def emit(event: Dict):
    print(json.dumps(event), flush=True)


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute_dtype() -> str:
    try:
      import platform
      return "float32" if platform.machine() == "arm64" else "float16"
    except Exception:
      return "float32"


class Worker:
    def __init__(self):
        self.model = None
        self.cancelled: Set[str] = set()

    def load_model(self):
        from dia.model import Dia

        dtype = compute_dtype()
        self.model = Dia.from_pretrained(MODEL_ID, compute_dtype=dtype)
        emit({"type": "ready", "model": MODEL_ID, "computeDtype": dtype})

    def cancel(self, request_id: str):
        self.cancelled.add(request_id)

    def is_cancelled(self, request_id: str) -> bool:
        return request_id in self.cancelled

    def clear_cancel(self, request_id: str):
        if request_id in self.cancelled:
            self.cancelled.remove(request_id)

    def generate_review(self, cmd: Dict):
        request_id = cmd.get("requestId")
        chunks = cmd.get("chunks", [])
        output_path = cmd.get("outputPath")
        timestamps_path = cmd.get("timestampsPath")
        cache_dir = cmd.get("cacheDir")
        gap_ms = int(cmd.get("gapMs", 300))
        fast_mode = bool(cmd.get("fastMode", False))

        if not request_id:
            emit({"type": "error", "message": "missing requestId"})
            return

        if not output_path or not timestamps_path:
            emit({
                "type": "error",
                "requestId": request_id,
                "message": "missing outputPath or timestampsPath",
            })
            return

        if not cache_dir:
            emit({
                "type": "error",
                "requestId": request_id,
                "message": "missing cacheDir",
            })
            return

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        os.makedirs(os.path.dirname(timestamps_path), exist_ok=True)
        os.makedirs(cache_dir, exist_ok=True)

        gap_samples = int(SAMPLE_RATE * gap_ms / 1000)
        silence_gap = np.zeros(gap_samples, dtype=np.float32)

        all_audio = []
        timestamps = []
        current_time = 0.0
        cache_hits = 0

        total = max(len(chunks), 1)

        for i, chunk in enumerate(chunks):
            if self.is_cancelled(request_id):
                self.clear_cancel(request_id)
                emit({
                    "type": "error",
                    "requestId": request_id,
                    "message": "generation cancelled",
                })
                return

            section_id = chunk.get("sectionId", f"section-{i}")
            text = chunk.get("text", "")

            if fast_mode and len(text) > 360:
                text = text[:360].rsplit(" ", 1)[0]

            cache_key = stable_hash(f"{MODEL_ID}|fast={fast_mode}|{text}")
            clip_path = os.path.join(cache_dir, f"{cache_key}.wav")
            meta_path = os.path.join(cache_dir, f"{cache_key}.json")

            cached = False
            audio = None

            if os.path.exists(clip_path) and os.path.exists(meta_path):
                try:
                    audio, sr = sf.read(clip_path, dtype="float32")
                    if sr != SAMPLE_RATE:
                        raise RuntimeError(f"sample rate mismatch: {sr}")
                    cached = True
                    cache_hits += 1
                except Exception:
                    # Corrupt cache entry, regenerate
                    cached = False
                    audio = None

            if audio is None:
                try:
                    emit({
                        "type": "progress",
                        "requestId": request_id,
                        "phase": "generating",
                        "sectionIndex": i,
                        "sectionId": section_id,
                        "totalSections": len(chunks),
                        "percent": (i / total),
                        "cached": False,
                        "cacheHits": cache_hits,
                    })

                    params = {
                        "use_torch_compile": False,
                        "verbose": False,
                        "cfg_scale": 2.2 if fast_mode else 3.0,
                        "temperature": 1.35 if fast_mode else 1.8,
                        "top_p": 0.82 if fast_mode else 0.90,
                    }
                    audio = self.model.generate(text, **params)
                    if isinstance(audio, list):
                        audio = np.array(audio, dtype=np.float32)

                    sf.write(clip_path, audio, SAMPLE_RATE)
                    duration = len(audio) / SAMPLE_RATE
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump(
                            {
                                "sectionId": section_id,
                                "duration": duration,
                                "fastMode": fast_mode,
                                "model": MODEL_ID,
                            },
                            f,
                            indent=2,
                        )
                except Exception as e:
                    emit({
                        "type": "error",
                        "requestId": request_id,
                        "message": f"failed generating section {section_id}: {e}",
                    })
                    return

            duration = len(audio) / SAMPLE_RATE
            timestamps.append(
                {
                    "sectionId": section_id,
                    "startTime": current_time,
                    "endTime": current_time + duration,
                }
            )

            all_audio.append(audio)
            current_time += duration

            if i < len(chunks) - 1:
                all_audio.append(silence_gap)
                current_time += gap_ms / 1000

            emit({
                "type": "progress",
                "requestId": request_id,
                "phase": "generating",
                "sectionIndex": i,
                "sectionId": section_id,
                "totalSections": len(chunks),
                "percent": ((i + 1) / total),
                "cached": cached,
                "cacheHits": cache_hits,
            })

        if not all_audio:
            emit({
                "type": "error",
                "requestId": request_id,
                "message": "no audio was generated",
            })
            return

        emit({"type": "progress", "requestId": request_id, "phase": "saving", "percent": 0.98})

        combined = np.concatenate(all_audio)
        max_val = np.max(np.abs(combined))
        if max_val > 0:
            combined = combined / max_val * 0.95

        sf.write(output_path, combined, SAMPLE_RATE)
        with open(timestamps_path, "w", encoding="utf-8") as f:
            json.dump(timestamps, f, indent=2)

        emit(
            {
                "type": "done",
                "requestId": request_id,
                "outputPath": output_path,
                "timestampsPath": timestamps_path,
                "durationSeconds": current_time,
                "cacheHits": cache_hits,
                "totalSections": len(chunks),
            }
        )


def main():
    try:
        worker = Worker()
        worker.load_model()

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except Exception:
                emit({"type": "error", "message": "invalid JSON command"})
                continue

            cmd_type = cmd.get("type")
            if cmd_type == "shutdown":
                emit({"type": "shutdown"})
                break
            elif cmd_type == "cancel":
                request_id = cmd.get("requestId")
                if request_id:
                    worker.cancel(request_id)
                    emit({"type": "cancelled", "requestId": request_id})
            elif cmd_type == "generate_review":
                worker.generate_review(cmd)
            elif cmd_type == "ping":
                emit({"type": "pong"})
            else:
                emit({"type": "error", "message": f"unknown command type: {cmd_type}"})
    except Exception as e:
        tb = traceback.format_exc(limit=3)
        emit({"type": "error", "message": f"fatal worker error: {e}\n{tb}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
