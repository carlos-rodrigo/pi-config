/**
 * ShellHeader — top bar with mode toggle, status badges, and completion action.
 *
 * Sticky header for the review shell. Contains:
 * - Mobile drawer triggers (review mode only)
 * - Document title + source path
 * - Read/Review mode toggle
 * - Language + status badges
 * - "Done Reviewing" action
 */

import { BookOpen, MessageSquareText, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ReviewMode = "read" | "review";

export interface ShellHeaderProps {
  mode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  sourcePath: string;
  language: string;
  status: string;
  isCompleting: boolean;
  onComplete: () => void;
  /** Mobile drawer triggers — passed from parent shell */
  onOpenToc?: () => void;
  onOpenComments?: () => void;
}

export function ShellHeader({
  mode,
  onModeChange,
  sourcePath,
  language,
  status,
  isCompleting,
  onComplete,
  onOpenToc,
  onOpenComments,
}: ShellHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/92 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 lg:px-6">
        {/* Left: mobile drawer triggers + title */}
        <div className="flex min-w-0 items-center gap-2">
          {mode === "review" && (onOpenToc || onOpenComments) ? (
            <div className="flex items-center gap-1 lg:hidden">
              {onOpenToc ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={onOpenToc}
                  aria-label="Open contents panel"
                >
                  <PanelLeftOpen />
                </Button>
              ) : null}
              {onOpenComments ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={onOpenComments}
                  aria-label="Open comments panel"
                >
                  <PanelRightOpen />
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
              Review Hub
            </h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">
              {sourcePath}
            </p>
          </div>
        </div>

        {/* Right: mode toggle + badges + action */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-card/70 p-1 shadow-sm">
            <Button
              variant={mode === "read" ? "default" : "ghost"}
              size="sm"
              onClick={() => onModeChange("read")}
              aria-label="Switch to read mode"
            >
              <BookOpen className="mr-1 h-4 w-4" />
              Read
            </Button>
            <Button
              variant={mode === "review" ? "default" : "ghost"}
              size="sm"
              onClick={() => onModeChange("review")}
              aria-label="Switch to review mode"
            >
              <MessageSquareText className="mr-1 h-4 w-4" />
              Review
            </Button>
          </div>

          <Badge variant="secondary" className="hidden rounded-full px-2.5 sm:inline-flex">
            {language.toUpperCase()}
          </Badge>
          <Badge
            variant={status === "reviewed" ? "default" : "outline"}
            className="rounded-full px-2.5 capitalize"
          >
            {status}
          </Badge>
          <Button onClick={onComplete} disabled={isCompleting}>
            {isCompleting ? "Completing…" : "Done Reviewing"}
          </Button>
        </div>
      </div>
    </header>
  );
}
