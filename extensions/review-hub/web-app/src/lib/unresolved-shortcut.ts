export type ReviewMode = "read" | "review";

interface NextUnresolvedShortcutOptions {
  mode: ReviewMode;
  unresolvedCount: number;
}

interface ShortcutEventLike {
  defaultPrevented: boolean;
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

export function shouldHandleNextUnresolvedShortcut(
  event: ShortcutEventLike,
  options: NextUnresolvedShortcutOptions,
): boolean {
  if (
    event.defaultPrevented ||
    options.mode !== "review" ||
    options.unresolvedCount === 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.key.toLowerCase() !== "n"
  ) {
    return false;
  }

  const target = event.target;
  if (!target || typeof target !== "object") {
    return true;
  }

  const maybeElement = target as { tagName?: unknown; isContentEditable?: unknown };
  const tagName =
    typeof maybeElement.tagName === "string" ? maybeElement.tagName.toUpperCase() : undefined;
  const isContentEditable = maybeElement.isContentEditable === true;

  if (isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return false;
  }

  return true;
}
