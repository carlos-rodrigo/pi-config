import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImplementationController, classifyImplementationIntent, formatAmbiguousImplementationRequest, highRiskRequest } from "./controller.ts";
import { terminalState } from "./contracts.ts";
import { DeliveryRunStore } from "./store.ts";
import { resolveRepository } from "./workspace.ts";
import { PRIMARY_READ_ONLY_TOOLS, primaryProfileDigest, registerPrimaryReadOnlyTools } from "./primary-tools.ts";
import { runProcess, scrubbedEnvironment } from "./process.ts";

const READ_ONLY_TOOLS = new Set<string>(PRIMARY_READ_ONLY_TOOLS);
const IMPLEMENTATION_START_TOOL = "implementation_start";
const CANCEL = /^(?:cancel|stop|abort)(?:\s+(?:the\s+)?implementation|\s+delivery)?[.!]?$/i;
const CONTROLLER_EXTENSION_PATH = resolve(fileURLToPath(import.meta.url));

function processGroupState(pid: number): "present" | "absent" | "unknown" {
	try { process.kill(-pid, 0); return "present"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
}

async function stopRecordedProcessGroup(pid: number): Promise<boolean> {
	try { process.kill(-pid, "SIGTERM"); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	for (let index = 0; index < 20; index += 1) {
		if (processGroupState(pid) === "absent") return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	try { process.kill(-pid, "SIGKILL"); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	for (let index = 0; index < 20; index += 1) {
		if (processGroupState(pid) === "absent") return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return processGroupState(pid) === "absent";
}

function controllerOwnedTool(tool: ReturnType<ExtensionAPI["getAllTools"]>[number] | undefined): boolean {
	if (!tool || tool.sourceInfo.source === "builtin" || !tool.sourceInfo.path) return false;
	return resolve(tool.sourceInfo.path) === CONTROLLER_EXTENSION_PATH;
}

export default function implementationLifecycle(pi: ExtensionAPI) {
	registerPrimaryReadOnlyTools(pi);
	const controller = new ImplementationController();
	const primaryProfile = primaryProfileDigest();
	let blockedBatch = false;

	const publish = (content: string) => pi.sendMessage({ customType: "implementation-lifecycle", content, display: true });
	const status = (text?: string) => {
		// Status is intentionally session-local; the durable manifest remains authoritative.
		if (lastContext?.hasUI) lastContext.ui.setStatus("implementation-lifecycle", text);
	};
	let lastContext: ExtensionContext | undefined;

	const startImplementation = async (text: string, ctx: ExtensionContext): Promise<string> => {
		const intent = classifyImplementationIntent(text);
		if (intent !== "implementation") return formatAmbiguousImplementationRequest(text);
		if (controller.active()) return "An implementation delivery already owns this repository. Cancel it or wait for a terminal result.";
		if (ctx.mode !== "tui" || !ctx.hasUI) return "Implementation approval requires an interactive TUI session. Continue with read-only analysis or reopen Pi in TUI mode.";
		const approved = await ctx.ui.confirm("Approve isolated implementation?", `${text}\n\nThe writer will work in an isolated candidate. The primary project will not be modified.`);
		if (!approved) return "Implementation not started. Approval was declined; read-only analysis remains available.";
		if (highRiskRequest(text)) return "DECISION REQUIRED: this request targets a protected or high-risk surface and cannot be autonomously implemented.";
		let repository;
		try { repository = await resolveRepository(ctx.cwd); } catch { return "FAILED SAFELY: trusted implementation requires a supported local Git repository."; }
		let profileDigest: string;
		try { profileDigest = await primaryProfile; } catch { return "FAILED SAFELY: the controller-owned primary capability profile could not be fingerprinted."; }
		ctx.ui.notify("Starting an isolated quality-gated implementation. The primary project will not be modified.", "info");
		status("delivery: authorizing");
		let announced = false;
		void controller.start(repository.root, repository.commonRoot, text, profileDigest, (run) => {
			status(`delivery: ${run.state}`);
			if (!announced) {
				announced = true;
				publish(`Implementation ${run.runId} acquired the delivery lease for ${run.root}. The primary project remains unchanged.`);
			}
		}).then((run) => {
			status();
			const evidence = run.base && run.candidate
				? `\nCandidate workspace: ${run.candidateRoot}\nRepository: ${run.root}\nBase tree: ${run.base.treeOid}\nCandidate tree: ${run.candidate.candidateTreeOid}\nTask context: ${run.taskContext?.files.length ?? 0} files, graph ${run.taskContext?.graphFingerprint ?? "unavailable"}\nChanged paths: ${run.changedPaths?.join(", ") || "none recorded"}`
				: "";
			publish(`${run.state === "merge-ready" ? "MERGE READY" : run.state === "decision-required" ? "DECISION REQUIRED" : "FAILED SAFELY"}: ${run.terminalReason ?? "unknown"}.${evidence}\nNo branch/ref integration, merge, push, deploy, or primary-tree mutation was performed.`);
		}).catch((error) => {
			status();
			publish(`DELIVERY BLOCKED: ${error instanceof Error ? error.message : String(error)} No integration was performed; any retained lease must be reconciled before another run.`);
		});
		return "Implementation approved and started in an isolated candidate workspace.";
	};

	pi.registerTool({
		name: IMPLEMENTATION_START_TOOL,
		label: "Start implementation",
		description: "Request one-time approval to start the isolated, quality-gated implementation lifecycle.",
		parameters: Type.Object({ request: Type.String({ description: "The bounded implementation request to approve." }) }, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text" as const, text: await startImplementation(params.request, ctx) }], details: {} };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		try {
			const repository = await resolveRepository(ctx.cwd);
			const store = new DeliveryRunStore(repository.commonRoot);
			const run = await store.read();
			if (run) {
				const adopted = await store.adoptForRecovery();
				if (!adopted) {
					status(`delivery: lease held for run ${run.runId}`);
					publish(`Implementation run ${run.runId} has a lease that could not be safely adopted (live owner, contention, or changed ownership). This session remains read-only and will not take it over.`);
					return;
				}
			}
			if (run && terminalState(run.state)) await store.releaseAdoptedTerminal();
			if (run && !terminalState(run.state)) {
				let recoveryRun = run;
				if (recoveryRun.pendingChild && !recoveryRun.child) {
					const pending = recoveryRun.pendingChild;
					const launchText = await readFile(pending.readyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					});
					let launch: { pid?: number } | undefined;
					if (launchText !== undefined) {
						try { launch = JSON.parse(launchText) as { pid?: number }; }
						catch { throw new Error("The pending child launch PID record is malformed."); }
						if (!Number.isInteger(launch.pid) || Number(launch.pid) <= 1) throw new Error("The pending child launch PID is unsafe.");
					}
					if (launch && Number.isInteger(launch.pid) && Number(launch.pid) > 1) {
						const pid = Number(launch!.pid);
						const processInfo = await runProcess("ps", ["-p", String(pid), "-o", "lstart="], { cwd: repository.root, env: scrubbedEnvironment({ LC_ALL: "C", LANG: "C" }), timeoutMs: 5_000, maxOutputBytes: 16_384 });
						const processStart = processInfo.stdout.trim();
						if (processInfo.code === 0 && processStart) {
							recoveryRun = await store.update({ pendingChild: undefined, child: { role: pending.role, pid, processStart, startedAt: pending.preparedAt } });
						} else if (processGroupState(pid) === "absent") {
							recoveryRun = await store.update({ pendingChild: undefined, childExits: [...recoveryRun.childExits, { role: pending.role, observedAt: new Date().toISOString(), timedOut: false, recovery: true }] });
						} else throw new Error("The pending child launch identity could not be proven.");
						await rm(pending.readyPath, { force: true });
					} else if (Date.now() - Date.parse(pending.preparedAt) > 30_000) {
						recoveryRun = await store.update({ pendingChild: undefined });
					} else throw new Error("The pending child launch has not produced a recoverable PID record.");
				}
				if (recoveryRun.child?.pid) {
					const groupState = processGroupState(recoveryRun.child.pid);
					if (groupState === "unknown") throw new Error("The recorded child process group liveness is uncertain.");
					if (groupState === "present") {
						const processInfo = await runProcess("ps", ["-p", String(recoveryRun.child.pid), "-o", "lstart="], { cwd: repository.root, env: scrubbedEnvironment({ LC_ALL: "C", LANG: "C" }), timeoutMs: 5_000, maxOutputBytes: 16_384 });
						if (processInfo.code === 0 && processInfo.stdout.trim() !== recoveryRun.child.processStart) throw new Error("The recorded child PID was reused; process-group ownership is uncertain.");
						if (!await stopRecordedProcessGroup(recoveryRun.child.pid)) throw new Error("The recorded child process group could not be stopped during recovery.");
					}
					recoveryRun = await store.update({
						child: undefined,
						childExits: [...recoveryRun.childExits, { role: recoveryRun.child.role, observedAt: new Date().toISOString(), timedOut: false, recovery: true }],
					});
				}
				await store.terminal("failed-safely", "controller-reloaded-before-child-proof");
				publish(`Implementation ${run.runId} was recovered as FAILED SAFELY after reload. No integration occurred.`);
			}
		} catch (error) {
			status("delivery: recovery blocked");
			publish(`FAILED SAFELY: delivery recovery is blocked because its lease or manifest could not be proven: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("input", async (event, ctx) => {
		lastContext = ctx;
		const text = event.text.trim();
		if (controller.active()) {
			if (event.source === "interactive" && CANCEL.test(text) && controller.fenced()) {
				ctx.ui.notify("The child exit is unproven and the lease remains fenced. Quit Pi, then restart in this repository to run dead-owner recovery.", "warning");
				return { action: "handled" as const };
			}
			if (event.source === "interactive" && CANCEL.test(text)) {
				ctx.ui.notify("Requesting cancellation and waiting for any recorded child process group to stop.", "warning");
				const accepted = await controller.cancel();
				ctx.ui.notify(accepted ? "Implementation cancelled without integration." : "The run had already entered its atomic terminal commit point.", accepted ? "info" : "warning");
				return { action: "handled" as const };
			}
			if (event.source === "interactive") {
				ctx.ui.notify("An implementation delivery already owns this repository. Cancel it or wait for a terminal result.", "warning");
				return { action: "handled" as const };
			}
		}
		const intent = classifyImplementationIntent(text);
		if (intent === "read-only") return { action: "continue" as const };
		if (intent === "ambiguous") {
			publish(formatAmbiguousImplementationRequest(text));
			// Ambiguity blocks mutation authorization, not the user's ability to investigate.
			return { action: "continue" as const };
		}
		if (event.source !== "interactive" || event.streamingBehavior !== undefined || ctx.mode !== "tui") {
			publish("Implementation was blocked: only an idle, direct interactive TUI request can authorize mutation.");
			return { action: "handled" as const };
		}
		if (event.images?.length) {
			publish("Implementation was not started because image-backed authority cannot yet be frozen deterministically. Provide a complete text request.");
			return { action: "handled" as const };
		}
		publish(await startImplementation(text, ctx));
		return { action: "handled" as const };
	});

	pi.on("turn_start", () => { blockedBatch = false; });
	pi.on("before_agent_start", async (_event, ctx) => {
		lastContext = ctx;
		const allTools = pi.getAllTools();
		const controllerTools = PRIMARY_READ_ONLY_TOOLS.filter((name) => {
			const tool = allTools.find((candidate) => candidate.name === name);
			return controllerOwnedTool(tool);
		});
		pi.setActiveTools(controllerTools.length === PRIMARY_READ_ONLY_TOOLS.length ? [...controllerTools, IMPLEMENTATION_START_TOOL] : []);
		return { systemPrompt: `${_event.systemPrompt}\n\nThe primary session is read-only. Any implementation must be authorized through the automatic isolated lifecycle; do not attempt mutation tools.` };
	});
	pi.on("tool_call", async (event, ctx) => {
		const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
		const controllerOwned = (READ_ONLY_TOOLS.has(event.toolName) || event.toolName === IMPLEMENTATION_START_TOOL) && controllerOwnedTool(definition);
		if (blockedBatch || !controllerOwned) {
			blockedBatch = true;
			void ctx.abort();
			return { block: true, reason: "Mutation or unknown effects are blocked outside an authorized isolated implementation lifecycle.", terminate: true };
		}
	});
	pi.on("session_before_switch", async () => controller.active() ? { cancel: true } : undefined);
	pi.on("session_before_fork", async () => controller.active() ? { cancel: true } : undefined);
	pi.on("session_shutdown", async () => { if (controller.active()) await controller.cancel(); });
}
