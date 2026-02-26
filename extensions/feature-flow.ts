import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildFeatureBranch,
	buildWindowName,
	createFeatureWorktree,
	ensureFeatureBranchFromMain,
	findFeatureWorktree,
	launchPiInTmux,
	listWorktrees,
	removeWorktree,
	slugifyFeature,
} from "./lib/worktree.js";

function stripWrappingQuotes(input: string): string {
	let text = input.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

function parseFeatureInput(raw: string): { brief: string; slugOverride?: string } {
	const match = raw.match(/(?:^|\s)--slug\s+("[^"]+"|'[^']+'|\S+)/i);
	if (!match) return { brief: stripWrappingQuotes(raw) };

	const slugOverride = stripWrappingQuotes(match[1] ?? "");
	const withoutFlag = `${raw.slice(0, match.index ?? 0)} ${raw.slice((match.index ?? 0) + match[0].length)}`.trim();
	const brief = stripWrappingQuotes(withoutFlag || slugOverride);
	return { brief, slugOverride };
}

function featureHelpText(): string {
	return [
		"Usage:",
		"  /feature <brief>",
		"  /feature <brief> --slug <name>",
		"  /feature --slug <name> <brief>",
		"  /feature list",
		"  /feature open <slug>",
		"  /feature reopen <slug>",
		"  /feature close <slug>",
		"",
		"Behavior:",
		"- Creates feat/<slug> worktree at ../<repo>-<slug>",
		"- Generates a concise slug from the brief (or uses --slug override)",
		"- In interactive mode, asks you to confirm/edit the slug before creating worktree",
		"- Opens a new tmux window and starts pi with a kickoff prompt",
		"- If worktree creation fails, creates feat/<slug> from main in current repo",
	].join("\n");
}

function buildKickoffPrompt(input: {
	brief: string;
	slug: string;
	branch: string;
	workspacePath: string;
	fallbackUsed: boolean;
	fallbackReason?: string;
}): string {
	const fallbackSection = input.fallbackUsed
		? [
			"## Runtime Mode",
			"Worktree creation failed, so this run is using single-working-copy fallback mode.",
			input.fallbackReason ? `Reason: ${input.fallbackReason}` : "",
		]
				.filter(Boolean)
				.join("\n")
		: "";

	return [
		"You are starting a new feature workflow.",
		"",
		"## Feature Context",
		`- Brief: ${input.brief}`,
		`- Slug: ${input.slug}`,
		`- Branch: ${input.branch}`,
		`- Workspace: ${input.workspacePath}`,
		fallbackSection,
		"",
		"## Required Workflow",
		"1. Ask 3-5 clarifying questions with lettered options (A/B/C/...).",
		`2. After answers, create PRD at .features/${input.slug}/prd.md (use the prd skill instructions).`,
		"3. Summarize PRD directly in chat and ask for explicit approval (do not ask user to open files).",
		`4. After PRD approval, create technical design at .features/${input.slug}/design.md (use design-solution skill).`,
		"5. Summarize design directly in chat and ask for explicit approval.",
		`6. After design approval, create tasks under .features/${input.slug}/tasks/ (use simple-tasks skill).`,
		"7. Summarize tasks in chat, confirm readiness, then proceed to implementation.",
		"",
		"## UX Rules",
		"- Keep the workflow conversational and smooth.",
		"- Do not require /open or manual file navigation unless user explicitly asks.",
		"- Use short status updates and clear next actions.",
		"",
		"## Hard Gates",
		"- Do not proceed to design before PRD approval.",
		"- Do not proceed to tasks before design approval.",
		"- Keep outputs concise and actionable.",
		"",
		"Start now with clarifying questions.",
	]
		.filter(Boolean)
		.join("\n");
}

function formatFeatureList(items: Array<{ branch?: string; path: string; dirty: boolean; isMain: boolean }>): string {
	if (items.length === 0) return "No feature worktrees found (branch prefix feat/).";
	const lines: string[] = ["Feature worktrees:"];
	for (const item of items) {
		const branch = item.branch ?? "(no branch)";
		const flags = [item.isMain ? "main" : "linked", item.dirty ? "dirty" : "clean"].join(", ");
		lines.push(`- ${branch} :: ${item.path} [${flags}]`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("feature", {
		description: "Create and run feature workflow in an isolated worktree",
		handler: async (args, ctx) => {
			const rawInput = args.trim();
			if (!rawInput || rawInput === "help") {
				ctx.ui.setEditorText(featureHelpText());
				ctx.ui.notify("/feature help written to editor", "info");
				return;
			}

			if (rawInput === "list") {
				const listing = await listWorktrees(pi, ctx.cwd);
				if (!listing) {
					ctx.ui.notify("Not inside a git repository", "error");
					return;
				}
				const features = listing.items.filter((item) => item.branch?.startsWith("feat/"));
				ctx.ui.setEditorText(formatFeatureList(features));
				ctx.ui.notify(`Listed ${features.length} feature worktree(s)`, "info");
				return;
			}

			if (rawInput.startsWith("open ") || rawInput.startsWith("reopen ")) {
				const isReopen = rawInput.startsWith("reopen ");
				const target = rawInput.slice(isReopen ? "reopen".length : "open".length).trim();
				if (!target) {
					ctx.ui.notify("Usage: /feature open <slug> (alias: /feature reopen <slug>)", "error");
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
					ctx.ui.notify(`No feature worktree found for '${slug}'`, "error");
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

				ctx.ui.notify(`${isReopen ? "Reopened" : "Opened"} ${slug} in tmux`, "info");
				return;
			}

			if (rawInput.startsWith("close ")) {
				const target = rawInput.slice("close".length).trim();
				if (!target) {
					ctx.ui.notify("Usage: /feature close <slug>", "error");
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
					ctx.ui.notify(`No feature worktree found for '${slug}'`, "error");
					return;
				}
				if (found.isMain) {
					ctx.ui.notify("Refusing to close main worktree", "error");
					return;
				}

				let force = false;
				if (found.dirty) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Worktree is dirty. Close manually with force", "error");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Dirty feature worktree",
						`Feature worktree ${found.path} has uncommitted changes. Remove it anyway?`,
					);
					if (!confirmed) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					force = true;
				}

				const removed = await removeWorktree(pi, ctx.cwd, found.path, force);
				if (!removed.ok) {
					ctx.ui.notify(removed.error ?? "Failed to remove feature worktree", "error");
					return;
				}

				ctx.ui.notify(`Closed feature workspace ${slug}`, "info");
				return;
			}

			const parsed = parseFeatureInput(rawInput);
			const brief = parsed.brief;
			if (!brief) {
				ctx.ui.notify("Feature brief is required", "error");
				return;
			}

			let slug = slugifyFeature(parsed.slugOverride || brief);
			if (ctx.hasUI && !parsed.slugOverride) {
				const editedSlug = await ctx.ui.editor("Confirm feature slug (edit or keep)", slug);
				if (editedSlug === undefined) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				const cleaned = stripWrappingQuotes(editedSlug).trim();
				if (!cleaned) {
					ctx.ui.notify("Feature slug cannot be empty", "error");
					return;
				}
				slug = slugifyFeature(cleaned);
			}

			const desiredBranch = buildFeatureBranch(slug);
			let workspacePath = "";
			let branch = desiredBranch;
			let fallbackUsed = false;
			let fallbackReason: string | undefined;

			const created = await createFeatureWorktree(pi, ctx.cwd, slug);
			if (created.ok) {
				slug = created.slug;
				workspacePath = created.worktreePath;
				branch = created.branch;
			} else {
				fallbackUsed = true;
				fallbackReason = created.error;

				const fallback = await ensureFeatureBranchFromMain(pi, ctx.cwd, slug);
				if (!fallback.ok || !fallback.repoContext) {
					ctx.ui.notify(
						`Worktree failed and fallback branch creation failed: ${fallback.error ?? "unknown error"}`,
						"error",
					);
					return;
				}

				branch = fallback.branch;
				workspacePath = fallback.repoContext.gitRoot;

				if (!fallback.checkedOut) {
					ctx.ui.notify("Branch created from main but not checked out (dirty repository)", "warning");
					ctx.ui.setEditorText(`git checkout ${branch}`);
					return;
				}
			}

			const kickoffPrompt = buildKickoffPrompt({
				brief,
				slug,
				branch,
				workspacePath,
				fallbackUsed,
				fallbackReason,
			});

			const launched = await launchPiInTmux(pi, {
				cwd: workspacePath,
				windowName: buildWindowName(slug),
				initialPrompt: kickoffPrompt,
			});

			if (!launched.ok) {
				ctx.ui.notify(launched.error ?? "Failed to open tmux window", "warning");
				if (launched.fallbackCommand) ctx.ui.setEditorText(launched.fallbackCommand);
				return;
			}

			if (fallbackUsed) {
				ctx.ui.notify(`Feature started in fallback mode on ${branch}`, "warning");
			} else {
				ctx.ui.notify(`Feature started in worktree: ${workspacePath}`, "info");
			}
		},
	});
}
