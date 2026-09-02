import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import implementationLifecycle from "./index.ts";
import roleGuard from "./role-guard.ts";
import { runWriter } from "./roles.ts";
import { ImplementationController, classifyImplementationIntent, formatAmbiguousImplementationRequest } from "./controller.ts";
import type { VerificationPolicy } from "./contracts.ts";
import { DeliveryRunStore, mergeReadyTupleDigest } from "./store.ts";
import { CandidateWorkspace, resolveRepository } from "./workspace.ts";
import { freezeVerificationPolicy, verifyCandidate } from "./verifier.ts";
import { runProcess, scrubbedEnvironment } from "./process.ts";

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}
async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-delivery-test-"));
	roots.push(root);
	git(root, "init", "-q");
	await writeFile(join(root, ".gitignore"), "node_modules\n");
	await writeFile(join(root, "tracked.txt"), "base\n");
	git(root, "add", "."); git(root, "commit", "-qm", "base");
	return root;
}
test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("intent classification is conservative and distinguishes ambiguity", () => {
	assert.equal(classifyImplementationIntent("Implement the approved task"), "ambiguous");
	assert.equal(classifyImplementationIntent("Implement Scope 6 from the approved list"), "implementation");
	assert.equal(classifyImplementationIntent("Modify only `extensions/implementation-lifecycle/` to improve ambiguity handling. You may edit and test those files, but do not commit or push."), "implementation");
	assert.equal(classifyImplementationIntent("Modify troubleshoot-tracking-attempt.ts and its PPR caller. Do not modify lease, manager, ingress, path, or attempt logic."), "implementation");
	assert.equal(classifyImplementationIntent("Could we maybe refactor this?"), "ambiguous");
	assert.equal(classifyImplementationIntent("How should we implement this?"), "read-only");
	assert.equal(classifyImplementationIntent("Review the implementation"), "read-only");
	assert.equal(classifyImplementationIntent("Add 2 + 2"), "ambiguous");
	assert.equal(classifyImplementationIntent("Do not edit anything; explain it"), "read-only");
	assert.equal(classifyImplementationIntent("Delete the obsolete file"), "ambiguous");
	assert.equal(classifyImplementationIntent("Review and fix the billing bug"), "implementation");
	assert.equal(classifyImplementationIntent("Review this code"), "read-only");
	assert.equal(classifyImplementationIntent("Explain this code"), "read-only");
	assert.equal(classifyImplementationIntent("Do not fix the bug"), "read-only");
	assert.equal(classifyImplementationIntent("/skill:implement-task"), "read-only");
});

test("ambiguous implementation guidance states the missing boundary and preserves safe alternatives", () => {
	const guidance = formatAmbiguousImplementationRequest("Implement the approved task");
	assert.match(guidance, /does not identify one concrete software surface/);
	assert.match(guidance, /exact bounded software and change you authorize/);
	assert.match(guidance, /read-only analysis/);
	assert.match(formatAmbiguousImplementationRequest("Delete the obsolete file"), /Delete and rename operations require/);
});

test("the process primitive records before release, honors pre-abort, and hashes overflow completely", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-delivery-process-"));
	roots.push(root);
	const marker = join(root, "marker.txt");
	let observedBeforeRelease = false;
	let launchRecordPath: string | undefined;
	const result = await runProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('x'.repeat(4096))`], {
		cwd: root,
		env: scrubbedEnvironment(),
		detached: true,
		maxOutputBytes: 64,
		onBeforeSpawn: async (readyPath) => { launchRecordPath = readyPath; },
		onSpawn: async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			observedBeforeRelease = await readFile(marker, "utf8").then(() => false).catch(() => true);
		},
	});
	assert.equal(observedBeforeRelease, true);
	assert.equal(await readFile(marker, "utf8"), "ran");
	assert.ok(launchRecordPath);
	await assert.rejects(readFile(launchRecordPath!));
	assert.equal(result.overflowed, true);
	assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
	const overflowA = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(128) + 'A')"], { cwd: root, maxOutputBytes: 64 });
	const overflowB = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(128) + 'B')"], { cwd: root, maxOutputBytes: 64 });
	assert.equal(overflowA.stdout, overflowB.stdout);
	assert.notEqual(overflowA.outputSha256, overflowB.outputSha256);
	const oneWrite = await runProcess(process.execPath, ["-e", "process.stdout.write('same-output')"], { cwd: root });
	const manyWrites = await runProcess(process.execPath, ["-e", "for (const x of ['same','-','output']) process.stdout.write(x)"], { cwd: root });
	assert.equal(oneWrite.outputSha256, manyWrites.outputSha256);
	const descendantStarted = Date.now();
	await runProcess("sh", ["-c", "sleep 30 >/dev/null 2>&1 &"], { cwd: root, env: scrubbedEnvironment(), detached: true, timeoutMs: 10_000 });
	assert.ok(Date.now() - descendantStarted < 3_000, "orphaned descendants should be terminated before resolution");

	const abort = new AbortController();
	abort.abort();
	const skipped = await runProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(join(root, "should-not-exist"))}, 'bad')`], { cwd: root, signal: abort.signal });
	assert.equal(skipped.code, 130);
	await assert.rejects(readFile(join(root, "should-not-exist")));
});

