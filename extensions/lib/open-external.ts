import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface LaunchAttempt {
	command: string;
	args: string[];
	displayCommand: string;
}

export interface OpenExternalResult {
	ok: boolean;
	usedCommand?: string;
	fallbackCommand?: string;
	error?: string;
}

let cachedLauncherCommand: string | undefined;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildAttempts(target: string): LaunchAttempt[] {
	if (process.platform === "darwin") {
		return [
			{
				command: "open",
				args: [target],
				displayCommand: `open ${shellQuote(target)}`,
			},
			{
				command: "xdg-open",
				args: [target],
				displayCommand: `xdg-open ${shellQuote(target)}`,
			},
		];
	}

	if (process.platform === "win32") {
		return [
			{
				command: "cmd",
				args: ["/c", "start", "", target],
				displayCommand: `start "" "${target}"`,
			},
			{
				command: "explorer",
				args: [target],
				displayCommand: `explorer "${target}"`,
			},
		];
	}

	return [
		{
			command: "xdg-open",
			args: [target],
			displayCommand: `xdg-open ${shellQuote(target)}`,
		},
		{
			command: "open",
			args: [target],
			displayCommand: `open ${shellQuote(target)}`,
		},
	];
}

function prioritizeCachedLauncher(attempts: LaunchAttempt[]): LaunchAttempt[] {
	if (!cachedLauncherCommand) return attempts;
	const cached = attempts.find((attempt) => attempt.command === cachedLauncherCommand);
	if (!cached) return attempts;
	return [cached, ...attempts.filter((attempt) => attempt.command !== cachedLauncherCommand)];
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

export async function openExternal(pi: ExtensionAPI, target: string): Promise<OpenExternalResult> {
	const attempts = prioritizeCachedLauncher(buildAttempts(target));
	const failures: string[] = [];

	for (const attempt of attempts) {
		try {
			const result = await pi.exec(attempt.command, attempt.args);
			if (result.code === 0) {
				cachedLauncherCommand = attempt.command;
				return {
					ok: true,
					usedCommand: attempt.displayCommand,
				};
			}

			const reason = result.stderr.trim() || result.stdout.trim() || "command failed";
			failures.push(`${attempt.displayCommand} → ${reason}`);
		} catch (error) {
			failures.push(`${attempt.displayCommand} → ${describeError(error)}`);
		}
	}

	return {
		ok: false,
		error: failures.join("; "),
		fallbackCommand: attempts[0]?.displayCommand,
	};
}
