import { validateCommentBody } from "./comment-composer.js";

const EMPTY_THREADS_COPY =
	"No comment threads yet. Select text in Visual mode, press c, and add your first comment.";

export function formatAnchorSnippet(anchor, maxLength = 90) {
	const quote = normalizeInlineText(anchor?.exact ?? anchor?.quote ?? "");
	if (!quote) return "(Anchor unavailable)";
	if (quote.length <= maxLength) return quote;
	return `${quote.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function renderThreadsMarkup(threads, options = {}) {
	const normalizedThreads = Array.isArray(threads) ? threads : [];
	if (normalizedThreads.length === 0) {
		return `<p class="threads-empty">${escapeHtml(EMPTY_THREADS_COPY)}</p>`;
	}

	const activeThreadId = options.activeThreadId ?? null;
	const replyErrors = options.replyErrors ?? new Map();
	const pendingReplies = options.pendingReplies ?? new Set();
	const replyDrafts = options.replyDrafts ?? new Map();

	return normalizedThreads
		.map((thread, index) => renderThreadCard(thread, index, { activeThreadId, replyErrors, pendingReplies, replyDrafts }))
		.join("");
}

export function createThreadsPanel(options = {}) {
	const listRoot = options.listRoot;
	if (!listRoot || typeof listRoot.addEventListener !== "function") {
		throw new Error("createThreadsPanel requires a listRoot element.");
	}

	const summaryElement = options.summaryElement;
	const onSelectThread = typeof options.onSelectThread === "function" ? options.onSelectThread : () => undefined;
	const onSubmitReply = typeof options.onSubmitReply === "function" ? options.onSubmitReply : async () => undefined;

	let threads = [];
	let activeThreadId = null;
	let summarySuffix = "";
	const replyErrors = new Map();
	const pendingReplies = new Set();
	const replyDrafts = new Map();

	const syncSummary = () => {
		if (!summaryElement) return;
		const count = threads.length;
		summaryElement.textContent = summarySuffix
			? `${count} thread${count === 1 ? "" : "s"} · ${summarySuffix}`
			: `${count} thread${count === 1 ? "" : "s"}`;
	};

	const render = (nextThreads = threads, nextOptions = {}) => {
		threads = normalizeThreads(nextThreads);
		if (Object.hasOwn(nextOptions, "activeThreadId")) {
			activeThreadId = nextOptions.activeThreadId;
		}

		const validThreadIds = new Set(threads.map((thread) => thread.threadId));
		for (const [threadId] of replyErrors) {
			if (!validThreadIds.has(threadId)) replyErrors.delete(threadId);
		}
		for (const [threadId] of replyDrafts) {
			if (!validThreadIds.has(threadId)) replyDrafts.delete(threadId);
		}
		for (const threadId of pendingReplies) {
			if (!validThreadIds.has(threadId)) pendingReplies.delete(threadId);
		}

		listRoot.innerHTML = renderThreadsMarkup(threads, { activeThreadId, replyErrors, pendingReplies, replyDrafts });
		syncSummary();
	};

	const handleClick = (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const button = target.closest("[data-thread-focus]");
		if (!button) return;

		event.preventDefault();
		const threadId = button.getAttribute("data-thread-focus") ?? "";
		if (!threadId) return;
		onSelectThread(threadId);
	};

	const handleInput = (event) => {
		const target = event.target;
		if (!(target instanceof HTMLTextAreaElement)) return;
		if (!target.hasAttribute("data-thread-reply-input")) return;
		const form = target.closest("[data-thread-reply-form]");
		if (!(form instanceof HTMLFormElement)) return;
		const threadId = form.getAttribute("data-thread-id") ?? "";
		if (!threadId) return;
		replyDrafts.set(threadId, target.value);
	};

	const handleSubmit = async (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement)) return;
		if (!form.hasAttribute("data-thread-reply-form")) return;

		event.preventDefault();
		const threadId = form.getAttribute("data-thread-id") ?? "";
		if (!threadId || pendingReplies.has(threadId)) return;

		const input = form.querySelector("[data-thread-reply-input]");
		const error = form.querySelector("[data-thread-reply-error]");
		if (!(input instanceof HTMLTextAreaElement) || !(error instanceof HTMLElement)) return;

		replyDrafts.set(threadId, input.value);
		const validation = validateCommentBody(input.value);
		if (!validation.ok) {
			replyErrors.set(threadId, validation.error);
			render();
			return;
		}

		pendingReplies.add(threadId);
		replyErrors.delete(threadId);
		render();

		try {
			await onSubmitReply({ threadId, body: validation.value });
			pendingReplies.delete(threadId);
			replyErrors.delete(threadId);
			replyDrafts.delete(threadId);
			activeThreadId = threadId;
			render();
		} catch (submitError) {
			pendingReplies.delete(threadId);
			replyErrors.set(threadId, formatError(submitError) || "Could not save reply.");
			render();
		}
	};

	listRoot.addEventListener("click", handleClick);
	listRoot.addEventListener("input", handleInput);
	listRoot.addEventListener("submit", handleSubmit);

	render(options.initialThreads ?? [], {
		activeThreadId: options.initialActiveThreadId ?? null,
	});

	return {
		render,
		setSummarySuffix(suffix) {
			summarySuffix = suffix ? String(suffix) : "";
			syncSummary();
		},
		destroy() {
			listRoot.removeEventListener("click", handleClick);
			listRoot.removeEventListener("input", handleInput);
			listRoot.removeEventListener("submit", handleSubmit);
		},
	};
}

function renderThreadCard(thread, index, options) {
	const threadId = String(thread?.threadId ?? "");
	const anchorSnippet = formatAnchorSnippet(thread?.anchor);
	const comments = Array.isArray(thread?.comments) ? thread.comments : [];
	const active = threadId && threadId === options.activeThreadId;
	const stale = thread?.stale === true;
	const activeClass = active ? " thread-card--active" : "";
	const staleClass = stale ? " thread-card--stale" : "";
	const pending = options.pendingReplies.has(threadId);
	const replyError = options.replyErrors.get(threadId) ?? "";
	const replyDraft = options.replyDrafts.get(threadId) ?? "";
	const safeThreadLabel = `Thread ${index + 1}`;

	const commentsMarkup = comments.length
		? comments
				.map((comment, commentIndex) => {
					const orderLabel = commentIndex === 0 ? "Comment" : `Reply ${commentIndex}`;
					return [
						`<li class="thread-comment" data-thread-comment-id="${escapeAttribute(comment.commentId ?? `${threadId}-${commentIndex}`)}">`,
						`<p class="thread-comment__meta">${escapeHtml(orderLabel)}</p>`,
						`<p class="thread-comment__body">${escapeHtml(comment.body ?? "")}</p>`,
						"</li>",
					].join("");
				})
				.join("")
		: '<li class="thread-comment thread-comment--empty"><p class="thread-comment__body">No comments in this thread yet.</p></li>';

	return [
		`<article class="thread-card${activeClass}${staleClass}" data-thread-id="${escapeAttribute(threadId)}">`,
		'<header class="thread-card__header">',
		`<button type="button" class="thread-card__focus" data-thread-focus="${escapeAttribute(threadId)}">${escapeHtml(safeThreadLabel)}</button>`,
		`<p class="thread-card__anchor">${escapeHtml(anchorSnippet)}${stale ? ' <span class="thread-card__stale">(stale anchor)</span>' : ""}</p>`,
		"</header>",
		`<ol class="thread-comments">${commentsMarkup}</ol>`,
		`<form class="thread-reply-form" data-thread-reply-form data-thread-id="${escapeAttribute(threadId)}">`,
		"<label class=\"thread-reply-form__label\">Reply</label>",
		`<textarea rows="2" maxlength="4000" placeholder="Add reply" data-thread-reply-input ${pending ? "disabled" : ""}>${escapeHtml(replyDraft)}</textarea>`,
		`<p class="thread-reply-form__error" data-thread-reply-error ${replyError ? "" : "hidden"}>${escapeHtml(replyError)}</p>`,
		`<button type="submit" ${pending ? "disabled" : ""}>${pending ? "Saving…" : "Reply"}</button>`,
		"</form>",
		"</article>",
	].join("");
}

function normalizeThreads(threads) {
	if (!Array.isArray(threads)) return [];
	return threads
		.filter((thread) => thread && typeof thread === "object" && typeof thread.threadId === "string")
		.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
}

function normalizeInlineText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
	return escapeHtml(String(value));
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