test("the run store grants one atomic lease per Git common root", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const first = new DeliveryRunStore(commonRoot);
	const second = new DeliveryRunStore(commonRoot);
	const profile = 'a'.repeat(64);
	const outcomes = await Promise.allSettled([first.acquire(root, "Fix one", profile), second.acquire(root, "Fix two", profile)]);
	assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
	assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
});

test("an observing session cannot update or terminate another live lease", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const profile = 'a'.repeat(64);
	const owner = new DeliveryRunStore(commonRoot);
	await owner.acquire(root, "Fix one", profile);
	const observer = new DeliveryRunStore(commonRoot);
	await observer.read();
	await assert.rejects(observer.terminal("failed-safely", "not-owner"), /does not own/);
	assert.equal((await owner.update({ state: "writing" })).state, "writing");
});

test("recovery atomically fences a proven-dead lease owner", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const profile = 'a'.repeat(64);
	const owner = new DeliveryRunStore(commonRoot);
	await owner.acquire(root, "Fix one", profile);
	const lease = JSON.parse(await readFile(owner.leasePath, "utf8"));
	lease.pid = 999_999_999;
	await writeFile(owner.leasePath, JSON.stringify(lease));
	const recovery = new DeliveryRunStore(commonRoot);
	await recovery.read();
	assert.equal(await recovery.adoptForRecovery(), true);
	await assert.rejects(owner.update({ state: "writing" }), /ownership was lost/);
	assert.equal((await recovery.terminal("failed-safely", "recovered")).state, "failed-safely");
});

test("a corrupt active manifest fails closed", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const owner = new DeliveryRunStore(commonRoot);
	await owner.acquire(root, "Fix one", 'a'.repeat(64));
	await writeFile(owner.manifestPath, "not-json\n");
	await assert.rejects(new DeliveryRunStore(commonRoot).read(), /missing or corrupt/);
});

test("recovery rejects malformed child and forged MERGE READY manifests before signaling or cleanup", async () => {
	for (const mutation of [
		(run: any) => { run.child = { role: "writer", pid: -1, processStart: "x", startedAt: new Date().toISOString() }; },
		(run: any) => { run.state = "merge-ready"; run.terminalReason = "verified-proud"; run.finalTupleDigest = 'a'.repeat(64); },
	]) {
		const root = await repository();
		const { commonRoot } = await resolveRepository(root);
		const owner = new DeliveryRunStore(commonRoot);
		await owner.acquire(root, "Fix one", 'a'.repeat(64));
		const manifest = JSON.parse(await readFile(owner.manifestPath, "utf8"));
		mutation(manifest);
		await writeFile(owner.manifestPath, JSON.stringify(manifest));
		await assert.rejects(new DeliveryRunStore(commonRoot).read(), /does not match/);
	}
});

test("a durable terminal releases its lease for the next authorized run", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const profile = 'a'.repeat(64);
	const first = new DeliveryRunStore(commonRoot);
	await first.acquire(root, "Fix one", profile);
	await first.terminal("failed-safely", "test-terminal");
	const next = await new DeliveryRunStore(commonRoot).acquire(root, "Fix two", profile);
	assert.equal(next.state, "authorizing");
});

