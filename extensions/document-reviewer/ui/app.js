import { createCommentComposer } from "./comment-composer.js";
import { createEndReviewController } from "./end-review.js";
import { computePageStep, MODES, resolveKeyAction } from "./keymap.js";
import { renderMermaidBlocks } from "./mermaid-block.js";
import { createSelectionController } from "./selection.js";
import { createThreadsPanel, formatAnchorSnippet } from "./threads-panel.js";

const THREAD_ANCHOR_SELECTOR = "[data-thread-anchor-id]";
const EMPTY_SELECTION_CONTEXT = "Select text in Visual mode to create a thread.";

startReviewerApp();

async function startReviewerApp() {
	const bootstrap = readBootstrap();
	const ui = collectUi();

	if (!bootstrap || !ui) {
		renderBootFailure();
		return;
	}

	const state = {
		mode: bootstrap.initialMode ?? MODES.NORMAL,
		shortSessionId: bootstrap.sessionId.slice(0, 8),
		hasVisualSelection: false,
		pendingAnchor: null,
		threads: [],
		activeThreadId: null,
		healthSummary: "health pending",
		selectionController: null,
		commentComposer: null,
		threadsPanel: null,
		endReviewController: null,
	};

	const selectionController = createSelectionController({
		root: ui.documentContent,
		onSelectionChange: (selectionState) => {
			state.hasVisualSelection = Boolean(selectionState?.hasSelection);
			state.pendingAnchor = state.hasVisualSelection ? captureSelectionAnchor(ui.documentContent) : null;
			updateComposerContext(state);
			if (state.mode === MODES.VISUAL) {
				const message = state.hasVisualSelection
					? "Review mode: Visual selection (active range)"
					: "Review mode: Visual selection (press motion keys to extend)";
				setReviewState(ui, message, state.shortSessionId);
			}
		},
	});
	state.selectionController = selectionController;

	let threadsPanel;
	const commentComposer = createCommentComposer({
		form: ui.newThreadForm,
		textarea: ui.newThreadInput,
		submitButton: ui.newThreadSubmit,
		errorElement: ui.newThreadError,
		contextElement: ui.threadComposerContext,
		onSubmit: async (body) => {
			await createThreadFromSelection(body, bootstrap, ui, state);
			threadsPanel?.render(state.threads, { activeThreadId: state.activeThreadId });
			threadsPanel?.setSummarySuffix(state.healthSummary);
		},
	});
	state.commentComposer = commentComposer;

	threadsPanel = createThreadsPanel({
		listRoot: ui.threadsList,
		summaryElement: ui.threadsSummary,
		onSelectThread: (threadId) => {
			setActiveThread(threadId, ui, state, { scrollToAnchor: true });
		},
		onSubmitReply: async ({ threadId, body }) => {
			await appendReply(threadId, body, bootstrap, ui, state);
		},
	});
	state.threadsPanel = threadsPanel;

	state.endReviewController = createEndReviewController({
		button: ui.endReviewButton,
		statusElement: ui.endReviewStatus,
		fallbackContainer: ui.endReviewFallback,
		fallbackTextarea: ui.endReviewFallbackText,
		onRequestExport: async () => requestEndReviewExport(bootstrap),
		onStateChange: (event) => {
			handleEndReviewState(event, ui, state);
		},
	});

	updateComposerContext(state);
	setMode(state.mode, ui, state, { clearSelection: false });

	ui.documentTitle.textContent = bootstrap.title;
	ui.documentPath.textContent = bootstrap.docPath;
	setReviewState(ui, "Loading markdown from local review service…", state.shortSessionId);

	const keydownHandler = (event) => {
		handleKeydown(event, ui, state);
	};
	const documentClickHandler = (event) => {
		handleDocumentClick(event, ui, state);
	};

	const teardown = () => {
		document.removeEventListener("keydown", keydownHandler);
		ui.documentContent.removeEventListener("click", documentClickHandler);
		state.selectionController?.destroy?.();
		state.commentComposer?.destroy?.();
		state.threadsPanel?.destroy?.();
		state.endReviewController?.destroy?.();
	};

	document.addEventListener("keydown", keydownHandler);
	ui.documentContent.addEventListener("click", documentClickHandler);
	window.addEventListener("beforeunload", teardown, { once: true });

	await loadDocument(bootstrap, ui, state);
	await Promise.all([loadThreads(bootstrap, ui, state), refreshHealthStatus(bootstrap, ui, state)]);
}

