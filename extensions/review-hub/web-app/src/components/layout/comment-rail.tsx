import { type FormEvent, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CommentComposer,
  CommentFilters,
  CommentList,
  type CommentFilter,
  type CommentFormState,
} from "@/components/comments";
import type { ReviewComment } from "@/lib/api";

export type { CommentFormState };

type SectionOption = {
  id: string;
  headingPath: string[];
};

export function CommentRail({
  comments,
  sections,
  formState,
  canSubmit,
  isSaving,
  unresolvedCount,
  onNextUnresolved,
  onSubmit,
  onFieldChange,
  onReset,
  onEdit,
  onDelete,
  onToggleStatus,
  onJumpToSection,
}: {
  comments: ReviewComment[];
  sections: SectionOption[];
  formState: CommentFormState;
  canSubmit: boolean;
  isSaving: boolean;
  unresolvedCount: number;
  onNextUnresolved: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: <K extends keyof CommentFormState>(key: K, value: CommentFormState[K]) => void;
  onReset: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (commentId: string) => void;
  onToggleStatus: (comment: ReviewComment) => void;
  onJumpToSection: (sectionId: string) => void;
}) {
  const [activeFilter, setActiveFilter] = useState<CommentFilter>("all");

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border">
      <div className="space-y-3 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Comments</h2>
          <div className="flex items-center gap-1">
            <Badge variant="outline">{comments.length}</Badge>
            <Badge variant={unresolvedCount > 0 ? "destructive" : "secondary"}>
              {unresolvedCount} open
            </Badge>
          </div>
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-between"
            onClick={onNextUnresolved}
            disabled={unresolvedCount === 0}
            aria-keyshortcuts="N"
          >
            <span>Next unresolved</span>
            <span className="text-muted-foreground text-xs">N</span>
          </Button>

          {unresolvedCount === 0 ? (
            <p className="text-muted-foreground text-xs">All caught up — no unresolved comments.</p>
          ) : null}
        </div>

        <CommentFilters comments={comments} activeFilter={activeFilter} onChange={setActiveFilter} />
      </div>

      <div className="p-4">
        <CommentComposer
          sections={sections}
          formState={formState}
          canSubmit={canSubmit}
          isSaving={isSaving}
          onSubmit={onSubmit}
          onFieldChange={onFieldChange}
          onReset={onReset}
        />
      </div>

      <Separator />

      <CommentList
        comments={comments}
        sections={sections}
        filter={activeFilter}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggleStatus={onToggleStatus}
        onJumpToSection={onJumpToSection}
      />
    </aside>
  );
}
