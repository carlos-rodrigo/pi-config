import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ReviewComment, ReviewManifest } from "@/lib/api";
import {
  buildUnresolvedCountsBySection,
  getNextUnresolvedComment,
  sortUnresolvedComments,
} from "@/lib/unresolved-navigation";

type ReviewSection = ReviewManifest["sections"][number];

export function useUnresolvedNavigation(comments: ReviewComment[], sections: ReviewSection[]) {
  const unresolvedComments = useMemo(
    () => sortUnresolvedComments(comments, sections),
    [comments, sections],
  );
  const unresolvedCountsBySection = useMemo(
    () => buildUnresolvedCountsBySection(comments),
    [comments],
  );
  const cursorCommentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cursorCommentIdRef.current) return;

    const stillExists = unresolvedComments.some(
      (comment) => comment.id === cursorCommentIdRef.current,
    );

    if (!stillExists) {
      cursorCommentIdRef.current = null;
    }
  }, [unresolvedComments]);

  const goToNextUnresolved = useCallback((): ReviewComment | null => {
    const nextComment = getNextUnresolvedComment(unresolvedComments, cursorCommentIdRef.current);
    cursorCommentIdRef.current = nextComment?.id ?? null;
    return nextComment;
  }, [unresolvedComments]);

  return {
    unresolvedComments,
    unresolvedCount: unresolvedComments.length,
    unresolvedCountsBySection,
    goToNextUnresolved,
  };
}
