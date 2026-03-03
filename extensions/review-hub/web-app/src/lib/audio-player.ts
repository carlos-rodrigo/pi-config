import type { ReviewManifest } from "@/lib/api";

export type AudioUxState = "generating" | "ready" | "failed" | "not-requested";

type ReviewSection = ReviewManifest["sections"][number];

export function resolveAudioUxState(manifest: ReviewManifest): AudioUxState {
  if (manifest.audioState === "failed") {
    return "failed";
  }

  if (manifest.audioState === "not-requested") {
    return "not-requested";
  }

  if (manifest.audioState === "ready") {
    return "ready";
  }

  if (manifest.audio) {
    return "ready";
  }

  if (manifest.status === "generating") {
    return "generating";
  }

  return "not-requested";
}

export function findSectionAtTime(
  sections: ReviewSection[],
  currentTimeSeconds: number,
): ReviewSection | null {
  for (const section of sections) {
    if (section.audioStartTime == null || section.audioEndTime == null) {
      continue;
    }

    if (currentTimeSeconds >= section.audioStartTime && currentTimeSeconds < section.audioEndTime) {
      return section;
    }
  }

  return null;
}

export function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }

  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}
