import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchFallbackText } from "./launch-help.ts";

test("buildLaunchFallbackText includes command and remote tunnel hint", () => {
	const text = buildLaunchFallbackText({
		reviewUrl: "http://127.0.0.1:49621/review/session-123",
		healthUrl: "http://127.0.0.1:49621/api/review/session/session-123/health",
		fallbackCommand: "open 'http://127.0.0.1:49621/review/session-123'",
		env: {
			SSH_CONNECTION: "1 2 3 4",
		},
	});

	assert.match(text, /Browser launch failed/i);
	assert.match(text, /Try this command on the same machine/i);
	assert.match(text, /ssh -L 49621:127\.0\.0\.1:49621 <remote-host>/i);
});

test("buildLaunchFallbackText keeps output concise for local desktop environments", () => {
	const text = buildLaunchFallbackText({
		reviewUrl: "http://127.0.0.1:41000/review/abc",
		healthUrl: "http://127.0.0.1:41000/api/review/session/abc/health",
		env: {
			DISPLAY: ":0",
		},
	});

	assert.match(text, /Review URL: http:\/\/127\.0\.0\.1:41000\/review\/abc/);
	assert.doesNotMatch(text, /Detected remote\/headless environment/i);
});
