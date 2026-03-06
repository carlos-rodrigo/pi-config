import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionController } from "./selection.js";

function createFakeClassList() {
	const classes = new Set();
	return {
		add: (...tokens) => tokens.forEach((token) => classes.add(token)),
		remove: (...tokens) => tokens.forEach((token) => classes.delete(token)),
		toggle: (token, force) => {
			if (force === true) {
				classes.add(token);
				return true;
			}
			if (force === false) {
				classes.delete(token);
				return false;
			}
			if (classes.has(token)) {
				classes.delete(token);
				return false;
			}
			classes.add(token);
			return true;
		},
		contains: (token) => classes.has(token),
	};
}

function createHarness() {
	const listeners = new Map();
	const root = {
		classList: createFakeClassList(),
		contains(node) {
			return Boolean(node?.insideRoot);
		},
	};

	const ownerDocument = {
		addEventListener(type, handler) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(handler);
		},
		removeEventListener(type, handler) {
			listeners.get(type)?.delete(handler);
		},
	};

	const selection = {
		rangeCount: 0,
		isCollapsed: true,
		modifyCalls: [],
		removeCalls: 0,
		getRangeAt() {
			return {
				commonAncestorContainer: { insideRoot: true },
			};
		},
		removeAllRanges() {
			this.removeCalls += 1;
		},
		modify(alter, direction, granularity) {
			this.modifyCalls.push({ alter, direction, granularity });
		},
	};

	return {
		root,
		ownerDocument,
		selection,
		dispatchSelectionChange() {
			for (const listener of listeners.get("selectionchange") ?? []) {
				listener();
			}
		},
	};
}

test("setMode toggles visual class and clears selection on exit", () => {
	const harness = createHarness();
	const controller = createSelectionController({
		root: harness.root,
		ownerDocument: harness.ownerDocument,
		getSelection: () => harness.selection,
	});

	controller.setMode("VISUAL");
	assert.equal(harness.root.classList.contains("document-content--visual"), true);

	controller.setMode("NORMAL", { clearSelection: true });
	assert.equal(harness.root.classList.contains("document-content--visual"), false);
	assert.equal(harness.selection.removeCalls, 1);

	controller.destroy();
});

test("selectionchange marks root when non-collapsed selection belongs to root", () => {
	const updates = [];
	const harness = createHarness();
	const controller = createSelectionController({
		root: harness.root,
		ownerDocument: harness.ownerDocument,
		getSelection: () => harness.selection,
		onSelectionChange: (payload) => updates.push(payload),
	});

	controller.setMode("VISUAL");
	harness.selection.rangeCount = 1;
	harness.selection.isCollapsed = false;
	harness.dispatchSelectionChange();

	assert.equal(harness.root.classList.contains("document-content--has-selection"), true);
	assert.equal(updates.at(-1)?.hasSelection, true);

	controller.destroy();
});

test("extendSelection uses browser selection.modify when available", () => {
	const harness = createHarness();
	const controller = createSelectionController({
		root: harness.root,
		ownerDocument: harness.ownerDocument,
		getSelection: () => harness.selection,
	});

	controller.setMode("VISUAL");
	const extended = controller.extendSelection({ direction: "forward", granularity: "line" });

	assert.equal(extended, true);
	assert.deepEqual(harness.selection.modifyCalls, [
		{ alter: "extend", direction: "forward", granularity: "line" },
	]);

	controller.destroy();
});

test("destroy detaches selectionchange listener", () => {
	const updates = [];
	const harness = createHarness();
	const controller = createSelectionController({
		root: harness.root,
		ownerDocument: harness.ownerDocument,
		getSelection: () => harness.selection,
		onSelectionChange: (payload) => updates.push(payload),
	});

	controller.setMode("VISUAL");
	controller.destroy();

	harness.selection.rangeCount = 1;
	harness.selection.isCollapsed = false;
	harness.dispatchSelectionChange();

	assert.equal(updates.length, 1);
	assert.equal(updates[0].hasSelection, false);
});
