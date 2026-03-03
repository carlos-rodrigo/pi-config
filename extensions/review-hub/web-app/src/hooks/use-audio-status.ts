/**
 * useAudioStatus — polls the audio lifecycle status and provides regeneration.
 *
 * Polls /audio/status at intervals when audio is in "generating" state.
 * Provides a regenerate action for "failed" or "not-requested" states.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export type AudioState = "not-requested" | "generating" | "ready" | "failed";

export interface AudioStatusResult {
  state: AudioState;
  reason?: string;
  progress?: number;
}

export interface UseAudioStatusOptions {
  /** Session token for API calls */
  token: string | null;
  /** Initial audio state from manifest bootstrap */
  initialState?: AudioState;
  /** Polling interval in ms when generating (default: 3000) */
  pollIntervalMs?: number;
}

export interface UseAudioStatusReturn {
  audioState: AudioState;
  audioReason: string | null;
  isRegenerating: boolean;
  regenerate: (options?: { fastAudio?: boolean }) => Promise<void>;
  regenError: string | null;
}

// ── Hook ───────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL = 3000;

export function useAudioStatus({
  token,
  initialState = "not-requested",
  pollIntervalMs = DEFAULT_POLL_INTERVAL,
}: UseAudioStatusOptions): UseAudioStatusReturn {
  const [audioState, setAudioState] = useState<AudioState>(initialState);
  const [audioReason, setAudioReason] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Polling ──────────────────────────────────────────────────────

  const pollStatus = useCallback(async () => {
    if (!token) return;

    try {
      const res = await fetch(`/audio/status?token=${encodeURIComponent(token)}`);
      if (!res.ok) return;

      const data = (await res.json()) as AudioStatusResult;
      setAudioState(data.state);
      setAudioReason(data.reason ?? null);
    } catch {
      // Silently ignore poll failures
    }
  }, [token]);

  useEffect(() => {
    if (audioState !== "generating" || !token) {
      // Stop polling when not generating or no token
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    // Start polling
    pollTimerRef.current = setInterval(pollStatus, pollIntervalMs);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [audioState, token, pollStatus, pollIntervalMs]);

  // Sync initial state from manifest changes
  useEffect(() => {
    setAudioState(initialState);
  }, [initialState]);

  // ── Regenerate ───────────────────────────────────────────────────

  const regenerate = useCallback(
    async (options?: { fastAudio?: boolean }) => {
      if (!token || isRegenerating) return;

      setIsRegenerating(true);
      setRegenError(null);

      try {
        const res = await fetch("/audio/regenerate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Token": token,
          },
          body: JSON.stringify(options ?? {}),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `Regeneration failed (${res.status})`);
        }

        const result = (await res.json()) as { accepted: boolean; status: AudioState };
        if (result.accepted) {
          setAudioState("generating");
        } else {
          setRegenError("Regeneration not accepted — audio may already be generating.");
        }
      } catch (err) {
        setRegenError(err instanceof Error ? err.message : "Regeneration failed");
      } finally {
        setIsRegenerating(false);
      }
    },
    [token, isRegenerating],
  );

  return { audioState, audioReason, isRegenerating, regenerate, regenError };
}
