import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DeliveryRunV1, ReviewReceipt, TaskContextReceipt, VerificationReceipt } from "./contracts.ts";
import { taskContextGraph, type TaskContextGraphReport } from "../code-intel/index.ts";
import { DeliveryRunStore, mergeReadyTupleDigest } from "./store.ts";
import { CandidateWorkspace, SnapshotReviewRequiredError, captureSnapshot } from "./workspace.ts";
import { freezeVerificationPolicy, verifyCandidate } from "./verifier.ts";
import { runReviewer, runWriter } from "./roles.ts";
import { runProcess, scrubbedEnvironment } from "./process.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PROTECTED_PATH = /(^|\/)(?:\.github\/workflows|infra|infrastructure|migrations?|schema|auth|payments?|privacy)(\/|$)|(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const HUMAN_REVIEWED_SNAPSHOT_EXCEPTION = /\bhuman[- ]reviewed snapshot exception\b/i;

export type ControllerUpdate = (run: DeliveryRunV1) => void;

type ControllerDependencies = {
	freezeVerificationPolicy: typeof freezeVerificationPolicy;
	verifyCandidate: typeof verifyCandidate;
	runWriter: typeof runWriter;
	runReviewer: typeof runReviewer;
	taskContextGraph: typeof taskContextGraph;
};

const defaultDependencies: ControllerDependencies = { freezeVerificationPolicy, verifyCandidate, runWriter, runReviewer, taskContextGraph };

function taskContextReceipt(report: TaskContextGraphReport): TaskContextReceipt {
	return {
		task: report.task,
		graphFingerprint: report.graph.fingerprint,
		files: report.files.map((file) => ({
			path: file.path,
			reasons: file.reasons,
			imports: file.imports,
			importedBy: file.importedBy,
			tests: file.tests,
			risks: file.risks,
		})),
		documentation: report.documentation.flatMap((result) => result.path ? [result.path] : []),
		notes: report.notes,
		capturedAt: new Date().toISOString(),
	};
}

function taskContextPrompt(request: string, context: TaskContextReceipt | undefined): string {
	if (!context) return request;
	return `${request}\n\nRead-only task context captured before implementation:\n${JSON.stringify(context, null, 2)}\nUse it as navigation guidance, then inspect the candidate files before editing.`;
}

export class ImplementationController {
	private abortController?: AbortController;
	private store?: DeliveryRunStore;
	private workspace?: CandidateWorkspace;
	private settled?: Promise<void>;
	private resolveSettled?: () => void;
	private committing = false;
	private fencedUnresolved = false;
	private readonly dependencies: ControllerDependencies;

	constructor(dependencies: Partial<ControllerDependencies> = {}) {
		this.dependencies = { ...defaultDependencies, ...dependencies };
	}

	active(): boolean { return Boolean(this.abortController) || this.fencedUnresolved; }
	fenced(): boolean { return this.fencedUnresolved; }

	async cancel(): Promise<boolean> {
		if (!this.abortController || !this.store || this.committing) return false;
		this.abortController.abort();
		await this.store.update({ state: "cancelling", cancelRequestedAt: new Date().toISOString() }).catch(() => undefined);
		await this.settled;
		return true;
	}

