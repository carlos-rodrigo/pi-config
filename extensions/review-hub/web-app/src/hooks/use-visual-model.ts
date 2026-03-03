/**
 * useVisualModel — fetches the canonical section render payload from /visual-model.
 *
 * Returns an array of RenderSection objects that the DocumentViewport
 * uses for rendering. Section IDs come from the server, never derived client-side.
 */

import { useEffect, useMemo, useState } from "react";
import { ReviewApiClient, type RenderSection } from "@/lib/api";

export function useVisualModel(token: string | null) {
  const client = useMemo(() => (token ? new ReviewApiClient(token) : null), [token]);
  const [sections, setSections] = useState<RenderSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setSections([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    client
      .fetchVisualModel()
      .then((response) => {
        if (cancelled) return;
        setSections(response.sections);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load visual model");
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  return { sections, isLoading, error };
}