test("the controller can publish MERGE READY only with candidate-bound two-key evidence", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	let writerCalls = 0;
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			writerCalls += 1;
			await writeFile(join(candidateRoot, "implemented.txt"), `attempt ${writerCalls}\n`);
			return { code: 0, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async (_candidateRoot, _stateRoot, candidateTreeOid, _request, _diff, _verification, _evidence, _signal, onSpawn, onExit, onEvidence) => {
			await onEvidence?.({ reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64) });
			await onSpawn?.(process.pid);
			await onExit?.({ code: 0, timedOut: false, processOutputDigest: '4'.repeat(64) });
			return { candidateTreeOid, reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64), reviewOutputDigest: createHash("sha256").update(JSON.stringify({ verdict: "proud", findings: [] })).digest("hex"), verdict: "proud", findings: [] };
		},
	});

	const run = await controller.start(root, commonRoot, "Implement the approved test feature", '8'.repeat(64));

	assert.equal(run.state, "merge-ready");
	assert.match(run.finalTupleDigest ?? "", /^[a-f0-9]{64}$/);
	assert.equal(run.finalTupleDigest, mergeReadyTupleDigest(run));
	assert.equal(run.taskContext?.task, "Implement the approved test feature");
	assert.ok(run.taskContext?.graphFingerprint);
	assert.deepEqual(run.changedPaths, ["implemented.txt"]);
	assert.equal(run.verification?.candidateTreeOid, run.candidate?.candidateTreeOid);
	assert.equal(run.review?.candidateTreeOid, run.candidate?.candidateTreeOid);
	assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "base\n");
	assert.equal(await readFile(join(root, "implemented.txt"), "utf8").then(() => true).catch(() => false), false);
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("cancellation recorded after review still blocks MERGE READY", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	let reviewReady!: () => void;
	let releaseReview!: () => void;
	const ready = new Promise<void>((resolve) => { reviewReady = resolve; });
	const release = new Promise<void>((resolve) => { releaseReview = resolve; });
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			await writeFile(join(candidateRoot, "implemented.txt"), "changed\n");
			return { code: 0, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async (_candidateRoot, _stateRoot, candidateTreeOid, _request, _diff, _verification, _evidence, _signal, onSpawn, onExit, onEvidence) => {
			await onEvidence?.({ reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64) });
			await onSpawn?.(process.pid);
			await onExit?.({ code: 0, timedOut: false, processOutputDigest: '4'.repeat(64) });
			reviewReady();
			await release;
			return { candidateTreeOid, reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64), reviewOutputDigest: createHash("sha256").update(JSON.stringify({ verdict: "proud", findings: [] })).digest("hex"), verdict: "proud", findings: [] };
		},
	});
	const running = controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64));
	await ready;
	const cancelling = controller.cancel();
	releaseReview();
	assert.equal(await cancelling, true);
	const run = await running;
	assert.equal(run.state, "failed-safely");
	assert.equal(run.terminalReason, "cancelled");
	assert.equal(run.finalTupleDigest, undefined);
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("the completion gate rejects a Proud receipt that still contains a blocking finding", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	const finding = { severity: "must-fix" as const, code: "correctness" as const, summary: "Wrong", evidence: "Mismatch" };
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			await writeFile(join(candidateRoot, "implemented.txt"), "changed\n");
			return { code: 0, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async (_candidateRoot, _stateRoot, candidateTreeOid, _request, _diff, _verification, _evidence, _signal, onSpawn, onExit, onEvidence) => {
			await onEvidence?.({ reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64) });
			await onSpawn?.(process.pid);
			await onExit?.({ code: 0, timedOut: false, processOutputDigest: '4'.repeat(64) });
			return { candidateTreeOid, reviewerProfileDigest: '5'.repeat(64), reviewInputDigest: '6'.repeat(64), reviewOutputDigest: createHash("sha256").update(JSON.stringify({ verdict: "proud", findings: [finding] })).digest("hex"), verdict: "proud", findings: [finding] };
		},
	});
	const run = await controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64));
	assert.equal(run.state, "failed-safely");
	assert.equal(run.finalTupleDigest, undefined);
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("an unproven child exit keeps the controller and lease durably fenced", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (_candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			throw new Error("process group absence could not be proven");
		},
		runReviewer: async () => { throw new Error("Reviewer must not run."); },
	});
	await assert.rejects(controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64)), /lease remains fenced/);
	assert.equal(controller.active(), true);
	assert.equal(controller.fenced(), true);
	const observed = await new DeliveryRunStore(commonRoot).read();
	assert.equal(observed?.state, "cancelling");
	assert.ok(observed?.child);
	if (observed?.candidateRoot) git(root, "worktree", "remove", "--force", observed.candidateRoot);
});

