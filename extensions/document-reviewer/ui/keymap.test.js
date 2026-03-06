import test from "node:test";
import assert from "node:assert/strict";
import { MODES, computePageStep, resolveKeyAction } from "./keymap.js";

function keyboardEvent(partial) {
	return {
		key: "",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		defaultPrevented: false,
		...partial,
	};
}

test("v enters visual mode from normal mode", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "v" }), MODES.NORMAL);
	assert.deepEqual(action, {
		type: "mode",
		mode: MODES.VISUAL,
		clearSelection: false,
	});
});

test("v exits visual mode when already in visual", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "v" }), MODES.VISUAL);
	assert.deepEqual(action, {
		type: "mode",
		mode: MODES.NORMAL,
		clearSelection: true,
	});
});

test("escape always returns to normal mode and clears selection", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "Escape" }), MODES.COMMENT);
	assert.deepEqual(action, {
		type: "mode",
		mode: MODES.NORMAL,
		clearSelection: true,
	});
});

test("c enters comment mode", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "c" }), MODES.NORMAL);
	assert.deepEqual(action, {
		type: "mode",
		mode: MODES.COMMENT,
		clearSelection: false,
	});
});

test("e triggers end review action", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "e" }), MODES.NORMAL);
	assert.deepEqual(action, {
		type: "end-review",
	});
});

test("ctrl+d and ctrl+u map to page scroll actions", () => {
	const down = resolveKeyAction(keyboardEvent({ key: "d", ctrlKey: true }), MODES.NORMAL);
	const up = resolveKeyAction(keyboardEvent({ key: "u", ctrlKey: true }), MODES.NORMAL);
	assert.deepEqual(down, { type: "page-scroll", direction: 1 });
	assert.deepEqual(up, { type: "page-scroll", direction: -1 });
});

test("j/k/h/l map to directional scrolling", () => {
	assert.deepEqual(resolveKeyAction(keyboardEvent({ key: "j" }), MODES.NORMAL), {
		type: "scroll",
		top: 44,
		left: 0,
		extendSelection: null,
	});
	assert.deepEqual(resolveKeyAction(keyboardEvent({ key: "k" }), MODES.NORMAL), {
		type: "scroll",
		top: -44,
		left: 0,
		extendSelection: null,
	});
	assert.deepEqual(resolveKeyAction(keyboardEvent({ key: "h" }), MODES.NORMAL), {
		type: "scroll",
		top: 0,
		left: -44,
		extendSelection: null,
	});
	assert.deepEqual(resolveKeyAction(keyboardEvent({ key: "l" }), MODES.NORMAL), {
		type: "scroll",
		top: 0,
		left: 44,
		extendSelection: null,
	});
});

test("movement in visual mode extends selection", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "j" }), MODES.VISUAL);
	assert.deepEqual(action, {
		type: "scroll",
		top: 44,
		left: 0,
		extendSelection: {
			direction: "forward",
			granularity: "line",
		},
	});
});

test("ctrl-modified non paging keys are ignored", () => {
	const action = resolveKeyAction(keyboardEvent({ key: "l", ctrlKey: true }), MODES.NORMAL);
	assert.equal(action, null);
});

test("alt/meta/defaultPrevented events are ignored", () => {
	assert.equal(resolveKeyAction(keyboardEvent({ key: "j", altKey: true }), MODES.NORMAL), null);
	assert.equal(resolveKeyAction(keyboardEvent({ key: "j", metaKey: true }), MODES.NORMAL), null);
	assert.equal(resolveKeyAction(keyboardEvent({ key: "j", defaultPrevented: true }), MODES.NORMAL), null);
});

test("page step respects ratio and minimum", () => {
	assert.equal(computePageStep(100), 120);
	assert.equal(computePageStep(500), 310);
	assert.equal(computePageStep(1000, { ratio: 0.5, min: 150 }), 500);
});