function handleKeydown(event, ui, state) {
	if (isEditableTarget(event.target)) return;

	const action = resolveKeyAction(event, state.mode);
	if (!action) return;

	event.preventDefault();
	applyKeyAction(action, ui, state);
}

function applyKeyAction(action, ui, state) {
	const viewport = ui.documentContent;

	if (action.type === "mode") {
		state.mode = action.mode;
		setMode(state.mode, ui, state, { clearSelection: action.clearSelection });
		return;
	}

	if (action.type === "page-scroll") {
		const pageStep = computePageStep(viewport.clientHeight);
		viewport.scrollBy({
			top: pageStep * action.direction,
			behavior: "smooth",
		});
		return;
	}

	if (action.type === "end-review") {
		void state.endReviewController?.run?.();
		return;
	}

	if (action.type === "scroll") {
		viewport.scrollBy({
			top: action.top,
			left: action.left,
			behavior: "auto",
		});

		if (action.extendSelection) {
			state.selectionController?.extendSelection?.(action.extendSelection);
		}
	}
}

function setMode(mode, ui, state, options = {}) {
	const safeMode = MODES[mode] ? mode : MODES.NORMAL;
	state.mode = safeMode;
	ui.modeBadge.textContent = safeMode;
	ui.modeBadge.dataset.mode = safeMode;
	state.selectionController?.setMode?.(safeMode, options);

	if (safeMode === MODES.COMMENT) {
		state.commentComposer?.focus?.();
	}

	const modeMessage =
		safeMode === MODES.NORMAL
			? "Review mode: Normal"
			: safeMode === MODES.VISUAL
				? state.hasVisualSelection
					? "Review mode: Visual selection (active range)"
					: "Review mode: Visual selection (press motion keys to extend)"
				: "Review mode: Comment drafting";

	setReviewState(ui, modeMessage, state.shortSessionId);
}

async function loadDocument(bootstrap, ui, state) {
	try {
		const response = await sessionFetch(bootstrap, bootstrap.documentUrl, {
			headers: { accept: "application/json" },
		});

		if (!response.ok) {
			const message = await readErrorMessage(response);
			throw new Error(message || `Document request failed (${response.status}).`);
		}

		const payload = await response.json();
		if (typeof payload.markdown !== "string") {
			throw new Error("Review service returned an invalid markdown payload.");
		}

		const markdown = payload.markdown;
		if (!markdown.trim()) {
			ui.documentContent.innerHTML =
				'<div class="empty-state">This markdown file is empty. Add content to start review notes.</div>';
			ui.documentSummary.textContent = "Empty markdown document";
			setReviewState(ui, "Ready · Empty file loaded", state.shortSessionId);
			return;
		}

		const rendered = renderMarkdown(markdown);
		ui.documentContent.innerHTML = rendered.html;
		ui.documentSummary.textContent = formatDocumentSummary(rendered.lineCount, rendered.mermaidBlockCount);

		if (rendered.mermaidBlockCount > 0) {
			setReviewState(
				ui,
				`Ready · ${rendered.lineCount} lines loaded · rendering ${rendered.mermaidBlockCount} Mermaid diagram${rendered.mermaidBlockCount === 1 ? "" : "s"}`,
				state.shortSessionId,
			);
			let mermaidResult = {
				total: rendered.mermaidBlockCount,
				rendered: 0,
				fallback: rendered.mermaidBlockCount,
			};
			try {
				mermaidResult = await renderMermaidBlocks(ui.documentContent);
			} catch (error) {
				console.warn("[document-reviewer] mermaid rendering failed:", error);
			}
			ui.documentSummary.textContent = formatDocumentSummary(rendered.lineCount, rendered.mermaidBlockCount, mermaidResult);
			setReviewState(ui, formatReadyState(rendered.lineCount, mermaidResult), state.shortSessionId);
			return;
		}

		setReviewState(ui, `Ready · ${rendered.lineCount} lines loaded`, state.shortSessionId);
	} catch (error) {
		ui.documentContent.innerHTML = `<div class="empty-state">Could not load markdown: ${escapeHtml(String(error))}</div>`;
		ui.documentSummary.textContent = "Load failed";
		setReviewState(ui, "Review service error · check the command output for details", state.shortSessionId);
	}
}

