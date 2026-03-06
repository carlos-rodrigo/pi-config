const VISUAL_MODE = "VISUAL";
const VISUAL_CLASS = "document-content--visual";
const HAS_SELECTION_CLASS = "document-content--has-selection";

export function createSelectionController(options) {
	const root = options?.root;
	if (!root || !root.classList || typeof root.contains !== "function") {
		throw new Error("createSelectionController requires a valid root element.");
	}

	const ownerDocument = options.ownerDocument ?? globalThis.document;
	const getSelection = options.getSelection ?? (() => globalThis.window?.getSelection?.() ?? null);
	const onSelectionChange =
		typeof options.onSelectionChange === "function" ? options.onSelectionChange : () => undefined;

	let mode = "NORMAL";
	let lastHasSelection;

	const syncSelectionState = () => {
		const selection = getSelection();
		const hasSelection = mode === VISUAL_MODE && isSelectionInsideRoot(selection, root);
		if (hasSelection === lastHasSelection) return;
		lastHasSelection = hasSelection;
		root.classList.toggle(HAS_SELECTION_CLASS, hasSelection);
		onSelectionChange({ hasSelection });
	};

	const handleSelectionChange = () => {
		syncSelectionState();
	};

	ownerDocument?.addEventListener?.("selectionchange", handleSelectionChange);

	return {
		setMode(nextMode, modeOptions = {}) {
			mode = typeof nextMode === "string" ? nextMode : "NORMAL";
			root.classList.toggle(VISUAL_CLASS, mode === VISUAL_MODE);

			if (mode !== VISUAL_MODE && modeOptions.clearSelection !== false) {
				clearSelection(getSelection);
			}

			syncSelectionState();
		},
		extendSelection(motion) {
			if (mode !== VISUAL_MODE) return false;
			const direction = motion?.direction;
			const granularity = motion?.granularity;
			if (typeof direction !== "string" || typeof granularity !== "string") return false;

			const selection = getSelection();
			if (!selection || typeof selection.modify !== "function") return false;

			selection.modify("extend", direction, granularity);
			syncSelectionState();
			return true;
		},
		clearSelection() {
			clearSelection(getSelection);
			syncSelectionState();
		},
		destroy() {
			ownerDocument?.removeEventListener?.("selectionchange", handleSelectionChange);
		},
	};
}

function isSelectionInsideRoot(selection, root) {
	if (!selection) return false;
	if (selection.rangeCount < 1 || selection.isCollapsed) return false;

	try {
		const range = selection.getRangeAt(0);
		return root.contains(range.commonAncestorContainer);
	} catch {
		return false;
	}
}

function clearSelection(getSelection) {
	const selection = getSelection();
	if (!selection || typeof selection.removeAllRanges !== "function") return;
	selection.removeAllRanges();
}