test("the controller rejects an unchanged writer candidate before review", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	let reviewed = false;
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (_candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { code: 0, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async () => { reviewed = true; throw new Error("Reviewer must not run."); },
	});
	const run = await controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64));
	assert.equal(run.state, "failed-safely");
	assert.equal(run.terminalReason, "unchanged-candidate");
	assert.equal(reviewed, false);
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("controller cancellation waits for the recorded writer exit before terminalizing", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	let writerStarted!: () => void;
	const started = new Promise<void>((resolve) => { writerStarted = resolve; });
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: "passed", exitCode: 0, durationMs: 1, outputSha256: '1'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid };
		},
		runWriter: async (_candidateRoot, _request, _repair, signal, onSpawn) => {
			await onSpawn?.(process.pid);
			writerStarted();
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { code: 130, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async () => { throw new Error("Reviewer must not run after cancellation."); },
	});
	const running = controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64));
	await started;
	await controller.cancel();
	const run = await running;
	assert.equal(run.state, "failed-safely");
	assert.equal(run.terminalReason, "cancelled");
	assert.equal(controller.active(), false);
	assert.equal(run.child, undefined);
	assert.ok(run.childExits.some((exit) => exit.role === "writer"));
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("the controller pre-counts one repair and stops a repeated failure safely", async () => {
	const root = await repository();
	const { commonRoot } = await resolveRepository(root);
	const policy: VerificationPolicy = { command: ["bash", "scripts/verify.sh"], closure: [], environmentDigest: 'e'.repeat(64), digest: 'f'.repeat(64) };
	let verificationCalls = 0;
	let writerCalls = 0;
	const controller = new ImplementationController({
		freezeVerificationPolicy: async () => policy,
		verifyCandidate: async (_root, candidate, frozen, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			verificationCalls += 1;
			const passed = verificationCalls === 1;
			return { candidateTreeOid: candidate.candidateTreeOid, policyDigest: frozen!.digest, status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1, durationMs: 1, outputSha256: passed ? '1'.repeat(64) : '9'.repeat(64), verifiedTreeOid: candidate.candidateTreeOid, ...(!passed ? { redactedFailureOutputTail: "same failure" } : {}) };
		},
		runWriter: async (candidateRoot, _request, _repair, _signal, onSpawn) => {
			await onSpawn?.(process.pid);
			writerCalls += 1;
			await writeFile(join(candidateRoot, "implemented.txt"), `attempt ${writerCalls}\n`);
			return { code: 0, timedOut: false, profileDigest: '2'.repeat(64), processOutputDigest: '3'.repeat(64) };
		},
		runReviewer: async () => { throw new Error("Reviewer must not run after failed verification."); },
	});

	const run = await controller.start(root, commonRoot, "Fix the approved test bug", '8'.repeat(64));

	assert.equal(run.state, "failed-safely");
	assert.equal(run.terminalReason, "repeated-failure");
	assert.equal(run.repairCount, 1);
	assert.equal(writerCalls, 2);
	assert.equal(run.invalidatedReceipts.length, 1);
	assert.equal(run.failureSignatures.length, 1);
	assert.equal(run.attempts.length, 2);
	assert.equal(run.attempts[0].verification?.status, "failed");
	assert.ok(run.attempts[0].invalidatedAt);
	if (run.candidateRoot) git(root, "worktree", "remove", "--force", run.candidateRoot);
});

