import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { dispatchArtifactComposeAction, dispatchOpenFileAction } from "./dispatch-service.js";

type MessageCall = {
	message: string;
	options?: { deliverAs: "followUp" };
};

type NotifyCall = {
	message: string;
	level: "info" | "warning" | "error";
};

function createPiMock() {
	const calls: MessageCall[] = [];
	const pi = {
		sendUserMessage: (message: string, options?: { deliverAs: "followUp" }) => {
			calls.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	return { pi, calls };
}

function createContextMock(params: { idle: boolean; cwd?: string }) {
	const notifications: NotifyCall[] = [];
	const ctx = {
		cwd: params.cwd ?? "/tmp/project",
		isIdle: () => params.idle,
		ui: {
			notify: (message: string, level: "info" | "warning" | "error") => {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	return { ctx, notifications };
}

test("dispatchOpenFileAction sends immediate /open command when idle", () => {
	const { pi, calls } = createPiMock();
	const { ctx, notifications } = createContextMock({ idle: true, cwd: "/project" });

	dispatchOpenFileAction({
		pi,
		ctx,
		mode: "view",
		path: ".features/product-agent-ui/tasks/010-polish-qa-and-command-docs.md",
	});

	assert.deepEqual(calls, [
		{
			message: "/open .features/product-agent-ui/tasks/010-polish-qa-and-command-docs.md",
			options: undefined,
		},
	]);
	assert.equal(notifications[0]?.level, "info");
	assert.match(notifications[0]?.message ?? "", /Open queued/);
});

test("dispatchOpenFileAction uses follow-up delivery when streaming", () => {
	const { pi, calls } = createPiMock();
	const { ctx, notifications } = createContextMock({ idle: false, cwd: "/project" });

	dispatchOpenFileAction({
		pi,
		ctx,
		mode: "diff",
		path: ".features/product-agent-ui/prd.md",
	});

	assert.deepEqual(calls, [
		{
			message: "/open .features/product-agent-ui/prd.md --diff",
			options: { deliverAs: "followUp" },
		},
	]);
	assert.equal(notifications[0]?.level, "info");
	assert.match(notifications[0]?.message ?? "", /Diff queued/);
});

test("dispatchArtifactComposeAction dispatches stage skill command and validates feature name", () => {
	const { pi, calls } = createPiMock();
	const { ctx, notifications } = createContextMock({ idle: false, cwd: "/project" });

	const validResult = dispatchArtifactComposeAction({
		pi,
		ctx,
		featureName: "product-agent-ui",
		stage: "design",
	});

	assert.equal(validResult.ok, true);
	assert.equal(calls.length, 1);
	assert.match(calls[0]?.message ?? "", /^\/skill:design-solution /);
	assert.deepEqual(calls[0]?.options, { deliverAs: "followUp" });
	assert.equal(notifications[0]?.level, "info");

	const invalidResult = dispatchArtifactComposeAction({
		pi,
		ctx,
		featureName: "../invalid",
		stage: "tasks",
	});

	assert.equal(invalidResult.ok, false);
	assert.equal(calls.length, 1);
});