async function loadThreads(bootstrap, ui, state) {
	const commentsUrl = buildSessionUrl(bootstrap.sessionId, "comments", bootstrap.documentUrl);
	try {
		const response = await sessionFetch(bootstrap, commentsUrl, {
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			const message = await readErrorMessage(response);
			throw new Error(message || `Comments request failed (${response.status}).`);
		}

		const payload = await response.json();
		state.threads = Array.isArray(payload?.threads) ? payload.threads : [];
		if (!state.threads.some((thread) => thread.threadId === state.activeThreadId)) {
			state.activeThreadId = null;
		}

		state.threadsPanel?.render(state.threads, { activeThreadId: state.activeThreadId });
		state.threadsPanel?.setSummarySuffix(state.healthSummary);
		renderThreadAnchorMarkers(ui.documentContent, state.threads, state.activeThreadId);
	} catch (error) {
		state.threadsPanel?.render([], { activeThreadId: null });
		ui.threadsSummary.textContent = "0 threads · comments unavailable";
		console.warn("[document-reviewer] comments load failed:", error);
	}
}

async function refreshHealthStatus(bootstrap, ui, state) {
	try {
		const response = await sessionFetch(bootstrap, bootstrap.healthUrl, {
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			state.healthSummary = "health check unavailable";
			state.threadsPanel?.setSummarySuffix(state.healthSummary);
			return;
		}

		const payload = await response.json();
		state.healthSummary = payload?.ok === true ? "session healthy" : "session unavailable";
		state.threadsPanel?.setSummarySuffix(state.healthSummary);
	} catch {
		state.healthSummary = "health check unavailable";
		state.threadsPanel?.setSummarySuffix(state.healthSummary);
	}
}

async function createThreadFromSelection(commentBody, bootstrap, ui, state) {
	const anchor = state.pendingAnchor ?? captureSelectionAnchor(ui.documentContent);
	if (!anchor) {
		throw new Error("Select text in Visual mode before creating a thread.");
	}

	const commentsUrl = buildSessionUrl(bootstrap.sessionId, "comments", bootstrap.documentUrl);
	const response = await sessionFetch(bootstrap, commentsUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({
			anchor,
			body: commentBody,
		}),
	});

	if (!response.ok) {
		const message = await readErrorMessage(response);
		throw new Error(message || `Could not create thread (${response.status}).`);
	}

	const payload = await response.json();
	const savedThread = payload?.thread;
	const savedThreadId = typeof savedThread?.threadId === "string" ? savedThread.threadId : null;
	if (savedThread) {
		state.threads = upsertThread(state.threads, savedThread);
	}
	if (savedThreadId) {
		state.activeThreadId = savedThreadId;
	}

	if (savedThreadId) {
		setActiveThread(savedThreadId, ui, state, { scrollToAnchor: true });
	} else {
		state.threadsPanel?.render(state.threads, { activeThreadId: state.activeThreadId });
		state.threadsPanel?.setSummarySuffix(state.healthSummary);
		renderThreadAnchorMarkers(ui.documentContent, state.threads, state.activeThreadId);
	}

	state.selectionController?.clearSelection?.();
	state.hasVisualSelection = false;
	state.pendingAnchor = null;
	updateComposerContext(state);
	setMode(MODES.NORMAL, ui, state, { clearSelection: true });
	setReviewState(ui, "Thread saved from selected range", state.shortSessionId);
}

async function appendReply(threadId, body, bootstrap, ui, state) {
	const replyUrl = buildSessionUrl(
		bootstrap.sessionId,
		`comments/${encodeURIComponent(threadId)}/replies`,
		bootstrap.documentUrl,
	);
	const response = await sessionFetch(bootstrap, replyUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({ body }),
	});

	if (!response.ok) {
		const message = await readErrorMessage(response);
		throw new Error(message || `Could not save reply (${response.status}).`);
	}

	const payload = await response.json();
	if (payload?.thread) {
		state.threads = upsertThread(state.threads, payload.thread);
	}
	state.activeThreadId = threadId;
	state.threadsPanel?.render(state.threads, { activeThreadId: state.activeThreadId });
	state.threadsPanel?.setSummarySuffix(state.healthSummary);
	renderThreadAnchorMarkers(ui.documentContent, state.threads, state.activeThreadId);
	setReviewState(ui, "Reply saved", state.shortSessionId);
}

