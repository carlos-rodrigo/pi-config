import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { boundedPreview, elapsed, isActive, sanitizeDisplay, type ManagerPreview, type ManagerRow, type ManagerSnapshot } from "./manager-model.ts";

export interface ManagerOperations {
	load(signal: AbortSignal): Promise<ManagerSnapshot>;
	preview(cwd: string, jobId: string, signal: AbortSignal): Promise<ManagerPreview>;
	cancel(cwd: string, jobId: string): Promise<string>;
}
interface ComponentOptions { autoRefresh?: boolean; now?: () => number; signal?: AbortSignal }

export class AgentManagerComponent {
	private selectedKey?: string;
	private preview: ManagerPreview = { output: "", errors: "" };
	private previewGeneration = 0;
	private previewKey?: string;
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private snapshot: ManagerSnapshot;
	private readonly operations: ManagerOperations;
	private readonly onClose: () => void;
	private previewController?: AbortController;
	private readonly lifetime = new AbortController();
	private interval?: ReturnType<typeof setInterval>;
	private disposed = false;
	private refreshing = false;
	private loadingPreview = false;
	private message = "";
	private confirmation?: { cwd: string; jobId: string; agent: string };
	private cancelling = false;
	private errorsView = false;
	private detailScroll = 0;
	private sidebarScroll = 0;
	private detailCapacity = 5;
	private readonly now: () => number;
	private readonly parentSignal?: AbortSignal;
	private readonly abortParent = () => this.close();

