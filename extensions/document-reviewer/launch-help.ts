export interface LaunchFallbackOptions {
	reviewUrl: string;
	healthUrl: string;
	fallbackCommand?: string;
}

export function buildLaunchFallbackText(options: LaunchFallbackOptions): string {
	const lines = [
		"Could not open the browser automatically.",
		"",
		`Review URL:  ${options.reviewUrl}`,
		`Health URL:  ${options.healthUrl}`,
		"",
		"Open the Review URL in your browser to start reviewing.",
	];

	if (options.fallbackCommand) {
		lines.push("", `Or run manually: ${options.fallbackCommand}`);
	}

	return lines.join("\n");
}