test("candidate preparation captures staged, unstaged, untracked, deletion, and symlink state without changing the primary index", async () => {
	const root = await repository();
	await writeFile(join(root, "deleted.txt"), "delete me\n");
	git(root, "add", "deleted.txt"); git(root, "commit", "-qm", "add deletion fixture");
	await writeFile(join(root, "tracked.txt"), "staged\n");
	git(root, "add", "tracked.txt");
	await writeFile(join(root, "tracked.txt"), "working\n");
	await writeFile(join(root, "untracked.txt"), "new\n");
	await rm(join(root, "deleted.txt"));
	await symlink("tracked.txt", join(root, "linked.txt"));
	const hookMarker = join(root, "post-checkout-ran");
	const postCheckout = join(root, ".git", "hooks", "post-checkout");
	await writeFile(postCheckout, `#!/bin/sh\nprintf hook > ${JSON.stringify(hookMarker)}\n`);
	await chmod(postCheckout, 0o755);
	const before = execFileSync("git", ["-C", root, "status", "--porcelain=v2", "-z"], { encoding: "buffer" });
	const { commonRoot } = await resolveRepository(root);
	const stateRoot = join(commonRoot, "pi-delivery-test-state");
	await mkdir(stateRoot, { recursive: true });
	const workspace = new CandidateWorkspace(root, stateRoot, "capture");
	const prepared = await workspace.prepare();

	assert.equal(await readFile(join(prepared.candidateRoot, "tracked.txt"), "utf8"), "working\n");
	assert.equal(await readFile(join(prepared.candidateRoot, "untracked.txt"), "utf8"), "new\n");
	assert.equal(await readFile(join(prepared.candidateRoot, "linked.txt"), "utf8"), "working\n");
	await assert.rejects(readFile(join(prepared.candidateRoot, "deleted.txt")));
	const after = execFileSync("git", ["-C", root, "status", "--porcelain=v2", "-z"], { encoding: "buffer" });
	assert.deepEqual(after, before);
	await assert.rejects(readFile(hookMarker));
	await workspace.dispose();
});

test("configured Git content filters require and honor a human-reviewed snapshot exception", async () => {
	const root = await repository();
	git(root, "config", "filter.demo.clean", "cat");
	const { commonRoot } = await resolveRepository(root);
	const stateRoot = join(commonRoot, "pi-delivery-filter-state");
	await mkdir(stateRoot, { recursive: true });
	await assert.rejects(new CandidateWorkspace(root, stateRoot, "blocked").prepare(), /human-reviewed snapshot exception/);
	const workspace = new CandidateWorkspace(root, stateRoot, "approved", { allowConfiguredFilters: true });
	const prepared = await workspace.prepare();
	assert.equal(await readFile(join(prepared.candidateRoot, "tracked.txt"), "utf8"), "base\n");
	await workspace.dispose();
});

test("candidate preparation refuses credential-bearing project files", async () => {
	const root = await repository();
	await writeFile(join(root, ".env"), "TOKEN=secret\n");
	const { commonRoot } = await resolveRepository(root);
	const stateRoot = join(commonRoot, "pi-delivery-credential-state");
	await mkdir(stateRoot, { recursive: true });
	const workspace = new CandidateWorkspace(root, stateRoot, "credential");
	await assert.rejects(workspace.prepare(), /Credential-bearing/);
});

test("explicit verification passes the exact candidate and rejects verification-closure edits", async () => {
	const root = await repository();
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "tests"));
	await writeFile(join(root, ".gitignore"), "node_modules\ncoverage.tmp\n");
	await writeFile(join(root, "source.js"), "export const value = 1;\n");
	await writeFile(join(root, "tests", "source.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../source.js'; test('value',()=>assert.equal(value,1));\n");
	await writeFile(join(root, "scripts", "verify.sh"), "#!/usr/bin/env bash\nset -euo pipefail\nnode --test tests/*.test.js >/dev/null\nprintf 'ignored output\\n' > coverage.tmp\nif [[ -f fail.flag ]]; then printf 'Authorization: Bearer super-secret-token\\n'; exit 1; fi\nif [[ -f mutate.flag ]]; then printf 'side effect\\n' >> source.js; fi\n");
	await chmod(join(root, "scripts", "verify.sh"), 0o755);
	git(root, "add", "."); git(root, "commit", "-qm", "verification");
	const { commonRoot } = await resolveRepository(root);
	const stateRoot = join(commonRoot, "pi-delivery-test-state"); await mkdir(stateRoot, { recursive: true });
	const workspace = new CandidateWorkspace(root, stateRoot, "verify");
	const prepared = await workspace.prepare();
	const policy = await freezeVerificationPolicy(root, prepared.base.treeOid);
	assert.ok(policy);
	await writeFile(join(prepared.candidateRoot, "feature.txt"), "candidate\n");
	let candidate = await workspace.capture(prepared.base);
	assert.equal((await verifyCandidate(root, candidate, policy)).status, "passed");
	await writeFile(join(prepared.candidateRoot, "candidate.test.js"), "throw new Error('must not be silently skipped');\n");
	candidate = await workspace.capture(prepared.base);
	assert.equal((await verifyCandidate(root, candidate, policy)).status, "mutated");
	await rm(join(prepared.candidateRoot, "candidate.test.js"));
	await writeFile(join(prepared.candidateRoot, "jest.config.js"), "export default {};\n");
	candidate = await workspace.capture(prepared.base);
	assert.equal((await verifyCandidate(root, candidate, policy)).status, "mutated");
	await rm(join(prepared.candidateRoot, "jest.config.js"));
	await writeFile(join(prepared.candidateRoot, "fail.flag"), "trigger\n");
	candidate = await workspace.capture(prepared.base);
	const failed = await verifyCandidate(root, candidate, policy);
	assert.equal(failed.status, "failed");
	assert.doesNotMatch(failed.redactedFailureOutputTail ?? "", /super-secret-token/);
	assert.match(failed.redactedFailureOutputTail ?? "", /REDACTED/);
	await rm(join(prepared.candidateRoot, "fail.flag"));
	await writeFile(join(prepared.candidateRoot, "mutate.flag"), "trigger\n");
	candidate = await workspace.capture(prepared.base);
	const mutated = await verifyCandidate(root, candidate, policy);
	assert.equal(mutated.status, "mutated");
	assert.deepEqual(mutated.mutationPaths, ["source.js"]);
	await rm(join(prepared.candidateRoot, "mutate.flag"));
	await writeFile(join(prepared.candidateRoot, "scripts", "verify.sh"), "#!/bin/bash\nexit 0\n");
	candidate = await workspace.capture(prepared.base);
	assert.equal((await verifyCandidate(root, candidate, policy)).status, "mutated");
	await workspace.dispose();
});

