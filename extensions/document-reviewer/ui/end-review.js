export function createEndReviewController(options = {}) {
	const button = options.button;
	if (!button || typeof button.addEventListener !== "function") {
		throw new Error("createEndReviewController requires a clickable button element.");
	}

	const statusElement = options.statusElement;
	const fallbackContainer = options.fallbackContainer;
	const fallbackTextarea = options.fallbackTextarea;
	const onRequestExport = typeof options.onRequestExport === "function" ? options.onRequestExport : async () => ({ text: "", count: 0 });
	const writeToClipboard =
		typeof options.writeToClipboard === "function"
			? options.writeToClipboard
			: async (text) => {
				await writeClipboardText(text);
			};
	const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => undefined;

	let pending = false;

	const updateStatus = (message) => {
		if (statusElement && "textContent" in statusElement) {
			statusElement.textContent = message;
		}
	};

	const showFallback = (text) => {
		if (fallbackContainer && "hidden" in fallbackContainer) {
			fallbackContainer.hidden = false;
		}
		if (fallbackTextarea && "value" in fallbackTextarea) {
			fallbackTextarea.value = text;
		}
	};

	const hideFallback = () => {
		if (fallbackContainer && "hidden" in fallbackContainer) {
			fallbackContainer.hidden = true;
		}
		if (fallbackTextarea && "value" in fallbackTextarea) {
			fallbackTextarea.value = "";
		}
	};

	const run = async () => {
		if (pending) {
			return { status: "pending", count: 0, text: "" };
		}

		pending = true;
		button.disabled = true;
		updateStatus("Preparing export…");

		try {
			const payload = normalizeExportPayload(await onRequestExport());
			if (payload.count < 1) {
				hideFallback();
				const result = { status: "empty", count: 0, text: payload.text };
				updateStatus("No comments to export yet.");
				onStateChange(result);
				return result;
			}

			try {
				await writeToClipboard(payload.text);
				hideFallback();
				const result = { status: "copied", count: payload.count, text: payload.text };
				updateStatus(`Copied ${payload.count} comment${payload.count === 1 ? "" : "s"} to clipboard.`);
				onStateChange(result);
				return result;
			} catch {
				showFallback(payload.text);
				const result = { status: "manual-copy", count: payload.count, text: payload.text };
				updateStatus("Clipboard unavailable. Copy the export text below.");
				onStateChange(result);
				return result;
			}
		} catch (error) {
			const result = {
				status: "error",
				count: 0,
				text: "",
				message: formatError(error) || "Could not export review comments.",
			};
			updateStatus(`Export failed: ${result.message}`);
			onStateChange(result);
			return result;
		} finally {
			pending = false;
			button.disabled = false;
		}
	};

	const handleClick = (event) => {
		event?.preventDefault?.();
		void run();
	};

	button.addEventListener("click", handleClick);

	return {
		run,
		destroy() {
			button.removeEventListener("click", handleClick);
		},
	};
}

export async function writeClipboardText(text) {
	const clipboard = globalThis.navigator?.clipboard;
	if (!clipboard || typeof clipboard.writeText !== "function") {
		throw new Error("Clipboard API unavailable");
	}
	await clipboard.writeText(String(text));
}

function normalizeExportPayload(payload) {
	const text = typeof payload?.text === "string" ? payload.text : "";
	const count = Number.isFinite(payload?.count) ? Math.max(0, Math.trunc(payload.count)) : 0;
	return { text, count };
}

function formatError(error) {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "";
}
