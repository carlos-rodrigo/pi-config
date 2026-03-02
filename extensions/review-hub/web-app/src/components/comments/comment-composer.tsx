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
  onSubmit,
  onFieldChange,
  onReset,
}: {
  sections: SectionOption[];
  formState: CommentFormState;
  canSubmit: boolean;
  isSaving: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: <K extends keyof CommentFormState>(key: K, value: CommentFormState[K]) => void;
  onReset: () => void;
}) {
  return (
    <form className="space-y-3" onSubmit={onSubmit}>
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
  );
}
