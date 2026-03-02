import { useCallback, useEffect, useMemo, useState } from "react";

import { ReviewApiClient, type ReviewManifest, type ReviewComment, type SaveCommentInput } from "@/lib/api";

export function useReviewBootstrap(token: string | null) {
  const client = useMemo(() => (token ? new ReviewApiClient(token) : null), [token]);

  const [manifest, setManifest] = useState<ReviewManifest | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(client));
  const [error, setError] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [completedAt, setCompletedAt] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;

    if (!client) {
      setManifest(null);
      setComments([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    client
      .fetchManifest()
      .then((nextManifest) => {
        if (isCancelled) return;
        const normalizedComments = (nextManifest.comments ?? []).map(normalizeComment);
        setManifest({ ...nextManifest, comments: normalizedComments });
        setComments(normalizedComments);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load review manifest.");
      })
      .finally(() => {
        if (isCancelled) return;
        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [client]);

  const saveComment = useCallback(
    async (input: SaveCommentInput): Promise<ReviewComment> => {
      if (!client) {
        throw new Error("API client not initialized.");
      }

      const saved = normalizeComment(await client.saveComment(input));
      setComments((prev) => {
        const existingIndex = prev.findIndex((item) => item.id === saved.id);
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = saved;
          return next;
        }
        return [...prev, saved];
      });
      setError(null);
      return saved;
    },
    [client],
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      if (!client) {
        throw new Error("API client not initialized.");
      }

      await client.deleteComment(commentId);
      setComments((prev) => prev.filter((item) => item.id !== commentId));
      setError(null);
    },
    [client],
  );

  const completeReview = useCallback(async (): Promise<void> => {
    if (!client) {
      throw new Error("API client not initialized.");
    }

    setIsCompleting(true);
    try {
      const result = await client.completeReview();
      setCompletedAt(result.completedAt);
      setManifest((prev) =>
        prev
          ? {
              ...prev,
              status: result.status,
              completedAt: result.completedAt,
            }
          : prev,
      );
      setError(null);
    } finally {
      setIsCompleting(false);
    }
  }, [client]);

  return {
    manifest,
    comments,
    isLoading,
    error,
    isCompleting,
    completedAt,
    saveComment,
    deleteComment,
    completeReview,
  };
}

function normalizeComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    status: comment.status ?? "open",
  };
}
