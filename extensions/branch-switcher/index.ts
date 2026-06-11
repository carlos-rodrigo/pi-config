import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type BranchKind = "local" | "remote";

export interface BranchRecord {
	ref: string;
	shortName: string;
	kind: BranchKind;
	isCurrent: boolean;
	localName: string;
}

export interface ResolveBranchResult {
	branch?: BranchRecord;
	error?: string;
	matches?: BranchRecord[];
	level?: "warning" | "error";
}

const LIST_BRANCH_ARGS = [
	"for-each-ref",
	"--sort=-committerdate",
	"--format=%(refname)\t%(refname:short)\t%(HEAD)",
	"refs/heads",
	"refs/remotes",
] as const;

export function parseBranchList(output: string): BranchRecord[] {
	const branches: BranchRecord[] = [];

	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [ref, shortName, head] = line.split("\t");
		if (!ref || !shortName) continue;
		if (ref.endsWith("/HEAD")) continue;

		const kind: BranchKind | undefined = ref.startsWith("refs/heads/")
			? "local"
			: ref.startsWith("refs/remotes/")
				? "remote"
				: undefined;
		if (!kind) continue;

		branches.push({
			ref,
			shortName,
			kind,
			isCurrent: head === "*",
			localName: kind === "local" ? shortName : shortName.slice(shortName.indexOf("/") + 1),
		});
	}

	return branches;
}

export function getVisibleBranches(branches: BranchRecord[]): BranchRecord[] {
	const localNames = new Set(branches.filter((branch) => branch.kind === "local").map((branch) => branch.localName));
	return branches.filter((branch) => branch.kind === "local" || !localNames.has(branch.localName));
}

export function formatBranchChoice(branch: BranchRecord): string {
	const tags: string[] = [];
	if (branch.isCurrent) tags.push("current");
	if (branch.kind === "remote") tags.push("remote");
	return tags.length > 0 ? `${branch.shortName} · ${tags.join(" · ")}` : branch.shortName;
}

export function formatBranchList(branches: BranchRecord[]): string {
	if (branches.length === 0) return "No branches found.";
	return ["Branches:", ...branches.map((branch) => `- ${formatBranchChoice(branch)}`)].join("\n");
}

