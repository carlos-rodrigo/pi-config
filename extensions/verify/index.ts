/**
 * Verify extension — back-pressure hook
 *
 * Runs `scripts/verify.sh` when the agent finishes (agent_end).
 * Silent on success (zero context consumed). On failure, injects
 * error output as a follow-up message so the agent must fix issues
 * before the user sees the result.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		// Only run in interactive mode
		if (!ctx.hasUI) return;

		const result = await pi.exec("bash", ["scripts/verify.sh"], {
			timeout: 60_000,
		});

		// Exit 0 → silent, no context consumed
		if (result.code === 0) return;

		// Failure → inject errors so agent must fix them
		const errors = (result.stderr || result.stdout || "Verification failed").trim();
		const message = `## ❌ Verification failed\n\nFix these errors before finishing:\n\n\`\`\`\n${errors}\n\`\`\`\n\nRun \`bash scripts/verify.sh\` after fixing to confirm.`;

		pi.sendUserMessage(message, { deliverAs: "followUp" });
	});
}
