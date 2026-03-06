const EMPTY_COMMENT_ERROR = "Comment cannot be empty. Add feedback text before saving.";
const DEFAULT_MAX_COMMENT_LENGTH = 4000;

export function validateCommentBody(rawValue, options = {}) {
	const maxLength = Number.isFinite(options.maxLength)
		? Math.max(1, Math.trunc(options.maxLength))
		: DEFAULT_MAX_COMMENT_LENGTH;

	if (typeof rawValue !== "string") {
		return { ok: false, error: EMPTY_COMMENT_ERROR };
	}

	const normalized = rawValue.trim();
	if (!normalized) {
		return { ok: false, error: EMPTY_COMMENT_ERROR };
	}

	if (normalized.length > maxLength) {
		return { ok: false, error: `Comment is too long. Keep it under ${maxLength} characters.` };
	}

	return { ok: true, value: normalized };
}

export function createCommentComposer(options = {}) {
	const textarea = options.textarea;
	if (!textarea || typeof textarea !== "object") {
		throw new Error("createCommentComposer requires a textarea-like element.");
	}

	const submitButton = options.submitButton;
	const errorElement = options.errorElement;
	const contextElement = options.contextElement;
	const onSubmit = typeof options.onSubmit === "function" ? options.onSubmit : async () => undefined;
	const maxLength = Number.isFinite(options.maxLength)
		? Math.max(1, Math.trunc(options.maxLength))
		: DEFAULT_MAX_COMMENT_LENGTH;

	let pending = false;

	const setError = (message) => {
		if (!errorElement) return;
		errorElement.textContent = message || "";
		errorElement.hidden = !message;
	};

	const setPending = (nextPending) => {
		pending = Boolean(nextPending);
		if (submitButton && typeof submitButton === "object") {
			submitButton.disabled = pending;
		}
		if (typeof textarea === "object") {
			textarea.disabled = pending;
		}
	};

	const submit = async () => {
		if (pending) return false;

		const validation = validateCommentBody(textarea.value, { maxLength });
		if (!validation.ok) {
			setError(validation.error);
			return false;
		}

		setError("");
		setPending(true);
		try {
			await onSubmit(validation.value);
			textarea.value = "";
			return true;
		} catch (error) {
			setError(formatError(error) || "Could not save comment. Try again.");
			return false;
		} finally {
			setPending(false);
		}
	};

	const submitFromEvent = async (event) => {
		event?.preventDefault?.();
		await submit();
	};

	options.form?.addEventListener?.("submit", submitFromEvent);

	return {
		submit,
		setError,
		setContext(message) {
			if (!contextElement) return;
			contextElement.textContent = message || "";
		},
		focus() {
			textarea.focus?.();
		},
		clear() {
			textarea.value = "";
			setError("");
		},
		setDisabled(disabled) {
			const nextDisabled = Boolean(disabled);
			if (submitButton && typeof submitButton === "object") {
				submitButton.disabled = nextDisabled;
			}
			if (typeof textarea === "object") {
				textarea.disabled = nextDisabled;
			}
		},
		destroy() {
			options.form?.removeEventListener?.("submit", submitFromEvent);
		},
	};
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
