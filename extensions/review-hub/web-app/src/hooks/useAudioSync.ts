import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ReviewManifest } from "@/lib/api";
import { findSectionAtTime } from "@/lib/audio-player";

type ReviewSection = ReviewManifest["sections"][number];

const SPEEDS = [1, 1.25, 1.5, 2] as const;

export function useAudioSync({
  audioUrl,
  sections,
  onSyncSection,
}: {
  audioUrl: string | null;
  sections: ReviewSection[];
  onSyncSection?: (sectionId: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSyncedSectionId = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState<number>(1);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!audioUrl) {
      audioRef.current?.pause();
      audioRef.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setError(null);
      return;
    }

    const audio = new Audio(audioUrl);
    audio.preload = "metadata";
    audio.playbackRate = playbackRate;
    audioRef.current = audio;

    const handleLoadedMetadata = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    const handleError = () => {
      setIsPlaying(false);
      setError("Unable to load audio playback.");
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.pause();
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    lastSyncedSectionId.current = null;
  }, [audioUrl, syncEnabled]);

  const activeAudioSection = useMemo(
    () => findSectionAtTime(sections, currentTime),
    [sections, currentTime],
  );

  useEffect(() => {
    if (!syncEnabled || !activeAudioSection) {
      return;
    }

    if (lastSyncedSectionId.current === activeAudioSection.id) {
      return;
    }

    lastSyncedSectionId.current = activeAudioSection.id;
    onSyncSection?.(activeAudioSection.id);
  }, [activeAudioSection, onSyncSection, syncEnabled]);

  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
      setError(null);
    } catch {
      setError("Playback was blocked. Click play again to retry.");
    }
  }, []);

  const skipBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const nextTime = Math.min(Math.max(audio.currentTime + seconds, 0), duration || Number.MAX_SAFE_INTEGER);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, [duration]);

  const cyclePlaybackRate = useCallback(() => {
    setPlaybackRateState((current) => {
      const currentIndex = SPEEDS.findIndex((speed) => speed === current);
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % SPEEDS.length;
      return SPEEDS[nextIndex]!;
    });
  }, []);

  return {
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
  };
}
