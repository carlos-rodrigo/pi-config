import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DeliveryRunV1, DeliveryState, TaskContextReceipt } from "./contracts.ts";
import { terminalState } from "./contracts.ts";

export class DeliveryLeaseError extends Error {}

const execFile = promisify(execFileCallback);
type LeaseRecord = { leaseNonce: string; runId: string; pid: number; processStart: string; root: string };

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function mergeReadyTupleDigest(run: DeliveryRunV1): string {
	return digest(JSON.stringify({
		authority: run.authority,
		taskContext: run.taskContext,
		changedPaths: run.changedPaths,
		base: run.base,
		candidate: run.candidate,
		verificationPolicy: run.verificationPolicy,
		baselineVerification: run.baselineVerification,
		primaryProfileDigest: run.primaryProfileDigest,
		writerReceipt: run.writerReceipts.at(-1),
		verification: run.verification,
		review: run.review,
		expectedReviewerProfileDigest: run.expectedReviewerProfileDigest,
		expectedReviewInputDigest: run.expectedReviewInputDigest,
		childExits: run.childExits,
		repairCount: run.repairCount,
		failureSignatures: run.failureSignatures,
		attempts: run.attempts,
	}));
}

function mergeReadyEvidenceValid(current: DeliveryRunV1): boolean {
	try {
	const writer = current.writerReceipts.at(-1);
	const attempt = current.attempts.at(-1);
	const sha256 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
	const expectedReviewOutputDigest = current.review ? digest(JSON.stringify({ verdict: current.review.verdict, findings: current.review.findings })) : undefined;
	return !current.pendingChild && !current.child
		&& Boolean(current.base && current.candidate && current.verificationPolicy && sha256(current.verificationPolicy.digest) && sha256(current.verificationPolicy.environmentDigest)
			&& current.candidate.base.treeOid === current.base.treeOid && current.candidate.base.headSha === current.base.headSha
			&& current.baselineVerification?.status === "passed"
			&& current.baselineVerification.candidateTreeOid === current.base.treeOid
			&& current.baselineVerification.verifiedTreeOid === current.base.treeOid
			&& current.baselineVerification.policyDigest === current.verificationPolicy.digest
			&& current.verification?.status === "passed" && current.verification.policyDigest === current.verificationPolicy.digest
			&& current.verification.verifiedTreeOid === current.candidate.candidateTreeOid && sha256(current.verification.outputSha256)
			&& current.review?.verdict === "proud" && current.review.findings.every((finding) => finding.severity === "optional")
			&& sha256(current.review.reviewerProfileDigest) && current.review.reviewerProfileDigest === current.expectedReviewerProfileDigest
			&& sha256(current.review.reviewInputDigest) && current.review.reviewInputDigest === current.expectedReviewInputDigest
			&& sha256(current.review.reviewOutputDigest) && current.review.reviewOutputDigest === expectedReviewOutputDigest
			&& attempt && !attempt.invalidatedAt && attempt.candidateTreeOid === current.candidate.candidateTreeOid
			&& attempt.verification?.candidateTreeOid === current.candidate.candidateTreeOid
			&& attempt.verification.policyDigest === current.verification.policyDigest
			&& attempt.verification.outputSha256 === current.verification.outputSha256
			&& attempt.review?.candidateTreeOid === current.candidate.candidateTreeOid
			&& attempt.review.reviewerProfileDigest === current.review.reviewerProfileDigest
			&& attempt.review.reviewInputDigest === current.review.reviewInputDigest
			&& attempt.review.reviewOutputDigest === current.review.reviewOutputDigest
			&& current.verification.candidateTreeOid === current.candidate.candidateTreeOid
			&& current.review.candidateTreeOid === current.candidate.candidateTreeOid
			&& writer?.candidateTreeOid === current.candidate.candidateTreeOid
			&& sha256(writer.profileDigest) && sha256(writer.processOutputDigest));
	} catch { return false; }
}

