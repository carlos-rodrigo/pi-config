import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import productAgentUiExtension from "../index.js";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

test("product-agent extension registers workflow commands and shell shortcut", () => {
	const registeredCommands = new Map<string, RegisteredCommand>();
	const shortcutDescriptions: string[] = [];

	const pi = {
		on: () => undefined,
		registerCommand: (name: string, command: RegisteredCommand) => {
			registeredCommands.set(name, command);
		},
		registerShortcut: (_key: unknown, shortcut: { description: string }) => {
			shortcutDescriptions.push(shortcut.description);
		},
		appendEntry: () => undefined,
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;

	productAgentUiExtension(pi);

	assert.equal(registeredCommands.has("product"), true);
	assert.equal(registeredCommands.has("product-run"), true);
	assert.equal(registeredCommands.has("product-review"), true);

	assert.match(registeredCommands.get("product")?.description ?? "", /\/product \[feature\]/);
	assert.match(registeredCommands.get("product-run")?.description ?? "", /\/product-run \[feature\]/);
	assert.match(registeredCommands.get("product-review")?.description ?? "", /\/product-review \[feature\]/);

	assert.equal(shortcutDescriptions.length, 1);
	assert.match(shortcutDescriptions[0] ?? "", /Product Agent UI shell/);
});
