/**
 * App — root component for Review Hub.
 *
 * Wires together the shell layout, bootstrap hook, comment management,
 * and all UI surfaces. Delegates layout orchestration to ReviewShell.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { shouldHandleNextUnresolvedShortcut } from "@/lib/unresolved-shortcut";
import type { ReviewComment, SaveCommentInput } from "@/lib/api";
import { useReviewBootstrap } from "@/hooks/use-review-bootstrap";
import { useSessionToken } from "@/hooks/use-session-token";
import { useVisualModel } from "@/hooks/use-visual-model";
import { useUnresolvedNavigation } from "@/hooks/use-unresolved-navigation";
import { useSelectionAnchor } from "@/hooks/use-selection-anchor";
import type { AnchorPayload } from "@/lib/anchor/capture";
import { NarrationPlayerBar } from "@/components/audio";
import { CommentRail, type CommentFormState } from "@/components/layout/comment-rail";
import { TocRail } from "@/components/layout/toc-rail";
import { DocumentViewport, type DocumentViewportHandle } from "@/components/document";
import { ReviewShell, type ReviewMode } from "@/components/shell";

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

  const [mode, setMode] = useState<ReviewMode>("review");
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CommentFormState>(EMPTY_FORM);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [anchorDraft, setAnchorDraft] = useState<AnchorPayload | null>(null);
  const viewportRef = useRef<DocumentViewportHandle | null>(null);
  const viewportContainerRef = useRef<HTMLElement | null>(null);

  const { sections: visualSections, isLoading: visualLoading, error: visualError } = useVisualModel(token);

  // ── Selection anchor capture ──────────────────────────────────────
  // Keep containerRef in sync with viewport's internal container
  useEffect(() => {
    viewportContainerRef.current = viewportRef.current?.getContainerRef() ?? null;
  });

  useSelectionAnchor({
    containerRef: viewportContainerRef,
    sections: visualSections,
    enabled: mode === "review",
    onAnchorCaptured: useCallback(({ sectionId, anchor }) => {
      setMode("review");
      setActiveSectionId(sectionId);
      setAnchorDraft(anchor);
      setFormState({ ...EMPTY_FORM, sectionId });
      setMutationError(null);
    }, []),
  });

  const sectionOptions = manifest?.sections ?? [];
  const { unresolvedCount, unresolvedCountsBySection, goToNextUnresolved } =
    useUnresolvedNavigation(comments, sectionOptions);

  // ── Section tracking ──────────────────────────────────────────────────

  useEffect(() => {
    if (!manifest?.sections.length) return;

    const fallbackSectionId = activeSectionId ?? manifest.sections[0]?.id ?? null;
    setActiveSectionId(fallbackSectionId);

    setFormState((prev) => ({
      ...prev,
      sectionId: prev.sectionId || fallbackSectionId || "",
    }));
  }, [manifest, activeSectionId]);

  const activeSection = useMemo(
    () => manifest?.sections.find((section) => section.id === activeSectionId) ?? null,
    [manifest, activeSectionId],
  );

  // ── Comment management ────────────────────────────────────────────────

  const canSubmit = Boolean(formState.sectionId && formState.text.trim().length > 0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const payload: SaveCommentInput = {
      id: formState.id,
      sectionId: formState.sectionId,
      type: formState.type,
      priority: formState.priority,
      text: formState.text.trim(),
      ...(anchorDraft && !formState.id ? { anchor: anchorDraft } : {}),
    };

    setIsSaving(true);
    try {
      await saveComment(payload);
      setMutationError(null);
      setAnchorDraft(null);
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

  function handleEdit(commentId: string) {
    const comment = comments.find((item) => item.id === commentId);
    if (!comment) return;

    setFormState({
      id: comment.id,
      sectionId: comment.sectionId,
      type: comment.type,
      priority: comment.priority,
      text: comment.text,
    });
    setActiveSectionId(comment.sectionId);
    setMutationError(null);
  }

  async function handleDelete(commentId: string) {
    try {
      await deleteComment(commentId);
      setMutationError(null);
      setFormState((prev) => (prev.id === commentId ? { ...EMPTY_FORM, sectionId: prev.sectionId } : prev));
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to delete comment.");
    }
  }

  async function handleToggleStatus(comment: ReviewComment) {
    try {
      await saveComment({
        id: comment.id,
        sectionId: comment.sectionId,
        type: comment.type,
        priority: comment.priority,
        text: comment.text,
        audioTimestamp: comment.audioTimestamp,
        status: (comment.status ?? "open") === "resolved" ? "open" : "resolved",
      });
      setMutationError(null);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to update comment status.");
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

  // ── Navigation ────────────────────────────────────────────────────────

  const handleTocSelect = useCallback((sectionId: string) => {
    setActiveSectionId(sectionId);
    viewportRef.current?.scrollToSection(sectionId);
  }, []);

  const handleSectionCommentRequest = useCallback((sectionId: string) => {
    setMode("review");
    setActiveSectionId(sectionId);
    setAnchorDraft(null);
    setFormState({ ...EMPTY_FORM, sectionId });
    setMutationError(null);
  }, []);

  const handleNextUnresolved = useCallback(() => {
    const nextComment = goToNextUnresolved();
    if (!nextComment) return;
    handleTocSelect(nextComment.sectionId);
  }, [goToNextUnresolved, handleTocSelect]);

  // ── Keyboard shortcut (N for next unresolved) ─────────────────────────

  useEffect(() => {
    if (mode !== "review" || unresolvedCount === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleNextUnresolvedShortcut(event, { mode, unresolvedCount })) return;
      event.preventDefault();
      handleNextUnresolved();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNextUnresolved, mode, unresolvedCount]);

  // ── Loading / error states ────────────────────────────────────────────

  if (tokenError) {
    return <ErrorState title="Session token missing" message={tokenError} />;
  }

  if (isLoading) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-6 py-12">
        <p className="text-sm text-muted-foreground">Loading review manifest…</p>
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

  // ── Render ────────────────────────────────────────────────────────────

  const tocRailContent = useMemo(() => (
    <TocRail
      sections={manifest.sections}
      activeSectionId={activeSectionId}
      unresolvedCountsBySection={unresolvedCountsBySection}
      onSelect={handleTocSelect}
    />
  ), [manifest?.sections, activeSectionId, unresolvedCountsBySection, handleTocSelect]);

  const commentRailContent = useMemo(() => (
    <CommentRail
      comments={comments}
      sections={sectionOptions}
      formState={formState}
      canSubmit={canSubmit}
      isSaving={isSaving}
      unresolvedCount={unresolvedCount}
      onNextUnresolved={handleNextUnresolved}
      onSubmit={handleSubmit}
      onFieldChange={(key, value) => setFormState((prev) => ({ ...prev, [key]: value }))}
      onReset={() => { setFormState({ ...EMPTY_FORM, sectionId: formState.sectionId }); setAnchorDraft(null); }}
      onEdit={(comment) => handleEdit(comment.id)}
      onDelete={handleDelete}
      onToggleStatus={handleToggleStatus}
      onJumpToSection={handleTocSelect}
    />
  ), [comments, sectionOptions, formState, canSubmit, isSaving, unresolvedCount,
      handleNextUnresolved, handleTocSelect]);

  return (
    <ReviewShell
      mode={mode}
      onModeChange={setMode}
      headerProps={{
        sourcePath: manifest.source,
        language: manifest.language,
        status: manifest.status,
        isCompleting,
        onComplete: handleComplete,
      }}
      tocRail={tocRailContent}
      commentRail={commentRailContent}
      bottomBar={<NarrationPlayerBar manifest={manifest} onSectionSync={handleTocSelect} />}
      statusBar={
        <>
          {completedAt ? (
            <p className="text-sm font-medium text-emerald-600" role="status" aria-live="polite">
              Review marked complete at {new Date(completedAt).toLocaleString()}.
            </p>
          ) : null}
          {mutationError || error ? (
            <p className="text-sm text-red-600" role="alert">
              {mutationError ?? error}
            </p>
          ) : null}
        </>
      }
    >
      {/* Main content area */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Document
        </h2>
        <Badge variant="outline" className="rounded-full px-2.5">
          {visualSections.length} sections
        </Badge>
      </div>

      {visualLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading document…
        </p>
      ) : visualError ? (
        <p className="py-8 text-center text-sm text-red-600">{visualError}</p>
      ) : (
        <DocumentViewport
          ref={viewportRef}
          sections={visualSections}
          className={cn("rounded-xl bg-background/35", mode === "read" ? "px-1" : "")}
          activeSectionId={activeSectionId}
          onActiveSectionChange={setActiveSectionId}
          onSectionCommentRequest={handleSectionCommentRequest}
        />
      )}

      {activeSection ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Active section: {activeSection.id}
        </p>
      ) : null}
    </ReviewShell>
  );
}

function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-12">
      <section className="w-full max-w-xl rounded-xl border p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </section>
    </main>
  );
}