function validTaskContext(value: unknown): value is TaskContextReceipt {
	if (!value || typeof value !== "object") return false;
	const context = value as Partial<TaskContextReceipt>;
	return typeof context.task === "string" && typeof context.graphFingerprint === "string" && /^[a-f0-9]{64}$/i.test(context.graphFingerprint)
		&& Array.isArray(context.files) && context.files.every((file) => file && typeof file === "object"
			&& typeof file.path === "string" && Array.isArray(file.reasons) && file.reasons.every((item) => typeof item === "string")
			&& Array.isArray(file.imports) && file.imports.every((item) => typeof item === "string")
			&& Array.isArray(file.importedBy) && file.importedBy.every((item) => typeof item === "string")
			&& Array.isArray(file.tests) && file.tests.every((item) => typeof item === "string")
			&& Array.isArray(file.risks) && file.risks.every((item) => typeof item === "string"))
		&& Array.isArray(context.documentation) && context.documentation.every((item) => typeof item === "string")
		&& Array.isArray(context.notes) && context.notes.every((item) => typeof item === "string")
		&& typeof context.capturedAt === "string" && Number.isFinite(Date.parse(context.capturedAt));
}

function validLease(value: unknown): value is LeaseRecord {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<LeaseRecord>;
	return typeof lease.leaseNonce === "string" && typeof lease.runId === "string"
		&& Number.isInteger(lease.pid) && Number(lease.pid) > 1 && typeof lease.processStart === "string" && lease.processStart.trim().length > 0 && typeof lease.root === "string";
}

