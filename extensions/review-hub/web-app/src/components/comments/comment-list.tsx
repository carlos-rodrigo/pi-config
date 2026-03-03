import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ReviewComment } from "@/lib/api";
import { fadeVariants, motionTransition } from "@/lib/motion";

import type { CommentFilter } from "./comment-filters";

type SectionOption = {
  id: string;
  headingPath: string[];
};

export function CommentList({
  comments,
  sections,
  filter,
  onEdit,
  onDelete,
  onToggleStatus,
  onJumpToSection,
}: {
  comments: ReviewComment[];
  sections: SectionOption[];
  filter: CommentFilter;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (commentId: string) => void;
  onToggleStatus: (comment: ReviewComment) => void;
  onJumpToSection: (sectionId: string) => void;
}) {
  const prefersReducedMotion = useReducedMotion();

  const filteredComments = useMemo(
    () =>
      comments
        .filter((comment) => (filter === "all" ? true : comment.type === filter))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [comments, filter],
  );

  return (
    <ScrollArea className="h-full px-3 py-2">
      {filteredComments.length === 0 ? (
        <p className="text-muted-foreground p-2 text-sm">
          {comments.length === 0
            ? "No comments yet."
            : `No ${filter} comments. Try another filter.`}
        </p>
      ) : (
        <motion.ul layout className="space-y-2 pb-2">
          <AnimatePresence initial={false}>
            {filteredComments.map((comment) => {
              const status = comment.status ?? "open";
              return (
                <motion.li
                  key={comment.id}
                  layout
                  className="space-y-2 rounded-lg border p-3"
                  variants={fadeVariants(Boolean(prefersReducedMotion))}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={motionTransition(Boolean(prefersReducedMotion), 0.16)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline">{comment.type}</Badge>
                      <Badge variant="secondary">{comment.priority}</Badge>
                      <Badge variant={status === "resolved" ? "default" : "outline"}>{status}</Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onToggleStatus(comment)}>
                        {status === "resolved" ? "Reopen" : "Resolve"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(comment)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(comment.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm">{comment.text}</p>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-left text-xs underline-offset-4 hover:underline"
                    onClick={() => onJumpToSection(comment.sectionId)}
                  >
                    {resolveSectionLabel(comment.sectionId, sections)}
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </motion.ul>
      )}
    </ScrollArea>
  );
}

function resolveSectionLabel(sectionId: string, sections: SectionOption[]): string {
  const section = sections.find((item) => item.id === sectionId);
  return section ? section.headingPath[section.headingPath.length - 1] : sectionId;
}
