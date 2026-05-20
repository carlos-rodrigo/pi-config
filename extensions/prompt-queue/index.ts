import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

export type PromptQueueStatus = "queued" | "running" | "done";

export interface PromptQueueItem {
	id: number;
	text: string;
	status: PromptQueueStatus;
	createdAt: number;
	updatedAt: number;
}

export type PromptQueueAction =
	| { action: "add"; item: PromptQueueItem }
	| { action: "update"; id: number; text: string; updatedAt: number }
	| { action: "delete"; id: number }
	| { action: "status"; id: number; status: PromptQueueStatus; updatedAt: number }
	| { action: "clearDone"; updatedAt: number };

export interface PromptQueueState {
	items: PromptQueueItem[];
	nextId: number;
	activeId?: number;
	draining: boolean;
}

type PaletteAction =
	| { type: "close" }
	| { type: "add" }
	| { type: "edit"; id: number }
	| { type: "delete"; id: number }
	| { type: "toggle"; id: number }
	| { type: "paste"; id: number }
	| { type: "run"; id: number }
	| { type: "runAll" }
	| { type: "stop" }
	| { type: "clearDone" };

const CUSTOM_ENTRY_TYPE = "prompt-queue";
const PALETTE_WIDTH = "72%";
const PALETTE_MIN_WIDTH = 64;
const PALETTE_MAX_HEIGHT = "80%";

export function createInitialState(): PromptQueueState {
	return { items: [], nextId: 1, draining: false };
}

export function applyPromptQueueAction(state: PromptQueueState, entry: PromptQueueAction): PromptQueueState {
	const items = state.items.map((item) => ({ ...item }));
	let nextId = state.nextId;
	let activeId = state.activeId;
	let draining = state.draining;

	switch (entry.action) {
		case "add": {
			items.push({ ...entry.item });
			nextId = Math.max(nextId, entry.item.id + 1);
			break;
		}
		case "update": {
			const item = items.find((candidate) => candidate.id === entry.id);
			if (item) {
				item.text = entry.text;
				item.updatedAt = entry.updatedAt;
			}
			break;
		}
		case "delete": {
			const index = items.findIndex((candidate) => candidate.id === entry.id);
			if (index >= 0) items.splice(index, 1);
			if (activeId === entry.id) {
				activeId = undefined;
				draining = false;
			}
			break;
		}
		case "status": {
			const item = items.find((candidate) => candidate.id === entry.id);
			if (item) {
				item.status = entry.status;
				item.updatedAt = entry.updatedAt;
			}
			if (entry.status === "running") activeId = entry.id;
			if (entry.status === "done" && activeId === entry.id) activeId = undefined;
			break;
		}
		case "clearDone": {
			for (let index = items.length - 1; index >= 0; index -= 1) {
				if (items[index]?.status === "done") items.splice(index, 1);
			}
			break;
		}
	}

	return { items, nextId, activeId, draining };
}

export function formatQueueStatus(state: PromptQueueState): string {
	const queued = state.items.filter((item) => item.status === "queued").length;
	const running = state.items.filter((item) => item.status === "running").length;
	if (running > 0) return `queue: ${queued} queued · running`;
	if (state.draining && queued > 0) return `queue: ${queued} queued · draining`;
	return queued > 0 ? `queue: ${queued} queued` : "queue: empty";
}

export function getNextQueuedItem(state: PromptQueueState): PromptQueueItem | undefined {
	return state.items.find((item) => item.status === "queued");
}

export function createPromptQueueItem(id: number, text: string, now = Date.now()): PromptQueueItem {
	return { id, text: text.trim(), status: "queued", createdAt: now, updatedAt: now };
}

function cloneState(state: PromptQueueState): PromptQueueState {
	return {
		items: state.items.map((item) => ({ ...item })),
		nextId: state.nextId,
		activeId: state.activeId,
		draining: state.draining,
	};
}

function isPromptQueueAction(value: unknown): value is PromptQueueAction {
	if (!value || typeof value !== "object") return false;
	const action = (value as { action?: unknown }).action;
	return action === "add" || action === "update" || action === "delete" || action === "status" || action === "clearDone";
}

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
	return line || "(empty prompt)";
}

function statusLabel(status: PromptQueueStatus): string {
	switch (status) {
		case "queued":
			return "queued ";
		case "running":
			return "running";
		case "done":
			return "done   ";
	}
}

class PromptQueuePalette {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private state: PromptQueueState;
	private theme: Theme;
	private done: (action: PaletteAction) => void;

