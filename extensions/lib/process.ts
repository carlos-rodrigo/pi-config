import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandLabel(command: string, args: readonly string[]): string {
	return [command, ...args].map(shellQuote).join(" ");
}

export async function execChecked(
	pi: Pick<ExtensionAPI, "exec">,
	command: string,
	args: string[],
	options?: Parameters<ExtensionAPI["exec"]>[2],
): Promise<Awaited<ReturnType<ExtensionAPI["exec"]>>> {
	const result = await pi.exec(command, args, options);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`${commandLabel(command, args)} failed: ${reason}`);
	}
	return result;
}
