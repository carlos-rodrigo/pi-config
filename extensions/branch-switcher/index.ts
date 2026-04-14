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

export function resolveRequestedBranch(input: string, branches: BranchRecord[]): ResolveBranchResult {
	const query = input.trim();
	if (!query) return { error: "No branch specified" };

	const exact = branches.find((branch) => branch.shortName === query || branch.ref === query);
	if (exact) return { branch: exact };

	const remoteMatches = branches.filter((branch) => branch.kind === "remote" && branch.localName === query);
	if (remoteMatches.length === 1) return { branch: remoteMatches[0] };
	if (remoteMatches.length > 1) {
		return {
			error: `Ambiguous remote branch '${query}': ${remoteMatches.map((branch) => branch.shortName).join(", ")}`,
		};
	}

	return { error: `Branch not found: ${query}` };
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
					ctx.ui.notify(resolved.error ?? "Branch not found", "error");
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