async function requestEndReviewExport(bootstrap) {
	const exportUrl = buildSessionUrl(bootstrap.sessionId, "export", bootstrap.documentUrl);
	const response = await sessionFetch(bootstrap, exportUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({ format: "plain" }),
	});

	if (!response.ok) {
		const message = await readErrorMessage(response);
		throw new Error(message || `Could not export review comments (${response.status}).`);
	}

	const payload = await response.json();
	const rawCount = Number(payload?.count);
	const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
	const text = typeof payload?.text === "string" ? payload.text : "";
	return { count, text };
}

function handleEndReviewState(event, ui, state) {
	if (!event || typeof event !== "object") return;

	if (event.status === "copied") {
		setReviewState(
			ui,
			`End Review copied ${event.count} comment${event.count === 1 ? "" : "s"} to clipboard`,
			state.shortSessionId,
		);
		return;
	}

	if (event.status === "manual-copy") {
		setReviewState(
			ui,
			`End Review clipboard unavailable · ${event.count} comment${event.count === 1 ? "" : "s"} ready for manual copy`,
			state.shortSessionId,
		);
		return;
	}

	if (event.status === "empty") {
		setReviewState(ui, "End Review: no comments to export yet", state.shortSessionId);
		return;
	}

	if (event.status === "error") {
		setReviewState(ui, `End Review failed: ${event.message ?? "unknown error"}`, state.shortSessionId);
	}
}

function handleDocumentClick(event, ui, state) {
	const target = event.target;
	if (!(target instanceof Element)) return;
	const marker = target.closest(THREAD_ANCHOR_SELECTOR);
	if (!marker) return;

	event.preventDefault();
	const threadId = marker.getAttribute("data-thread-anchor-id") ?? "";
	if (!threadId) return;
	setActiveThread(threadId, ui, state, { scrollToAnchor: false });
}

function setActiveThread(threadId, ui, state, options = {}) {
	if (!threadId) return;
	state.activeThreadId = threadId;
	state.threadsPanel?.render(state.threads, { activeThreadId: threadId });
	state.threadsPanel?.setSummarySuffix(state.healthSummary);
	if (!setActiveThreadMarker(ui.documentContent, state.activeThreadId)) {
		renderThreadAnchorMarkers(ui.documentContent, state.threads, state.activeThreadId);
	}

	if (options.scrollToAnchor) {
		const marker = findThreadMarker(ui.documentContent, threadId);
		marker?.scrollIntoView?.({ block: "center", behavior: "smooth" });
	}

	const activeThread = state.threads.find((thread) => thread.threadId === threadId);
	if (activeThread) {
		state.commentComposer?.setContext(`Active thread: ${formatAnchorSnippet(activeThread.anchor, 70)}`);
	}
}

function updateComposerContext(state) {
	if (state.pendingAnchor) {
		state.commentComposer?.setContext(`Selected: ${formatAnchorSnippet(state.pendingAnchor, 70)}`);
		return;
	}
	state.commentComposer?.setContext(EMPTY_SELECTION_CONTEXT);
}

