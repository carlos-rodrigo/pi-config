import test from "node:test";
import assert from "node:assert/strict";
import { createEndReviewController } from "./end-review.js";

function createButton() {
	const listeners = new Map();
	return {
		disabled: false,
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
		removeEventListener(type, handler) {
			if (listeners.get(type) === handler) {
				listeners.delete(type);
			}
		},
		async click() {
			const handler = listeners.get("click");
			if (!handler) return;
			await handler({ preventDefault() {} });
		},
	};
}

test("end review copies export text and reports success", async () => {
	const button = createButton();
	const statusElement = { textContent: "" };
	const fallbackContainer = { hidden: true };
	const fallbackTextarea = { value: "" };
	let copiedText = "";
	const events = [];

	const controller = createEndReviewController({
		button,
		statusElement,
		fallbackContainer,
		fallbackTextarea,
		onRequestExport: async () => ({ text: "- [anchor: Intro] C1", count: 1 }),
		writeToClipboard: async (text) => {
			copiedText = text;
		},
		onStateChange: (event) => events.push(event.status),
	});

	await controller.run();

	assert.equal(copiedText, "- [anchor: Intro] C1");
	assert.match(statusElement.textContent, /copied 1 comment/i);
	assert.equal(fallbackContainer.hidden, true);
	assert.equal(fallbackTextarea.value, "");
	assert.deepEqual(events.slice(-1), ["copied"]);
});

test("end review shows manual-copy fallback when clipboard write fails", async () => {
	const button = createButton();
	const statusElement = { textContent: "" };
	const fallbackContainer = { hidden: true };
	const fallbackTextarea = { value: "" };

	const controller = createEndReviewController({
		button,
		statusElement,
		fallbackContainer,
		fallbackTextarea,
		onRequestExport: async () => ({ text: "- [anchor: Intro] C1", count: 1 }),
		writeToClipboard: async () => {
			throw new Error("denied");
		},
	});

	await controller.run();

	assert.match(statusElement.textContent, /clipboard unavailable/i);
	assert.equal(fallbackContainer.hidden, false);
	assert.equal(fallbackTextarea.value, "- [anchor: Intro] C1");
});

test("end review handles empty exports without clipboard writes", async () => {
	const button = createButton();
	const statusElement = { textContent: "" };
	const fallbackContainer = { hidden: false };
	const fallbackTextarea = { value: "existing" };
	let wroteClipboard = false;

	const controller = createEndReviewController({
		button,
		statusElement,
		fallbackContainer,
		fallbackTextarea,
		onRequestExport: async () => ({ text: "No comments to export yet.", count: 0 }),
		writeToClipboard: async () => {
			wroteClipboard = true;
		},
	});

	await controller.run();

	assert.equal(wroteClipboard, false);
	assert.match(statusElement.textContent, /no comments to export/i);
	assert.equal(fallbackContainer.hidden, true);
	assert.equal(fallbackTextarea.value, "");
});

test("end review keeps existing fallback text visible when export request fails", async () => {
	const button = createButton();
	const statusElement = { textContent: "" };
	const fallbackContainer = { hidden: false };
	const fallbackTextarea = { value: "- [anchor: Intro] Previous export" };

	const controller = createEndReviewController({
		button,
		statusElement,
		fallbackContainer,
		fallbackTextarea,
		onRequestExport: async () => {
			throw new Error("network unavailable");
		},
	});

	await controller.run();

	assert.equal(fallbackContainer.hidden, false);
	assert.equal(fallbackTextarea.value, "- [anchor: Intro] Previous export");
	assert.match(statusElement.textContent, /export failed/i);
});
