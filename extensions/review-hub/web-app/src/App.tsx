import { type FormEvent, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { CommentPriority, CommentType, ReviewComment, SaveCommentInput } from "@/lib/api";
import { useReviewBootstrap } from "@/hooks/use-review-bootstrap";
import { useSessionToken } from "@/hooks/use-session-token";

type CommentFormState = {
  id?: string;
  sectionId: string;
  type: CommentType;
  priority: CommentPriority;
  text: string;
};

const EMPTY_FORM: CommentFormState = {
  sectionId: "",
  type: "change",
  priority: "medium",
  text: "",
};

export default function App() {
  const { token, error: tokenError } = useSessionToken();
  const {
    manifest,
    comments,
    isLoading,
    error,
    isCompleting,
    completedAt,
    saveComment,
    deleteComment,
    completeReview,
  } = useReviewBootstrap(token);

  const [formState, setFormState] = useState<CommentFormState>(EMPTY_FORM);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const sectionOptions = manifest?.sections ?? [];

  const canSubmit = Boolean(formState.sectionId && formState.text.trim().length > 0);

  const sortedComments = useMemo(
    () => [...comments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [comments],
  );

  if (tokenError) {
    return <ErrorState title="Session token missing" message={tokenError} />;
  }

  if (isLoading) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-6 py-12">
        <p className="text-muted-foreground text-sm">Loading review manifest…</p>
      </main>
    );
  }

  if (!manifest) {
    return (
      <ErrorState
        title="Unable to load review"
        message={error ?? "Review manifest is unavailable. Try re-opening the URL from pi."}
      />
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const payload: SaveCommentInput = {
      id: formState.id,
      sectionId: formState.sectionId,
      type: formState.type,
      priority: formState.priority,
      text: formState.text.trim(),
    };

    setIsSaving(true);
    try {
      await saveComment(payload);
      setMutationError(null);
      setFormState((prev) => ({
        ...EMPTY_FORM,
        sectionId: prev.sectionId,
      }));
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to save comment.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleEdit(comment: ReviewComment) {
    setFormState({
      id: comment.id,
      sectionId: comment.sectionId,
      type: comment.type,
      priority: comment.priority,
      text: comment.text,
    });
    setMutationError(null);
  }

  async function handleDelete(commentId: string) {
    try {
      await deleteComment(commentId);
      setMutationError(null);
      setFormState((prev) => (prev.id === commentId ? EMPTY_FORM : prev));
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to delete comment.");
    }
  }

  async function handleComplete() {
    try {
      await completeReview();
      setMutationError(null);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to complete review.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Review Hub</h1>
          <p className="text-muted-foreground text-sm">{manifest.source}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{manifest.language.toUpperCase()}</Badge>
          <Badge variant={manifest.status === "reviewed" ? "default" : "outline"}>{manifest.status}</Badge>
          <Button onClick={handleComplete} disabled={isCompleting}>
            {isCompleting ? "Completing…" : "Done Reviewing"}
          </Button>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-[1.1fr_1.4fr]">
        <section className="rounded-xl border p-4">
          <h2 className="text-sm font-semibold">Comment editor</h2>
          <p className="text-muted-foreground mt-1 text-xs">Typed API client uses token auth for all mutations.</p>

          <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
            <label className="text-xs font-medium">Section</label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              value={formState.sectionId}
              onChange={(event) => setFormState((prev) => ({ ...prev, sectionId: event.target.value }))}
            >
              <option value="">Select a section</option>
              {sectionOptions.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.headingPath[section.headingPath.length - 1]}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Type</label>
                <select
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                  value={formState.type}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, type: event.target.value as CommentType }))
                  }
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
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, priority: event.target.value as CommentPriority }))
                  }
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>

            <label className="text-xs font-medium">Comment</label>
            <textarea
              className="min-h-28 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              value={formState.text}
              onChange={(event) => setFormState((prev) => ({ ...prev, text: event.target.value }))}
              placeholder="Write your feedback…"
            />

            <div className="flex gap-2">
              <Button type="submit" disabled={!canSubmit || isSaving}>
                {isSaving ? "Saving…" : formState.id ? "Update comment" : "Add comment"}
              </Button>
              {formState.id ? (
                <Button type="button" variant="outline" onClick={() => setFormState(EMPTY_FORM)}>
                  Cancel edit
                </Button>
              ) : null}
            </div>
          </form>
        </section>

        <section className="rounded-xl border p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Comments</h2>
            <Badge variant="outline">{comments.length}</Badge>
          </div>
          <Separator />
          <ScrollArea className="mt-3 h-[420px] pr-2">
            {sortedComments.length === 0 ? (
              <p className="text-muted-foreground p-2 text-sm">No comments yet.</p>
            ) : (
              <ul className="space-y-2">
                {sortedComments.map((comment) => (
                  <li key={comment.id} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs">
                        <Badge variant="outline">{comment.type}</Badge>
                        <Badge variant="secondary">{comment.priority}</Badge>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(comment)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(comment.id)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                    <p className="text-sm">{comment.text}</p>
                    <p className="text-muted-foreground text-xs">{resolveSectionLabel(comment.sectionId, sectionOptions)}</p>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </section>
      </div>

      {completedAt ? (
        <p className="text-sm font-medium text-emerald-600">
          Review marked complete at {new Date(completedAt).toLocaleString()}.
        </p>
      ) : null}

      {mutationError || error ? (
        <p className="text-sm text-red-600">{mutationError ?? error}</p>
      ) : null}
    </main>
  );
}

function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-12">
      <section className="w-full max-w-xl rounded-xl border p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{message}</p>
      </section>
    </main>
  );
}

function resolveSectionLabel(
  sectionId: string,
  sections: Array<{ id: string; headingPath: string[] }>,
): string {
  const section = sections.find((item) => item.id === sectionId);
  return section ? section.headingPath[section.headingPath.length - 1] : sectionId;
}