function renderThreadAnchorMarkers(root, threads, activeThreadId) {
	clearThreadAnchorMarkers(root);
	if (!Array.isArray(threads) || threads.length === 0) return;

	const sortedThreads = [...threads].sort(
		(left, right) => Number(left?.anchor?.startOffset ?? 0) - Number(right?.anchor?.startOffset ?? 0),
	);

	for (const thread of sortedThreads) {
		const threadId = typeof thread?.threadId === "string" ? thread.threadId : "";
		if (thread?.stale === true) continue;
		const startOffset = Number(thread?.anchor?.startOffset);
		if (!threadId || !Number.isFinite(startOffset) || startOffset < 0) continue;

		const position = resolveTextPosition(root, startOffset);
		if (!position) continue;

		const marker = document.createElement("button");
		marker.type = "button";
		marker.className = "thread-anchor-marker";
		marker.setAttribute("data-thread-anchor-id", threadId);
		marker.setAttribute("aria-label", `Focus thread: ${formatAnchorSnippet(thread.anchor, 40)}`);
		marker.title = formatAnchorSnippet(thread.anchor, 60);
		if (threadId === activeThreadId) {
			marker.classList.add("thread-anchor-marker--active");
		}

		const range = document.createRange();
		range.setStart(position.node, position.offset);
		range.collapse(true);
		range.insertNode(marker);
	}
}

function clearThreadAnchorMarkers(root) {
	for (const marker of root.querySelectorAll(THREAD_ANCHOR_SELECTOR)) {
		marker.remove();
	}
}

function resolveTextPosition(root, targetOffset) {
	const normalizedOffset = Math.max(0, Math.floor(Number(targetOffset) || 0));
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let traversed = 0;
	let lastTextNode = null;

	while (walker.nextNode()) {
		const textNode = walker.currentNode;
		const length = textNode.nodeValue?.length ?? 0;
		if (length === 0) continue;
		lastTextNode = textNode;
		if (traversed + length >= normalizedOffset) {
			return {
				node: textNode,
				offset: Math.max(0, normalizedOffset - traversed),
			};
		}
		traversed += length;
	}

	if (!lastTextNode) return null;
	if (normalizedOffset !== traversed) return null;
	return {
		node: lastTextNode,
		offset: lastTextNode.nodeValue?.length ?? 0,
	};
}

function findThreadMarker(root, threadId) {
	for (const marker of root.querySelectorAll(THREAD_ANCHOR_SELECTOR)) {
		if (marker.getAttribute("data-thread-anchor-id") === threadId) {
			return marker;
		}
	}
	return null;
}

function setActiveThreadMarker(root, activeThreadId) {
	let found = false;
	for (const marker of root.querySelectorAll(THREAD_ANCHOR_SELECTOR)) {
		const markerThreadId = marker.getAttribute("data-thread-anchor-id") ?? "";
		const isActive = markerThreadId === activeThreadId;
		marker.classList.toggle("thread-anchor-marker--active", isActive);
		if (isActive) {
			found = true;
		}
	}
	return found;
}

function captureSelectionAnchor(root) {
	const selection = window.getSelection?.();
	if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return null;

	let range;
	try {
		range = selection.getRangeAt(0);
	} catch {
		return null;
	}

	if (!root.contains(range.commonAncestorContainer)) return null;

	const exact = range.toString().replace(/\s+/g, " ").trim();
	if (!exact) return null;

	const textContent = root.textContent ?? "";
	const startOffset = computeRangeOffset(root, range.startContainer, range.startOffset);
	const endOffset = computeRangeOffset(root, range.endContainer, range.endOffset);
	if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset <= startOffset) {
		return null;
	}

	const prefix = textContent.slice(Math.max(0, startOffset - 48), startOffset).trim();
	const suffix = textContent.slice(endOffset, Math.min(textContent.length, endOffset + 48)).trim();

	return {
		exact,
		startOffset,
		endOffset,
		...(prefix ? { prefix } : {}),
		...(suffix ? { suffix } : {}),
	};
}

