import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { CandidateIdentity, VerificationPolicy, VerificationReceipt } from "./contracts.ts";
import { COMPLETE_EVIDENCE_OUTPUT_LIMIT_BYTES, runProcess, scrubbedEnvironment } from "./process.ts";

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
type FilesystemEntry = { kind: "file" | "symlink" | "other"; mode: number; digest?: string; target?: string };

async function filesystemManifest(root: string): Promise<Map<string, FilesystemEntry>> {
	const manifest = new Map<string, FilesystemEntry>();
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.name === ".git") continue;
			const relativePath = relative(root, absolute).split(sep).join("/");
			const stat = await lstat(absolute);
			if (stat.isDirectory()) await visit(absolute);
			else if (stat.isSymbolicLink()) manifest.set(relativePath, { kind: "symlink", mode: stat.mode & 0o7777, target: await readlink(absolute) });
			else if (stat.isFile()) manifest.set(relativePath, { kind: "file", mode: stat.mode & 0o7777, digest: sha(await readFile(absolute)) });
			else manifest.set(relativePath, { kind: "other", mode: stat.mode & 0o7777 });
		}
	};
	await visit(root);
	return manifest;
}

async function manifestDifferences(before: Map<string, FilesystemEntry>, after: Map<string, FilesystemEntry>, root: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
	const differences: string[] = [];
	for (const path of [...new Set([...before.keys(), ...after.keys()])]) {
		if (JSON.stringify(before.get(path)) === JSON.stringify(after.get(path))) continue;
		if (!before.has(path)) {
			const ignored = await runProcess("git", ["-C", root, "check-ignore", "--no-index", "--", path], { cwd: root, env: scrubbedEnvironment(environment), timeoutMs: 60_000, maxOutputBytes: 16_384 });
			if (ignored.code === 0) continue;
		}
		differences.push(path);
	}
	return differences.sort();
}

