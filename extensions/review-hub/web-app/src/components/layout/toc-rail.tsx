import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type TocSection = {
  id: string;
  headingPath: string[];
  headingLevel: number;
};

export function TocRail({
  sections,
  activeSectionId,
  unresolvedCountsBySection,
  onSelect,
}: {
  sections: TocSection[];
  activeSectionId: string | null;
  unresolvedCountsBySection?: Record<string, number>;
  onSelect: (sectionId: string) => void;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm backdrop-blur">
      <div className="border-b border-border/70 bg-muted/40 px-4 py-3">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Contents</h2>
      </div>
      <ScrollArea className="h-full p-2">
        <ul className="space-y-1">
          {sections.map((section) => {
            const label = section.headingPath[section.headingPath.length - 1] ?? section.id;
            const depthPadding = Math.max(section.headingLevel - 1, 0) * 10;
            const unresolvedCount = unresolvedCountsBySection?.[section.id] ?? 0;

            return (
              <li key={section.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    activeSectionId === section.id
                      ? "bg-primary/95 text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                  )}
                  style={{ paddingLeft: `${10 + depthPadding}px` }}
                  onClick={() => onSelect(section.id)}
                >
                  <span className="truncate">{label}</span>
                  {unresolvedCount > 0 ? (
                    <Badge variant={activeSectionId === section.id ? "secondary" : "destructive"}>
                      {unresolvedCount}
                    </Badge>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