test("the real role launcher keeps authority out of argv and uses a private removable packet", async () => {
	const root = await repository();
	const bin = join(root, "fake-bin");
	await mkdir(bin);
	const fakePi = join(bin, "pi");
	await writeFile(fakePi, `#!/usr/bin/env node\nconst fs=require('fs'); const path=require('path'); const args=process.argv.slice(2); if(args[0]==='--version'){console.log('fake-pi-1');process.exit(0)} fs.writeFileSync(path.join(process.cwd(),'.fake-args'),JSON.stringify(args)); const packet=args.find(x=>x.startsWith('@')).slice(1); fs.writeFileSync(path.join(process.cwd(),'.fake-packet'),fs.readFileSync(packet)); fs.writeFileSync(path.join(process.cwd(),'.fake-mode'),String(fs.statSync(packet).mode & 0o777));\n`);
	await chmod(fakePi, 0o755);
	const previous = { PATH: process.env.PATH, PI_PROVIDER: process.env.PI_PROVIDER, PI_MODEL: process.env.PI_MODEL, PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL };
	process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
	try {
		const authority = "Implement secret-but-authorized fixture behavior";
		const result = await runWriter(root, authority, undefined, undefined, undefined, undefined, { provider: "fake-provider", model: "fake-model", reasoning: "low" });
		assert.equal(result.code, 0);
		const args = await readFile(join(root, ".fake-args"), "utf8");
		assert.doesNotMatch(args, /secret-but-authorized/);
		assert.match(await readFile(join(root, ".fake-packet"), "utf8"), /secret-but-authorized/);
		assert.equal(await readFile(join(root, ".fake-mode"), "utf8"), String(0o600));
		assert.deepEqual((JSON.parse(args) as string[]).slice(0, 6), ["--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]);
		assert.ok((JSON.parse(args) as string[]).includes("fake-provider"));
		assert.ok((JSON.parse(args) as string[]).includes("fake-model"));
		assert.ok((JSON.parse(args) as string[]).includes("low"));
		const packetArgument = (JSON.parse(args) as string[]).find((value) => value.startsWith("@"));
		assert.ok(packetArgument);
		await assert.rejects(readFile(packetArgument!.slice(1)));
	} finally {
		if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
		for (const key of ["PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
	}
});

test("the explicit child guard confines the no-shell writer profile to its candidate", async () => {
	const root = await repository();
	const priorRoot = process.env.PI_DELIVERY_CANDIDATE_ROOT;
	const priorRole = process.env.PI_DELIVERY_ROLE;
	process.env.PI_DELIVERY_CANDIDATE_ROOT = root;
	process.env.PI_DELIVERY_ROLE = "writer";
	const handlers = new Map<string, (...args: any[]) => any>();
	try {
		roleGuard({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); }, registerTool() {} } as any);
		const call = handlers.get("tool_call");
		assert.deepEqual(await call?.({ toolName: "bash", input: { command: "true" } }), { block: true, reason: "Tool is outside the controller-owned role profile.", terminate: true });
		assert.equal((await call?.({ toolName: "write", input: { path: "../escape" } })).block, true);
		assert.equal(await call?.({ toolName: "write", input: { path: "new.txt" } }), undefined);
	} finally {
		if (priorRoot === undefined) delete process.env.PI_DELIVERY_CANDIDATE_ROOT; else process.env.PI_DELIVERY_CANDIDATE_ROOT = priorRoot;
		if (priorRole === undefined) delete process.env.PI_DELIVERY_ROLE; else process.env.PI_DELIVERY_ROLE = priorRole;
	}
});

test("the primary mutation barrier blocks edit calls and noninteractive implementation authority", async () => {
	const root = await repository();
	await writeFile(join(root, "readable.txt"), "safe\n");
	await writeFile(join(root, "large.txt"), "needle\n".repeat(12_000));
	const outside = await mkdtemp(join(tmpdir(), "pi-delivery-outside-"));
	roots.push(outside);
	await writeFile(join(outside, "secret.txt"), "secret\n");
	await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: string[] = [];
	let activeTools: string[] = [];
	const registered: any[] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(definition: any) { registered.push(definition); },
		sendMessage(message: { content: string }) { messages.push(message.content); },
		getAllTools() { return registered.map((tool) => ({ ...tool, sourceInfo: { source: "extension", path: join(process.cwd(), "extensions/implementation-lifecycle/index.ts") } })); },
		setActiveTools(names: string[]) { activeTools = names; },
	} as any;
	implementationLifecycle(pi);
	let aborted = false;
	let confirmations = 0;
	let confirmationText = "";
	const ctx = { cwd: root, mode: "rpc", sessionManager: { getBranch() { return [{ message: { role: "user", content: [{ type: "text", text: "Scope 6: modify engines/example/feature.ts and focused tests." }] } }]; } }, ui: { setStatus() {}, notify() {}, async confirm(_title: string, message: string) { confirmations += 1; confirmationText = message; return false; } }, abort() { aborted = true; } };
	const ambiguous = await handlers.get("input")?.({ text: "Could we maybe refactor this?", source: "interactive", streamingBehavior: undefined, images: [] }, { ...ctx, mode: "tui" });
	assert.equal(ambiguous.action, "continue");
	assert.match(messages.at(-1) ?? "", /exact bounded software and change you authorize/);
	const natural = await handlers.get("input")?.({ text: "Implement Scope 6 from the approved list", source: "interactive", streamingBehavior: undefined, images: [] }, { ...ctx, mode: "tui", hasUI: true });
	assert.equal(natural.action, "handled");
	assert.equal(confirmations, 1);
	assert.match(confirmationText, /engines\/example\/feature\.ts/);
	assert.match(messages.at(-1) ?? "", /Approval was declined/);
	const input = await handlers.get("input")?.({ text: "Fix the bug", source: "rpc", streamingBehavior: undefined, images: [] }, ctx);
	assert.equal(input.action, "handled");
	assert.match(messages.at(-1) ?? "", /only an idle, direct interactive TUI request/);
	await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.deepEqual(activeTools, ["trusted_delivery_read", "trusted_delivery_grep", "trusted_delivery_find", "trusted_delivery_ls", "implementation_start"]);
	const startTool = registered.find((tool) => tool.name === "implementation_start");
	const declined = await startTool.execute("start", { request: "Modify source.js" }, new AbortController().signal, undefined, { ...ctx, mode: "tui", hasUI: true });
	assert.match(declined.content[0].text, /Approval was declined/);
	const readTool = registered.find((tool) => tool.name === "trusted_delivery_read");
	assert.match((await readTool.execute("read", { path: "readable.txt" }, new AbortController().signal, undefined, ctx)).content[0].text, /safe/);
	await assert.rejects(readTool.execute("read", { path: "escape.txt" }, new AbortController().signal, undefined, ctx), /escapes/);
	const grepTool = registered.find((tool) => tool.name === "trusted_delivery_grep");
	const search = await grepTool.execute("grep", { pattern: "needle", path: "." }, new AbortController().signal, undefined, ctx);
	assert.equal(search.details.overflowed, true);
	assert.match(search.content[0].text, /truncated; refine/);
	const blocked = await handlers.get("tool_call")?.({ toolName: "edit", input: {}, toolCallId: "1" }, ctx);
	assert.equal(blocked.block, true);
	assert.equal(aborted, true);
});
