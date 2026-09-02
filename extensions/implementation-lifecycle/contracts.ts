export type DeliveryState =
	| "authorizing"
	| "preparing-candidate"
	| "writing"
	| "verifying"
	| "reviewing"
	| "repairing"
	| "cancelling"
	| "merge-ready"
	| "decision-required"
	| "failed-safely";

export type SnapshotIdentity = {
	headSha: string;
	treeOid: string;
	statusDigest: string;
};

export type CandidateIdentity = {
	base: SnapshotIdentity;
	candidateTreeOid: string;
	diffSha256: string;
};

export type VerificationPolicy = {
	command: ["bash", "scripts/verify.sh"];
	closure: Array<{ path: string; mode: string; blobOid: string }>;
	environmentDigest: string;
	digest: string;
};

export type VerificationReceipt = {
	candidateTreeOid: string;
	policyDigest: string;
	status: "passed" | "failed" | "missing" | "timeout" | "mutated";
	exitCode?: number;
	durationMs: number;
	outputSha256: string;
	redactedFailureOutputTail?: string;
	mutationPaths?: string[];
	verifiedTreeOid?: string;
};

export type ReviewFinding = {
	severity: "must-fix" | "should-fix" | "optional";
	code: "correctness" | "simplicity" | "maintainability" | "tests" | "specification";
	summary: string;
	evidence: string;
};

export type ReviewReceipt = {
	candidateTreeOid: string;
	reviewerProfileDigest: string;
	reviewInputDigest: string;
	reviewOutputDigest: string;
	verdict: "proud" | "needs-attention";
	findings: ReviewFinding[];
};

export type TaskContextReceipt = {
	task: string;
	graphFingerprint: string;
	files: Array<{
		path: string;
		reasons: string[];
		imports: string[];
		importedBy: string[];
		tests: string[];
		risks: string[];
	}>;
	documentation: string[];
	notes: string[];
	capturedAt: string;
};

export type DeliveryAttemptRecord = {
	attempt: number;
	candidateTreeOid: string;
	writerProfileDigest: string;
	writerProcessOutputDigest: string;
	verification?: VerificationReceipt;
	review?: ReviewReceipt;
	invalidatedAt?: string;
};

export type DeliveryRunV1 = {
	schemaVersion: 1;
	runId: string;
	root: string;
	state: DeliveryState;
	authority: { requestId: string; source: "interactive"; request: string; requestDigest: string };
	taskContext?: TaskContextReceipt;
	changedPaths?: string[];
	primaryProfileDigest: string;
	base?: SnapshotIdentity;
	candidate?: CandidateIdentity;
	candidateRoot?: string;
	verificationPolicy?: VerificationPolicy;
	baselineVerification?: VerificationReceipt;
	verification?: VerificationReceipt;
	review?: ReviewReceipt;
	expectedReviewerProfileDigest?: string;
	expectedReviewInputDigest?: string;
	finalTupleDigest?: string;
	repairCount: number;
	invalidatedReceipts: Array<{ candidateTreeOid: string; at: string }>;
	failureSignatures: string[];
	writerReceipts: Array<{ attempt: number; role: "writer" | "repair"; candidateTreeOid: string; profileDigest: string; processOutputDigest: string; exitCode: number; timedOut: boolean }>;
	attempts: DeliveryAttemptRecord[];
	pendingChild?: { role: "writer" | "repair" | "verifier" | "reviewer"; readyPath: string; preparedAt: string };
	child?: { role: "writer" | "repair" | "verifier" | "reviewer"; pid: number; processStart: string; startedAt: string };
	childExits: Array<{ role: "writer" | "repair" | "verifier" | "reviewer"; observedAt: string; exitCode?: number; timedOut: boolean; recovery?: boolean }>;
	cancelRequestedAt?: string;
	terminalReason?: string;
	createdAt: string;
	updatedAt: string;
};

export function terminalState(state: DeliveryState): boolean {
	return state === "merge-ready" || state === "decision-required" || state === "failed-safely";
}
