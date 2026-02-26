import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	buildWindowName,
	createFeatureWorktree,
	findFeatureWorktree,
	launchPiInTmux,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	slugifyFeature,
} from "./lib/worktree.js";

function stripPrefix(input: string, prefix: string): string {
	return input.slice(prefix.length).trim();
}

function formatWorktreeList(
	items: Array<{ path: string; branch?: string; detached: boolean; dirty: boolean; isMain: boolean; isPrunable: boolean }>,
): string {
	if (items.length === 0) return "No worktrees found.";
	const lines: string[] = ["Worktrees:"];
	for (const item of items) {
		const flags: string[] = [];
		if (item.isMain) flags.push("main");
		if (item.detached) flags.push("detached");
		if (item.isPrunable) flags.push("prunable");
		flags.push(item.dirty ? "dirty" : "clean");
		lines.push(`- ${item.branch ?? "(no branch)"} :: ${item.path} [${flags.join(", ")}]`);
	}
	return lines.join("\n");
}

function wsHelpText(): string {
	return [
		"Usage:",
		"  /ws new <feature name or slug>",
		"  /ws list",
		"  /ws open <slug>",
		"  /ws remove <slug> [--force]",
		"  /ws prune",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ws", {
		description: "Manage git worktrees for feature branches",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "help") {
				ctx.ui.setEditorText(wsHelpText());
				ctx.ui.notify("/ws help written to editor", "info");
				return;
			}

			if (input === "list") {
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					ctx.ui.notify("Not inside a git repository", "error");
					return;
				}
				ctx.ui.setEditorText(formatWorktreeList(listing.items));
				ctx.ui.notify(`Listed ${listing.items.length} worktree(s)`, "info");
				return;
			}

			if (input.startsWith("new ")) {
				const brief = stripPrefix(input, "new");
				if (!brief) {
					ctx.ui.notify("Usage: /ws new <feature name>", "error");
					return;
				}

				const result = await createFeatureWorktree(pi, ctx.cwd, brief);
				if (!result.ok) {
					ctx.ui.notify(result.error ?? "Failed to create worktree", "error");
					return;
				}

				ctx.ui.notify(`Created ${result.branch} at ${result.worktreePath}`, "info");
				ctx.ui.setEditorText(`cd ${result.worktreePath}\npi`);
				return;
			}

			if (input.startsWith("open ")) {
				const target = stripPrefix(input, "open");
				if (!target) {
					ctx.ui.notify("Usage: /ws open <slug>", "error");
					return;
				}
				const slug = slugifyFeature(target);
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					ctx.ui.notify("Not inside a git repository", "error");
					return;
				}

				const found = findFeatureWorktree(listing.items, slug);
				if (!found) {
					ctx.ui.notify(`No worktree found for slug '${slug}'`, "error");
					return;
				}

				const launched = await launchPiInTmux(pi, {
					cwd: found.path,
					windowName: buildWindowName(slug),
					continueSession: true,
				});

				if (!launched.ok) {
					ctx.ui.notify(launched.error ?? "Failed to open tmux window", "warning");
					if (launched.fallbackCommand) ctx.ui.setEditorText(launched.fallbackCommand);
					return;
				}

				ctx.ui.notify(`Opened ${slug} in tmux`, "info");
				return;
			}

			if (input.startsWith("remove ")) {
				const force = input.includes("--force");
				const raw = stripPrefix(input.replace("--force", "").trim(), "remove");
				if (!raw) {
					ctx.ui.notify("Usage: /ws remove <slug> [--force]", "error");
					return;
				}
				const slug = slugifyFeature(raw);
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					ctx.ui.notify("Not inside a git repository", "error");
					return;
				}

				const found = findFeatureWorktree(listing.items, slug);
				if (!found) {
					ctx.ui.notify(`No worktree found for slug '${slug}'`, "error");
					return;
				}

				if (found.isMain) {
					ctx.ui.notify("Refusing to remove main worktree", "error");
					return;
				}

				let allowForce = force;
				if (found.dirty && !allowForce) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Worktree is dirty. Use --force to remove it", "error");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Dirty worktree",
						`Worktree ${found.path} has uncommitted changes. Remove with force?`,
					);
					if (!confirmed) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					allowForce = true;
				}

				const removed = await removeWorktree(pi, ctx.cwd, found.path, allowForce);
				if (!removed.ok) {
					ctx.ui.notify(removed.error ?? "Failed to remove worktree", "error");
					return;
				}

				ctx.ui.notify(`Removed worktree ${found.path}`, "info");
				return;
			}

			if (input === "prune") {
				const pruned = await pruneWorktrees(pi, ctx.cwd);
				if (!pruned.ok) {
					ctx.ui.notify(pruned.error ?? "Failed to prune worktrees", "error");
					return;
				}
				ctx.ui.notify("Pruned stale worktree references", "info");
				return;
			}

			ctx.ui.setEditorText(wsHelpText());
			ctx.ui.notify("Unknown /ws command. Help written to editor", "warning");
		},
	});

	pi.registerTool({
		name: "worktree_manage",
		label: "Worktree Manager",
		description:
			"Manage git worktrees for feature development. Supports creating, listing, opening, removing, and pruning worktrees.",
		parameters: Type.Object({
			action: StringEnum(["new", "list", "open", "remove", "prune"] as const),
			target: Type.Optional(
				Type.String({
					description:
						"Feature brief or slug. Required for new/open/remove. For 'new', this can be a natural-language feature brief.",
				}),
			),
			force: Type.Optional(Type.Boolean({ description: "Force removal of dirty worktrees when action is remove." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					return { content: [{ type: "text", text: "Not inside a git repository." }], details: {} };
				}
				return { content: [{ type: "text", text: formatWorktreeList(listing.items) }], details: { count: listing.items.length } };
			}

			if (params.action === "new") {
				if (!params.target?.trim()) {
					return { content: [{ type: "text", text: "target is required for action=new" }], details: {}, isError: true };
				}
				const created = await createFeatureWorktree(pi, ctx.cwd, params.target);
				if (!created.ok) {
					return {
						content: [{ type: "text", text: created.error ?? "Failed to create worktree." }],
						details: created,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Created ${created.branch} at ${created.worktreePath}` }],
					details: created,
				};
			}

			if (params.action === "open") {
				if (!params.target?.trim()) {
					return { content: [{ type: "text", text: "target is required for action=open" }], details: {}, isError: true };
				}

				const slug = slugifyFeature(params.target);
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					return { content: [{ type: "text", text: "Not inside a git repository." }], details: {}, isError: true };
				}

				const found = findFeatureWorktree(listing.items, slug);
				if (!found) {
					return {
						content: [{ type: "text", text: `No worktree found for slug '${slug}'` }],
						details: {},
						isError: true,
					};
				}

				const launched = await launchPiInTmux(pi, {
					cwd: found.path,
					windowName: buildWindowName(slug),
					continueSession: true,
				});
				if (!launched.ok) {
					return {
						content: [
							{
								type: "text",
								text:
									`${launched.error ?? "Failed to open tmux window."}` +
									(launched.fallbackCommand ? `\nFallback: ${launched.fallbackCommand}` : ""),
							},
						],
						details: { slug, path: found.path },
						isError: true,
					};
				}
				return { content: [{ type: "text", text: `Opened ${slug} in tmux.` }], details: { slug, path: found.path } };
			}

			if (params.action === "remove") {
				if (!params.target?.trim()) {
					return { content: [{ type: "text", text: "target is required for action=remove" }], details: {}, isError: true };
				}
				const slug = slugifyFeature(params.target);
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					return { content: [{ type: "text", text: "Not inside a git repository." }], details: {}, isError: true };
				}
				const found = findFeatureWorktree(listing.items, slug);
				if (!found) {
					return {
						content: [{ type: "text", text: `No worktree found for slug '${slug}'` }],
						details: {},
						isError: true,
					};
				}
				if (found.isMain) {
					return {
						content: [{ type: "text", text: "Refusing to remove main worktree." }],
						details: {},
						isError: true,
					};
				}
				if (found.dirty && !params.force) {
					return {
						content: [{ type: "text", text: "Worktree is dirty. Retry with force=true." }],
						details: { slug, path: found.path },
						isError: true,
					};
				}
				const removed = await removeWorktree(pi, ctx.cwd, found.path, Boolean(params.force));
				if (!removed.ok) {
					return {
						content: [{ type: "text", text: removed.error ?? "Failed to remove worktree." }],
						details: { slug, path: found.path },
						isError: true,
					};
				}
				return { content: [{ type: "text", text: `Removed ${found.path}` }], details: { slug, path: found.path } };
			}

			const pruned = await pruneWorktrees(pi, ctx.cwd);
			if (!pruned.ok) {
				return { content: [{ type: "text", text: pruned.error ?? "Failed to prune worktrees." }], details: {}, isError: true };
			}
			return { content: [{ type: "text", text: "Pruned stale worktree references." }], details: {} };
		},
	});
}
