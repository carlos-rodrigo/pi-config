/**
 * DocumentViewport — renders canonical sections from /visual-model using react-markdown.
 *
 * Each section is rendered as a block with stable data-section-id attributes.
 * IntersectionObserver tracks which section is active for TOC sync.
 * Exposes scrollToSection via forwardRef/useImperativeHandle.
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { RenderSection } from "@/lib/api";
import { HighlightLayer, type HighlightEntry } from "./highlight-layer";

// Stable reference to avoid re-creating on every render
const REMARK_PLUGINS = [remarkGfm];

// ── Types ──────────────────────────────────────────────────────────────────

export interface DocumentViewportHandle {
  scrollToSection: (sectionId: string) => void;
  /** Ref to the container element — used by useSelectionAnchor */
  getContainerRef: () => HTMLElement | null;
}

export interface DocumentViewportProps {
  sections: RenderSection[];
  activeSectionId: string | null;
  onActiveSectionChange: (sectionId: string) => void;
  onSectionCommentRequest?: (sectionId: string) => void;
  /** Highlight entries grouped by sectionId */
  highlightsBySectionId?: Map<string, HighlightEntry[]>;
  /** Called when clicking a highlight chip */
  onHighlightClick?: (commentId: string) => void;
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────

export const DocumentViewport = forwardRef<DocumentViewportHandle, DocumentViewportProps>(
  function DocumentViewport(
    { sections, activeSectionId, onActiveSectionChange, onSectionCommentRequest, highlightsBySectionId, onHighlightClick, className },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

    // ── Register section elements ─────────────────────────────────────

    const setSectionRef = useCallback((sectionId: string, el: HTMLElement | null) => {
      if (el) {
        sectionRefs.current.set(sectionId, el);
      } else {
        sectionRefs.current.delete(sectionId);
      }
    }, []);

    // ── IntersectionObserver for active section tracking ───────────────

    useEffect(() => {
      const elements = Array.from(sectionRefs.current.values());
      if (elements.length === 0) return;

      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

          const topEntry = visible[0]?.target as HTMLElement | undefined;
          const sectionId = topEntry?.dataset.sectionId;
          if (sectionId) {
            onActiveSectionChange(sectionId);
          }
        },
        {
          root: null,
          threshold: [0.1, 0.3, 0.6],
          rootMargin: "-10% 0px -50% 0px",
        },
      );

      elements.forEach((el) => observer.observe(el));
      return () => observer.disconnect();
    }, [sections, onActiveSectionChange]);

    // ── Imperative scroll ─────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      scrollToSection(sectionId: string) {
        const el = sectionRefs.current.get(sectionId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
      getContainerRef() {
        return containerRef.current;
      },
    }));

    // ── Render ────────────────────────────────────────────────────────

    if (sections.length === 0) {
      return (
        <div className={cn("py-8 text-center text-sm text-muted-foreground", className)}>
          No sections to display.
        </div>
      );
    }

    return (
      <div ref={containerRef} className={cn("document-viewport space-y-1", className)}>
        {sections.map((section) => (
          <SectionBlock
            key={section.sectionId}
            section={section}
            isActive={activeSectionId === section.sectionId}
            onRef={(el) => setSectionRef(section.sectionId, el)}
            onCommentRequest={onSectionCommentRequest}
            highlights={highlightsBySectionId?.get(section.sectionId)}
            onHighlightClick={onHighlightClick}
          />
        ))}
      </div>
    );
  },
);

// ── Memoized section block ─────────────────────────────────────────────

interface SectionBlockProps {
  section: RenderSection;
  isActive: boolean;
  onRef: (el: HTMLElement | null) => void;
  onCommentRequest?: (sectionId: string) => void;
  highlights?: HighlightEntry[];
  onHighlightClick?: (commentId: string) => void;
}

const SectionBlock = memo(function SectionBlock({
  section,
  isActive,
  onRef,
  onCommentRequest,
  highlights,
  onHighlightClick,
}: SectionBlockProps) {
  return (
    <section
      data-section-id={section.sectionId}
      ref={onRef}
      className={cn(
        "document-section scroll-mt-20 rounded-lg px-1 py-2 transition-colors duration-200",
        isActive && "bg-accent/30",
      )}
    >
      <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-h4:text-base prose-p:leading-7 prose-pre:rounded-lg prose-pre:bg-muted prose-code:text-sm prose-table:text-sm">
        <Markdown remarkPlugins={REMARK_PLUGINS}>
          {section.markdown}
        </Markdown>
      </div>

      {highlights && highlights.length > 0 && (
        <HighlightLayer
          highlights={highlights}
          onHighlightClick={onHighlightClick}
        />
      )}

      {onCommentRequest ? (
        <button
          type="button"
          onClick={() => onCommentRequest(section.sectionId)}
          className="mt-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-primary [.document-section:hover_&]:opacity-100"
          aria-label={`Comment on ${section.headingPath[section.headingPath.length - 1] ?? "section"}`}
        >
          💬 Comment
        </button>
      ) : null}
    </section>
  );
});