	async start(root: string, commonRoot: string, request: string, primaryProfileDigest: string, update: ControllerUpdate = () => undefined): Promise<DeliveryRunV1> {
		if (this.active()) throw new Error("An implementation delivery is already active in this session.");
		this.fencedUnresolved = false;
		this.abortController = new AbortController();
		this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });
		this.store = new DeliveryRunStore(commonRoot);
		let run: DeliveryRunV1;
		let acquired = false;
		try {
			run = await this.store.acquire(root, request, primaryProfileDigest);
			acquired = true;
			update(run);
			if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
			this.workspace = new CandidateWorkspace(root, this.store.deliveryStateRoot, run.runId, { allowConfiguredFilters: HUMAN_REVIEWED_SNAPSHOT_EXCEPTION.test(request) });
			const signatures = new Set<string>(run.failureSignatures);
			const taskContext = await this.dependencies.taskContextGraph(root, { task: request, limit: 12, signal: this.abortController.signal });
			run = await this.store.update({ taskContext: taskContextReceipt(taskContext) }); update(run);
			let repairEvidence: string | undefined;
			let previousCandidateTree: string | undefined;
			run = await this.store.update({ state: "preparing-candidate" }); update(run);
			const prepared = await this.workspace.prepare();
			const policy = await this.dependencies.freezeVerificationPolicy(root, prepared.base.treeOid);
			run = await this.store.update({ base: prepared.base, candidateRoot: prepared.candidateRoot, verificationPolicy: policy }); update(run);
			if (!policy) {
				await this.workspace.dispose();
				await this.store.update({ candidateRoot: undefined });
				return await this.finish("decision-required", "verification-missing", update);
			}
			const baselineCandidate = { base: prepared.base, candidateTreeOid: prepared.base.treeOid, diffSha256: sha("") };
			run = await this.store.update({ state: "verifying" }); update(run);
			const baselineVerification = await this.dependencies.verifyCandidate(root, baselineCandidate, policy, this.abortController.signal, (pid) => this.checkpointChild("verifier", pid, update), (readyPath) => this.prepareChild("verifier", readyPath, update));
			await this.recordChildExit("verifier", baselineVerification.exitCode ?? (baselineVerification.status === "passed" ? 0 : 1), baselineVerification.status === "timeout", update);
			if (this.abortController.signal.aborted) {
				await this.workspace.dispose();
				await this.store.update({ candidateRoot: undefined });
				return await this.finish("failed-safely", "cancelled", update);
			}
			run = await this.store.update({ baselineVerification }); update(run);
			if (baselineVerification.status !== "passed") {
				await this.workspace.dispose();
				await this.store.update({ candidateRoot: undefined });
				return await this.finish("failed-safely", `baseline-verification-${baselineVerification.status}`, update);
			}

			for (let attempt = 0; attempt <= 2; attempt += 1) {
				const role = attempt === 0 ? "writer" : "repair";
				run = await this.store.update({ state: attempt === 0 ? "writing" : "repairing", child: undefined }); update(run);
				const writerRequest = taskContextPrompt(request, this.store.current().taskContext);
				const writer = await this.dependencies.runWriter(prepared.candidateRoot, writerRequest, repairEvidence, this.abortController.signal, (pid) => this.checkpointChild(role, pid, update), (readyPath) => this.prepareChild(role, readyPath, update));
				await this.recordChildExit(role, writer.code, writer.timedOut, update);
				if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
				if (writer.code !== 0 || writer.timedOut) return await this.finish("failed-safely", writer.timedOut ? "writer-timeout" : "writer-failed", update);
				const candidate = await this.workspace.capture(prepared.base);
				if (attempt === 0 && candidate.candidateTreeOid === prepared.base.treeOid) return await this.finish("failed-safely", "unchanged-candidate", update);
				if (attempt > 0 && previousCandidateTree === candidate.candidateTreeOid) return await this.finish("failed-safely", "unchanged-candidate", update);
				await this.recordWriterReceipt(attempt, role, candidate.candidateTreeOid, writer);
				const changedPaths = await this.workspace.changedPaths(prepared.base.treeOid, candidate.candidateTreeOid);
				run = await this.store.update({ candidate, changedPaths }); update(run);
				if (changedPaths.some((path) => PROTECTED_PATH.test(path))) {
					run = await this.store.update({ candidate }); update(run);
					return await this.finish("decision-required", "protected-path-change", update);
				}
				run = await this.store.update({ state: "verifying", candidate, verification: undefined, review: undefined, child: undefined }); update(run);
				const verification = await this.dependencies.verifyCandidate(root, candidate, policy, this.abortController.signal, (pid) => this.checkpointChild("verifier", pid, update), (readyPath) => this.prepareChild("verifier", readyPath, update));
				await this.recordChildExit("verifier", verification.exitCode ?? (verification.status === "passed" ? 0 : 1), verification.status === "timeout", update);
				if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
				run = await this.store.update({
					verification,
					attempts: this.store.current().attempts.map((record) => record.attempt === attempt ? { ...record, verification } : record),
				}); update(run);
				if (verification.status !== "passed") {
					if (verification.status !== "failed") return await this.finish("failed-safely", `verification-${verification.status}`, update);
					const signature = sha(JSON.stringify({ status: verification.status, output: verification.outputSha256, environment: policy.environmentDigest }));
					if (signatures.has(signature)) return await this.finish("failed-safely", "repeated-failure", update);
					if (attempt >= 2) return await this.finish("failed-safely", "repair-budget-exhausted", update);
					signatures.add(signature);
					repairEvidence = `Frozen verification failed (signature ${signature}). Repair the implementation, not verification policy.\n${verification.redactedFailureOutputTail ?? "No bounded verifier output was available."}`;
					await this.invalidate(candidate.candidateTreeOid, attempt + 1, signature);
					previousCandidateTree = candidate.candidateTreeOid;
					continue;
				}

				run = await this.store.update({ state: "reviewing" }); update(run);
				const diff = await this.workspace.diff(prepared.base.treeOid, candidate.candidateTreeOid);
				const reviewControllerEvidence = {
					authority: this.store.current().authority,
					taskContext: this.store.current().taskContext,
					changedPaths: this.store.current().changedPaths,
					base: prepared.base,
					candidate,
					verificationPolicy: policy,
					baselineVerification: this.store.current().baselineVerification,
					primaryProfileDigest: this.store.current().primaryProfileDigest,
					writerReceipt: this.store.current().writerReceipts.at(-1),
				};
				let review: ReviewReceipt;
				try {
					review = await this.dependencies.runReviewer(
						prepared.candidateRoot,
						this.store.deliveryStateRoot,
						candidate.candidateTreeOid,
						request,
						diff,
						verification,
						reviewControllerEvidence,
						this.abortController.signal,
						(pid) => this.checkpointChild("reviewer", pid, update),
						(result) => this.recordChildExit("reviewer", result.code, result.timedOut, update),
						async ({ reviewerProfileDigest, reviewInputDigest }) => {
							const evidenceRun = await this.store!.update({ expectedReviewerProfileDigest: reviewerProfileDigest, expectedReviewInputDigest: reviewInputDigest });
							update(evidenceRun);
						},
						(readyPath) => this.prepareChild("reviewer", readyPath, update),
					);
				} catch {
					return await this.finish("failed-safely", "reviewer-failed-or-malformed", update);
				}
				run = await this.store.update({
					review,
					child: undefined,
					attempts: this.store.current().attempts.map((record) => record.attempt === attempt ? { ...record, review } : record),
				}); update(run);
				if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
				if (review.verdict === "proud") {
					const original = await captureSnapshot(root, this.store.deliveryStateRoot, `final-${run.runId}`);
					const finalCandidate = await this.workspace.capture(prepared.base);
					const writerReceipt = this.store.current().writerReceipts.at(-1);
					if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
					if (JSON.stringify(original) !== JSON.stringify(prepared.base)
						|| this.store.current().primaryProfileDigest !== primaryProfileDigest
						|| finalCandidate.candidateTreeOid !== candidate.candidateTreeOid
						|| writerReceipt?.candidateTreeOid !== candidate.candidateTreeOid
						|| !/^[a-f0-9]{64}$/i.test(writerReceipt.profileDigest)
						|| !/^[a-f0-9]{64}$/i.test(writerReceipt.processOutputDigest)) {
						return await this.finish("failed-safely", "stale-base-or-candidate", update);
					}
					this.committing = true;
					return await this.finish("merge-ready", "verified-proud", update);
				}
				const blocking = review.findings.filter((finding) => finding.severity !== "optional");
				const signature = sha(JSON.stringify(blocking.map(({ severity, code, summary }) => ({ severity, code, summary }))));
				if (blocking.length > 0 && highRiskRequest(JSON.stringify(blocking))) {
					return await this.finish("decision-required", "review-repair-crosses-protected-authority", update);
				}
				if (blocking.length > 0) {
					if (signatures.has(signature)) return await this.finish("failed-safely", "repeated-failure", update);
					if (attempt >= 2) return await this.finish("failed-safely", "repair-budget-exhausted", update);
					signatures.add(signature);
					repairEvidence = JSON.stringify(blocking);
					await this.invalidate(candidate.candidateTreeOid, attempt + 1, signature);
					previousCandidateTree = candidate.candidateTreeOid;
					continue;
				}
				return await this.finish("decision-required", "review-not-proud", update);
			}
			return await this.finish("failed-safely", "repair-budget-exhausted", update);
		} catch (error) {
			if (!acquired) throw error;
			if (error instanceof SnapshotReviewRequiredError) return await this.finish("decision-required", "snapshot-human-review-required", update);
			const activeChild = this.store.current().child;
			const pendingChild = this.store.current().pendingChild;
			if (activeChild || pendingChild) {
				this.fencedUnresolved = true;
				const blocked = await this.store.update({ state: "cancelling" });
				update(blocked);
				throw new Error("The recorded child process group has no proven exit; the lease remains fenced for recovery.", { cause: error });
			}
			if (this.abortController.signal.aborted) return await this.finish("failed-safely", "cancelled", update);
			return await this.finish("failed-safely", `infrastructure-failure:${error instanceof Error ? error.message : String(error)}`, update);
		} finally {
			this.abortController = undefined;
			this.committing = false;
			this.resolveSettled?.();
			this.resolveSettled = undefined;
			this.settled = undefined;
		}
	}

	private async prepareChild(role: "writer" | "repair" | "verifier" | "reviewer", readyPath: string, update: ControllerUpdate): Promise<void> {
		const pendingRun = await this.store!.update({ pendingChild: { role, readyPath, preparedAt: new Date().toISOString() } });
		update(pendingRun);
	}

	private async checkpointChild(role: "writer" | "repair" | "verifier" | "reviewer", pid: number, update: ControllerUpdate): Promise<void> {
		const identity = await runProcess("ps", ["-p", String(pid), "-o", "lstart="], { cwd: this.store!.current().root, env: scrubbedEnvironment({ LC_ALL: "C", LANG: "C" }), timeoutMs: 5_000, maxOutputBytes: 16_384 });
		const processStart = identity.stdout.trim();
		if (identity.code !== 0 || identity.overflowed || !processStart) throw new Error("The child process identity could not be proven before release.");
		const readyPath = this.store!.current().pendingChild?.readyPath;
		const childRun = await this.store!.update({ pendingChild: undefined, child: { role, pid, processStart, startedAt: new Date().toISOString() } });
		if (readyPath) await rm(readyPath, { force: true });
		update(childRun);
	}

	private async recordWriterReceipt(
		attempt: number,
		role: "writer" | "repair",
		candidateTreeOid: string,
		result: { profileDigest: string; processOutputDigest: string; code: number; timedOut: boolean },
	): Promise<void> {
		if (!/^[a-f0-9]{64}$/i.test(result.profileDigest) || !/^[a-f0-9]{64}$/i.test(result.processOutputDigest)) throw new Error("Writer capability evidence is malformed.");
		const current = this.store!.current();
		await this.store!.update({
			writerReceipts: [...current.writerReceipts, { attempt, role, candidateTreeOid, profileDigest: result.profileDigest, processOutputDigest: result.processOutputDigest, exitCode: result.code, timedOut: result.timedOut }],
			attempts: [...current.attempts, {
				attempt,
				candidateTreeOid,
				writerProfileDigest: result.profileDigest,
				writerProcessOutputDigest: result.processOutputDigest,
			}],
		});
	}

	private async recordChildExit(role: "writer" | "repair" | "verifier" | "reviewer", exitCode: number, timedOut: boolean, update: ControllerUpdate): Promise<void> {
		const current = this.store!.current();
		const run = await this.store!.update({
			pendingChild: undefined,
			child: undefined,
			childExits: [...current.childExits, { role, observedAt: new Date().toISOString(), exitCode, timedOut }],
		});
		update(run);
	}

	private async invalidate(candidateTreeOid: string, repairCount: number, failureSignature: string): Promise<void> {
		const current = this.store!.current();
		const invalidatedAt = new Date().toISOString();
		await this.store!.update({
			repairCount,
			verification: undefined,
			review: undefined,
			attempts: current.attempts.map((record) => record.candidateTreeOid === candidateTreeOid && !record.invalidatedAt ? { ...record, invalidatedAt } : record),
			invalidatedReceipts: [...current.invalidatedReceipts, { candidateTreeOid, at: invalidatedAt }],
			failureSignatures: [...new Set([...current.failureSignatures, failureSignature])],
		});
	}

	private async finish(state: "merge-ready" | "decision-required" | "failed-safely", reason: string, update: ControllerUpdate): Promise<DeliveryRunV1> {
		if (state === "merge-ready") {
			const current = this.store!.current();
			const writerRole = current.repairCount > 0 ? "repair" : "writer";
			const finalExit = (role: "writer" | "repair" | "verifier" | "reviewer") => [...current.childExits].reverse().find((exit) => exit.role === role);
			const exits = [finalExit(writerRole), finalExit("verifier"), finalExit("reviewer")];
			if (current.child || exits.some((exit) => !exit || exit.exitCode !== 0 || exit.timedOut || exit.recovery)) {
				return await this.finish("failed-safely", "incomplete-child-exit-evidence", update);
			}
			const tupleDigest = mergeReadyTupleDigest(current);
			const run = await this.store!.markMergeReady(tupleDigest);
			update(run);
			return run;
		}
		const run = await this.store!.terminal(state, reason);
		update(run);
		return run;
	}
}