function computeRangeOffset(root, boundaryNode, boundaryOffset) {
	const range = document.createRange();
	range.selectNodeContents(root);
	try {
		range.setEnd(boundaryNode, boundaryOffset);
		return range.toString().length;
	} catch {
		return Number.NaN;
	}
}

function upsertThread(threads, updatedThread) {
	if (!updatedThread || typeof updatedThread !== "object") return Array.isArray(threads) ? threads : [];
	const threadId = typeof updatedThread.threadId === "string" ? updatedThread.threadId : "";
	if (!threadId) return Array.isArray(threads) ? threads : [];

	const current = Array.isArray(threads) ? [...threads] : [];
	const index = current.findIndex((thread) => thread.threadId === threadId);
	if (index >= 0) {
		current[index] = updatedThread;
		return current;
	}
	current.push(updatedThread);
	return current;
}

function buildSessionUrl(sessionId, routeSuffix, documentUrl) {
	const baseUrl = new URL(documentUrl);
	const encodedSessionId = encodeURIComponent(sessionId);
	const suffix = String(routeSuffix || "").replace(/^\/+/, "");
	baseUrl.pathname = `/api/review/session/${encodedSessionId}/${suffix}`;
	baseUrl.search = "";
	baseUrl.hash = "";
	return baseUrl.toString();
}

function sessionFetch(bootstrap, url, init = {}) {
	const headers = new Headers(init.headers ?? {});
	headers.set("x-review-session-token", bootstrap.apiToken);
	return fetch(url, {
		...init,
		headers,
		cache: init.cache ?? "no-store",
	});
}

function renderMarkdown(markdown) {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	const paragraphLines = [];
	let listType = null;
	let listItems = [];
	let mermaidBlockCount = 0;

	const flushParagraph = () => {
		if (paragraphLines.length === 0) return;
		const content = renderInlineMarkdown(paragraphLines.join(" ").trim());
		if (content) blocks.push(`<p>${content}</p>`);
		paragraphLines.length = 0;
	};

	const flushList = () => {
		if (!listType || listItems.length === 0) {
			listType = null;
			listItems = [];
			return;
		}
		blocks.push(`<${listType}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${listType}>`);
		listType = null;
		listItems = [];
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();

		const codeFenceMatch = line.match(/^```(.*)$/);
		if (codeFenceMatch) {
			flushParagraph();
			flushList();

			const language = codeFenceMatch[1].trim();
			const fenceLanguage = normalizeFenceLanguage(language);
			const codeLines = [];
			index += 1;
			while (index < lines.length && !/^```/.test(lines[index])) {
				codeLines.push(lines[index]);
				index += 1;
			}

			const codeText = codeLines.join("\n");
			if (fenceLanguage === "mermaid") {
				mermaidBlockCount += 1;
				blocks.push(renderMermaidPlaceholder(codeText));
				continue;
			}

			const languageAttr = language ? ` data-language="${escapeAttribute(language)}"` : "";
			blocks.push(`<pre><code${languageAttr}>${escapeHtml(codeText)}</code></pre>`);
			continue;
		}

		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushParagraph();
			flushList();
			const level = headingMatch[1].length;
			blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
			continue;
		}

		if (/^([-*_]\s*){3,}$/.test(trimmed)) {
			flushParagraph();
			flushList();
			blocks.push("<hr />");
			continue;
		}

		if (trimmed.startsWith(">")) {
			flushParagraph();
			flushList();
			const quoteLines = [trimmed.replace(/^>\s?/, "")];
			while (index + 1 < lines.length && lines[index + 1].trim().startsWith(">")) {
				index += 1;
				quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
			}
			blocks.push(`<blockquote>${renderInlineMarkdown(quoteLines.join(" "))}</blockquote>`);
			continue;
		}

		if (isTableHeaderLine(line) && index + 1 < lines.length && isTableDividerLine(lines[index + 1])) {
			flushParagraph();
			flushList();

			const tableLines = [line, lines[index + 1]];
			index += 2;
			while (index < lines.length && looksLikeTableRow(lines[index])) {
				tableLines.push(lines[index]);
				index += 1;
			}
			index -= 1;
			blocks.push(renderTable(tableLines));
			continue;
		}

		const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
		const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
		if (unorderedMatch || orderedMatch) {
			flushParagraph();
			const nextListType = unorderedMatch ? "ul" : "ol";
			if (listType !== nextListType) {
				flushList();
				listType = nextListType;
			}
			listItems.push(renderInlineMarkdown((unorderedMatch?.[1] ?? orderedMatch?.[1] ?? "").trim()));
			continue;
		}

		if (listType && /^\s{2,}\S+/.test(line) && listItems.length > 0) {
			const continuation = renderInlineMarkdown(trimmed);
			listItems[listItems.length - 1] += `<br />${continuation}`;
			continue;
		}

		flushList();
		paragraphLines.push(trimmed);
	}

	flushParagraph();
	flushList();

	return {
		html: blocks.join("\n"),
		lineCount: lines.length,
		mermaidBlockCount,
	};
}