function normalizeLookupValue(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

function scoreLookupCandidate(candidate: string, normalizedQuery: string, queryTokens: string[]): number {
	const normalizedCandidate = normalizeLookupValue(candidate);
	if (!normalizedCandidate) return 0;
	if (normalizedCandidate === normalizedQuery) return 1000;

	let score = 0;
	if (normalizedCandidate.startsWith(normalizedQuery)) score = Math.max(score, 800);
	else if (normalizedCandidate.includes(normalizedQuery)) score = Math.max(score, 650);

	const candidateTokens = normalizedCandidate.split("-").filter(Boolean);
	let exactMatches = 0;
	let prefixMatches = 0;
	let containsMatches = 0;

	for (const token of queryTokens) {
		if (candidateTokens.some((part) => part === token)) {
			exactMatches += 1;
			prefixMatches += 1;
			containsMatches += 1;
			continue;
		}
		if (candidateTokens.some((part) => part.startsWith(token))) {
			prefixMatches += 1;
			containsMatches += 1;
			continue;
		}
		if (candidateTokens.some((part) => part.includes(token))) {
			containsMatches += 1;
		}
	}

	if (queryTokens.length > 0) {
		if (exactMatches === queryTokens.length) score = Math.max(score, 760 + exactMatches * 10);
		else if (prefixMatches === queryTokens.length) score = Math.max(score, 720 + prefixMatches * 10);
		else if (containsMatches === queryTokens.length) score = Math.max(score, 660 + containsMatches * 10);
		else if (score === 0) return 0;
	}

	return score + exactMatches * 30 + (prefixMatches - exactMatches) * 18 + (containsMatches - prefixMatches) * 8;
}

export function resolveRequestedBranch(input: string, branches: BranchRecord[]): ResolveBranchResult {
	const query = input.trim();
	if (!query) return { error: "No branch specified", level: "error", matches: [] };

	const exact = branches.find((branch) => branch.shortName === query || branch.ref === query);
	if (exact) return { branch: exact, matches: [exact] };

	const remoteMatches = branches.filter((branch) => branch.kind === "remote" && branch.localName === query);
	if (remoteMatches.length === 1) return { branch: remoteMatches[0], matches: remoteMatches };
	if (remoteMatches.length > 1) {
		return {
			error: `Ambiguous remote branch '${query}': ${remoteMatches.map((branch) => branch.shortName).join(", ")}`,
			matches: remoteMatches,
			level: "warning",
		};
	}

	const normalizedQuery = normalizeLookupValue(query);
	if (!normalizedQuery) return { error: "No branch specified", level: "error", matches: [] };
	const queryTokens = normalizedQuery.split("-").filter(Boolean);
	const ranked = getVisibleBranches(branches)
		.map((branch) => ({
			branch,
			score: Math.max(scoreLookupCandidate(branch.shortName, normalizedQuery, queryTokens), scoreLookupCandidate(branch.localName, normalizedQuery, queryTokens)),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.branch.shortName.localeCompare(right.branch.shortName));

	if (ranked.length === 0) {
		return { error: `Branch not found: ${query}`, level: "error", matches: [] };
	}
	if (ranked.length === 1 || ranked[0].score > ranked[1].score) {
		return { branch: ranked[0].branch, matches: ranked.map((entry) => entry.branch) };
	}

	const matches = ranked.filter((entry) => entry.score === ranked[0].score).map((entry) => entry.branch);
	return {
		error: `Ambiguous branch query '${query}': ${matches.map((branch) => branch.shortName).join(", ")}`,
		matches,
		level: "warning",
	};
}

export function buildSwitchArgs(branch: BranchRecord): string[] {
	return branch.kind === "remote" ? ["switch", "--track", branch.shortName] : ["switch", branch.shortName];
}

async function listBranches(pi: ExtensionAPI, cwd: string): Promise<{ branches: BranchRecord[] } | { error: string }> {
	const result = await pi.exec("git", ["-C", cwd, ...LIST_BRANCH_ARGS]);
	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || "Failed to list branches.";
		if (/not a git repository/i.test(message)) return { error: "Not inside a git repository" };
		return { error: message };
	}
	return { branches: parseBranchList(result.stdout) };
}

function getCurrentBranch(branches: BranchRecord[]): BranchRecord | undefined {
	return branches.find((branch) => branch.kind === "local" && branch.isCurrent);
}

export default function branchSwitcherExtension(pi: ExtensionAPI) {
	pi.registerCommand("branch", {
		description: "Switch git branches in the current repository",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const requested = args.trim();
			const listing = await listBranches(pi, ctx.cwd);
			if ("error" in listing) {
				ctx.ui.notify(listing.error, /git repository/i.test(listing.error) ? "error" : "warning");
				return;
			}

			const branches = listing.branches;
			const visibleBranches = getVisibleBranches(branches);

			if (requested === "list") {
				ctx.ui.setEditorText(formatBranchList(visibleBranches));
				ctx.ui.notify(`Listed ${visibleBranches.length} branches`, "info");
				return;
			}

			if (requested === "current") {
				const current = getCurrentBranch(branches);
				ctx.ui.notify(current ? `Current branch: ${current.shortName}` : "Detached HEAD", "info");
				return;
			}

			let target: BranchRecord | undefined;
			if (!requested) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /branch <name> | /branch list | /branch current", "info");
					return;
				}

				const choices = visibleBranches.map((branch) => ({ label: formatBranchChoice(branch), branch }));
				const selected = await ctx.ui.select(
					"Switch branch",
					choices.map((choice) => choice.label),
				);
				if (!selected) return;
				target = choices.find((choice) => choice.label === selected)?.branch;
				if (!target) {
					ctx.ui.notify(`Unknown branch selection: ${selected}`, "warning");
					return;
				}
			} else {
				const resolved = resolveRequestedBranch(requested, branches);
				if (!resolved.branch) {
					if (ctx.hasUI && resolved.matches && resolved.matches.length > 0) {
						ctx.ui.setEditorText(formatBranchList(resolved.matches));
					}
					ctx.ui.notify(resolved.error ?? "Branch not found", resolved.level ?? "error");
					return;
				}
				target = resolved.branch;
			}

			if (!target) return;
			if (target.kind === "local" && target.isCurrent) {
				ctx.ui.notify(`Already on ${target.shortName}`, "info");
				return;
			}

			const switchResult = await pi.exec("git", ["-C", ctx.cwd, ...buildSwitchArgs(target)]);
			if (switchResult.code !== 0) {
				ctx.ui.notify(switchResult.stderr.trim() || switchResult.stdout.trim() || "Failed to switch branch", "error");
				return;
			}

			ctx.ui.notify(`Switched to ${target.localName}`, "info");
		},
	});
}