	constructor(state: PromptQueueState, theme: Theme, done: (action: PaletteAction) => void) {
		this.state = state;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done({ type: "close" });
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = this.selectedItem();
			if (item) this.done({ type: "run", id: item.id });
			return;
		}
		if (data === "a") {
			this.done({ type: "add" });
			return;
		}
		if (data === "e") {
			const item = this.selectedItem();
			if (item) this.done({ type: "edit", id: item.id });
			return;
		}
		if (data === "d" || matchesKey(data, Key.delete)) {
			const item = this.selectedItem();
			if (item) this.done({ type: "delete", id: item.id });
			return;
		}
		if (data === " ") {
			const item = this.selectedItem();
			if (item) this.done({ type: "toggle", id: item.id });
			return;
		}
		if (data === "p") {
			const item = this.selectedItem();
			if (item) this.done({ type: "paste", id: item.id });
			return;
		}
		if (data === "r") {
			const item = this.selectedItem();
			if (item) this.done({ type: "run", id: item.id });
			return;
		}
		if (data === "R") {
			this.done({ type: "runAll" });
			return;
		}
		if (data === "s") {
			this.done({ type: "stop" });
			return;
		}
		if (data === "c") {
			this.done({ type: "clearDone" });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.ensureSelectionInRange();

		const lines: string[] = [];
		const th = this.theme;
		const total = this.state.items.length;
		const queued = this.state.items.filter((item) => item.status === "queued").length;
		const running = this.state.items.filter((item) => item.status === "running").length;
		const done = this.state.items.filter((item) => item.status === "done").length;
		const title = th.fg("accent", " Prompt Queue ");
		const border = th.fg("borderMuted", "─".repeat(Math.max(0, width - 15)));

		lines.push(truncateToWidth(`${th.fg("borderMuted", "┌──")}${title}${border}`, width));
		lines.push(truncateToWidth(`  ${queued} queued · ${running} running · ${done} done · Enter/r: run · p: paste · R: run all`, width));
		lines.push("");

		if (total === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No queued prompts yet. Press a to add one, or use /queue-add <prompt>.")}`, width));
		} else {
			const availableRows = 12;
			const visibleItems = this.state.items.slice(this.scrollOffset, this.scrollOffset + availableRows);
			for (let offset = 0; offset < visibleItems.length; offset += 1) {
				const index = this.scrollOffset + offset;
				const item = visibleItems[offset]!;
				const selected = index === this.selectedIndex;
				const pointer = selected ? th.fg("accent", "▶") : " ";
				const label = item.status === "done" ? th.fg("dim", statusLabel(item.status)) : item.status === "running" ? th.fg("success", statusLabel(item.status)) : th.fg("muted", statusLabel(item.status));
				const text = item.status === "done" ? th.fg("dim", firstLine(item.text)) : th.fg("text", firstLine(item.text));
				lines.push(truncateToWidth(` ${pointer} [${label}] #${item.id} ${text}`, width));
			}
			if (this.scrollOffset + availableRows < total) lines.push(truncateToWidth(`  ${th.fg("dim", `… ${total - this.scrollOffset - availableRows} more`)}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ select · a add · e edit · d delete · Space done/queued · p paste · s stop · c clear done · Esc close")}`, width));
		lines.push(truncateToWidth(th.fg("borderMuted", "└" + "─".repeat(Math.max(0, width - 1))), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private selectedItem(): PromptQueueItem | undefined {
		this.ensureSelectionInRange();
		return this.state.items[this.selectedIndex];
	}

	private moveSelection(delta: number): void {
		if (this.state.items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.state.items.length - 1, this.selectedIndex + delta));
		this.invalidate();
	}

	private ensureSelectionInRange(): void {
		if (this.state.items.length === 0) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.state.items.length - 1, this.selectedIndex));
		const visibleRows = 12;
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		if (this.selectedIndex >= this.scrollOffset + visibleRows) this.scrollOffset = this.selectedIndex - visibleRows + 1;
	}
}

export default function promptQueueExtension(pi: ExtensionAPI) {
	let state = createInitialState();

	function persist(action: PromptQueueAction): void {
		state = applyPromptQueueAction(state, action);
		pi.appendEntry(CUSTOM_ENTRY_TYPE, action);
	}

	function reconstruct(ctx: ExtensionContext): void {
		state = createInitialState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
			if (isPromptQueueAction(entry.data)) state = applyPromptQueueAction(state, entry.data);
		}
		state.draining = false;
		state.activeId = state.items.find((item) => item.status === "running")?.id;
		updateStatus(ctx);
	}

	function updateStatus(ctx: Pick<ExtensionContext, "ui">): void {
		ctx.ui.setStatus("prompt-queue", formatQueueStatus(state));
	}

	function findItem(id: number): PromptQueueItem | undefined {
		return state.items.find((item) => item.id === id);
	}

