import test from "node:test";
import assert from "node:assert/strict";
import { createCommentComposer, validateCommentBody } from "./comment-composer.js";

test("validateCommentBody trims plain text comments", () => {
	const result = validateCommentBody("  Thread note  ");
	assert.deepEqual(result, { ok: true, value: "Thread note" });
});

test("validateCommentBody rejects empty comments with friendly error", () => {
	const result = validateCommentBody("   \n\t  ");
	assert.equal(result.ok, false);
	assert.match(result.error, /comment cannot be empty/i);
});

test("createCommentComposer submit returns trimmed body and clears field", async () => {
	const textarea = { value: "   C1 comment   ", disabled: false, focusCalled: 0, focus() { this.focusCalled += 1; } };
	const submitButton = { disabled: false };
	const errorElement = { textContent: "", hidden: true };
	const contextElement = { textContent: "" };
	let submitted = "";

	const composer = createCommentComposer({
		textarea,
		submitButton,
		errorElement,
		contextElement,
		onSubmit: async (body) => {
			submitted = body;
		},
	});

	const ok = await composer.submit();

	assert.equal(ok, true);
	assert.equal(submitted, "C1 comment");
	assert.equal(textarea.value, "");
	assert.equal(errorElement.hidden, true);
	assert.equal(errorElement.textContent, "");
});

test("createCommentComposer submit rejects empty comment and keeps focusable state", async () => {
	const textarea = { value: "    ", disabled: false, focusCalled: 0, focus() { this.focusCalled += 1; } };
	const submitButton = { disabled: false };
	const errorElement = { textContent: "", hidden: true };

	const composer = createCommentComposer({
		textarea,
		submitButton,
		errorElement,
		onSubmit: async () => {
			throw new Error("should not submit empty comments");
		},
	});

	const ok = await composer.submit();

	assert.equal(ok, false);
	assert.match(errorElement.textContent, /comment cannot be empty/i);
	assert.equal(errorElement.hidden, false);
	assert.equal(textarea.disabled, false);
	assert.equal(submitButton.disabled, false);
});

test("validateCommentBody enforces max length boundary", () => {
	assert.equal(validateCommentBody("x".repeat(4000)).ok, true);
	const tooLong = validateCommentBody("x".repeat(4001));
	assert.equal(tooLong.ok, false);
	assert.match(tooLong.error, /too long/i);
});

test("createCommentComposer re-enables controls after submit failure", async () => {
	const textarea = { value: "Needs retry", disabled: false, focus() {} };
	const submitButton = { disabled: false };
	const errorElement = { textContent: "", hidden: true };

	const composer = createCommentComposer({
		textarea,
		submitButton,
		errorElement,
		onSubmit: async () => {
			throw new Error("network unavailable");
		},
	});

	const ok = await composer.submit();

	assert.equal(ok, false);
	assert.equal(textarea.disabled, false);
	assert.equal(submitButton.disabled, false);
	assert.match(errorElement.textContent, /network unavailable/i);
});
