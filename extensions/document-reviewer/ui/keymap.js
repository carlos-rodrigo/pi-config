export const MODES = Object.freeze({
	NORMAL: "NORMAL",
	VISUAL: "VISUAL",
	COMMENT: "COMMENT",
});

const DEFAULT_SCROLL_STEP = 44;

const VISUAL_MOTION = Object.freeze({
	j: { direction: "forward", granularity: "line" },
	k: { direction: "backward", granularity: "line" },
	h: { direction: "backward", granularity: "character" },
	l: { direction: "forward", granularity: "character" },
});

export function resolveKeyAction(event, mode, options = {}) {
	if (!event) return null;
	if (event.defaultPrevented || event.metaKey || event.altKey) return null;

	const key = normalizeKey(event.key);
	const currentMode = MODES[mode] ? mode : MODES.NORMAL;

	if (key === "escape") {
		return {
			type: "mode",
			mode: MODES.NORMAL,
			clearSelection: true,
		};
	}

	if (!event.ctrlKey && key === "v") {
		const nextMode = currentMode === MODES.VISUAL ? MODES.NORMAL : MODES.VISUAL;
		return {
			type: "mode",
			mode: nextMode,
			clearSelection: nextMode === MODES.NORMAL,
		};
	}

	if (!event.ctrlKey && key === "c") {
		return {
			type: "mode",
			mode: MODES.COMMENT,
			clearSelection: false,
		};
	}

	if (!event.ctrlKey && key === "e") {
		return {
			type: "end-review",
		};
	}

	if (event.ctrlKey && key === "d") {
		return { type: "page-scroll", direction: 1 };
	}

	if (event.ctrlKey && key === "u") {
		return { type: "page-scroll", direction: -1 };
	}

	if (event.ctrlKey) return null;

	const scrollStep = Number.isFinite(options.scrollStep) ? Number(options.scrollStep) : DEFAULT_SCROLL_STEP;

	if (key === "j") {
		return createScrollAction(scrollStep, 0, currentMode);
	}
	if (key === "k") {
		return createScrollAction(-scrollStep, 0, currentMode);
	}
	if (key === "h") {
		return createScrollAction(0, -scrollStep, currentMode);
	}
	if (key === "l") {
		return createScrollAction(0, scrollStep, currentMode);
	}

	return null;
}

export function computePageStep(viewportHeight, options = {}) {
	const ratio = Number.isFinite(options.ratio) ? Number(options.ratio) : 0.62;
	const min = Number.isFinite(options.min) ? Number(options.min) : 120;
	const normalizedHeight = Number.isFinite(viewportHeight) ? Math.max(0, Number(viewportHeight)) : 0;
	return Math.max(min, Math.floor(normalizedHeight * ratio));
}

function createScrollAction(top, left, mode) {
	const visualMotion = mode === MODES.VISUAL ? resolveVisualMotion(top, left) : null;
	return {
		type: "scroll",
		top,
		left,
		extendSelection: visualMotion,
	};
}

function resolveVisualMotion(top, left) {
	if (top > 0) return VISUAL_MOTION.j;
	if (top < 0) return VISUAL_MOTION.k;
	if (left < 0) return VISUAL_MOTION.h;
	if (left > 0) return VISUAL_MOTION.l;
	return null;
}

function normalizeKey(key) {
	if (typeof key !== "string") return "";
	return key.toLowerCase();
}