export function highRiskRequest(text: string): boolean {
	return /\b(auth(?:entication|orization)?|payment|billing|privacy|secret|credential|production|deploy|infrastructure|migration|schema|public api|delete data|destructive)\b/i.test(text);
}

export function classifyImplementationIntent(text: string): "implementation" | "ambiguous" | "read-only" {
	const normalized = text.trim();
	if (!normalized || normalized.startsWith("/") || /^(?:why|what|where|when|who|how)\b/i.test(normalized)
		|| /\b(?:do not|don't|without)\s+(?:implement|fix|refactor|edit|write|code|create|add|update|change|build|modify|remove|delete|rename)\b/i.test(normalized)) return "read-only";
	const destructiveMutation = /\b(?:remove|delete|rename)\b/i.test(normalized);
	const strongMutation = /\b(?:implement|fix|refactor|edit|write)\b/i.test(normalized) || /^code\b/i.test(normalized);
	const weakMutation = /\b(?:create|add|update|change|build|modify)\b/i.test(normalized);
	const softwareObject = /\b(?:bug|code|file|test|feature|function|class|component|module|service|endpoint|api|ui|page|docs?|readme|config(?:uration)?|dependency|schema|migration|script|logging|behavior)\b|(?:^|\s)[\w./-]+\.[a-z0-9]{1,8}\b|(?:^|[\s`'\"(])[\w.-]+\/[\w./-]*/i.test(normalized);
	const asksForMutation = strongMutation || weakMutation || destructiveMutation;
	if (asksForMutation) {
		if (destructiveMutation) return "ambiguous";
		if (!softwareObject || /\b(?:maybe|perhaps|could we|should we|idea)\b/i.test(normalized)) return "ambiguous";
		return "implementation";
	}
	if (/^(?:why|what|where|when|who|how)\b/i.test(normalized)
		|| /\b(?:review|analy[sz]e|inspect|explain|summari[sz]e|find|search|read)\b/i.test(normalized)) return "read-only";
	return "read-only";
}

export function formatAmbiguousImplementationRequest(text: string): string {
	const normalized = text.trim();
	const reason = !normalized
		? "The request was empty."
		: /\b(?:remove|delete|rename)\b/i.test(normalized)
			? "Delete and rename operations require a separate human-controlled workflow."
			: "The request does not identify one concrete software surface and authorized change."
	return `${reason} I did not start implementation. State the exact bounded software and change you authorize (for example, \"Modify only extensions/implementation-lifecycle/controller.ts to improve request classification; edit and test that directory, but do not commit or push\"), or ask for read-only analysis.`;
}
