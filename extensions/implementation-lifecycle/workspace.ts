import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CandidateIdentity, SnapshotIdentity } from "./contracts.ts";
import { COMPLETE_EVIDENCE_OUTPUT_LIMIT_BYTES, runProcess, scrubbedEnvironment } from "./process.ts";

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function credentialPath(path: string): boolean {
	return path.split("/").some((segment) => segment === ".env"
		|| segment.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(segment)
		|| [".npmrc", ".pypirc", ".netrc"].includes(segment));
}

async function gitRaw(root: string, args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
	const result = await runProcess("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: root, env: scrubbedEnvironment(environment), timeoutMs: 60_000, maxOutputBytes: COMPLETE_EVIDENCE_OUTPUT_LIMIT_BYTES });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	if (result.overflowed) throw new Error(`git ${args[0]} exceeded the complete-evidence output bound`);
	return result.stdout;
}

async function git(root: string, args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
	return (await gitRaw(root, args, environment)).trim();
}

export class SnapshotReviewRequiredError extends Error {
	constructor() {
		super("Configured Git content filters require a human-reviewed snapshot exception.");
		this.name = "SnapshotReviewRequiredError";
	}
}

export type SnapshotOptions = {
	allowConfiguredFilters?: boolean;
};

export async function resolveRepository(cwd: string): Promise<{ root: string; commonRoot: string }> {
	const root = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
	const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return { root, commonRoot: resolve(root, common) };
}

export async function captureSnapshot(root: string, stateRoot: string, identity: string, options: SnapshotOptions = {}): Promise<SnapshotIdentity> {
	const sparse = await git(root, ["config", "--bool", "core.sparseCheckout"]).catch(() => "false");
	if (sparse === "true") throw new Error("Sparse-checkout repositories are not supported by complete delivery snapshots.");
	const filters = await git(root, ["config", "--get-regexp", "^filter\\."]).catch(() => "");
	if (filters && !options.allowConfiguredFilters) throw new SnapshotReviewRequiredError();
	if ((await git(root, ["ls-files", "--stage"])).split("\n").some((line) => line.startsWith("160000 "))) throw new Error("Submodule entries are not supported by complete delivery snapshots.");
	const headSha = await git(root, ["rev-parse", "HEAD"]);
	const status = await gitRaw(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
	const index = join(stateRoot, `snapshot-${identity}.index`);
	await git(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
	await git(root, ["add", "-A", "--", "."], { GIT_INDEX_FILE: index });
	const stagedEntries = (await git(root, ["ls-files", "--stage"], { GIT_INDEX_FILE: index })).split("\n").filter(Boolean);
	if (stagedEntries.some((line) => line.startsWith("160000 "))) {
		throw new Error("Nested repositories and submodule entries are not supported by complete delivery snapshots.");
	}
	if (stagedEntries.some((line) => credentialPath(line.split("\t", 2)[1] ?? ""))) {
		throw new Error("Credential-bearing project files cannot enter an autonomous delivery candidate.");
	}
	const treeOid = await git(root, ["write-tree"], { GIT_INDEX_FILE: index });
	const finalHead = await git(root, ["rev-parse", "HEAD"]);
	const finalStatus = await gitRaw(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
	if (headSha !== finalHead || status !== finalStatus) throw new Error("The project changed while its complete delivery snapshot was being captured.");
	return { headSha, treeOid, statusDigest: sha(status) };
}

export class CandidateWorkspace {
	private temporaryRoot?: string;
	candidateRoot?: string;
	private readonly root: string;
	private readonly stateRoot: string;
	private readonly runId: string;
	private readonly allowConfiguredFilters: boolean;
	constructor(root: string, stateRoot: string, runId: string, options: SnapshotOptions = {}) {
		this.root = root;
		this.stateRoot = stateRoot;
		this.runId = runId;
		this.allowConfiguredFilters = options.allowConfiguredFilters ?? false;
	}

	async prepare(): Promise<{ base: SnapshotIdentity; candidateRoot: string }> {
		const base = await captureSnapshot(this.root, this.stateRoot, `base-${this.runId}`, { allowConfiguredFilters: this.allowConfiguredFilters });
		const commit = await git(this.root, ["commit-tree", base.treeOid, "-p", base.headSha, "-m", `pi delivery base ${this.runId}`], {
			GIT_AUTHOR_NAME: "Pi Delivery Controller", GIT_AUTHOR_EMAIL: "pi-delivery@invalid", GIT_COMMITTER_NAME: "Pi Delivery Controller", GIT_COMMITTER_EMAIL: "pi-delivery@invalid",
		});
		this.temporaryRoot = await mkdtemp(join(tmpdir(), `pi-delivery-${this.runId}-`));
		this.candidateRoot = join(this.temporaryRoot, "candidate");
		await mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
		await git(this.root, ["worktree", "add", "--detach", this.candidateRoot, commit]);
		return { base, candidateRoot: this.candidateRoot };
	}

	async capture(base: SnapshotIdentity): Promise<CandidateIdentity> {
		if (!this.candidateRoot) throw new Error("Candidate workspace is not prepared.");
		const index = join(this.stateRoot, `candidate-${this.runId}.index`);
		await git(this.candidateRoot, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
		await git(this.candidateRoot, ["add", "-A", "--", "."], { GIT_INDEX_FILE: index });
		const candidateTreeOid = await git(this.candidateRoot, ["write-tree"], { GIT_INDEX_FILE: index });
		const diff = await git(this.candidateRoot, ["diff", "--binary", "--full-index", base.treeOid, candidateTreeOid]);
		return { base, candidateTreeOid, diffSha256: sha(diff) };
	}

	async diff(baseTreeOid: string, candidateTreeOid: string): Promise<string> {
		return git(this.root, ["diff", "--binary", "--full-index", baseTreeOid, candidateTreeOid]);
	}

	async changedPaths(baseTreeOid: string, candidateTreeOid: string): Promise<string[]> {
		const output = await git(this.root, ["diff", "--no-renames", "--name-only", "-z", baseTreeOid, candidateTreeOid]);
		return output ? output.split("\0").filter(Boolean) : [];
	}

	async dispose(): Promise<void> {
		if (this.candidateRoot) await git(this.root, ["worktree", "remove", "--force", this.candidateRoot]).catch(() => undefined);
		if (this.temporaryRoot) await rm(this.temporaryRoot, { recursive: true, force: true });
	}
}
