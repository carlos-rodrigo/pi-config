export interface LaunchFallbackOptions {
	reviewUrl: string;
	healthUrl?: string;
	fallbackCommand?: string;
	env?: NodeJS.ProcessEnv;
}

export function buildLaunchFallbackText(options: LaunchFallbackOptions): string {
	const env = options.env ?? process.env;
	const lines: string[] = [];
	const reviewUrl = options.reviewUrl;
	const healthUrl = options.healthUrl;
	const fallbackCommand = options.fallbackCommand;

	lines.push("Browser launch failed for this review session.");
	lines.push(`Review URL: ${reviewUrl}`);
	if (healthUrl) {
		lines.push(`Health URL: ${healthUrl}`);
	}
	if (fallbackCommand) {
		lines.push(`Try this command on the same machine: ${fallbackCommand}`);
	}

	if (isLikelyRemoteOrHeadless(env)) {
		lines.push("");
		lines.push("Detected remote/headless environment.");
		lines.push("Open the Review URL from a machine that has a browser.");
		const tunnelHint = buildSshTunnelHint(reviewUrl);
		if (tunnelHint) {
			lines.push(`If needed, forward the local service port: ${tunnelHint}`);
		}
	}

	return lines.join("\n");
}

function isLikelyRemoteOrHeadless(env: NodeJS.ProcessEnv): boolean {
	if (env.CI === "true") return true;
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
	if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
	return false;
}

function buildSshTunnelHint(reviewUrl: string): string | null {
	try {
		const parsed = new URL(reviewUrl);
		if (!parsed.port) return null;
		const port = Number(parsed.port);
		if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
		return `ssh -L ${port}:127.0.0.1:${port} <remote-host>`;
	} catch {
		return null;
	}
}
