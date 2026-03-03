import type { ReactNode } from "react";
import { FastForward, Link2, Link2Off, Pause, Play, Rewind } from "lucide-react";

import type { ReviewManifest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAudioTime, resolveAudioUxState } from "@/lib/audio-player";
import { useAudioSync } from "@/hooks/useAudioSync";

type ReviewSection = ReviewManifest["sections"][number];

export function NarrationPlayerBar({
  manifest,
  onSectionSync,
}: {
  manifest: ReviewManifest;
  onSectionSync: (sectionId: string) => void;
}) {
  const audioState = resolveAudioUxState(manifest);
  const audioUrl = audioState === "ready" ? "/audio" : null;

  const {
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    syncEnabled,
    error,
    activeAudioSection,
    setSyncEnabled,
    togglePlayPause,
    skipBy,
    cyclePlaybackRate,
  } = useAudioSync({
    audioUrl,
    sections: manifest.sections,
    onSyncSection: onSectionSync,
  });

  if (audioState !== "ready") {
    return (
      <PlayerShell>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Narration</Badge>
          <p className="text-sm">{getAudioStateMessage(audioState, manifest.audioFailureReason)}</p>
        </div>
      </PlayerShell>
    );
  }

  return (
    <PlayerShell>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Badge variant="outline">Narration</Badge>
        <Button variant="outline" size="icon" aria-label="Rewind 10 seconds" onClick={() => skipBy(-10)}>
          <Rewind className="size-4" />
        </Button>
        <Button variant="default" size="icon" aria-label={isPlaying ? "Pause narration" : "Play narration"} onClick={togglePlayPause}>
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button variant="outline" size="icon" aria-label="Forward 10 seconds" onClick={() => skipBy(10)}>
          <FastForward className="size-4" />
        </Button>

        <Button variant="outline" size="sm" className="min-w-14" onClick={cyclePlaybackRate}>
          {playbackRate.toFixed(playbackRate % 1 === 0 ? 0 : 2)}x
        </Button>

        <Button
          variant={syncEnabled ? "default" : "outline"}
          size="sm"
          onClick={() => setSyncEnabled((enabled) => !enabled)}
          aria-label={syncEnabled ? "Disable section sync" : "Enable section sync"}
        >
          {syncEnabled ? <Link2 className="mr-1 size-4" /> : <Link2Off className="mr-1 size-4" />}
          Sync
        </Button>
      </div>

      <div className="text-muted-foreground flex min-w-0 flex-1 items-center justify-end gap-2 text-xs">
        <span>
          {formatAudioTime(currentTime)} / {formatAudioTime(duration || manifest.audio?.durationSeconds || 0)}
        </span>
        <span className="max-w-[20rem] truncate">
          {resolveActiveSectionLabel(activeAudioSection) ?? "No section timestamps"}
        </span>
      </div>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </PlayerShell>
  );
}

function PlayerShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background/95 fixed inset-x-0 bottom-0 z-50 border-t backdrop-blur">
      <div className="mx-auto flex min-h-16 w-full max-w-[1400px] items-center gap-2 overflow-x-auto px-4 py-2 lg:px-6">
        {children}
      </div>
    </div>
  );
}

function resolveActiveSectionLabel(section: ReviewSection | null): string | null {
  if (!section) {
    return null;
  }

  return section.headingPath[section.headingPath.length - 1] ?? section.id;
}

function getAudioStateMessage(state: ReturnType<typeof resolveAudioUxState>, failureReason?: string): string {
  if (state === "generating") {
    return "Narration is still being generated. It will appear here when ready.";
  }

  if (state === "failed") {
    return failureReason ?? "Narration generation failed for this review.";
  }

  return "Narration was not requested for this review.";
}
