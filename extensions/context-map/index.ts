/**
 * Context Map — visualize what's in the context window
 *
 * Shows a minimap of the context as stacked color-coded blocks,
 * inspired by HumanLayer's context engineering visualizations.
 *
 * Usage:
 *   /context          — open context map for current session chain
 *
 * Navigation:
 *   j/k or ↑/↓       — move selection
 *   Enter             — drill into session / show block detail
 *   Backspace/Delete  — go back
 *   Esc or q          — close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseSessionFile, parseSessionBranch, buildSessionChain, type SessionMap } from "./lib/parse-session.js";
import { MinimapComponent } from "./lib/minimap-component.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Visualize the context window as a minimap",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/context requires interactive mode", "error");
				return;
			}

			// Build session chain: current session + ancestors via parentSession links
			const sessions: SessionMap[] = [];

			// Get current session from live branch (most up-to-date)
			const branch = ctx.sessionManager.getBranch();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const header = ctx.sessionManager.getHeader();
			const sessionId = ctx.sessionManager.getSessionId();

			const currentSession = parseSessionBranch(
				branch,
				sessionId || "current",
				sessionFile || "in-memory",
				header?.parentSession,
				ctx.cwd,
			);
			currentSession.name = ctx.sessionManager.getSessionName() || "Current";

			// Follow parentSession chain backward for history
			if (header?.parentSession) {
				const ancestors = buildSessionChain(header.parentSession);
				sessions.push(...ancestors);
			}
			sessions.push(currentSession);

			// Show the minimap modal
			await ctx.ui.custom<void>(
				(tui: any, theme: any, _kb: any, done: (v: void) => void) => {
					const component = new MinimapComponent(sessions, theme, () => done(), tui);
					return {
						render: (w: number) => component.render(w),
						invalidate: () => component.invalidate(),
						handleInput: (data: string) => component.handleInput(data),
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center" as const,
						width: "76%",
						minWidth: 64,
						maxHeight: "88%",
					},
				},
			);
		},
	});
}