function redact(value: string): string {
	return value
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
		.replace(/\b((?:proxy-)?authorization|x-api-key)\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, "$1: [REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
		.replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED]")
		.replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
		.replace(/(?<![A-Za-z0-9_-])(["']?)([A-Za-z0-9_-]*(?:password|secret|token|api[-_ ]?key))\1\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1$2$1$3[REDACTED]")
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}
async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	const result = await runProcess("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: root, env: scrubbedEnvironment(env), timeoutMs: 60_000, maxOutputBytes: COMPLETE_EVIDENCE_OUTPUT_LIMIT_BYTES });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	if (result.overflowed) throw new Error(`git ${args[0]} exceeded the complete-evidence output bound`);
	return result.stdout.trim();
}

const PROTECTED_CONFIGURATION = /^(scripts\/.+|package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Makefile|tsconfig[^/]*\.json|(?:vite|vitest|jest|eslint|playwright)[^/]*\.(?:ts|js|mts|mjs|cts|cjs|json)|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|(?:.+\/)?conftest\.py|\.github\/workflows\/[^/]+)$/;
const EXISTING_TEST = /(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)[^/]+_test\.go$|(?:^|\/)test_[^/]+\.py$/;

export async function freezeVerificationPolicy(root: string, baseTreeOid: string): Promise<VerificationPolicy | undefined> {
	const listing = await git(root, ["ls-tree", "-r", baseTreeOid]);
	const entries = listing.split("\n").filter(Boolean).map((line) => {
		const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
		return match ? { mode: match[1], blobOid: match[2], path: match[3] } : undefined;
	}).filter((entry): entry is { mode: string; blobOid: string; path: string } => Boolean(entry));
	const verify = entries.find((entry) => entry.path === "scripts/verify.sh");
	if (!verify || verify.mode === "120000") return undefined;
	const closure = entries
		.filter((entry) => PROTECTED_CONFIGURATION.test(entry.path) || EXISTING_TEST.test(entry.path))
		.map(({ path, mode, blobOid }) => ({ path, mode, blobOid }))
		.sort((left, right) => left.path.localeCompare(right.path));
	const environmentDigest = sha(JSON.stringify({
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		path: process.env.PATH ?? "",
		credentialEnvironment: "scrubbed",
		home: "isolated-per-run",
		gitMetadata: "standalone",
	}));
	const body = { command: ["bash", "scripts/verify.sh"] as ["bash", "scripts/verify.sh"], closure, environmentDigest };
	return { ...body, digest: sha(JSON.stringify(body)) };
}

export async function verifyCandidate(
	root: string,
	candidate: CandidateIdentity,
	policy: VerificationPolicy | undefined,
	signal?: AbortSignal,
	onSpawn?: (pid: number) => void | Promise<void>,
	onBeforeSpawn?: (readyPath: string) => void | Promise<void>,
): Promise<VerificationReceipt> {
	const started = Date.now();
	if (!policy) return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: "missing", status: "missing", durationMs: 0, outputSha256: sha("") };
	const candidateListing = await git(root, ["ls-tree", "-r", candidate.candidateTreeOid]);
	const candidateEntries = new Map(candidateListing.split("\n").filter(Boolean).map((line) => {
		const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
		return match ? [match[3], { mode: match[1], blobOid: match[2] }] as const : undefined;
	}).filter((entry): entry is readonly [string, { mode: string; blobOid: string }] => Boolean(entry)));
	const protectedPaths = new Set(policy.closure.map((entry) => entry.path));
	const addedProtectedInput = [...candidateEntries.keys()].some((path) => (PROTECTED_CONFIGURATION.test(path) || EXISTING_TEST.test(path)) && !protectedPaths.has(path));
	if (addedProtectedInput || policy.closure.some((entry) => {
		const candidateEntry = candidateEntries.get(entry.path);
		return !candidateEntry || candidateEntry.mode !== entry.mode || candidateEntry.blobOid !== entry.blobOid;
	})) {
		return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: policy.digest, status: "mutated", durationMs: Date.now() - started, outputSha256: sha("protected verification closure changed") };
	}
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-delivery-verify-"));
	const verificationRoot = join(temporaryRoot, "candidate");
	const archive = join(temporaryRoot, "candidate.tar");
	try {
		await git(root, ["archive", "--format=tar", "--prefix=candidate/", `--output=${archive}`, candidate.candidateTreeOid]);
		const extracted = await runProcess("tar", ["-xf", archive, "-C", temporaryRoot], { cwd: temporaryRoot, env: scrubbedEnvironment(), timeoutMs: 60_000 });
		if (extracted.code !== 0) throw new Error("The standalone verification snapshot could not be materialized.");
		const isolatedHome = join(temporaryRoot, "home");
		await mkdir(isolatedHome, { mode: 0o700 });
		const isolatedEnvironment = { HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, ".config"), XDG_CACHE_HOME: join(isolatedHome, ".cache"), GIT_CONFIG_NOSYSTEM: "1" };
		await git(verificationRoot, ["init", "-q"], isolatedEnvironment);
		const beforeVerification = await filesystemManifest(verificationRoot);
		const result = await runProcess("bash", ["scripts/verify.sh"], { cwd: verificationRoot, env: scrubbedEnvironment(isolatedEnvironment), signal, timeoutMs: 10 * 60_000, maxOutputBytes: 1_000_000, detached: true, onBeforeSpawn, onSpawn });
		const afterVerification = await filesystemManifest(verificationRoot);
		const mutationPaths = await manifestDifferences(beforeVerification, afterVerification, verificationRoot, isolatedEnvironment);
		const output = `${result.stdout}\n${result.stderr}`;
		const status = result.timedOut ? "timeout" : mutationPaths.length > 0 ? "mutated" : result.code === 0 ? "passed" : "failed";
		return {
			candidateTreeOid: candidate.candidateTreeOid,
			policyDigest: policy.digest,
			status,
			exitCode: result.code,
			durationMs: result.durationMs,
			outputSha256: result.outputSha256,
			...(status === "failed" ? { redactedFailureOutputTail: redact(output).slice(-20_000) } : {}),
			...(mutationPaths.length > 0 ? { mutationPaths } : {}),
			...(status === "passed" ? { verifiedTreeOid: candidate.candidateTreeOid } : {}),
		};
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
