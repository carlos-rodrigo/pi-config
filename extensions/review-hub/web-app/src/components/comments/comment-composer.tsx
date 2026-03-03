import { type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import type { CommentPriority, CommentType } from "@/lib/api";

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

export function CommentComposer({
  sections,
  formState,
  canSubmit,
  isSaving,
  anchorQuote,
  onSubmit,
  onFieldChange,
  onReset,
  onClearAnchor,
}: {
  sections: SectionOption[];
  formState: CommentFormState;
  canSubmit: boolean;
  isSaving: boolean;
  /** Quoted text from selection anchor (if any) */
  anchorQuote?: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: <K extends keyof CommentFormState>(key: K, value: CommentFormState[K]) => void;
  onReset: () => void;
  /** Clear the current anchor draft */
  onClearAnchor?: () => void;
}) {
  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      {anchorQuote ? (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 dark:border-yellow-700 dark:bg-yellow-900/20">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-yellow-700 dark:text-yellow-300">
              📌 Quoted text
            </span>
            {onClearAnchor ? (
              <button
                type="button"
                className="text-xs text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200"
                onClick={onClearAnchor}
              >
                ✕ Clear
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-sm italic text-yellow-800 dark:text-yellow-200 line-clamp-3">
            &ldquo;{anchorQuote}&rdquo;
          </p>
        </div>
      ) : null}

      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Section</label>
      <select
        className="w-full rounded-lg border bg-background/70 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
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
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</label>
          <select
            className="w-full rounded-lg border bg-background/70 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
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
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Priority</label>
          <select
            className="w-full rounded-lg border bg-background/70 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={formState.priority}
            onChange={(event) => onFieldChange("priority", event.target.value as CommentPriority)}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Comment</label>
      <textarea
        className="min-h-24 w-full rounded-lg border bg-background/70 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
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
  );
}
