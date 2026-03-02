import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CommentType, ReviewComment } from "@/lib/api";

export type CommentFilter = "all" | CommentType;

const FILTERS: CommentFilter[] = ["all", "change", "question", "approval", "concern"];

export function CommentFilters({
  comments,
  activeFilter,
  onChange,
}: {
  comments: ReviewComment[];
  activeFilter: CommentFilter;
  onChange: (filter: CommentFilter) => void;
}) {
  const counts = buildCounts(comments);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filters</p>
        <Badge variant="outline">{counts.all}</Badge>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((filter) => (
          <Button
            key={filter}
            type="button"
            size="sm"
            variant={activeFilter === filter ? "default" : "ghost"}
            onClick={() => onChange(filter)}
            className="h-7"
          >
            <span className="capitalize">{filter}</span>
            <span className="text-xs opacity-70">{counts[filter]}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function buildCounts(comments: ReviewComment[]): Record<CommentFilter, number> {
  return {
    all: comments.length,
    change: comments.filter((comment) => comment.type === "change").length,
    question: comments.filter((comment) => comment.type === "question").length,
    approval: comments.filter((comment) => comment.type === "approval").length,
    concern: comments.filter((comment) => comment.type === "concern").length,
  };
}
