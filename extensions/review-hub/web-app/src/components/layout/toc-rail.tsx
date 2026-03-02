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
  onSelect,
}: {
  sections: TocSection[];
  activeSectionId: string | null;
  onSelect: (sectionId: string) => void;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Contents</h2>
      </div>
      <ScrollArea className="h-full p-2">
        <ul className="space-y-1">
          {sections.map((section) => {
            const label = section.headingPath[section.headingPath.length - 1] ?? section.id;
            const depthPadding = Math.max(section.headingLevel - 1, 0) * 10;

            return (
              <li key={section.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    activeSectionId === section.id
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted text-muted-foreground",
                  )}
                  style={{ paddingLeft: `${8 + depthPadding}px` }}
                  onClick={() => onSelect(section.id)}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
