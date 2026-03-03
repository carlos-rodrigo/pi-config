import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ListTree, MessageSquare, PanelLeftOpen, PanelRightOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fadeVariants, motionTransition, panelVariants } from "@/lib/motion";
import { shouldHandleNextUnresolvedShortcut } from "@/lib/unresolved-shortcut";
import type { ReviewComment, SaveCommentInput } from "@/lib/api";
import { useReviewBootstrap } from "@/hooks/use-review-bootstrap";
import { useSessionToken } from "@/hooks/use-session-token";
import { useUnresolvedNavigation } from "@/hooks/use-unresolved-navigation";
import { NarrationPlayerBar } from "@/components/audio";
import { CommentRail, type CommentFormState } from "@/components/layout/comment-rail";
import { TocRail } from "@/components/layout/toc-rail";
import { VisualContentHost, type VisualContentHostHandle } from "@/components/visual/visual-content-host";

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

  const [mode, setMode] = useState<"read" | "review">("review");
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CommentFormState>(EMPTY_FORM);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const visualHostRef = useRef<VisualContentHostHandle | null>(null);
  const prefersReducedMotion = useReducedMotion();

  const sectionOptions = manifest?.sections ?? [];
  const { unresolvedCount, unresolvedCountsBySection, goToNextUnresolved } =
    useUnresolvedNavigation(comments, sectionOptions);

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

  const handleTocSelect = useCallback((sectionId: string) => {
    setActiveSectionId(sectionId);
    visualHostRef.current?.scrollToSection(sectionId);
  }, []);

  const handleSectionCommentRequest = useCallback((sectionId: string) => {
    setMode("review");
    setActiveSectionId(sectionId);
    setFormState({ ...EMPTY_FORM, sectionId });
    setMutationError(null);
  }, []);

  const handleNextUnresolved = useCallback(() => {
    const nextComment = goToNextUnresolved();
    if (!nextComment) {
      return;
    }

    handleTocSelect(nextComment.sectionId);
  }, [goToNextUnresolved, handleTocSelect]);

  useEffect(() => {
    if (mode !== "review" || unresolvedCount === 0) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleNextUnresolvedShortcut(event, { mode, unresolvedCount })) {
        return;
      }

      event.preventDefault();
      handleNextUnresolved();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNextUnresolved, mode, unresolvedCount]);

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

  return (
    <div className="review-hub-shell min-h-screen bg-background pb-24 text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/92 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {mode === "review" ? (
              <div className="flex items-center gap-1 lg:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Open contents panel">
                      <PanelLeftOpen />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-[320px] p-0 sm:max-w-[360px]">
                    <SheetHeader className="px-4 pt-5">
                      <SheetTitle>Contents</SheetTitle>
                      <SheetDescription>Navigate between review sections.</SheetDescription>
                    </SheetHeader>
                    <div className="h-[calc(100%-4.5rem)] p-4 pt-2">
                      <TocRail
                        sections={manifest.sections}
                        activeSectionId={activeSectionId}
                        unresolvedCountsBySection={unresolvedCountsBySection}
                        onSelect={handleTocSelect}
                      />
                    </div>
                  </SheetContent>
                </Sheet>

                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Open comments panel">
                      <PanelRightOpen />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-[360px] p-0 sm:max-w-[420px]">
                    <SheetHeader className="px-4 pt-5">
                      <SheetTitle>Comments</SheetTitle>
                      <SheetDescription>Add and manage review feedback.</SheetDescription>
                    </SheetHeader>
                    <div className="h-[calc(100%-4.5rem)] p-4 pt-2">
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
                        onReset={() => setFormState({ ...EMPTY_FORM, sectionId: formState.sectionId })}
                        onEdit={(comment) => handleEdit(comment.id)}
                        onDelete={handleDelete}
                        onToggleStatus={handleToggleStatus}
                        onJumpToSection={handleTocSelect}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            ) : null}

            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">Review Hub</h1>
              <p className="text-muted-foreground hidden truncate text-xs sm:block">{manifest.source}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-card/70 p-1 shadow-sm">
              <Button
                variant={mode === "read" ? "default" : "ghost"}
                size="sm"
                onClick={() => setMode("read")}
                aria-label="Switch to read mode"
              >
                <ListTree className="mr-1" />
                Read
              </Button>
              <Button
                variant={mode === "review" ? "default" : "ghost"}
                size="sm"
                onClick={() => setMode("review")}
                aria-label="Switch to review mode"
              >
                <MessageSquare className="mr-1" />
                Review
              </Button>
            </div>

            <Badge variant="secondary" className="hidden sm:inline-flex rounded-full px-2.5">
              {manifest.language.toUpperCase()}
            </Badge>
            <Badge variant={manifest.status === "reviewed" ? "default" : "outline"} className="rounded-full px-2.5 capitalize">
              {manifest.status}
            </Badge>
            <Button onClick={handleComplete} disabled={isCompleting}>
              {isCompleting ? "Completing…" : "Done Reviewing"}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1400px] gap-4 p-4 lg:p-6">
        <div
          className={cn(
            "grid min-h-[calc(100vh-8.5rem)] gap-4",
            mode === "review"
              ? "lg:grid-cols-[16rem_minmax(0,1fr)_24rem]"
              : "lg:grid-cols-[minmax(0,1fr)]",
          )}
        >
          <AnimatePresence initial={false}>
            {mode === "review" ? (
              <motion.div
                key="toc-rail"
                className="hidden lg:block"
                variants={panelVariants(Boolean(prefersReducedMotion), "left")}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={motionTransition(Boolean(prefersReducedMotion))}
              >
                <TocRail
                  sections={manifest.sections}
                  activeSectionId={activeSectionId}
                  unresolvedCountsBySection={unresolvedCountsBySection}
                  onSelect={handleTocSelect}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <motion.main
            variants={fadeVariants(Boolean(prefersReducedMotion))}
            initial="hidden"
            animate="visible"
            transition={motionTransition(Boolean(prefersReducedMotion), 0.2)}
            className={cn(
              "min-w-0 rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur sm:p-5",
              mode === "read" && "lg:px-10 lg:py-8",
            )}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Visual review content</h2>
              <Badge variant="outline" className="rounded-full px-2.5">
                {manifest.sections.length} sections
              </Badge>
            </div>

            <VisualContentHost
              ref={visualHostRef}
              className={cn("rounded-xl bg-background/35", mode === "read" ? "px-1" : "")}
              activeSectionId={activeSectionId}
              showEmbeddedProgressNav={mode === "read"}
              onActiveSectionChange={setActiveSectionId}
              onSectionCommentRequest={handleSectionCommentRequest}
            />

            <AnimatePresence initial={false}>
              {activeSection ? (
                <motion.p
                  key={activeSection.id}
                  className="text-muted-foreground mt-4 text-xs"
                  variants={fadeVariants(Boolean(prefersReducedMotion))}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={motionTransition(Boolean(prefersReducedMotion), 0.16)}
                >
                  Active section: {activeSection.id}
                </motion.p>
              ) : null}
            </AnimatePresence>
          </motion.main>

          <AnimatePresence initial={false}>
            {mode === "review" ? (
              <motion.div
                key="comment-rail"
                className="hidden lg:block"
                variants={panelVariants(Boolean(prefersReducedMotion), "right")}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={motionTransition(Boolean(prefersReducedMotion))}
              >
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
                  onReset={() => setFormState({ ...EMPTY_FORM, sectionId: formState.sectionId })}
                  onEdit={(comment) => handleEdit(comment.id)}
                  onDelete={handleDelete}
                  onToggleStatus={handleToggleStatus}
                  onJumpToSection={handleTocSelect}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

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
      </div>

      <NarrationPlayerBar manifest={manifest} onSectionSync={handleTocSelect} />
    </div>
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