function normalizeFenceLanguage(rawLanguage) {
	if (!rawLanguage) return "";
	return rawLanguage.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function renderMermaidPlaceholder(source) {
	const escapedSource = escapeHtml(source);
	return [
		'<figure class="mermaid-block" data-mermaid-block>',
		'<div class="mermaid-block__canvas"><p class="mermaid-block__status">Rendering Mermaid diagram…</p></div>',
		'<figcaption class="mermaid-block__caption">Mermaid diagram</figcaption>',
		'<details class="mermaid-block__fallback" hidden><summary>View Mermaid source</summary><pre><code data-language="mermaid"></code></pre></details>',
		`<pre class="mermaid-block__source" hidden>${escapedSource}</pre>`,
		"</figure>",
	].join("");
}

function formatDocumentSummary(lineCount, mermaidBlockCount, mermaidResult) {
	const lineSummary = `${lineCount} lines rendered`;
	if (!mermaidBlockCount) return lineSummary;
	if (!mermaidResult) {
		return `${lineSummary} · ${mermaidBlockCount} Mermaid diagram${mermaidBlockCount === 1 ? "" : "s"}`;
	}

	const parts = [`${mermaidResult.rendered} rendered`];
	if (mermaidResult.fallback > 0) {
		parts.push(`${mermaidResult.fallback} fallback`);
	}
	return `${lineSummary} · Mermaid: ${parts.join(", ")}`;
}

function formatReadyState(lineCount, mermaidResult) {
	if (!mermaidResult || mermaidResult.total === 0) {
		return `Ready · ${lineCount} lines loaded`;
	}
	if (mermaidResult.fallback > 0) {
		return `Ready · ${lineCount} lines loaded · Mermaid fallback on ${mermaidResult.fallback}`;
	}
	return `Ready · ${lineCount} lines loaded · ${mermaidResult.rendered} Mermaid diagram${mermaidResult.rendered === 1 ? "" : "s"} rendered`;
}

function renderInlineMarkdown(text) {
	if (!text) return "";

	const codeSegments = [];
	const linkSegments = [];

	let tokenized = text.replace(/`([^`]+)`/g, (_, codeText) => {
		const token = `@@INLINE_CODE_${codeSegments.length}@@`;
		codeSegments.push(`<code>${escapeHtml(codeText)}</code>`);
		return token;
	});

	tokenized = tokenized.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, link) => {
		const token = `@@INLINE_LINK_${linkSegments.length}@@`;
		const safeLabel = escapeHtml(label);
		const safeLink = escapeAttribute(link);
		linkSegments.push(`<a href="${safeLink}" target="_blank" rel="noreferrer noopener">${safeLabel}</a>`);
		return token;
	});

	let html = escapeHtml(tokenized);
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
	html = html.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
	html = html.replace(/@@INLINE_CODE_(\d+)@@/g, (_, index) => codeSegments[Number(index)] ?? "");
	html = html.replace(/@@INLINE_LINK_(\d+)@@/g, (_, index) => linkSegments[Number(index)] ?? "");
	return html;
}

function renderTable(lines) {
	const headerCells = splitTableRow(lines[0]);
	const bodyLines = lines.slice(2);

	const head = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
	const bodyRows = bodyLines
		.map((line) => splitTableRow(line))
		.map((cells) => `<tr>${cells.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
		.join("");

	const body = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
	return `<table>${head}${body}</table>`;
}

function splitTableRow(line) {
	const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return normalized.split("|").map((cell) => cell.trim());
}

function isTableHeaderLine(line) {
	return /\|/.test(line) && splitTableRow(line).length >= 2;
}

function isTableDividerLine(line) {
	const cells = splitTableRow(line);
	if (cells.length < 2) return false;
	return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeTableRow(line) {
	return /\|/.test(line) && line.trim().length > 0;
}

function readBootstrap() {
	const element = document.getElementById("review-bootstrap");
	if (!element) return null;

	try {
		const raw = element.textContent ?? "{}";
		const payload = JSON.parse(raw);
		if (!payload || typeof payload !== "object") return null;
		if (typeof payload.sessionId !== "string") return null;
		if (typeof payload.title !== "string") return null;
		if (typeof payload.docPath !== "string") return null;
		if (typeof payload.documentUrl !== "string") return null;
		if (typeof payload.healthUrl !== "string") return null;
		if (typeof payload.apiToken !== "string" || payload.apiToken.trim().length < 16) return null;
		return payload;
	} catch {
		return null;
	}
}

function collectUi() {
	const modeBadge = document.getElementById("mode-badge");
	const documentTitle = document.getElementById("document-title");
	const documentPath = document.getElementById("document-path");
	const reviewState = document.getElementById("review-state");
	const documentSummary = document.getElementById("document-summary");
	const documentContent = document.getElementById("document-content");
	const threadsSummary = document.getElementById("threads-summary");
	const threadsList = document.getElementById("threads-list");
	const threadComposerContext = document.getElementById("thread-composer-context");
	const newThreadForm = document.getElementById("new-thread-form");
	const newThreadInput = document.getElementById("new-thread-input");
	const newThreadError = document.getElementById("new-thread-error");
	const newThreadSubmit = document.getElementById("new-thread-submit");
	const endReviewButton = document.getElementById("end-review-button");
	const endReviewStatus = document.getElementById("end-review-status");
	const endReviewFallback = document.getElementById("end-review-fallback");
	const endReviewFallbackText = document.getElementById("end-review-fallback-text");

	if (!modeBadge || !documentTitle || !documentPath || !reviewState) return null;
	if (!documentSummary || !documentContent || !threadsSummary || !threadsList) return null;
	if (!threadComposerContext || !newThreadForm || !newThreadInput || !newThreadError || !newThreadSubmit) return null;
	if (!endReviewButton || !endReviewStatus || !endReviewFallback || !endReviewFallbackText) return null;

	return {
		modeBadge,
		documentTitle,
		documentPath,
		reviewState,
		documentSummary,
		documentContent,
		threadsSummary,
		threadsList,
		threadComposerContext,
		newThreadForm,
		newThreadInput,
		newThreadError,
		newThreadSubmit,
		endReviewButton,
		endReviewStatus,
		endReviewFallback,
		endReviewFallbackText,
	};
}

function renderBootFailure() {
	const root = document.getElementById("reviewer-shell") ?? document.body;
	root.innerHTML =
		'<div class="empty-state">Document reviewer UI could not initialize. Re-run <code>/review &lt;path&gt;</code> to start a new session.</div>';
}

async function readErrorMessage(response) {
	try {
		const payload = await response.json();
		if (payload && typeof payload.error === "string") {
			return payload.error;
		}
	} catch {
		// ignore parse failures
	}
	return "";
}

function setReviewState(ui, message, shortSessionId) {
	ui.reviewState.textContent = `${message} · Session ${shortSessionId}`;
}

function isEditableTarget(target) {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
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