	constructor(
		tui: Pick<TUI, "requestRender" | "terminal">,
		theme: Theme,
		snapshot: ManagerSnapshot,
		operations: ManagerOperations,
		onClose: () => void,
		options: ComponentOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.snapshot = snapshot;
		this.operations = operations;
		this.onClose = onClose;
		this.now = options.now ?? Date.now;
		this.parentSignal = options.signal;
		this.selectedKey = snapshot.rows[0]?.key;
		void this.loadPreview();
		if (options.autoRefresh !== false) {
			this.interval = setInterval(() => void this.refresh(), 1500);
			this.interval.unref?.();
		}
		this.parentSignal?.addEventListener("abort", this.abortParent, { once: true });
		if (this.parentSignal?.aborted) this.close();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.confirmation) {
			if (matchesKey(data, Key.escape) || matchesKey(data, "n") || matchesKey(data, "q")) {
				this.confirmation = undefined;
				this.redraw();
			} else if (matchesKey(data, "y") || matchesKey(data, Key.enter)) {
				const target = this.confirmation;
				this.confirmation = undefined;
				void this.cancel(target);
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) { this.close(); return; }
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) { this.select(-1); return; }
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) { this.select(1); return; }
		if (matchesKey(data, Key.tab)) { this.errorsView = !this.errorsView; this.detailScroll = 0; this.redraw(); return; }
		if (matchesKey(data, Key.pageUp)) { this.detailScroll = Math.max(0, this.detailScroll - this.detailCapacity); this.redraw(); return; }
		if (matchesKey(data, Key.pageDown)) { this.detailScroll += this.detailCapacity; this.redraw(); return; }
		if (matchesKey(data, "r")) { void this.refresh(); return; }
		if (matchesKey(data, "c") && !this.cancelling) {
			const row = this.selected();
			if (row?.jobId && row.state === "running" && !row.cancellationPending && !row.exitRecorded) {
				this.confirmation = { cwd: this.snapshot.cwd, jobId: row.jobId, agent: row.agent };
				this.redraw();
			}
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) return;
		this.refreshing = true;
		this.redraw();
		try {
			const next = await this.operations.load(this.lifetime.signal);
			if (this.disposed) return;
			const previous = this.selected();
			const previousIndex = Math.max(0, this.snapshot.rows.findIndex(row => row.key === this.selectedKey));
			this.snapshot = next;
			this.message = "";
			if (!next.rows.some(row => row.key === this.selectedKey)) {
				this.selectedKey = (previous?.jobId ? next.rows.find(row => row.jobId === previous.jobId) : undefined)?.key
					?? next.rows[Math.min(previousIndex, Math.max(0, next.rows.length - 1))]?.key;
				this.detailScroll = 0;
			}
			await this.loadPreview();
		} catch (error) {
			if (!this.disposed) this.message = `Refresh failed: ${sanitizeDisplay(String(error), true)}`;
		} finally {
			this.refreshing = false;
			this.redraw();
		}
	}

	private selected(): ManagerRow | undefined { return this.snapshot.rows.find(row => row.key === this.selectedKey); }
	private redraw(): void { if (!this.disposed) this.tui.requestRender(); }
	private select(delta: number): void {
		const index = this.snapshot.rows.findIndex(row => row.key === this.selectedKey);
		const next = this.snapshot.rows[Math.max(0, Math.min(this.snapshot.rows.length - 1, index + delta))];
		if (!next || next.key === this.selectedKey) return;
		this.selectedKey = next.key;
		this.detailScroll = 0;
		this.redraw();
		void this.loadPreview();
	}
	private async loadPreview(): Promise<void> {
		const generation = ++this.previewGeneration;
		this.previewController?.abort();
		const controller = new AbortController();
		this.previewController = controller;
		const row = this.selected();
		const sameSelection = this.previewKey === row?.key;
		this.previewKey = row?.key;
		if (!row?.jobId) {
			this.loadingPreview = false;
			this.preview = { output: boundedPreview(row?.output ?? "Waiting to launch…"), errors: boundedPreview(row?.state === "failed" ? row.output ?? "" : "") };
			this.redraw();
			return;
		}
		const previous = sameSelection ? this.preview : { output: "", errors: "" };
		this.loadingPreview = true;
		if (!sameSelection) this.preview = { output: "Loading selected output…", errors: "" };
		this.redraw();
		try {
			const preview = await this.operations.preview(this.snapshot.cwd, row.jobId, controller.signal);
			if (this.disposed || generation !== this.previewGeneration) return;
			this.preview = { output: boundedPreview(preview.output), errors: boundedPreview(preview.errors) };
		} catch (error) {
			if (this.disposed || generation !== this.previewGeneration) return;
			this.preview = { output: previous.output, errors: `Preview unavailable: ${sanitizeDisplay(String(error))}` };
		} finally {
			if (!this.disposed && generation === this.previewGeneration) { this.loadingPreview = false; this.redraw(); }
		}
	}
	private async cancel(target: { cwd: string; jobId: string }): Promise<void> {
		if (this.cancelling || this.disposed) return;
		this.cancelling = true;
		this.message = "Requesting cancellation…";
		this.redraw();
		try {
			const result = await this.operations.cancel(target.cwd, target.jobId);
			if (!this.disposed) {
				await this.refresh();
				this.message = sanitizeDisplay(result, true);
			}
		} catch (error) {
			if (!this.disposed) this.message = `Cancellation failed: ${sanitizeDisplay(String(error), true)}`;
		} finally { this.cancelling = false; this.redraw(); }
	}

	render(width: number): string[] {
		const outerWidth = Math.max(1, width);
		const rows = this.tui.terminal.rows || 24;
		// Match the overlay's maxHeight and top/bottom margins; never clip confirmation.
		const height = Math.max(1, Math.min(36, Math.floor(rows * 0.9), rows - 2));
		const framed = outerWidth >= 6 && height >= 6;
		const w = framed ? outerWidth - 4 : outerWidth;
		if (height < 4) return [truncateToWidth(this.theme.fg("warning", this.footer()), w, "…")];
		const bodyHeight = height - (framed ? 5 : 3);
		const split = w >= 80;
		const listHeight = split ? bodyHeight : Math.max(1, Math.floor(bodyHeight / 3));
		const detailHeight = split ? bodyHeight : Math.max(0, bodyHeight - listHeight);
		const listWidth = split ? Math.min(40, Math.floor(w * 0.36)) : w;
		const detailWidth = split ? Math.max(1, w - listWidth - 3) : w;
		const entries: Array<{ key?: string; text: string }> = [];
		let section = "";
		for (const row of this.snapshot.rows) {
			const nextSection = isActive(row.state) ? "ACTIVE" : "RECENT";
			if (nextSection !== section) {
				entries.push({ text: this.theme.fg("muted", nextSection) });
				section = nextSection;
			}
			const text = `${row.key === this.selectedKey ? ">" : " "} ${row.agent} · ${row.state} · ${elapsed(row.createdAt, row.completedAt, this.now())}`;
			entries.push({ key: row.key, text: this.theme.fg(row.state === "failed" ? "error" : row.key === this.selectedKey ? "accent" : isActive(row.state) ? "text" : "muted", text) });
		}
		const selectedIndex = Math.max(0, entries.findIndex(entry => entry.key === this.selectedKey));
		if (selectedIndex < this.sidebarScroll) this.sidebarScroll = selectedIndex;
		if (selectedIndex >= this.sidebarScroll + listHeight) this.sidebarScroll = selectedIndex - listHeight + 1;
		this.sidebarScroll = Math.max(0, Math.min(this.sidebarScroll, Math.max(0, entries.length - listHeight)));
		const list = entries.slice(this.sidebarScroll, this.sidebarScroll + listHeight).map(entry => entry.text);
		if (!list.length) list.push(this.theme.fg("muted", "No agent jobs in this project."));
		const row = this.selected();
		const info = row ? [
			`${row.agent} — ${row.state}${row.cancellationPending ? " · cancellation requested" : ""}`,
			`Task: ${row.task}`,
			`Model: ${row.model} · session: ${row.origin} · elapsed: ${elapsed(row.createdAt, row.completedAt, this.now())}`,
			`Follow-up: ${row.followUp === undefined ? "unknown" : row.followUp ? "enabled" : "disabled"}${row.jobId ? ` · Job: ${row.jobId}` : ""}`,
			...(row.exitRecorded && row.state === "running" ? ["Exit recorded; awaiting reconciliation."] : []),
			...(row.resultPath ? [`Result: ${sanitizeDisplay(row.resultPath, true)}`] : []),
			...(row.eventLogPath ? [`Events: ${sanitizeDisplay(row.eventLogPath, true)}`] : []),
			...(row.stderrPath ? [`Errors: ${sanitizeDisplay(row.stderrPath, true)}`] : []),
			`${this.errorsView ? "ERRORS" : "OUTPUT"}${this.loadingPreview ? " · loading" : ""}`,
			...(this.errorsView ? this.preview.errors || "No errors recorded." : this.preview.output || "Waiting for output…").split("\n"),
		] : ["Select a job to inspect its task and output."];
		const wrapped = info.flatMap(line => wrapTextWithAnsi(line, detailWidth));
		this.detailCapacity = Math.max(1, detailHeight);
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, wrapped.length - detailHeight)));
		const detail = wrapped.slice(this.detailScroll, this.detailScroll + detailHeight).map(line => this.theme.fg("text", line));
		const age = elapsed(this.snapshot.loadedAt, undefined, this.now());
		const lines = [this.theme.fg("accent", this.theme.bold(`Agents — ${sanitizeDisplay(this.snapshot.cwd, true)}`)),
			`${this.snapshot.running} recorded running · ${this.snapshot.queued} queued/launching · refreshed ${age} ago${this.refreshing ? " · refreshing" : ""}`];
		if (split) {
			for (let i = 0; i < bodyHeight; i++) {
				const left = truncateToWidth(list[i] ?? "", listWidth, "…");
				lines.push(`${left}${" ".repeat(Math.max(0, listWidth - visibleWidth(left)))} ${this.theme.fg("accent", "│")} ${truncateToWidth(detail[i] ?? "", detailWidth, "…")}`);
			}
		} else {
			lines.push(...list, ...Array(Math.max(0, listHeight - list.length)).fill(""), ...detail);
		}
		lines.push(this.theme.fg(this.confirmation || this.message || this.snapshot.warnings.length ? "warning" : "muted", this.footer()));
		const clipped = lines.map(line => truncateToWidth(line, w, "…"));
		if (!framed) return clipped;
		const side = this.theme.fg("accent", "│");
		return [
			this.theme.fg("accent", `┌${"─".repeat(outerWidth - 2)}┐`),
			...clipped.map(line => `${side} ${line}${" ".repeat(Math.max(0, w - visibleWidth(line)))} ${side}`),
			this.theme.fg("accent", `└${"─".repeat(outerWidth - 2)}┘`),
		];
	}
	private footer(): string {
		if (this.confirmation) return `y/Enter cancel · n/Esc back — Cancel ${this.confirmation.agent} (${this.confirmation.jobId})?`;
		const warning = this.message || this.snapshot.warnings[0];
		return `${warning ? sanitizeDisplay(warning, true) + " · " : ""}↑↓/jk select · PgUp/PgDn scroll · Tab output/errors · c cancel · r refresh · q close`;
	}
	invalidate(): void { /* Render from current theme and state; no styled strings are cached. */ }
	close(): void { if (this.disposed) return; this.dispose(); this.onClose(); }
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.parentSignal?.removeEventListener("abort", this.abortParent);
		this.lifetime.abort();
		this.previewController?.abort();
		if (this.interval) clearInterval(this.interval);
	}
}

export async function showAgentManager(ctx: ExtensionContext, operations: ManagerOperations, signal: AbortSignal): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/agents requires the interactive Pi TUI. Use /agent-job-status or agent_job_status instead.", "info");
		return;
	}
	const initial = await operations.load(signal);
	signal.throwIfAborted();
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AgentManagerComponent(tui, theme, initial, operations, () => done(undefined), { signal });
	}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } });
}
