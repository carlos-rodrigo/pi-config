/**
 * ReviewShell — top-level layout orchestration for the review app.
 *
 * Handles:
 * - 3-column desktop layout (TOC / content / comments) in Review mode
 * - Single-column reading layout in Read mode
 * - Mobile drawers for rails via Sheet components
 * - Responsive transitions between modes
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fadeVariants, motionTransition, panelVariants } from "@/lib/motion";
import { ShellHeader, type ReviewMode, type ShellHeaderProps } from "./shell-header";

export interface ReviewShellProps {
  /** Current review mode */
  mode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  /** Header props forwarded to ShellHeader */
  headerProps: Omit<ShellHeaderProps, "mode" | "onModeChange" | "onOpenToc" | "onOpenComments">;
  /** Main content area (document viewport) */
  children: ReactNode;
  /** Left rail content (TOC) — shown in Review mode */
  tocRail?: ReactNode;
  /** Right rail content (comments) — shown in Review mode */
  commentRail?: ReactNode;
  /** Bottom bar content (audio player) */
  bottomBar?: ReactNode;
  /** Status messages (completion, errors) */
  statusBar?: ReactNode;
}

export function ReviewShell({
  mode,
  onModeChange,
  headerProps,
  children,
  tocRail,
  commentRail,
  bottomBar,
  statusBar,
}: ReviewShellProps) {
  const prefersReducedMotion = useReducedMotion();
  const [tocOpen, setTocOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);

  return (
    <div className="review-hub-shell min-h-screen bg-background pb-24 text-foreground">
      <ShellHeader
        mode={mode}
        onModeChange={onModeChange}
        onOpenToc={() => setTocOpen(true)}
        onOpenComments={() => setCommentsOpen(true)}
        {...headerProps}
      />

      {/* Mobile drawers */}
      {mode === "review" ? (
        <>
          <Sheet open={tocOpen} onOpenChange={setTocOpen}>
            <SheetContent side="left" className="w-[320px] p-0 sm:max-w-[360px]">
              <SheetHeader className="px-4 pt-5">
                <SheetTitle>Contents</SheetTitle>
                <SheetDescription>Navigate between review sections.</SheetDescription>
              </SheetHeader>
              <div className="h-[calc(100%-4.5rem)] p-4 pt-2">{tocRail}</div>
            </SheetContent>
          </Sheet>

          <Sheet open={commentsOpen} onOpenChange={setCommentsOpen}>
            <SheetContent side="right" className="w-[360px] p-0 sm:max-w-[420px]">
              <SheetHeader className="px-4 pt-5">
                <SheetTitle>Comments</SheetTitle>
                <SheetDescription>Add and manage review feedback.</SheetDescription>
              </SheetHeader>
              <div className="h-[calc(100%-4.5rem)] p-4 pt-2">{commentRail}</div>
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      {/* Main layout */}
      <div className="mx-auto grid w-full max-w-[1400px] gap-4 p-4 lg:p-6">
        <div
          className={cn(
            "grid min-h-[calc(100vh-8.5rem)] gap-4",
            mode === "review"
              ? "lg:grid-cols-[16rem_minmax(0,1fr)_24rem]"
              : "lg:grid-cols-[minmax(0,1fr)]",
          )}
        >
          {/* Left rail: TOC (desktop, Review mode) */}
          <AnimatePresence initial={false}>
            {mode === "review" && tocRail ? (
              <motion.div
                key="toc-rail"
                className="hidden lg:block"
                variants={panelVariants(Boolean(prefersReducedMotion), "left")}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={motionTransition(Boolean(prefersReducedMotion))}
              >
                {tocRail}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* Center: main content */}
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
            {children}
          </motion.main>

          {/* Right rail: comments (desktop, Review mode) */}
          <AnimatePresence initial={false}>
            {mode === "review" && commentRail ? (
              <motion.div
                key="comment-rail"
                className="hidden lg:block"
                variants={panelVariants(Boolean(prefersReducedMotion), "right")}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={motionTransition(Boolean(prefersReducedMotion))}
              >
                {commentRail}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Status bar (completion, errors) */}
        {statusBar}
      </div>

      {/* Bottom bar (audio player) */}
      {bottomBar}
    </div>
  );
}
