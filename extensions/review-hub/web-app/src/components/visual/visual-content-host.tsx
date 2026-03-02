import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

export type VisualContentHostHandle = {
  scrollToSection: (sectionId: string) => void;
};

export const VisualContentHost = forwardRef<
  VisualContentHostHandle,
  {
    className?: string;
    activeSectionId: string | null;
    onActiveSectionChange: (sectionId: string) => void;
  }
>(function VisualContentHost({ className, activeSectionId, onActiveSectionChange }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visualHtml, setVisualHtml] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const linkId = "review-hub-visual-styles";
    let styleLink = document.getElementById(linkId) as HTMLLinkElement | null;

    if (!styleLink) {
      styleLink = document.createElement("link");
      styleLink.id = linkId;
      styleLink.rel = "stylesheet";
      styleLink.href = "/visual-styles";
      document.head.appendChild(styleLink);
    }

    return () => {
      // Keep stylesheet mounted for app lifetime once inserted.
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    setIsLoading(true);
    setError(null);

    fetch("/visual")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load visual content (${response.status})`);
        }
        return response.text();
      })
      .then((html) => {
        if (isCancelled) return;
        setVisualHtml(html);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load visual content");
      })
      .finally(() => {
        if (isCancelled) return;
        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  const sectionElements = useMemo(() => {
    const root = containerRef.current;
    if (!root) return [] as HTMLElement[];

    return Array.from(root.querySelectorAll<HTMLElement>(".review-section[data-section-id]"));
  }, [visualHtml]);

  useEffect(() => {
    if (sectionElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        const candidate = visible[0]?.target as HTMLElement | undefined;
        const sectionId = candidate?.dataset.sectionId;
        if (sectionId) {
          onActiveSectionChange(sectionId);
        }
      },
      {
        root: null,
        threshold: [0.2, 0.5, 0.8],
        rootMargin: "-20% 0px -55% 0px",
      },
    );

    sectionElements.forEach((element) => observer.observe(element));

    return () => {
      observer.disconnect();
    };
  }, [sectionElements, onActiveSectionChange]);

  useImperativeHandle(ref, () => ({
    scrollToSection(sectionId: string) {
      const root = containerRef.current;
      if (!root) return;

      const escapedId = typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(sectionId) : sectionId;
      const section = root.querySelector<HTMLElement>(`.review-section[data-section-id="${escapedId}"]`);
      if (!section) return;

      section.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  }));

  useEffect(() => {
    if (!activeSectionId) return;

    const root = containerRef.current;
    if (!root) return;

    root.querySelectorAll<HTMLElement>(".review-section.is-active").forEach((node) => {
      node.classList.remove("is-active");
    });

    const escapedId = typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(activeSectionId) : activeSectionId;
    const section = root.querySelector<HTMLElement>(`.review-section[data-section-id="${escapedId}"]`);
    section?.classList.add("is-active");
  }, [activeSectionId]);

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading visual content…</div>;
  }

  if (error) {
    return <div className="text-sm text-red-600">{error}</div>;
  }

  return (
    <div className={cn("min-h-full", className)}>
      <div ref={containerRef} dangerouslySetInnerHTML={{ __html: visualHtml }} />
    </div>
  );
});