async function processStartToken(pid: number): Promise<string | undefined> {
	try {
		const result = await execFile("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", maxBuffer: 16_384, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
		return result.stdout.trim() || undefined;
	} catch { return undefined; }
}

async function ownerAlive(owner: LeaseRecord): Promise<boolean> {
	try { process.kill(owner.pid, 0); } catch { return false; }
	return await processStartToken(owner.pid) === owner.processStart;
}

export class DeliveryRunStore {
	readonly deliveryStateRoot: string;
	readonly leasePath: string;
	manifestPath: string;
	private run?: DeliveryRunV1;
	private owner?: LeaseRecord;
	private ownsLease = false;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(gitCommonDir: string) {
		this.deliveryStateRoot = join(gitCommonDir, "pi-delivery");
		this.leasePath = join(this.deliveryStateRoot, "lease.json");
		this.manifestPath = join(this.deliveryStateRoot, "unbound-manifest.json");
	}

	async acquire(repositoryRoot: string, request: string, primaryProfileDigest: string): Promise<DeliveryRunV1> {
		if (!/^[a-f0-9]{64}$/i.test(primaryProfileDigest)) throw new DeliveryLeaseError("The primary capability profile is malformed.");
		await mkdir(join(this.deliveryStateRoot, "runs"), { recursive: true, mode: 0o700 });
		const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
		const processStart = await processStartToken(process.pid);
		if (!processStart) throw new DeliveryLeaseError("The controller process identity cannot be proven.");
		const owner: LeaseRecord = { leaseNonce: randomUUID(), runId, pid: process.pid, processStart, root: repositoryRoot };
		const handle = await open(this.leasePath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") throw new DeliveryLeaseError("Another process acquired the delivery lease.");
			throw error;
		});
		this.owner = owner;
		this.ownsLease = true;
		this.manifestPath = join(this.deliveryStateRoot, "runs", runId, "manifest.json");
		try {
			await handle.writeFile(`${JSON.stringify(owner)}\n`);
			await handle.close();
			await mkdir(dirname(this.manifestPath), { recursive: false, mode: 0o700 });
			const now = new Date().toISOString();
			this.run = {
				schemaVersion: 1,
				runId,
				root: repositoryRoot,
				state: "authorizing",
				authority: { requestId: randomUUID(), source: "interactive", request, requestDigest: digest(request) },
				changedPaths: [],
				primaryProfileDigest,
				repairCount: 0,
				invalidatedReceipts: [],
				failureSignatures: [],
				writerReceipts: [],
				attempts: [],
				childExits: [],
				createdAt: now,
				updatedAt: now,
			};
			await this.persist();
			return structuredClone(this.run);
		} catch (error) {
			await handle.close().catch(() => undefined);
			await this.removeOwnedLease().catch(() => undefined);
			throw error;
		}
	}

	async read(): Promise<DeliveryRunV1 | undefined> {
		let leaseText: string;
		try { leaseText = await readFile(this.leasePath, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new DeliveryLeaseError("The delivery lease cannot be read safely.");
		}
		let leaseValue: unknown;
		try { leaseValue = JSON.parse(leaseText); } catch { throw new DeliveryLeaseError("The delivery lease is corrupt."); }
		if (!validLease(leaseValue)) throw new DeliveryLeaseError("The delivery lease is malformed.");
		this.owner = leaseValue;
		this.ownsLease = false;
		this.manifestPath = join(this.deliveryStateRoot, "runs", leaseValue.runId, "manifest.json");
		let parsed: DeliveryRunV1;
		try { parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as DeliveryRunV1; }
		catch { throw new DeliveryLeaseError("The active delivery manifest is missing or corrupt."); }
		const validStates = new Set<DeliveryState>(["authorizing", "preparing-candidate", "writing", "verifying", "reviewing", "repairing", "cancelling", "merge-ready", "decision-required", "failed-safely"]);
		const validPendingChild = !parsed.pendingChild || (["writer", "repair", "verifier", "reviewer"].includes(parsed.pendingChild.role)
			&& typeof parsed.pendingChild.readyPath === "string" && dirname(resolve(parsed.pendingChild.readyPath)) === resolve(tmpdir())
			&& /^pi-delivery-ready-[a-zA-Z0-9-]+$/.test(basename(parsed.pendingChild.readyPath))
			&& typeof parsed.pendingChild.preparedAt === "string" && Number.isFinite(Date.parse(parsed.pendingChild.preparedAt)));
		const validChild = !parsed.child || (["writer", "repair", "verifier", "reviewer"].includes(parsed.child.role)
			&& Number.isInteger(parsed.child.pid) && parsed.child.pid > 1 && typeof parsed.child.processStart === "string" && parsed.child.processStart.trim().length > 0);
		const arraysValid = Array.isArray(parsed.invalidatedReceipts) && Array.isArray(parsed.failureSignatures)
			&& (parsed.changedPaths === undefined || Array.isArray(parsed.changedPaths))
			&& Array.isArray(parsed.writerReceipts) && Array.isArray(parsed.attempts) && Array.isArray(parsed.childExits);
		const validTerminal = parsed.state === "merge-ready"
			? arraysValid && parsed.terminalReason === "verified-proud" && typeof parsed.finalTupleDigest === "string"
				&& parsed.finalTupleDigest === mergeReadyTupleDigest(parsed) && mergeReadyEvidenceValid(parsed)
			: !terminalState(parsed.state) || !parsed.pendingChild && !parsed.child;
		if (parsed.schemaVersion !== 1 || parsed.runId !== leaseValue.runId || parsed.root !== leaseValue.root
			|| !validStates.has(parsed.state) || !Number.isInteger(parsed.repairCount) || parsed.repairCount < 0 || parsed.repairCount > 2
			|| !parsed.authority || parsed.authority.source !== "interactive" || typeof parsed.authority.requestDigest !== "string"
			|| !/^[a-f0-9]{64}$/i.test(parsed.primaryProfileDigest) || (parsed.taskContext !== undefined && !validTaskContext(parsed.taskContext))
			|| !validPendingChild || !validChild || !validTerminal || !arraysValid) {
			throw new DeliveryLeaseError("The active delivery manifest does not match its lease.");
		}
		this.run = parsed;
		return structuredClone(parsed);
	}

	async adoptForRecovery(): Promise<boolean> {
		if (!this.owner || !this.run || this.ownsLease) return this.ownsLease;
		if (await ownerAlive(this.owner)) return false;
		const recoveryLock = join(this.deliveryStateRoot, "recovery.lock");
		const recoveryProcessStart = await processStartToken(process.pid);
		if (!recoveryProcessStart) throw new DeliveryLeaseError("The recovery process identity cannot be proven.");
		const lock = await open(recoveryLock, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") return undefined;
			throw error;
		});
		if (!lock) return false;
		try {
			await lock.writeFile(`${JSON.stringify({ pid: process.pid, processStart: recoveryProcessStart })}\n`);
			const current = JSON.parse(await readFile(this.leasePath, "utf8")) as unknown;
			if (!validLease(current) || current.leaseNonce !== this.owner.leaseNonce || await ownerAlive(current)) return false;
			const adopted: LeaseRecord = { ...current, leaseNonce: randomUUID(), pid: process.pid, processStart: recoveryProcessStart };
			const temporary = join(this.deliveryStateRoot, `.lease-${process.pid}-${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(adopted)}\n`, { mode: 0o600 });
			await rename(temporary, this.leasePath);
			this.owner = adopted;
			this.ownsLease = true;
			return true;
		} finally {
			await lock.close();
			await rm(recoveryLock, { force: true });
		}
	}

	current(): DeliveryRunV1 {
		if (!this.run) throw new Error("No delivery run is loaded.");
		return this.run;
	}

	async update(change: Partial<DeliveryRunV1> & { state?: DeliveryState }): Promise<DeliveryRunV1> {
		let result: DeliveryRunV1 | undefined;
		const operation = this.writeQueue.then(async () => {
			await this.assertOwnership();
			this.run = { ...this.current(), ...structuredClone(change), updatedAt: new Date().toISOString() };
			await this.persist();
			result = structuredClone(this.run);
		});
		this.writeQueue = operation.catch(() => undefined);
		await operation;
		return result!;
	}

	async releaseAdoptedTerminal(): Promise<void> {
		if (!terminalState(this.current().state)) throw new DeliveryLeaseError("Only a terminal run can release a recovered lease.");
		await this.removeOwnedLease();
	}

	async markMergeReady(tupleDigest: string): Promise<DeliveryRunV1> {
		const current = this.current();
		if (!/^[a-f0-9]{64}$/i.test(tupleDigest) || tupleDigest !== mergeReadyTupleDigest(current)
			|| current.state !== "reviewing" || current.cancelRequestedAt || !mergeReadyEvidenceValid(current)) {
			throw new DeliveryLeaseError("The immutable completion tuple is not eligible for MERGE READY.");
		}
		const run = await this.update({ state: "merge-ready", terminalReason: "verified-proud", finalTupleDigest: tupleDigest, child: undefined });
		await this.removeOwnedLease();
		return run;
	}

	async terminal(state: Extract<DeliveryState, "decision-required" | "failed-safely">, reason: string): Promise<DeliveryRunV1> {
		if (this.current().pendingChild || this.current().child) throw new DeliveryLeaseError("A run cannot become terminal before its pending launch and recorded child exit are proven.");
		const run = await this.update({ state, terminalReason: reason, child: undefined });
		await this.removeOwnedLease();
		return run;
	}

	private async assertOwnership(): Promise<void> {
		if (!this.ownsLease || !this.owner) throw new DeliveryLeaseError("This process does not own the delivery lease.");
		let current: unknown;
		try { current = JSON.parse(await readFile(this.leasePath, "utf8")); } catch { throw new DeliveryLeaseError("Delivery lease ownership was lost."); }
		if (!validLease(current) || current.leaseNonce !== this.owner.leaseNonce || current.runId !== this.owner.runId || current.pid !== this.owner.pid || current.processStart !== this.owner.processStart) {
			throw new DeliveryLeaseError("Delivery lease ownership was lost.");
		}
	}

	private async removeOwnedLease(): Promise<void> {
		await this.assertOwnership();
		await rm(this.leasePath, { force: true });
		this.ownsLease = false;
	}

	private async persist(): Promise<void> {
		const temporary = join(dirname(this.manifestPath), `.manifest-${process.pid}-${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(this.current(), null, 2)}\n`, { mode: 0o600 });
		await this.assertOwnership();
		await rename(temporary, this.manifestPath);
	}
}