	function addPrompt(text: string): PromptQueueItem | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const item = createPromptQueueItem(state.nextId, trimmed);
		persist({ action: "add", item });
		return item;
	}

	function addEditorPromptToQueue(ctx: ExtensionContext): void {
		const text = ctx.ui.getEditorText().trim();
		if (!text) {
			ctx.ui.notify("Editor is empty — nothing to queue", "warning");
			return;
		}
		const item = addPrompt(text);
		if (!item) return;
		ctx.ui.setEditorText("");
		updateStatus(ctx);
		ctx.ui.notify(`Queued editor prompt #${item.id}`, "info");
	}

	function setItemStatus(id: number, status: PromptQueueStatus): void {
		persist({ action: "status", id, status, updatedAt: Date.now() });
	}

	function runItem(id: number, ctx: ExtensionContext, options?: { drain?: boolean }): boolean {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Prompt queue waits for Pi to be idle before starting a prompt", "warning");
			return false;
		}
		if (state.activeId !== undefined) {
			ctx.ui.notify("A queued prompt is already running", "warning");
			return false;
		}
		const item = findItem(id);
		if (!item) return false;
		state.draining = options?.drain ?? false;
		setItemStatus(id, "running");
		updateStatus(ctx);
		pi.sendUserMessage(item.text);
		return true;
	}

	function runNext(ctx: ExtensionContext): boolean {
		const next = getNextQueuedItem(state);
		if (!next) {
			state.draining = false;
			updateStatus(ctx);
			return false;
		}
		return runItem(next.id, ctx, { drain: true });
	}

	async function showQueue(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/queue requires interactive mode", "error");
			return;
		}

		let reopen = true;
		while (reopen) {
			reopen = false;
			const action = await ctx.ui.custom<PaletteAction>(
				(_tui, theme, _kb, done) => new PromptQueuePalette(cloneState(state), theme, done),
				{
					overlay: true,
					overlayOptions: {
						width: PALETTE_WIDTH,
						minWidth: PALETTE_MIN_WIDTH,
						maxHeight: PALETTE_MAX_HEIGHT,
						anchor: "center",
						margin: 1,
					},
				},
			);

			if (!action || action.type === "close") return;

			switch (action.type) {
				case "add": {
					const text = await ctx.ui.editor("Add queued prompt", "");
					if (text?.trim()) {
						addPrompt(text);
						updateStatus(ctx);
					}
					reopen = true;
					break;
				}
				case "edit": {
					const item = findItem(action.id);
					if (!item) break;
					const text = await ctx.ui.editor("Edit queued prompt", item.text);
					if (text?.trim()) {
						persist({ action: "update", id: item.id, text: text.trim(), updatedAt: Date.now() });
						updateStatus(ctx);
					}
					reopen = true;
					break;
				}
				case "delete":
					persist({ action: "delete", id: action.id });
					updateStatus(ctx);
					reopen = true;
					break;
				case "toggle": {
					const item = findItem(action.id);
					if (item && item.status !== "running") setItemStatus(item.id, item.status === "done" ? "queued" : "done");
					updateStatus(ctx);
					reopen = true;
					break;
				}
				case "paste": {
					const item = findItem(action.id);
					if (item) {
						ctx.ui.setEditorText(item.text);
						ctx.ui.notify(`Pasted queued prompt #${item.id}`, "info");
					}
					break;
				}
				case "run":
					runItem(action.id, ctx);
					break;
				case "runAll":
					state.draining = true;
					runNext(ctx);
					break;
				case "stop":
					state.draining = false;
					updateStatus(ctx);
					ctx.ui.notify("Prompt queue will stop after the current prompt", "info");
					break;
				case "clearDone":
					persist({ action: "clearDone", updatedAt: Date.now() });
					updateStatus(ctx);
					reopen = true;
					break;
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		const activeId = state.activeId;
		if (activeId === undefined) return;
		const shouldContinue = state.draining;
		persist({ action: "delete", id: activeId });
		state.draining = shouldContinue;
		if (shouldContinue) runNext(ctx);
		else updateStatus(ctx);
	});

	pi.registerShortcut("ctrl+q", {
		description: "Open prompt queue",
		handler: async (ctx) => {
			await showQueue(ctx as ExtensionContext);
		},
	});

	pi.registerShortcut("ctrl+shift+a", {
		description: "Add current editor text to the prompt queue",
		handler: async (ctx) => {
			addEditorPromptToQueue(ctx as ExtensionContext);
		},
	});

	pi.registerCommand("queue", {
		description: "Open the interactive prompt queue (Ctrl+Q)",
		handler: async (_args, ctx) => {
			await showQueue(ctx as ExtensionContext);
		},
	});

	pi.registerCommand("queue-add", {
		description: "Add a prompt to the queue (usage: /queue-add <prompt>)",
		handler: async (args, ctx) => {
			const text = args.trim() || (ctx.hasUI ? await ctx.ui.editor("Add queued prompt", "") : "");
			const item = addPrompt(text ?? "");
			if (!item) {
				ctx.ui.notify("Usage: /queue-add <prompt>", "warning");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`Queued prompt #${item.id}`, "info");
		},
	});

	pi.registerCommand("queue-run", {
		description: "Run queued prompts serially, one at a time",
		handler: async (_args, ctx) => {
			state.draining = true;
			if (!runNext(ctx as ExtensionContext)) ctx.ui.notify("No queued prompts to run", "info");
		},
	});

	pi.registerCommand("queue-stop", {
		description: "Stop the prompt queue after the current prompt",
		handler: async (_args, ctx) => {
			state.draining = false;
			updateStatus(ctx);
			ctx.ui.notify("Prompt queue stopped", "info");
		},
	});
}
