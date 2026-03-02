import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const previewItems = [
  "React + Vite + TypeScript scaffold",
  "Tailwind v4 design tokens and utility pipeline",
  "shadcn/ui primitives for Review Hub shell",
  "Deterministic dist output for local server hosting",
  "No runtime CDN dependency for core UI rendering",
];

export function FoundationPreview() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Review Hub UI Refresh</h1>
          <Badge variant="secondary">Task 001</Badge>
        </div>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Frontend workspace is now powered by React, Vite, Tailwind v4, and shadcn/ui primitives.
        </p>
      </header>

      <section className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Foundation check</h2>
          <ScrollArea className="h-40 rounded-md border p-3">
            <ul className="space-y-2 text-sm">
              {previewItems.map((item) => (
                <li key={item} className="bg-muted/40 rounded px-2 py-1">
                  {item}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary action</Button>
            <Button variant="outline">Secondary</Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost">Tooltip demo</Button>
              </TooltipTrigger>
              <TooltipContent>Review controls will use shadcn tooltips.</TooltipContent>
            </Tooltip>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog primitive wired</DialogTitle>
                  <DialogDescription>
                    This confirms Radix dialog integration for modal flows.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button>Looks good</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open sheet</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Sheet primitive wired</SheetTitle>
                  <SheetDescription>
                    Responsive rails and drawers can now use this primitive.
                  </SheetDescription>
                </SheetHeader>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </section>
    </main>
  );
}
