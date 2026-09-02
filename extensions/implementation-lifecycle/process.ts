import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProcessResult = {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	overflowed: boolean;
	outputSha256: string;
};

const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL"] as const;

export function scrubbedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) if (process.env[key]) environment[key] = process.env[key];
	return { ...environment, CI: "1", NO_COLOR: "1", ...extra };
}

function emptyProcessOutputDigest(): string {
	const empty = createHash("sha256").digest("hex");
	return createHash("sha256").update(`stdout:${empty}:stderr:${empty}`).digest("hex");
}

type ProcessGroupState = "present" | "absent" | "unknown";
function processGroupState(pid: number): ProcessGroupState {
	try { process.kill(-pid, 0); return "present"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (processGroupState(pid) === "absent") return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return processGroupState(pid) === "absent";
}

export async function runProcess(
	program: string,
	args: string[],
	options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxOutputBytes?: number;
		detached?: boolean;
		onBeforeSpawn?: (readyPath: string) => void | Promise<void>;
		onSpawn?: (pid: number) => void | Promise<void>;
	},
): Promise<ProcessResult> {
	const started = Date.now();
	const timeoutMs = options.timeoutMs ?? 10 * 60_000;
	const maxOutputBytes = options.maxOutputBytes ?? 512_000;
	if (options.signal?.aborted) {
		return { code: 130, stdout: "", stderr: "", durationMs: 0, timedOut: false, overflowed: false, outputSha256: emptyProcessOutputDigest() };
	}
	const detached = options.detached ?? false;
	const useStartBarrier = detached && process.platform !== "win32";
	const readyPath = useStartBarrier ? join(tmpdir(), `pi-delivery-ready-${process.pid}-${randomUUID()}`) : undefined;
	if (readyPath) await options.onBeforeSpawn?.(readyPath);
	if (options.signal?.aborted) {
		return { code: 130, stdout: "", stderr: "", durationMs: Date.now() - started, timedOut: false, overflowed: false, outputSha256: emptyProcessOutputDigest() };
	}
	return new Promise((resolve, reject) => {
		const child = spawn(
			useStartBarrier ? "sh" : program,
			useStartBarrier ? ["-c", `printf '{"pid":%s}\\n' "$$" > "$1"; kill -STOP $$; shift; exec "$@"`, "pi-delivery-child", readyPath!, program, ...args] : args,
			{ cwd: options.cwd, env: options.env ?? scrubbedEnvironment(), detached, stdio: ["ignore", "pipe", "pipe"] },
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const stdoutHash = createHash("sha256");
		const stderrHash = createHash("sha256");
		let outputBytes = 0;
		let overflowed = false;
		let timedOut = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const collect = (hash: ReturnType<typeof createHash>, target: Buffer[]) => (chunk: Buffer) => {
			hash.update(chunk);
			if (outputBytes >= maxOutputBytes) { overflowed = true; return; }
			const part = chunk.subarray(0, maxOutputBytes - outputBytes);
			if (part.length < chunk.length) overflowed = true;
			outputBytes += part.length;
			target.push(part);
		};
		child.stdout.on("data", collect(stdoutHash, stdout));
		child.stderr.on("data", collect(stderrHash, stderr));
		const signalChild = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try { process.kill(detached && process.platform !== "win32" ? -child.pid : child.pid, signal); }
			catch { child.kill(signal); }
		};
		const terminate = () => {
			signalChild("SIGTERM");
			killTimer ??= setTimeout(() => signalChild("SIGKILL"), 2_000);
		};
		const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
		const abort = () => terminate();
		options.signal?.addEventListener("abort", abort, { once: true });
		const cleanup = () => {
			if (readyPath) void rm(readyPath, { force: true });
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			void (async () => {
				if (settled) return;
				if (detached && child.pid && process.platform !== "win32" && processGroupState(child.pid) !== "absent") {
					signalChild("SIGTERM");
					if (!await waitForGroupExit(child.pid, 2_000)) {
						signalChild("SIGKILL");
						if (!await waitForGroupExit(child.pid, 2_000)) {
							settled = true;
							cleanup();
							return reject(new Error("The recorded process group did not terminate."));
						}
					}
				}
				settled = true;
				cleanup();
				resolve({
					code: code ?? 1,
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					durationMs: Date.now() - started,
					timedOut,
					overflowed,
					outputSha256: createHash("sha256").update(`stdout:${stdoutHash.digest("hex")}:stderr:${stderrHash.digest("hex")}`).digest("hex"),
				});
			})();
		});
		void (async () => {
			try {
				if (!child.pid) throw new Error("The child process has no PID.");
				if (readyPath) {
					let ready = false;
					for (let index = 0; index < 500; index += 1) {
						if (await access(readyPath).then(() => true).catch(() => false)) { ready = true; break; }
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					if (!ready) throw new Error("The child start barrier did not become ready.");
				}
				await options.onSpawn?.(child.pid);
				if (useStartBarrier) signalChild("SIGCONT");
			} catch (error) {
				terminate();
				if (child.pid && detached && process.platform !== "win32" && !await waitForGroupExit(child.pid, 2_000)) {
					signalChild("SIGKILL");
					await waitForGroupExit(child.pid, 2_000);
				}
				if (!settled) {
					settled = true;
					cleanup();
					reject(error);
				}
			}
		})();
	});
}
