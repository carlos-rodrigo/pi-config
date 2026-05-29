import path from "node:path";
import { pathToFileURL } from "node:url";
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
} from "./lib/worktree.ts";
import { openExternal } from "../lib/open-external.ts";
import { createExecutionReport, createWorkOrder, formatFeaturePacketStatus, getFeaturePacketStatus, initializeFeaturePacket, listFeaturePacketSlugs, rebuildFeatureLearningView } from "./packet.ts";
import { buildKickoffPrompt } from "./prompt.ts";

function stripWrappingQuotes(input: string): string {
	let text = input.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStandaloneFlag(input: string, flag: string): boolean {
	const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i");
	return pattern.test(input);
}

function stripStandaloneFlag(input: string, flag: string): string {
	const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "gi");
	return input.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

function getLaunchMode(input: string): { cleanedInput: string; launchMode: "pane" | "window" } {
	const useWindow = hasStandaloneFlag(input, "--window");
	return {
		cleanedInput: stripStandaloneFlag(input, "--window"),
		launchMode: useWindow ? "window" : "pane",
	};
}

function parseFeatureInput(raw: string, options: { fallbackBriefToSlug?: boolean } = {}): { brief: string; slugOverride?: string } {
	const fallbackBriefToSlug = options.fallbackBriefToSlug ?? true;
	const match = raw.match(/(?:^|\s)--slug\s+("[^"]+"|'[^']+'|\S+)/i);
	if (!match) return { brief: stripWrappingQuotes(raw) };

	const slugOverride = stripWrappingQuotes(match[1] ?? "");
	const withoutFlag = `${raw.slice(0, match.index ?? 0)} ${raw.slice((match.index ?? 0) + match[0].length)}`.trim();
	const brief = stripWrappingQuotes(withoutFlag || (fallbackBriefToSlug ? slugOverride : ""));
	return { brief, slugOverride };
}

function getSubcommandTarget(input: string, command: string): string | undefined {
	if (input === command) return "";
	return input.startsWith(`${command} `) ? input.slice(command.length).trim() : undefined;
}

async function resolveFeatureSlug(cwd: string, target: string): Promise<{ ok: true; slug: string } | { ok: false; message: string }> {
	if (target.trim()) return { ok: true, slug: slugifyFeature(target) };
	const slugs = await listFeaturePacketSlugs(cwd);
	if (slugs.length === 1) return { ok: true, slug: slugs[0] ?? "" };
	if (slugs.length === 0) {
		return { ok: false, message: "No feature packet found under docs/features/. Pass a slug or start one with /feature <brief>." };
	}
	return { ok: false, message: `Multiple feature packets found: ${slugs.join(", ")}. Pass a slug, e.g. /feature status ${slugs[0]}.` };
}

function featureHelpText(): string {
	return [
		"Usage:",
		"  /feature <brief>",
		"  /feature <brief> --slug <name>",
		"  /feature <brief> --window",
		"  /feature --slug <name> <brief>",
		"  /feature list",
		"  /feature status [slug]",
		"  /feature next [slug]",
		"  /feature work-order <title> [--slug <name>]",
		"  /feature report <work-order> [--slug <name>]",
		"  /feature review [slug]",
		"  /feature view [slug]",
		"  /feature open <slug> [--window]",
		"  /feature reopen <slug> [--window]",
		"  /feature close <slug>",
		"",
		"Behavior:",
		"- Creates feat/<slug> worktree at ../<repo>-<slug>",
		"- Generates a concise slug from the brief (or uses --slug override)",
		"- In interactive mode, asks you to confirm/edit the slug before creating worktree",
		"- Opens a tmux pane by default (use --window for a new window) and starts pi with a strategy-first kickoff prompt",
		"- Scaffolds docs/features/<slug>/ as a learning packet and generates index.html",
		"- Keeps optional work orders under docs/features/<slug>/work-orders/; .features/ is legacy/optional",
		"- /feature status [slug] summarizes docs, decisions, proof, work orders, diagrams, and next action",
		"- /feature next [slug] writes the next recommended strategic prompt to the editor",
		"- /feature work-order <title> [--slug <name>] creates a draft Work Order v2 delegation brief",
		"- /feature report <work-order> [--slug <name>] creates a draft execution report for a ready/done work order",
		"- /feature review [slug] writes a strategy-review prompt for final alignment and optional /reown --remember",
		"- /feature view [slug] regenerates and opens docs/features/<slug>/index.html",
		"- When slug is omitted, feature-flow infers it if there is exactly one docs/features packet",
		"- If worktree creation fails, creates feat/<slug> from main in current repo",
	].join("\n");
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

function buildFeatureReviewPrompt(slug: string): string {
	return `Review strategy alignment for docs/features/${slug}/.

Use the feature packet as source of truth:
- strategy.md
- system-model.md
- decisions.md
- work-orders/
- execution/
- proof.md

Compare original intent, decisions, implementation evidence, and proof. Update docs/features/${slug}/review.md with:

1. Original intent
2. Actual implementation
3. Match / mismatch table
4. Product/system rule now
5. What I should retain
6. Follow-up questions

Use repo-relative paths only. If this review should become searchable ownership memory, suggest /reown --remember after updating review.md.`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("feature", {
		description: "Start a strategy-first feature workflow in an isolated worktree",
		handler: async (args, ctx) => {
			const rawInput = args.trim();
			const { cleanedInput, launchMode } = getLaunchMode(rawInput);
			if (!cleanedInput || cleanedInput === "help") {
				ctx.ui.setEditorText(featureHelpText());
				ctx.ui.notify("/feature help written to editor", "info");
				return;
			}

			if (cleanedInput === "list") {
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

			const statusTarget = getSubcommandTarget(cleanedInput, "status");
			if (statusTarget !== undefined) {
				const resolved = await resolveFeatureSlug(ctx.cwd, statusTarget);
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				const status = await getFeaturePacketStatus(ctx.cwd, resolved.slug);
				ctx.ui.setEditorText(formatFeaturePacketStatus(status));
				ctx.ui.notify(status.ok ? "Feature status written to editor" : "Feature packet not found", status.ok ? "info" : "error");
				return;
			}

			const nextTarget = getSubcommandTarget(cleanedInput, "next");
			if (nextTarget !== undefined) {
				const resolved = await resolveFeatureSlug(ctx.cwd, nextTarget);
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				const status = await getFeaturePacketStatus(ctx.cwd, resolved.slug);
				ctx.ui.setEditorText(status.nextPrompt);
				ctx.ui.notify(status.ok ? `Next action: ${status.nextAction}` : status.error ?? "Feature packet not found", status.ok ? "info" : "error");
				return;
			}

			const workOrderTarget = getSubcommandTarget(cleanedInput, "work-order") ?? getSubcommandTarget(cleanedInput, "workorder");
			if (workOrderTarget !== undefined) {
				const parsed = parseFeatureInput(workOrderTarget, { fallbackBriefToSlug: false });
				const title = parsed.brief;
				if (!title) {
					ctx.ui.notify("Usage: /feature work-order <title> [--slug <name>]", "error");
					return;
				}
				const resolved = parsed.slugOverride
					? { ok: true as const, slug: slugifyFeature(parsed.slugOverride) }
					: await resolveFeatureSlug(ctx.cwd, "");
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				const created = await createWorkOrder(ctx.cwd, resolved.slug, title);
				if (!created.ok) {
					ctx.ui.notify(created.error, "error");
					return;
				}
				ctx.ui.setEditorText(created.path);
				ctx.ui.notify(`Created draft work order: ${created.path}`, "info");
				return;
			}

			const reportTarget = getSubcommandTarget(cleanedInput, "report") ?? getSubcommandTarget(cleanedInput, "execution-report");
			if (reportTarget !== undefined) {
				const parsed = parseFeatureInput(reportTarget, { fallbackBriefToSlug: false });
				const workOrderRef = parsed.brief;
				if (!workOrderRef) {
					ctx.ui.notify("Usage: /feature report <work-order> [--slug <name>]", "error");
					return;
				}
				const resolved = parsed.slugOverride
					? { ok: true as const, slug: slugifyFeature(parsed.slugOverride) }
					: await resolveFeatureSlug(ctx.cwd, "");
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				const created = await createExecutionReport(ctx.cwd, resolved.slug, workOrderRef);
				if (!created.ok) {
					ctx.ui.notify(created.error, "error");
					return;
				}
				ctx.ui.setEditorText(created.path);
				ctx.ui.notify(`Created draft execution report: ${created.path}`, "info");
				return;
			}

			const reviewTarget = getSubcommandTarget(cleanedInput, "review");
			if (reviewTarget !== undefined) {
				const resolved = await resolveFeatureSlug(ctx.cwd, reviewTarget);
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				ctx.ui.setEditorText(buildFeatureReviewPrompt(resolved.slug));
				ctx.ui.notify("Feature strategy-review prompt written to editor", "info");
				return;
			}

			const viewTarget = getSubcommandTarget(cleanedInput, "view");
			if (viewTarget !== undefined) {
				const resolved = await resolveFeatureSlug(ctx.cwd, viewTarget);
				if (!resolved.ok) {
					ctx.ui.setEditorText(resolved.message);
					ctx.ui.notify(resolved.message, "error");
					return;
				}
				const slug = resolved.slug;
				const rebuilt = await rebuildFeatureLearningView(ctx.cwd, slug);
				if (!rebuilt.ok) {
					ctx.ui.notify(rebuilt.error, "error");
					ctx.ui.setEditorText(`Feature packet not found. Expected: ${rebuilt.packetDir}`);
					return;
				}

				const absoluteIndexPath = path.join(ctx.cwd, rebuilt.indexPath);
				const opened = await openExternal(pi, pathToFileURL(absoluteIndexPath).href);
				ctx.ui.setEditorText(rebuilt.indexPath);
				if (!opened.ok) {
					ctx.ui.notify(opened.error ?? "Learning view generated; open manually", "warning");
					if (opened.fallbackCommand) ctx.ui.setEditorText(opened.fallbackCommand);
					return;
				}
				ctx.ui.notify(`Opened feature learning view: ${rebuilt.indexPath}`, "info");
				return;
			}

			if (cleanedInput.startsWith("open ") || cleanedInput.startsWith("reopen ")) {
				const isReopen = cleanedInput.startsWith("reopen ");
				const target = cleanedInput.slice(isReopen ? "reopen".length : "open".length).trim();
				if (!target) {
					ctx.ui.notify("Usage: /feature open <slug> [--window] (alias: /feature reopen <slug> [--window])", "error");
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
					launchMode,
				});
				if (!launched.ok) {
					ctx.ui.notify(launched.error ?? "Failed to open tmux session", "warning");
					if (launched.fallbackCommand) ctx.ui.setEditorText(launched.fallbackCommand);
					return;
				}

				ctx.ui.notify(
					`${isReopen ? "Reopened" : "Opened"} ${slug} in tmux ${launchMode === "window" ? "window" : "pane"}`,
					"info",
				);
				return;
			}

			if (cleanedInput.startsWith("close ")) {
				const target = cleanedInput.slice("close".length).trim();
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

			const parsed = parseFeatureInput(cleanedInput);
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

			let packetDir: string | undefined;
			let learningViewPath: string | undefined;
			try {
				const packet = await initializeFeaturePacket(workspacePath, {
					brief,
					slug,
					branch,
					workspacePath,
				});
				packetDir = packet.packetDir;
				learningViewPath = packet.indexPath;
			} catch (error) {
				ctx.ui.notify(`Feature packet scaffold failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}

			const kickoffPrompt = buildKickoffPrompt({
				brief,
				slug,
				branch,
				workspacePath,
				fallbackUsed,
				fallbackReason,
				packetDir,
				learningViewPath,
			});

			const launched = await launchPiInTmux(pi, {
				cwd: workspacePath,
				windowName: buildWindowName(slug),
				initialPrompt: kickoffPrompt,
				launchMode,
			});

			if (!launched.ok) {
				ctx.ui.notify(launched.error ?? "Failed to open tmux session", "warning");
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
