import { type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { CommentPriority, CommentType, ReviewComment } from "@/lib/api";

export type CommentFormState = {
  id?: string;
  sectionId: string;
  type: CommentType;
  priority: CommentPriority;
  text: string;
};

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
  onSubmit,
  onFieldChange,
  onReset,
  onEdit,
  onDelete,
}: {
  comments: ReviewComment[];
  sections: SectionOption[];
  formState: CommentFormState;
  canSubmit: boolean;
  isSaving: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: <K extends keyof CommentFormState>(key: K, value: CommentFormState[K]) => void;
  onReset: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (commentId: string) => void;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Comments</h2>
          <Badge variant="outline">{comments.length}</Badge>
        </div>
      </div>

      <form className="space-y-3 p-4" onSubmit={onSubmit}>
        <label className="text-xs font-medium">Section</label>
        <select
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          value={formState.sectionId}
          onChange={(event) => onFieldChange("sectionId", event.target.value)}
        >
          <option value="">Select a section</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.headingPath[section.headingPath.length - 1]}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">Type</label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              value={formState.type}
              onChange={(event) => onFieldChange("type", event.target.value as CommentType)}
            >
              <option value="change">Change</option>
              <option value="question">Question</option>
              <option value="approval">Approval</option>
              <option value="concern">Concern</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Priority</label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              value={formState.priority}
              onChange={(event) => onFieldChange("priority", event.target.value as CommentPriority)}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <label className="text-xs font-medium">Comment</label>
        <textarea
          className="min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          value={formState.text}
          onChange={(event) => onFieldChange("text", event.target.value)}
          placeholder="Write your feedback…"
        />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canSubmit || isSaving}>
            {isSaving ? "Saving…" : formState.id ? "Update" : "Add"}
          </Button>
          {formState.id ? (
            <Button type="button" variant="outline" onClick={onReset}>
              Cancel edit
            </Button>
          ) : null}
        </div>
      </form>

      <Separator />

      <ScrollArea className="h-full px-3 py-2">
        {comments.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">No comments yet.</p>
        ) : (
          <ul className="space-y-2 pb-2">
            {[...comments]
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((comment) => (
                <li key={comment.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline">{comment.type}</Badge>
                      <Badge variant="secondary">{comment.priority}</Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onEdit(comment)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(comment.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm">{comment.text}</p>
                  <p className="text-muted-foreground text-xs">{resolveSectionLabel(comment.sectionId, sections)}</p>
                </li>
              ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

function resolveSectionLabel(sectionId: string, sections: SectionOption[]): string {
  const section = sections.find((item) => item.id === sectionId);
  return section ? section.headingPath[section.headingPath.length - 1] : sectionId;
}
