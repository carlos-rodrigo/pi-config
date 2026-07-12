/**
 * Builds the full HTML page for the document review UI.
 * All JS/CSS is inlined — no external files needed beyond CDN libs.
 */
export function buildReviewPage(sessionId: string, title: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Review: ${escapeHtml(title)}</title>

<!-- Marked.js for markdown rendering -->
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<!-- Mermaid for diagrams -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<!-- highlight.js for code blocks -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>

<style>
${getStyles()}
</style>
</head>
<body>

<div id="app">
  <header id="header">
    <div class="header-left">
      <span class="header-title">${escapeHtml(title)}</span>
      <span class="header-context hidden" id="session-context"></span>
      <span class="header-badge" id="comment-count">0 comments</span>
      <span class="vim-mode" id="vim-mode">NORMAL</span>
    </div>
    <div class="header-right">
      <button id="toggle-sidebar" class="btn btn-ghost" title="Toggle comments sidebar (\\\\)">
        <span>Comments</span>
      </button>
      <button id="finish-btn" class="btn btn-finish" title="Finish review and write comments to file">
        Finish Review
      </button>
    </div>
  </header>

  <div id="main">
    <div id="content" tabindex="0">
      <div id="markdown-body" class="markdown-body" tabindex="0" contenteditable="true" spellcheck="false"></div>
    </div>

    <aside id="sidebar" class="sidebar-open">
      <div class="sidebar-header">
        <h3>Comments</h3>
        <button id="close-sidebar" class="btn btn-ghost btn-sm">&times;</button>
      </div>
      <div id="comments-list"></div>
    </aside>
  </div>

  <!-- Comment input popup -->
  <div id="comment-popup" class="hidden">
    <div class="popup-header">Add Comment</div>
    <div class="popup-selected-text" id="popup-selected-text"></div>
    <div class="popup-mode-hint hidden" id="popup-mode-hint"></div>
    <textarea id="comment-input" placeholder="Type your comment..." rows="3"></textarea>
    <div class="popup-actions">
      <button id="popup-cancel" class="btn btn-ghost btn-sm">Cancel <kbd>Esc</kbd></button>
      <button id="popup-submit" class="btn btn-accent btn-sm">Submit <kbd>⌘↵</kbd></button>
    </div>
  </div>

  <!-- Finish confirmation modal -->
  <div id="finish-modal" class="hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h3>Finish Review?</h3>
      <p id="finish-description">This will finalize <strong id="finish-count">0</strong> review comment(s).</p>
      <div class="modal-actions">
        <button id="finish-cancel" class="btn btn-ghost">Cancel</button>
        <button id="finish-confirm" class="btn btn-finish">Finish &amp; Save</button>
      </div>
    </div>
  </div>

  <!-- Toast notifications -->
  <div id="toast-container"></div>

  <!-- Help overlay -->
  <div id="help-overlay" class="hidden">
    <div class="help-content">
      <h3>Keyboard Shortcuts</h3>
      <div class="help-grid">
        <div class="help-section">
          <h4>Navigation</h4>
          <div class="help-row"><kbd>j</kbd> / <kbd>k</kbd><span>Move cursor down / up (normal mode)</span></div>
          <div class="help-row"><kbd>Ctrl+D</kbd><span>Half page down</span></div>
          <div class="help-row"><kbd>Ctrl+U</kbd><span>Half page up</span></div>
          <div class="help-row"><kbd>g g</kbd><span>Go to top</span></div>
          <div class="help-row"><kbd>G</kbd><span>Go to bottom</span></div>
        </div>
        <div class="help-section">
          <h4>Review</h4>
          <div class="help-row"><kbd>v</kbd><span>Toggle visual mode (selection mode)</span></div>
          <div class="help-row"><kbd>h</kbd> / <kbd>j</kbd> / <kbd>k</kbd> / <kbd>l</kbd><span>Move cursor in visual mode</span></div>
          <div class="help-row"><kbd>Shift</kbd> + <kbd>h/j/k/l</kbd><span>Extend selection in visual mode</span></div>
          <div class="help-row"><kbd>c</kbd><span>Comment on selection</span></div>
          <div class="help-row"><kbd>\\</kbd><span>Toggle sidebar</span></div>
          <div class="help-row"><kbd>Ctrl+Enter</kbd><span>Submit comment</span></div>
          <div class="help-row"><kbd>Esc</kbd><span>Cancel popup / exit visual mode / close help</span></div>
          <div class="help-row"><kbd>Ctrl+Shift+F</kbd><span>Finish review</span></div>
        </div>
        <div class="help-section">
          <h4>Other</h4>
          <div class="help-row"><kbd>?</kbd><span>Toggle this help</span></div>
        </div>
      </div>
      <p class="help-dismiss">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>
    </div>
  </div>
</div>

<script>
${getScript(sessionId)}
</script>
</body>
</html>`;
}

export function buildHtmlVisualReviewPage(
	sessionId: string,
	title: string,
	sourceHtml: string,
	options: { nonce: string },
): string {
	const nonce = options.nonce;
	const headInjection = [
		`<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
		`<style id="pi-html-review-highlight-style" nonce="${escapeHtml(nonce)}">${getHtmlVisualReviewPageStyles()}</style>`,
	].join("\n");
	const bodyInjection = `<script nonce="${escapeHtml(nonce)}">${getHtmlVisualReviewScript(sessionId, title)}</script>`;
	return injectHtmlReviewAssets(sourceHtml, headInjection, bodyInjection);
}

function stripHtmlReviewConflicts(sourceHtml: string): string {
	return sourceHtml
		.replace(/<meta\s+[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, "")
		.replace(/<base\b[^>]*>/gi, "")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/\son[a-z]+=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function injectHtmlReviewAssets(sourceHtml: string, headInjection: string, bodyInjection: string): string {
	let html = stripHtmlReviewConflicts(sourceHtml || "");

	if (!/<html[\s>]/i.test(html)) {
		const body = /<body[\s>]/i.test(html) ? html : `<body>${html}</body>`;
		html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${headInjection}</head>${body}</html>`;
	} else if (/<head[\s>]/i.test(html)) {
		html = html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${headInjection}`);
	} else {
		html = html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}\n<head><meta charset="utf-8">${headInjection}</head>`);
	}

	if (/<\/body>/i.test(html)) {
		return html.replace(/<\/body>/i, `${bodyInjection}\n</body>`);
	}
	return `${html}\n${bodyInjection}`;
}

function getHtmlVisualReviewPageStyles(): string {
	return `
[data-review-id].pi-html-review-anchor-has-comment {
  outline: 2px solid color-mix(in srgb, #2f81f7 78%, transparent) !important;
  outline-offset: 6px !important;
  border-radius: 12px !important;
}

[data-review-id].pi-html-review-anchor-active {
  outline: 3px solid color-mix(in srgb, #f59e0b 88%, transparent) !important;
  outline-offset: 8px !important;
}
`;
}

function getHtmlVisualReviewOverlayStyles(): string {
	return `
:host { all: initial; }
* { box-sizing: border-box; }
.dock, .drawer, .popover, .toast {
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #f5f7fb;
}
.dock {
  position: fixed;
  z-index: 2147483647;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(calc(100vw - 32px), 980px);
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, .28);
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(15, 23, 42, .88), rgba(2, 6, 23, .82));
  box-shadow: 0 24px 80px rgba(2, 6, 23, .34), inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter: blur(18px) saturate(1.18);
}
.brand {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}
.mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(96, 165, 250, .16);
  color: #bfdbfe;
  font-size: 11px;
  font-weight: 850;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.mark::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, .16);
}
.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 760;
  letter-spacing: -.01em;
}
.count {
  flex: 0 0 auto;
  padding: 4px 9px;
  border: 1px solid rgba(148, 163, 184, .28);
  border-radius: 999px;
  color: #cbd5e1;
  background: rgba(15, 23, 42, .62);
  font-size: 12px;
  font-weight: 720;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
button {
  appearance: none;
  border: 1px solid rgba(148, 163, 184, .28);
  border-radius: 999px;
  background: rgba(15, 23, 42, .74);
  color: #e2e8f0;
  min-height: 36px;
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 760;
  cursor: pointer;
  transition: transform .16s ease, background .16s ease, border-color .16s ease, opacity .16s ease;
}
button:hover:not(:disabled) { transform: translateY(-1px); background: rgba(30, 41, 59, .92); border-color: rgba(203, 213, 225, .42); }
button:focus-visible, textarea:focus-visible { outline: 3px solid rgba(96, 165, 250, .72); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: .48; }
.primary { background: linear-gradient(135deg, #86efac, #22c55e); color: #04130a; border-color: rgba(134, 239, 172, .72); }
.accent { background: linear-gradient(135deg, #bfdbfe, #60a5fa); color: #061529; border-color: rgba(147, 197, 253, .75); }
.drawer {
  position: fixed;
  z-index: 2147483646;
  top: 78px;
  right: 18px;
  bottom: 18px;
  width: min(420px, calc(100vw - 36px));
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(148, 163, 184, .28);
  border-radius: 28px;
  background: linear-gradient(180deg, rgba(15, 23, 42, .94), rgba(2, 6, 23, .92));
  box-shadow: 0 24px 80px rgba(2, 6, 23, .42), inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter: blur(18px) saturate(1.14);
  transform: translateX(calc(100% + 28px));
  opacity: .2;
  pointer-events: none;
  transition: transform .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease;
}
.drawer[data-open="true"] { transform: translateX(0); opacity: 1; pointer-events: auto; }
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, .18);
}
.drawer-header h2 { margin: 0; font-size: 13px; letter-spacing: .11em; text-transform: uppercase; color: #93c5fd; }
.comments {
  display: grid;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}
.empty {
  padding: 28px 18px;
  border: 1px dashed rgba(148, 163, 184, .28);
  border-radius: 20px;
  color: #cbd5e1;
  line-height: 1.5;
}
.comment-card {
  display: grid;
  gap: 9px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, .22);
  border-radius: 20px;
  background: rgba(15, 23, 42, .68);
}
.snippet {
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.45;
  max-height: 82px;
  overflow: hidden;
}
.anchor {
  width: max-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, .14);
  color: #fde68a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 800;
}
.note { color: #f8fafc; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-footer { display: flex; justify-content: flex-end; }
.danger { color: #fca5a5; }
.popover {
  position: fixed;
  z-index: 2147483647;
  width: min(390px, calc(100vw - 24px));
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, .3);
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(15, 23, 42, .97), rgba(2, 6, 23, .96));
  box-shadow: 0 22px 70px rgba(2, 6, 23, .42), inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter: blur(18px) saturate(1.14);
}
.popover[hidden] { display: none; }
.popover h2 { margin: 0 0 8px; color: #bfdbfe; font-size: 13px; letter-spacing: .09em; text-transform: uppercase; }
.selection-preview {
  max-height: 84px;
  overflow: auto;
  margin-bottom: 10px;
  padding: 10px;
  border-radius: 16px;
  background: rgba(148, 163, 184, .12);
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.45;
}
textarea {
  width: 100%;
  min-height: 92px;
  resize: vertical;
  border: 1px solid rgba(148, 163, 184, .26);
  border-radius: 18px;
  padding: 12px;
  background: rgba(2, 6, 23, .62);
  color: #f8fafc;
  font: inherit;
  font-size: 14px;
  line-height: 1.45;
}
.popover-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.toast {
  position: fixed;
  z-index: 2147483647;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 32px));
  padding: 12px 16px;
  border: 1px solid rgba(148, 163, 184, .28);
  border-radius: 999px;
  background: rgba(15, 23, 42, .94);
  color: #e2e8f0;
  box-shadow: 0 18px 60px rgba(2, 6, 23, .38);
  font-size: 13px;
}
.hint {
  color: #94a3b8;
  font-size: 12px;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .dock { top: 10px; width: calc(100vw - 20px); border-radius: 24px; align-items: stretch; flex-direction: column; }
  .brand, .actions { width: 100%; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; }
  .hint { display: none; }
  button { width: 100%; }
  .drawer { top: 132px; right: 10px; bottom: 10px; width: calc(100vw - 20px); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: .001ms !important; animation-duration: .001ms !important; }
}
`;
}

function getHtmlVisualReviewScript(sessionId: string, title: string): string {
	return `
(function() {
  'use strict';

  const SESSION_ID = ${JSON.stringify(sessionId)};
  const REVIEW_TITLE = ${JSON.stringify(title)};
  const API_BASE = window.location.origin + '/api/' + SESSION_ID;
  const OVERLAY_CSS = ${JSON.stringify(getHtmlVisualReviewOverlayStyles())};

  let comments = [];
  let currentSelection = null;
  let pendingSelection = null;
  let drawerOpen = false;
  let reviewCompleted = false;
  let pendingDecisionWrite = Promise.resolve();

  const host = document.createElement('div');
  host.id = 'pi-html-review-root';
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;');
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.innerHTML =
    '<section class="dock" role="region" aria-label="HTML review controls">' +
      '<div class="brand"><span class="mark">Review</span><span class="title" id="review-title"></span><span class="count" id="comment-count">0 comments</span></div>' +
      '<div class="actions">' +
        '<button id="comment-selection" class="accent" type="button" disabled>Comment selection</button>' +
        '<button id="toggle-drawer" type="button">Comments</button>' +
        '<button id="finish-review" class="primary" type="button">Finish Review</button>' +
      '</div>' +
      '<span class="hint">Select text, press c</span>' +
    '</section>' +
    '<aside class="drawer" id="drawer" data-open="false" aria-label="Review comments">' +
      '<div class="drawer-header"><h2>Comments</h2><button id="close-drawer" type="button">Close</button></div>' +
      '<div class="comments" id="comments"></div>' +
    '</aside>' +
    '<section class="popover" id="popover" hidden aria-label="Add review comment">' +
      '<h2>Add Comment</h2>' +
      '<div class="selection-preview" id="selection-preview"></div>' +
      '<textarea id="comment-input" placeholder="What should change?" rows="4"></textarea>' +
      '<div class="popover-actions"><button id="cancel-comment" type="button">Cancel</button><button id="submit-comment" class="primary" type="button">Submit</button></div>' +
    '</section>' +
    '<div class="toast" id="toast" hidden></div>';
  shadow.appendChild(root);

  const titleEl = shadow.getElementById('review-title');
  const countEl = shadow.getElementById('comment-count');
  const commentButton = shadow.getElementById('comment-selection');
  const toggleDrawerButton = shadow.getElementById('toggle-drawer');
  const closeDrawerButton = shadow.getElementById('close-drawer');
  const finishButton = shadow.getElementById('finish-review');
  const drawer = shadow.getElementById('drawer');
  const commentsEl = shadow.getElementById('comments');
  const popover = shadow.getElementById('popover');
  const selectionPreview = shadow.getElementById('selection-preview');
  const commentInput = shadow.getElementById('comment-input');
  const cancelCommentButton = shadow.getElementById('cancel-comment');
  const submitCommentButton = shadow.getElementById('submit-comment');
  const toastEl = shadow.getElementById('toast');

  titleEl.textContent = REVIEW_TITLE;

  function setOverlayPointerMode() {
    host.style.pointerEvents = drawerOpen || !popover.hidden ? 'auto' : 'none';
    const dock = shadow.querySelector('.dock');
    if (dock) dock.style.pointerEvents = 'auto';
    drawer.style.pointerEvents = drawerOpen ? 'auto' : 'none';
    popover.style.pointerEvents = popover.hidden ? 'none' : 'auto';
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    return tag === 'textarea' || tag === 'input' || tag === 'select' || target.isContentEditable;
  }

  function findReviewId(node) {
    let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    while (current && current !== document.documentElement) {
      if (current.getAttribute && current.getAttribute('data-review-id')) {
        return current.getAttribute('data-review-id');
      }
      current = current.parentElement;
    }
    return undefined;
  }

  function findContextElement(node) {
    let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    while (current && current !== document.documentElement) {
      if (current.getAttribute && current.getAttribute('data-review-id')) return current;
      if (/^(section|article|main|aside|header|footer|figure|table|tr|li|p|div)$/i.test(current.tagName || '')) return current;
      current = current.parentElement;
    }
    return document.body;
  }

  function getSelectionRect(range) {
    const rects = Array.from(range.getClientRects());
    const usable = rects.find((rect) => rect.width > 0 || rect.height > 0);
    return usable || range.getBoundingClientRect();
  }

  function buildSelector(range, selectedText) {
    const container = findContextElement(range.commonAncestorContainer);
    const text = (container && (container.innerText || container.textContent)) || '';
    const index = text.indexOf(selectedText);
    if (index === -1) return { exact: selectedText };
    return {
      exact: selectedText,
      prefix: text.slice(Math.max(0, index - 80), index).trim(),
      suffix: text.slice(index + selectedText.length, index + selectedText.length + 80).trim(),
    };
  }

  function readSelection() {
    const activeInShadow = shadow.activeElement;
    if (isTypingTarget(document.activeElement) || isTypingTarget(activeInShadow)) return null;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    if (!selection || !selectedText || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer)) return null;
    const rect = getSelectionRect(range);
    const reviewId = findReviewId(range.commonAncestorContainer || selection.anchorNode);
    return {
      selectedText,
      offsetStart: 0,
      offsetEnd: 0,
      reviewId,
      selector: buildSelector(range, selectedText),
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
    };
  }

  function updateSelectionState() {
    currentSelection = readSelection();
    commentButton.disabled = !currentSelection;
    document.querySelectorAll('.pi-html-review-anchor-active').forEach((node) => node.classList.remove('pi-html-review-anchor-active'));
    if (currentSelection && currentSelection.reviewId) {
      document.querySelectorAll('[data-review-id]').forEach((node) => {
        if (node.getAttribute('data-review-id') === currentSelection.reviewId) {
          node.classList.add('pi-html-review-anchor-active');
        }
      });
    }
  }

  function setDrawerOpen(open) {
    drawerOpen = open;
    drawer.setAttribute('data-open', open ? 'true' : 'false');
    setOverlayPointerMode();
  }

  function positionPopover(selection) {
    const width = 390;
    const left = Math.max(12, Math.min(selection.rect.left, window.innerWidth - width - 12));
    let top = selection.rect.bottom + 12;
    if (top + 280 > window.innerHeight) top = Math.max(12, selection.rect.top - 280);
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  function openCommentPopover(selection) {
    if (!selection) {
      showToast('Select text in the document first, then press c.');
      return;
    }
    pendingSelection = selection;
    selectionPreview.textContent = selection.selectedText.slice(0, 500) + (selection.selectedText.length > 500 ? '…' : '');
    commentInput.value = '';
    positionPopover(selection);
    popover.hidden = false;
    setOverlayPointerMode();
    commentInput.focus();
  }

  function closeCommentPopover() {
    pendingSelection = null;
    popover.hidden = true;
    setOverlayPointerMode();
  }

  async function fetchJson(path, options) {
    const response = await fetch(API_BASE + path, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }

  async function submitComment() {
    const text = commentInput.value.trim();
    if (!pendingSelection || !text) return;
    const payload = {
      selectedText: pendingSelection.selectedText,
      comment: text,
      offsetStart: 0,
      offsetEnd: 0,
      reviewId: pendingSelection.reviewId,
      selector: pendingSelection.selector || { exact: pendingSelection.selectedText },
    };
    try {
      const data = await fetchJson('/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      comments.push(data.comment);
      closeCommentPopover();
      renderComments();
      markCommentAnchors();
      setDrawerOpen(true);
      showToast('Comment added.');
    } catch (error) {
      showToast('Error creating comment: ' + error.message);
    }
  }

  function decisionOptionText(input) {
    const label = input.closest('label');
    if (!label) return input.value || 'Selected option';
    const clone = label.cloneNode(true);
    clone.querySelectorAll('input').forEach((node) => node.remove());
    return (clone.textContent || input.value || 'Selected option').replace(/\\s+/g, ' ').trim().replace(/:\\s*$/, '');
  }

  async function recordDecision(input) {
    const decision = input.closest('[data-review-decision]');
    const anchor = decision && decision.closest('[data-review-id]');
    const reviewId = anchor && anchor.getAttribute('data-review-id');
    if (!decision || !reviewId) return;

    const selected = decision.querySelector('input[type="radio"]:checked');
    if (!selected) return;
    const optionText = decisionOptionText(selected);
    const customInput = selected.closest('label')?.querySelector('input[type="text"], textarea');
    const customText = customInput && customInput.value ? customInput.value.trim() : '';
    const commentText = 'Decision selected: ' + optionText + (customText ? ' — ' + customText : '');
    const previous = comments.find((comment) => comment.reviewId === reviewId && String(comment.comment || '').startsWith('Decision selected:'));

    try {
      if (previous) {
        await fetchJson('/comments/' + previous.id, { method: 'DELETE' });
        comments = comments.filter((comment) => comment.id !== previous.id);
      }
      const data = await fetchJson('/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedText: optionText,
          comment: commentText,
          offsetStart: 0,
          offsetEnd: 0,
          reviewId,
          selector: { exact: optionText },
        }),
      });
      comments.push(data.comment);
      renderComments();
      markCommentAnchors();
      showToast('Decision recorded as review feedback.');
    } catch (error) {
      showToast('Error recording decision: ' + error.message);
    }
  }

  function queueDecision(input) {
    pendingDecisionWrite = pendingDecisionWrite.then(() => recordDecision(input));
  }

  async function deleteComment(commentId) {
    try {
      await fetchJson('/comments/' + commentId, { method: 'DELETE' });
      comments = comments.filter((comment) => comment.id !== commentId);
      renderComments();
      markCommentAnchors();
      showToast('Comment deleted.');
    } catch (error) {
      showToast('Error deleting comment: ' + error.message);
    }
  }

  function markCommentAnchors() {
    document.querySelectorAll('.pi-html-review-anchor-has-comment').forEach((node) => node.classList.remove('pi-html-review-anchor-has-comment'));
    const ids = new Set(comments.map((comment) => comment.reviewId).filter(Boolean));
    if (ids.size === 0) return;
    document.querySelectorAll('[data-review-id]').forEach((node) => {
      if (ids.has(node.getAttribute('data-review-id'))) node.classList.add('pi-html-review-anchor-has-comment');
    });
  }

  function makeText(className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
  }

  function renderComments() {
    countEl.textContent = comments.length + ' comment' + (comments.length === 1 ? '' : 's');
    commentsEl.textContent = '';
    if (comments.length === 0) {
      const empty = makeText('empty', 'No comments yet. Select text in the document and press c, or use Comment selection.');
      commentsEl.appendChild(empty);
      return;
    }

    comments.forEach((comment) => {
      const card = document.createElement('article');
      card.className = 'comment-card';
      card.appendChild(makeText('snippet', comment.selectedText || '(empty selection)'));
      if (comment.reviewId) card.appendChild(makeText('anchor', comment.reviewId));
      card.appendChild(makeText('note', comment.comment || '(empty note)'));
      const footer = document.createElement('div');
      footer.className = 'comment-footer';
      const button = document.createElement('button');
      button.className = 'danger';
      button.type = 'button';
      button.textContent = 'Delete';
      button.addEventListener('click', () => deleteComment(comment.id));
      footer.appendChild(button);
      card.appendChild(footer);
      commentsEl.appendChild(card);
    });
  }

  async function finishReview() {
    if (reviewCompleted) return;
    try {
      await pendingDecisionWrite;
      const data = await fetchJson('/finish', { method: 'POST' });
      reviewCompleted = true;
      finishButton.textContent = 'Done';
      finishButton.disabled = true;
      showToast('Review complete: ' + data.commentsWritten + ' comment(s) written to sidecar.');
      window.setTimeout(() => {
        try { window.close(); } catch (_error) { /* no-op */ }
      }, 120);
    } catch (error) {
      showToast('Error finishing review: ' + error.message);
    }
  }

  function openExternalLinksInNewTab(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const anchor = target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (/^(mailto|tel):/i.test(href)) return;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) return;
    event.preventDefault();
    window.open(url.href, '_blank', 'noopener,noreferrer');
    showToast('Opened external link in a new tab.');
  }

  document.addEventListener('click', openExternalLinksInNewTab, true);
  document.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('[data-review-decision]')) return;
    if (target.matches('input[type="radio"]')) queueDecision(target);
    if (target.matches('input[type="text"], textarea')) {
      const selected = target.closest('[data-review-decision]')?.querySelector('input[type="radio"]:checked');
      if (selected) queueDecision(selected);
    }
  });
  document.addEventListener('selectionchange', () => window.setTimeout(updateSelectionState, 30));
  document.addEventListener('mouseup', () => window.setTimeout(updateSelectionState, 0));
  document.addEventListener('keyup', () => window.setTimeout(updateSelectionState, 0));
  document.addEventListener('keydown', (event) => {
    const activeInShadow = shadow.activeElement;
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      finishReview();
      return;
    }
    if (event.key === 'Escape' && !popover.hidden) {
      event.preventDefault();
      closeCommentPopover();
      return;
    }
    if (isTypingTarget(event.target) || isTypingTarget(activeInShadow)) return;
    if (event.key === '\\\\') {
      event.preventDefault();
      setDrawerOpen(!drawerOpen);
      return;
    }
    if (event.key && event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      updateSelectionState();
      if (currentSelection) {
        event.preventDefault();
        openCommentPopover(currentSelection);
      }
    }
  });

  commentInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submitComment();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommentPopover();
    }
  });
  commentButton.addEventListener('click', () => {
    updateSelectionState();
    openCommentPopover(currentSelection);
  });
  toggleDrawerButton.addEventListener('click', () => setDrawerOpen(!drawerOpen));
  closeDrawerButton.addEventListener('click', () => setDrawerOpen(false));
  finishButton.addEventListener('click', finishReview);
  cancelCommentButton.addEventListener('click', closeCommentPopover);
  submitCommentButton.addEventListener('click', submitComment);

  fetchJson('/comments')
    .then((data) => {
      comments = data.comments || [];
      renderComments();
      markCommentAnchors();
      setOverlayPointerMode();
    })
    .catch((error) => showToast('Failed to load review comments: ' + error.message));
})();
`;
}

export interface ReviewSelectionMetadata {
	offsetStart: number;
	offsetEnd: number;
	/** The actual text matched in the markdown source (may include formatting chars). */
	matchedText?: string;
	lineStart?: number;
	lineEnd?: number;
	inlineEligible?: boolean;
	fallbackReason?: string;
}

export type ReviewSourceKind = "markdown" | "html";

export interface ReviewSelectionDraft extends ReviewSelectionMetadata {
	selectedText: string;
	reviewId?: string;
	selector?: {
		exact: string;
		prefix?: string;
		suffix?: string;
	};
}

export interface PullRequestSessionDisplayContext {
	owner: string;
	repo: string;
	number: number;
	filePath?: string;
}

type ProjectedCharacter = {
	char: string;
	start: number;
	end: number;
};

function parseDelimitedRange(
	source: string,
	start: number,
	openChar: string,
	closeChar: string,
): {contentStart: number; contentEnd: number; end: number} | null {
	if (source[start] !== openChar) return null;

	let depth = 0;
	for (let index = start + 1; index < source.length; index++) {
		const char = source[index]!;
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "\n") return null;
		if (char === openChar) {
			depth += 1;
			continue;
		}
		if (char !== closeChar) continue;
		if (depth > 0) {
			depth -= 1;
			continue;
		}
		return {contentStart: start + 1, contentEnd: index, end: index + 1};
	}

	return null;
}

function parseInlineLinkRange(source: string, start: number): {labelStart: number; labelEnd: number; end: number} | null {
	const bracketStart = source[start] === "!" && source[start + 1] === "[" ? start + 1 : start;
	if (source[bracketStart] !== "[") return null;

	const label = parseDelimitedRange(source, bracketStart, "[", "]");
	if (!label) return null;

	const afterLabel = label.end;
	if (source[afterLabel] === "(") {
		const destination = parseDelimitedRange(source, afterLabel, "(", ")");
		if (!destination) return null;
		return {labelStart: label.contentStart, labelEnd: label.contentEnd, end: destination.end};
	}
	if (source[afterLabel] === "[") {
		const reference = parseDelimitedRange(source, afterLabel, "[", "]");
		if (!reference) return null;
		return {labelStart: label.contentStart, labelEnd: label.contentEnd, end: reference.end};
	}

	return {labelStart: label.contentStart, labelEnd: label.contentEnd, end: label.end};
}

function parseInlineCodeSpanRange(source: string, start: number): {contentStart: number; contentEnd: number; end: number} | null {
	if (source[start] !== "`") return null;

	let tickCount = 1;
	while (source[start + tickCount] === "`") tickCount += 1;
	const closingFence = "`".repeat(tickCount);
	const closingIndex = source.indexOf(closingFence, start + tickCount);
	if (closingIndex === -1) return null;

	return {
		contentStart: start + tickCount,
		contentEnd: closingIndex,
		end: closingIndex + tickCount,
	};
}

function consumeMarkdownLinePrefix(source: string, start: number): number {
	let cursor = start;
	let consumedMarker = false;

	const skipIndent = () => {
		let width = 0;
		while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t") && width < 4) {
			cursor += 1;
			width += 1;
		}
	};

	skipIndent();
	while (source[cursor] === ">") {
		consumedMarker = true;
		cursor += 1;
		skipIndent();
	}

	const headingMatch = source.slice(cursor).match(/^(#{1,6})[ \t]+/);
	if (headingMatch) {
		cursor += headingMatch[0].length;
		return cursor;
	}

	const listMatch = source.slice(cursor).match(/^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/);
	if (listMatch) {
		cursor += listMatch[0].length;
		return cursor;
	}

	return consumedMarker ? cursor : start;
}

function projectMarkdownForMatching(markdown: string): ProjectedCharacter[] {
	const projected: ProjectedCharacter[] = [];
	let index = 0;
	let lineStart = true;
	let fenceMarker: string | null = null;

	const appendText = (text: string, start: number, end: number) => {
		for (const char of text) projected.push({char, start, end});
	};

	while (index < markdown.length) {
		if (lineStart) {
			let fenceCursor = index;
			while (fenceCursor < markdown.length && (markdown[fenceCursor] === " " || markdown[fenceCursor] === "\t") && fenceCursor - index < 4) {
				fenceCursor += 1;
			}
			const fenceChar = markdown[fenceCursor];
			if (fenceChar === "`" || fenceChar === "~") {
				let fenceEnd = fenceCursor;
				while (markdown[fenceEnd] === fenceChar) fenceEnd += 1;
				if (fenceEnd - fenceCursor >= 3) {
					const marker = markdown.slice(fenceCursor, fenceEnd);
					if (!fenceMarker) {
						fenceMarker = marker;
					} else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
						fenceMarker = null;
					}
					while (index < markdown.length && markdown[index] !== "\n") index += 1;
					if (markdown[index] === "\n") index += 1;
					lineStart = true;
					continue;
				}
			}

			if (!fenceMarker) {
				const prefixed = consumeMarkdownLinePrefix(markdown, index);
				if (prefixed !== index) {
					index = prefixed;
					lineStart = false;
					if (index >= markdown.length) break;
				}
			}
		}

		if (!fenceMarker) {
			if (markdown.startsWith("<!--", index)) {
				const commentEnd = markdown.indexOf("-->", index + 4);
				if (commentEnd !== -1) {
					index = commentEnd + 3;
					continue;
				}
			}

			const link = parseInlineLinkRange(markdown, index);
			if (link) {
				const labelProjection = projectMarkdownForMatching(markdown.slice(link.labelStart, link.labelEnd));
				if (labelProjection.length > 0) {
					for (const item of labelProjection) projected.push({char: item.char, start: index, end: link.end});
				} else {
					appendText(markdown.slice(link.labelStart, link.labelEnd), index, link.end);
				}
				index = link.end;
				lineStart = false;
				continue;
			}

			const inlineCode = parseInlineCodeSpanRange(markdown, index);
			if (inlineCode) {
				appendText(markdown.slice(inlineCode.contentStart, inlineCode.contentEnd), index, inlineCode.end);
				index = inlineCode.end;
				lineStart = false;
				continue;
			}

			if (markdown[index] === "\\" && index + 1 < markdown.length) {
				const escaped = markdown[index + 1]!;
				projected.push({char: escaped, start: index, end: index + 2});
				lineStart = escaped === "\n";
				index += 2;
				continue;
			}

			if (markdown[index] === "<") {
				const autolinkEnd = markdown.indexOf(">", index + 1);
				const autolinkContent = autolinkEnd === -1 ? "" : markdown.slice(index + 1, autolinkEnd);
				if (autolinkEnd !== -1 && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(autolinkContent) || autolinkContent.includes("@"))) {
					appendText(autolinkContent, index, autolinkEnd + 1);
					index = autolinkEnd + 1;
					lineStart = false;
					continue;
				}
			}

			if (markdown[index] === "*" || markdown[index] === "_" || markdown[index] === "~" || markdown[index] === "`") {
				index += 1;
				continue;
			}
		}

		const char = markdown[index]!;
		projected.push({char, start: index, end: index + 1});
		lineStart = char === "\n";
		index += 1;
	}

	return projected;
}

function normalizeProjectedCharacters(characters: ProjectedCharacter[]): ProjectedCharacter[] {
	const normalized: ProjectedCharacter[] = [];

	for (const character of characters) {
		if (/\s/.test(character.char)) {
			const previous = normalized.at(-1);
			if (previous?.char === " ") {
				previous.end = character.end;
				continue;
			}
			normalized.push({char: " ", start: character.start, end: character.end});
			continue;
		}
		normalized.push({...character});
	}

	return normalized;
}

function normalizeSearchTextForMatching(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function expandSelectionToSafeRange(markdown: string, start: number, end: number): {start: number; end: number} {
	let expandedStart = start;
	let expandedEnd = end;

	while (expandedStart > 0 && /[*_~`]/.test(markdown[expandedStart - 1]!)) expandedStart -= 1;
	while (expandedEnd < markdown.length && /[*_~`]/.test(markdown[expandedEnd]!)) expandedEnd += 1;

	const lineStart = markdown.lastIndexOf("\n", expandedStart - 1) + 1;
	const lineBreakAfterEnd = markdown.indexOf("\n", expandedEnd);
	const lineEnd = lineBreakAfterEnd === -1 ? markdown.length : lineBreakAfterEnd;

	for (let index = lineStart; index <= lineEnd; index++) {
		const link = parseInlineLinkRange(markdown, index);
		if (link && link.labelStart <= expandedStart && expandedEnd <= link.labelEnd) {
			expandedStart = index;
			expandedEnd = link.end;
			break;
		}

		const inlineCode = parseInlineCodeSpanRange(markdown, index);
		if (inlineCode && inlineCode.contentStart <= expandedStart && expandedEnd <= inlineCode.contentEnd) {
			expandedStart = index;
			expandedEnd = inlineCode.end;
			break;
		}
	}

	while (expandedStart > 0 && /[*_~`]/.test(markdown[expandedStart - 1]!)) expandedStart -= 1;
	while (expandedEnd < markdown.length && /[*_~`]/.test(markdown[expandedEnd]!)) expandedEnd += 1;

	return {start: expandedStart, end: expandedEnd};
}

/**
 * Try to find `searchText` in `markdown` by projecting the markdown source into
 * the rendered text a reviewer can actually select.
 */
export function findFlexibleMatch(markdown: string, searchText: string): { start: number; end: number } | null {
	if (!searchText || !markdown) return null;

	const normalizedSearch = normalizeSearchTextForMatching(searchText);
	if (!normalizedSearch) return null;

	const projected = normalizeProjectedCharacters(projectMarkdownForMatching(markdown));
	const projectedText = projected.map((character) => character.char).join("");
	const matchIndex = projectedText.indexOf(normalizedSearch);
	if (matchIndex === -1) return null;

	const lastCharacter = projected[matchIndex + normalizedSearch.length - 1];
	if (!lastCharacter) return null;

	return expandSelectionToSafeRange(markdown, projected[matchIndex]!.start, lastCharacter.end);
}

export function computeSelectionMetadata(markdown: string, selectedText: string): ReviewSelectionMetadata {
	// Strategy 1: exact substring match
	const exactIdx = markdown.indexOf(selectedText);
	if (exactIdx !== -1) {
		const expanded = expandSelectionToSafeRange(markdown, exactIdx, exactIdx + selectedText.length);
		return buildSelectionResult(markdown, markdown.slice(expanded.start, expanded.end), expanded.start, expanded.end);
	}

	// Strategy 2: trimmed match
	const trimmed = selectedText.trim();
	if (trimmed) {
		const trimmedIdx = markdown.indexOf(trimmed);
		if (trimmedIdx !== -1) {
			const expanded = expandSelectionToSafeRange(markdown, trimmedIdx, trimmedIdx + trimmed.length);
			return buildSelectionResult(markdown, markdown.slice(expanded.start, expanded.end), expanded.start, expanded.end);
		}
	}

	// Strategy 3: flexible match — compare against a markdown-aware rendered projection
	const flex = findFlexibleMatch(markdown, selectedText);
	if (flex) {
		return buildSelectionResult(markdown, markdown.slice(flex.start, flex.end), flex.start, flex.end);
	}

	// No match found
	return { offsetStart: -1, offsetEnd: -1 };
}

function buildSelectionResult(
	markdown: string,
	matchedText: string,
	offsetStart: number,
	offsetEnd: number,
): ReviewSelectionMetadata {
	const lineStart = markdown.slice(0, offsetStart).split("\n").length;
	const lineEnd = markdown.slice(0, Math.max(offsetStart, offsetEnd - 1) + 1).split("\n").length;
	const inlineEligible = lineStart === lineEnd;

	return {
		offsetStart,
		offsetEnd,
		matchedText,
		lineStart,
		lineEnd,
		inlineEligible,
		fallbackReason: inlineEligible ? undefined : "multi_line_selection",
	};
}

export function buildCommentDraftPayload(
	sessionMode: "document" | "pull_request",
	selection: ReviewSelectionDraft,
	comment: string,
	sourceKind: ReviewSourceKind = "markdown",
) {
	const payload: Record<string, unknown> = {
		selectedText: selection.selectedText,
		comment,
		offsetStart: selection.offsetStart,
		offsetEnd: selection.offsetEnd,
	};

	if (sourceKind === "html") {
		if (selection.reviewId) payload.reviewId = selection.reviewId;
		if (selection.selector) payload.selector = selection.selector;
		return payload;
	}

	if (sessionMode === "pull_request" && selection.lineStart !== undefined && selection.lineEnd !== undefined) {
		payload.lineStart = selection.lineStart;
		payload.lineEnd = selection.lineEnd;
	}

	return payload;
}

export function formatPullRequestSessionContext(
	pullRequest: PullRequestSessionDisplayContext | null,
	sessionFilePath = "",
): string {
	if (!pullRequest) return "";
	const prLabel = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
	const fileLabel = pullRequest.filePath || sessionFilePath;
	return prLabel + (fileLabel ? ` · ${fileLabel}` : "");
}

export function buildFinishDescription(
	sessionMode: "document" | "pull_request",
	commentCount: number,
	sourceKind: ReviewSourceKind = "markdown",
): string {
	if (sessionMode === "pull_request") {
		return `This will submit <strong id="finish-count">${commentCount}</strong> comment(s) to the GitHub pull request review. Single-line selections stay inline when possible; multi-line selections are grouped under <code>Fallback comments</code>.`;
	}

	if (sourceKind === "html") {
		return `This will write <strong id="finish-count">${commentCount}</strong> comment(s) to a sidecar <code>.review.md</code> file. The source HTML will not be modified.`;
	}

	return `This will insert <strong id="finish-count">${commentCount}</strong> comment(s) as <code>&lt;!-- REVIEW: ... --&gt;</code> annotations into the original markdown file.`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function getStyles(): string {
	return `
:root {
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --text-dim: #6e7681;
  --accent: #58a6ff;
  --accent-muted: #1f6feb;
  --success: #3fb950;
  --warning: #d29922;
  --error: #f85149;
  --highlight-bg: rgba(88, 166, 255, 0.15);
  --comment-bg: rgba(88, 166, 255, 0.08);
  --sidebar-width: 360px;
  --header-height: 48px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

.hidden { display: none !important; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  height: 100vh;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Header */
#header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: var(--header-height);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  z-index: 10;
}

.header-left { display: flex; align-items: center; gap: 12px; }
.header-right { display: flex; align-items: center; gap: 8px; }

.header-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.header-context {
  font-size: 12px;
  color: var(--accent);
  background: rgba(31, 111, 235, 0.12);
  border: 1px solid rgba(88, 166, 255, 0.25);
  border-radius: 999px;
  padding: 2px 8px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
}

.vim-mode {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--accent-muted);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.vim-mode.insert-mode {
  background: #238636;
}

.vim-mode.visual-mode {
  background: #8957e5;
}

/* Buttons */
.btn {
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 12px;
  transition: all 0.15s ease;
  font-family: inherit;
}

.btn-ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.btn-ghost:hover { background: var(--bg-tertiary); color: var(--text); }

.btn-accent {
  background: var(--accent-muted);
  color: var(--text);
}
.btn-accent:hover { background: var(--accent); }

.btn-finish {
  background: var(--success);
  color: #000;
  font-weight: 600;
}
.btn-finish:hover { filter: brightness(1.15); }

.btn-sm { padding: 4px 8px; font-size: 12px; }

kbd {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

/* Main layout */
#main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

#content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 48px;
  outline: none;
  scroll-behavior: auto;
}

#content.html-review-content {
  padding: 12px;
}

#content.visual-mode {
  cursor: text;
}

/* Sidebar */
#sidebar {
  width: var(--sidebar-width);
  background: var(--bg-secondary);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  flex-shrink: 0;
  transition: width 0.2s ease, opacity 0.2s ease;
}

#sidebar.sidebar-closed {
  width: 0;
  overflow: hidden;
  opacity: 0;
  border-left: none;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.sidebar-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

#comments-list {
  padding: 8px;
}

.comment-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  transition: border-color 0.15s ease;
}

.comment-card:hover {
  border-color: var(--accent);
}

.comment-selected-text {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--comment-bg);
  padding: 4px 8px;
  border-radius: 4px;
  border-left: 2px solid var(--accent);
  margin-bottom: 8px;
  max-height: 60px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

.comment-text {
  font-size: 13px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

.comment-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.comment-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
}

.comment-badge-inline {
  color: var(--success);
  border-color: rgba(63, 185, 80, 0.35);
}

.comment-badge-fallback {
  color: var(--warning);
  border-color: rgba(210, 153, 34, 0.35);
}

.comment-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.comment-delete {
  font-size: 11px;
  color: var(--text-dim);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.comment-delete:hover { color: var(--error); background: rgba(248, 81, 73, 0.1); }

.no-comments {
  text-align: center;
  color: var(--text-dim);
  padding: 32px 16px;
  font-size: 13px;
}

/* Markdown body */
.markdown-body {
  color: var(--text);
  font-size: 15px;
  line-height: 1.7;
  max-width: 860px;
  caret-color: var(--accent);
  outline: none;
}

.markdown-body:focus {
  outline: none;
}

.markdown-body.html-review-shell {
  max-width: none;
  width: 100%;
  height: calc(100vh - var(--header-height) - 24px);
}

#html-review-frame {
  width: 100%;
  min-height: 100%;
  height: calc(100vh - var(--header-height) - 24px);
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
}

#content.visual-mode .markdown-body ::selection,
#content.visual-mode .markdown-body::selection {
  background: rgba(88, 166, 255, 0.35);
}

.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  color: var(--text);
  border-bottom: none;
  padding-bottom: 0;
}

.markdown-body h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-body h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.25em; }

.markdown-body p { margin-bottom: 1em; }

.markdown-body a { color: var(--accent); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }

.markdown-body code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.88em;
  background: var(--bg-tertiary);
  padding: 0.2em 0.4em;
  border-radius: 4px;
}

.markdown-body pre {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
  margin-bottom: 1em;
}

.markdown-body pre code {
  background: none;
  padding: 0;
  font-size: 13px;
  line-height: 1.5;
}

.markdown-body blockquote {
  border-left: 3px solid var(--border);
  padding-left: 16px;
  color: var(--text-muted);
  margin-bottom: 1em;
}

.markdown-body ul, .markdown-body ol {
  padding-left: 2em;
  margin-bottom: 1em;
}

.markdown-body li { margin-bottom: 0.3em; }

.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1em;
}

.markdown-body th, .markdown-body td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.markdown-body th {
  background: var(--bg-secondary);
  font-weight: 600;
}

.markdown-body hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}

.markdown-body img {
  max-width: 100%;
  border-radius: 8px;
}

/* Mermaid */
.mermaid {
  display: flex;
  justify-content: center;
  margin: 1em 0;
}

/* Highlighted selection (for comments) */
.review-highlight {
  background: var(--highlight-bg);
  border-bottom: 2px solid var(--accent);
  cursor: pointer;
  border-radius: 2px;
  transition: background 0.15s ease;
}

.review-highlight:hover {
  background: rgba(88, 166, 255, 0.25);
}

/* Comment popup */
#comment-popup {
  position: fixed;
  z-index: 100;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  width: 380px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}

#comment-popup.hidden { display: none; }

.popup-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.popup-selected-text {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--comment-bg);
  padding: 6px 10px;
  border-radius: 4px;
  border-left: 2px solid var(--accent);
  margin-bottom: 12px;
  max-height: 80px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

.popup-mode-hint {
  font-size: 12px;
  color: var(--warning);
  background: rgba(210, 153, 34, 0.12);
  border: 1px solid rgba(210, 153, 34, 0.35);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 12px;
  line-height: 1.5;
}

#comment-input {
  width: 100%;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  min-height: 60px;
  outline: none;
}

#comment-input:focus {
  border-color: var(--accent);
}

.popup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

/* Finish modal */
#finish-modal.hidden { display: none; }

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 200;
}

.modal-content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 420px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.5);
}

.modal-content h3 {
  font-size: 16px;
  margin-bottom: 12px;
}

.modal-content p {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 20px;
  line-height: 1.6;
}

.modal-content code {
  font-size: 12px;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Help overlay */
#help-overlay.hidden { display: none; }

#help-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}

.help-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px;
  width: 520px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.5);
}

.help-content h3 {
  font-size: 16px;
  margin-bottom: 20px;
  color: var(--text);
}

.help-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.help-section h4 {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.help-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
  color: var(--text-muted);
}

.help-row kbd { margin-right: 8px; }

.help-dismiss {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  margin-top: 20px;
}

/* Toast */
#toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 400;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 13px;
  color: var(--text);
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  animation: toast-in 0.2s ease;
}

.toast.toast-success { border-left: 3px solid var(--success); }
.toast.toast-error { border-left: 3px solid var(--error); }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-tertiary); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border); }
`;
}

function getScript(sessionId: string): string {
	return `
(function() {
  'use strict';

  const SESSION_ID = '${sessionId}';
  const API_BASE = window.location.origin + '/api/' + SESSION_ID;
  const PAGE_STEP_FACTOR = 0.5;
  const CARET_VIEWPORT_PADDING = 28;
  const parseDelimitedRange = ${parseDelimitedRange.toString()};
  const parseInlineLinkRange = ${parseInlineLinkRange.toString()};
  const parseInlineCodeSpanRange = ${parseInlineCodeSpanRange.toString()};
  const consumeMarkdownLinePrefix = ${consumeMarkdownLinePrefix.toString()};
  const projectMarkdownForMatching = ${projectMarkdownForMatching.toString()};
  const normalizeProjectedCharacters = ${normalizeProjectedCharacters.toString()};
  const normalizeSearchTextForMatching = ${normalizeSearchTextForMatching.toString()};
  const expandSelectionToSafeRange = ${expandSelectionToSafeRange.toString()};
  const findFlexibleMatch = ${findFlexibleMatch.toString()};
  const buildSelectionResult = ${buildSelectionResult.toString()};
  const computeSelectionMetadata = ${computeSelectionMetadata.toString()};
  const buildCommentDraftPayload = ${buildCommentDraftPayload.toString()};
  const formatPullRequestSessionContext = ${formatPullRequestSessionContext.toString()};
  const buildFinishDescription = ${buildFinishDescription.toString()};

  let comments = [];
  let pendingSelection = null;
  let sidebarOpen = true;
  let helpOpen = false;
  let finishModalOpen = false;
  let commentPopupOpen = false;
  let visualMode = false;
  let reviewCompleted = false;
  let lastKeyTime = 0;
  let lastKey = '';
  let originalMarkdown = '';
  let sourceKind = 'markdown';
  let lastCaretRange = null;
  let sessionMode = 'document';
  let sessionFilePath = '';
  let pullRequestContext = null;
  let htmlReviewFrame = null;
  let htmlFrameSelection = null;

  // ─── Elements ───
  const contentEl = document.getElementById('content');
  const markdownBody = document.getElementById('markdown-body');
  const sidebar = document.getElementById('sidebar');
  const commentsList = document.getElementById('comments-list');
  const commentCount = document.getElementById('comment-count');
  const sessionContextEl = document.getElementById('session-context');
  const commentPopup = document.getElementById('comment-popup');
  const commentInput = document.getElementById('comment-input');
  const popupSelectedText = document.getElementById('popup-selected-text');
  const popupModeHint = document.getElementById('popup-mode-hint');
  const finishModal = document.getElementById('finish-modal');
  const finishDescriptionEl = document.getElementById('finish-description');
  const finishButton = document.getElementById('finish-btn');
  const finishConfirmButton = document.getElementById('finish-confirm');
  const helpOverlay = document.getElementById('help-overlay');
  const vimModeEl = document.getElementById('vim-mode');

  // ─── Init ───
  async function init() {
    const res = await fetch(API_BASE + '/document');
    const data = await res.json();
    sourceKind = data.sourceKind || (data.html ? 'html' : 'markdown');
    originalMarkdown = data.source || data.markdown || data.html || '';
    sessionMode = data.mode || 'document';
    sessionFilePath = data.filePath || '';
    pullRequestContext = data.pullRequest || null;

    renderSessionContext();
    renderFinishCopy();

    if (sourceKind === 'html') {
      renderHtmlDocument(originalMarkdown);
      focusEditor();
      const commentsRes = await fetch(API_BASE + '/comments');
      const commentsData = await commentsRes.json();
      comments = commentsData.comments || [];
      renderComments();
      return;
    }

    // Configure marked with mermaid support and syntax highlighting
    // (highlighting is handled in the custom code renderer below)
    let mermaidCounter = 0;
    const mermaidBlocks = {};

    function safeHighlight(code, lang) {
      const highlighter = window.hljs;
      if (!highlighter) {
        return escapeHtml(code);
      }

      try {
        if (lang && highlighter.getLanguage && highlighter.getLanguage(lang)) {
          return highlighter.highlight(code, { language: lang }).value;
        }
        if (highlighter.highlightAuto) {
          return highlighter.highlightAuto(code).value;
        }
      } catch (_) {
        // Fall through to plain escaped code
      }

      return escapeHtml(code);
    }

    const customRenderer = {
      code(token) {
        if (token.lang === 'mermaid') {
          const id = 'mermaid-' + (mermaidCounter++);
          mermaidBlocks[id] = token.text;
          return '<div class="mermaid" id="' + id + '">' + escapeHtml(token.text) + '</div>';
        }
        const lang = token.lang || '';
        const highlighted = safeHighlight(token.text, lang);
        return '<pre><code class="hljs language-' + lang + '">' + highlighted + '</code></pre>';
      }
    };

    marked.use({ gfm: true, breaks: false, renderer: customRenderer });

    markdownBody.innerHTML = marked.parse(originalMarkdown);

    // Keep markdown read-only while allowing caret + selection in both normal/visual modes
    markdownBody.addEventListener('beforeinput', (e) => {
      e.preventDefault();
    });
    markdownBody.addEventListener('paste', (e) => {
      e.preventDefault();
    });
    markdownBody.addEventListener('drop', (e) => {
      e.preventDefault();
    });

    // Initialize mermaid
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#0d1117',
        primaryColor: '#1f6feb',
        primaryTextColor: '#e6edf3',
        primaryBorderColor: '#30363d',
        lineColor: '#8b949e',
        secondaryColor: '#161b22',
        tertiaryColor: '#21262d',
      }
    });

    // Render mermaid diagrams
    await mermaid.run({ querySelector: '.mermaid' });

    // Add text offset data attributes to text nodes for comment positioning
    addOffsetTracking();

    // Keep an always-available caret so NORMAL and VISUAL share position.
    focusEditor();
    ensureSelectionAnchor(false);

    // Load existing comments
    const commentsRes = await fetch(API_BASE + '/comments');
    const commentsData = await commentsRes.json();
    comments = commentsData.comments || [];
    renderComments();

    document.addEventListener('selectionchange', rememberCaretFromSelection);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function htmlReviewBridge() {
    function findReviewId(node) {
      let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
      while (current && current !== document.documentElement) {
        if (current.getAttribute && current.getAttribute('data-review-id')) {
          return current.getAttribute('data-review-id');
        }
        current = current.parentElement;
      }
      return undefined;
    }

    function selectionPayload() {
      const sel = window.getSelection();
      const selectedText = sel ? sel.toString().trim() : '';
      if (!sel || !selectedText || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const reviewId = findReviewId(range.commonAncestorContainer || sel.anchorNode);
      return {
        selectedText,
        offsetStart: 0,
        offsetEnd: 0,
        reviewId,
        selector: { exact: selectedText },
        rect: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right },
      };
    }

    function postSelection(kind) {
      const selection = selectionPayload();
      if (!selection) return;
      parent.postMessage({ type: kind, selection }, '*');
    }

    function decodeHashTarget(href) {
      try {
        return decodeURIComponent(href.slice(1));
      } catch (_error) {
        return href.slice(1);
      }
    }

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href.startsWith('#')) return;

      event.preventDefault();
      const targetId = decodeHashTarget(href);
      if (!targetId) return;
      const destination = document.getElementById(targetId);
      if (!destination) return;

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      destination.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      try {
        history.replaceState(null, '', '#' + encodeURIComponent(targetId));
      } catch (_error) {
        // Sandboxed srcdoc frames may reject history updates; scrolling already succeeded.
      }
    });

    document.addEventListener('selectionchange', () => {
      window.clearTimeout(window.__reviewSelectionTimer);
      window.__reviewSelectionTimer = window.setTimeout(() => postSelection('document-reviewer:html-selection'), 40);
    });
    document.addEventListener('mouseup', () => postSelection('document-reviewer:html-selection'));
    document.addEventListener('keydown', (event) => {
      if (event.key && event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const selection = selectionPayload();
        if (!selection) return;
        event.preventDefault();
        parent.postMessage({ type: 'document-reviewer:html-comment-request', selection }, '*');
      }
    });
  }

  function buildSandboxedHtml(source) {
    const csp = "<meta http-equiv=\\\"Content-Security-Policy\\\" content=\\\"default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\\\">";
    const bridge = '<script>(' + htmlReviewBridge.toString() + ')();<' + '/script>';
    let html = source || '';
    if (/<head[\s>]/i.test(html)) {
      html = html.replace(/<head(\s[^>]*)?>/i, (match) => match + csp);
    } else {
      html = csp + html;
    }
    if (/<\\/body>/i.test(html)) {
      return html.replace(/<\\/body>/i, bridge + '</body>');
    }
    return html + bridge;
  }

  function renderHtmlDocument(source) {
    contentEl.classList.add('html-review-content');
    markdownBody.classList.add('html-review-shell');
    markdownBody.setAttribute('contenteditable', 'false');
    markdownBody.innerHTML = '';

    htmlReviewFrame = document.createElement('iframe');
    htmlReviewFrame.id = 'html-review-frame';
    htmlReviewFrame.setAttribute('sandbox', 'allow-scripts');
    htmlReviewFrame.setAttribute('referrerpolicy', 'no-referrer');
    htmlReviewFrame.srcdoc = buildSandboxedHtml(source);
    markdownBody.appendChild(htmlReviewFrame);
  }

  window.addEventListener('message', (event) => {
    if (!htmlReviewFrame || event.source !== htmlReviewFrame.contentWindow) return;
    const data = event.data || {};
    if (data.type !== 'document-reviewer:html-selection' && data.type !== 'document-reviewer:html-comment-request') return;
    if (!data.selection || typeof data.selection.selectedText !== 'string') return;

    htmlFrameSelection = data.selection;
    if (data.type === 'document-reviewer:html-comment-request') {
      const frameRect = htmlReviewFrame.getBoundingClientRect();
      const selectionRect = data.selection.rect || { left: 24, bottom: 48 };
      showCommentPopup(
        buildPendingSelection(data.selection.selectedText, data.selection),
        frameRect.left + selectionRect.left,
        frameRect.top + selectionRect.bottom,
      );
    }
  });

  function isPullRequestMode() {
    return sessionMode === 'pull_request' && !!pullRequestContext;
  }

  function renderSessionContext() {
    const contextText = isPullRequestMode()
      ? formatPullRequestSessionContext(pullRequestContext, sessionFilePath)
      : '';

    if (!contextText) {
      sessionContextEl.classList.add('hidden');
      sessionContextEl.textContent = '';
      sessionContextEl.removeAttribute('title');
      return;
    }

    sessionContextEl.textContent = contextText;
    sessionContextEl.title = contextText;
    sessionContextEl.classList.remove('hidden');
  }

  function renderFinishCopy() {
    finishDescriptionEl.innerHTML = buildFinishDescription(isPullRequestMode() ? 'pull_request' : 'document', comments.length, sourceKind);
    finishConfirmButton.textContent = isPullRequestMode() ? 'Finish & Submit' : sourceKind === 'html' ? 'Finish & Export' : 'Finish & Save';
    finishButton.title = isPullRequestMode()
      ? 'Finish review and submit PR comments'
      : sourceKind === 'html'
        ? 'Finish review and write comments to a sidecar .review.md file'
        : 'Finish review and write comments to file';
  }

  function getLineLabel(lineStart, lineEnd) {
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return '';
    return lineStart === lineEnd ? 'Line ' + lineStart : 'Lines ' + lineStart + '–' + lineEnd;
  }

  function buildCommentMetaHtml(comment) {
    if (sourceKind === 'html') {
      return comment.reviewId
        ? '<div class="comment-meta-row"><span class="comment-badge">Anchor ' + escapeHtml(comment.reviewId) + '</span></div>'
        : '';
    }

    if (!isPullRequestMode()) return '';

    const badges = [];
    if (comment.fallbackReason === 'multi_line_selection') {
      badges.push('<span class="comment-badge comment-badge-fallback">Fallback only</span>');
    } else if (comment.inlineEligible) {
      badges.push('<span class="comment-badge comment-badge-inline">Inline candidate</span>');
    }

    const lineLabel = getLineLabel(comment.lineStart, comment.lineEnd);
    if (lineLabel) {
      badges.push('<span class="comment-badge">' + escapeHtml(lineLabel) + '</span>');
    }

    return badges.length > 0 ? '<div class="comment-meta-row">' + badges.join('') + '</div>' : '';
  }

  // ─── Offset tracking ───
  // Walk the rendered DOM and compute character offsets back to the original markdown
  // We use a simplified approach: store the text content and use string matching
  function addOffsetTracking() {
    // We store the original markdown for offset computation during comment creation
    markdownBody.dataset.originalMarkdown = originalMarkdown;
  }

  function buildPendingSelection(selectedText, htmlSelection) {
    if (sourceKind === 'html') {
      return {
        selectedText,
        offsetStart: 0,
        offsetEnd: 0,
        reviewId: htmlSelection && htmlSelection.reviewId ? htmlSelection.reviewId : undefined,
        selector: htmlSelection && htmlSelection.selector ? htmlSelection.selector : { exact: selectedText },
      };
    }

    const metadata = computeSelectionMetadata(originalMarkdown, selectedText);
    if (metadata.offsetStart === -1) {
      return null;
    }
    return {
      selectedText: metadata.matchedText || selectedText,
      offsetStart: metadata.offsetStart,
      offsetEnd: metadata.offsetEnd,
      lineStart: metadata.lineStart,
      lineEnd: metadata.lineEnd,
      inlineEligible: metadata.inlineEligible,
      fallbackReason: metadata.fallbackReason,
    };
  }

  // ─── Vim Navigation ───
  function scrollBy(amount) {
    contentEl.scrollBy({ top: amount, behavior: 'auto' });
  }

  function scrollToTop() {
    contentEl.scrollTo({ top: 0, behavior: 'auto' });
  }

  function scrollToBottom() {
    contentEl.scrollTo({ top: contentEl.scrollHeight, behavior: 'auto' });
  }

  function pageScroll(direction) {
    const pageHeight = contentEl.clientHeight * PAGE_STEP_FACTOR;
    scrollBy(direction * pageHeight);
  }

  function setModeLabel(mode) {
    vimModeEl.classList.remove('insert-mode', 'visual-mode');
    if (mode === 'INSERT') {
      vimModeEl.classList.add('insert-mode');
    }
    if (mode === 'VISUAL') {
      vimModeEl.classList.add('visual-mode');
    }
    vimModeEl.textContent = mode;
  }

  function focusEditor() {
    if (sourceKind === 'html' && htmlReviewFrame) {
      htmlReviewFrame.focus({ preventScroll: true });
      return;
    }
    markdownBody.focus({ preventScroll: true });
  }

  function selectionInsideMarkdown(sel) {
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    return markdownBody.contains(range.startContainer) && markdownBody.contains(range.endContainer);
  }

  function rememberCaretFromSelection() {
    const sel = window.getSelection();
    if (!selectionInsideMarkdown(sel)) return;
    lastCaretRange = sel.getRangeAt(0).cloneRange();
  }

  function setSelectionRange(range) {
    const sel = window.getSelection();
    if (!sel || !range) return null;

    try {
      sel.removeAllRanges();
      sel.addRange(range);
      lastCaretRange = range.cloneRange();
      return sel;
    } catch (_) {
      return null;
    }
  }

  function createCollapsedRangeAt(node, offset) {
    const range = document.createRange();

    if (node.nodeType === Node.TEXT_NODE) {
      const maxOffset = node.textContent ? node.textContent.length : 0;
      range.setStart(node, Math.max(0, Math.min(offset, maxOffset)));
    } else {
      const maxOffset = node.childNodes ? node.childNodes.length : 0;
      range.setStart(node, Math.max(0, Math.min(offset, maxOffset)));
    }

    range.collapse(true);
    return range;
  }

  function findTextNode(atEnd) {
    const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let target = null;

    while (node) {
      if (node.textContent.trim()) {
        target = node;
        if (!atEnd) break;
      }
      node = walker.nextNode();
    }

    return target;
  }

  function createRangeFromPoint(x, y) {
    if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && markdownBody.contains(pos.offsetNode)) {
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        return range;
      }
    }

    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y);
      if (range && markdownBody.contains(range.startContainer)) {
        range.collapse(true);
        return range;
      }
    }

    return null;
  }

  function createFallbackRange(atEnd) {
    const node = findTextNode(atEnd);
    if (!node) return null;

    const range = document.createRange();
    const offset = atEnd ? node.textContent.length : 0;
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  }

  function createViewportAnchorRange() {
    const rect = contentEl.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return createFallbackRange(false);
    }

    const x = rect.left + Math.max(8, Math.min(48, rect.width - 12));
    const y = rect.top + Math.max(8, Math.min(CARET_VIEWPORT_PADDING, rect.height - 8));
    return createRangeFromPoint(x, y) || createFallbackRange(false);
  }

  function ensureSelectionAnchor(preferViewport) {
    if (sourceKind === 'html') return window.getSelection();

    const sel = window.getSelection();
    if (!sel) return null;

    if (!preferViewport && selectionInsideMarkdown(sel)) {
      rememberCaretFromSelection();
      return sel;
    }

    if (!preferViewport && lastCaretRange) {
      const restored = setSelectionRange(lastCaretRange.cloneRange());
      if (restored) {
        return restored;
      }
    }

    const anchor = createViewportAnchorRange() || createFallbackRange(false);
    if (!anchor) return sel;
    return setSelectionRange(anchor);
  }

  function getFocusCaretRect() {
    const sel = window.getSelection();
    if (!selectionInsideMarkdown(sel)) return null;

    const focusNode = sel.focusNode;
    if (!focusNode) return null;

    const range = createCollapsedRangeAt(focusNode, sel.focusOffset);

    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[0];
    }

    const fallback = range.getBoundingClientRect();
    return fallback && (fallback.height || fallback.width) ? fallback : null;
  }

  function ensureCaretInView() {
    const caretRect = getFocusCaretRect();
    if (!caretRect) return;

    const contentRect = contentEl.getBoundingClientRect();
    if (caretRect.top < contentRect.top + CARET_VIEWPORT_PADDING) {
      const delta = caretRect.top - (contentRect.top + CARET_VIEWPORT_PADDING);
      contentEl.scrollBy({ top: delta, behavior: 'auto' });
      return;
    }

    if (caretRect.bottom > contentRect.bottom - CARET_VIEWPORT_PADDING) {
      const delta = caretRect.bottom - (contentRect.bottom - CARET_VIEWPORT_PADDING);
      contentEl.scrollBy({ top: delta, behavior: 'auto' });
    }
  }

  function collapseSelectionToFocus() {
    const sel = window.getSelection();
    if (!selectionInsideMarkdown(sel) || sel.isCollapsed || !sel.focusNode) return;

    const range = createCollapsedRangeAt(sel.focusNode, sel.focusOffset);
    setSelectionRange(range);
  }

  function enterVisualMode() {
    visualMode = true;
    contentEl.classList.add('visual-mode');
    setModeLabel('VISUAL');
    focusEditor();
    ensureSelectionAnchor(false);
    ensureCaretInView();
  }

  function exitVisualMode() {
    visualMode = false;
    contentEl.classList.remove('visual-mode');
    collapseSelectionToFocus();
    setModeLabel('NORMAL');
    focusEditor();
    ensureSelectionAnchor(false);
    ensureCaretInView();
  }

  function placeCaretAtBoundary(atEnd) {
    const range = createFallbackRange(atEnd);
    if (!range) return;
    setSelectionRange(range);
    ensureCaretInView();
  }

  function moveCaret(direction, granularity, extend) {
    const sel = ensureSelectionAnchor(false);
    if (!sel) return;

    if (typeof sel.modify === 'function') {
      sel.modify(extend ? 'extend' : 'move', direction, granularity);
      rememberCaretFromSelection();
      ensureCaretInView();
      return;
    }

    if (!extend) {
      const fallback = createViewportAnchorRange() || createFallbackRange(false);
      if (fallback) {
        setSelectionRange(fallback);
        ensureCaretInView();
      }
    }
  }

  // ─── Comments ───
  async function addComment(selection, commentText) {
    const body = buildCommentDraftPayload(isPullRequestMode() ? 'pull_request' : 'document', selection, commentText, sourceKind);

    const res = await fetch(API_BASE + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to create review comment.');
    }

    comments.push(data.comment);
    renderComments();
    highlightCommentInDocument(data.comment);
    showToast('Comment added', 'success');
  }

  async function deleteComment(commentId) {
    await fetch(API_BASE + '/comments/' + commentId, { method: 'DELETE' });
    comments = comments.filter(c => c.id !== commentId);
    renderComments();
    removeHighlight(commentId);
    showToast('Comment deleted', 'success');
  }

  function renderComments() {
    commentCount.textContent = comments.length + ' comment' + (comments.length !== 1 ? 's' : '');
    renderFinishCopy();
    updateFinishCount();

    if (comments.length === 0) {
      commentsList.innerHTML = '<div class="no-comments">No comments yet.<br>Select text and press <kbd>c</kbd> to add a comment.</div>';
      return;
    }

    commentsList.innerHTML = comments.map(c => \`
      <div class="comment-card" data-comment-id="\${c.id}">
        <div class="comment-selected-text">\${escapeHtml(c.selectedText.slice(0, 200))}\${c.selectedText.length > 200 ? '...' : ''}</div>
        \${buildCommentMetaHtml(c)}
        <div class="comment-text">\${escapeHtml(c.comment)}</div>
        <div class="comment-actions">
          <button class="comment-delete" onclick="window.__deleteComment('\${c.id}')">Delete</button>
        </div>
      </div>
    \`).join('');
  }

  window.__deleteComment = function(id) {
    deleteComment(id);
  };

  function highlightCommentInDocument(comment) {
    if (sourceKind === 'html') return;

    // Try to find and highlight the selected text in the rendered document
    if (!comment.selectedText) return;

    const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT);
    const target = comment.selectedText;
    let node;

    while (node = walker.nextNode()) {
      const idx = node.textContent.indexOf(target);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + target.length);

        const span = document.createElement('span');
        span.className = 'review-highlight';
        span.dataset.commentId = comment.id;
        span.title = comment.comment;
        range.surroundContents(span);
        return;
      }
    }
  }

  function removeHighlight(commentId) {
    if (sourceKind === 'html') return;

    const el = markdownBody.querySelector('[data-comment-id="' + commentId + '"]');
    if (el) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    }
  }

  // ─── Comment Popup ───
  function showCommentPopup(selection, x, y) {
    pendingSelection = selection;
    popupSelectedText.textContent = selection.selectedText.slice(0, 200) + (selection.selectedText.length > 200 ? '...' : '');

    if (isPullRequestMode() && selection.fallbackReason === 'multi_line_selection') {
      popupModeHint.textContent = 'Fallback only — multi-line selections are preserved in the PR review body instead of an inline diff comment.';
      popupModeHint.classList.remove('hidden');
    } else {
      popupModeHint.textContent = '';
      popupModeHint.classList.add('hidden');
    }

    // Position popup near the selection
    const popupWidth = 380;
    const popupHeight = 240;
    let left = Math.min(x, window.innerWidth - popupWidth - 16);
    let top = y + 10;

    if (top + popupHeight > window.innerHeight) {
      top = y - popupHeight - 10;
    }

    commentPopup.style.left = Math.max(8, left) + 'px';
    commentPopup.style.top = Math.max(8, top) + 'px';
    commentPopup.classList.remove('hidden');
    commentPopupOpen = true;

    commentInput.value = '';
    commentInput.focus();
    setModeLabel('INSERT');
  }

  function hideCommentPopup() {
    commentPopup.classList.add('hidden');
    commentPopupOpen = false;
    pendingSelection = null;
    popupModeHint.textContent = '';
    popupModeHint.classList.add('hidden');

    setModeLabel(visualMode ? 'VISUAL' : 'NORMAL');
    focusEditor();
    ensureSelectionAnchor(false);
    ensureCaretInView();
  }

  async function submitComment() {
    const text = commentInput.value.trim();
    if (!text || !pendingSelection) return;
    try {
      await addComment(pendingSelection, text);
      hideCommentPopup();
    } catch (err) {
      showToast('Error creating comment: ' + err.message, 'error');
    }
  }

  // ─── Finish Review ───
  function updateFinishCount() {
    const countEl = document.getElementById('finish-count');
    if (countEl) {
      countEl.textContent = comments.length;
    }
  }

  function showFinishModal() {
    renderFinishCopy();
    updateFinishCount();
    finishModal.classList.remove('hidden');
    finishModalOpen = true;
  }

  function hideFinishModal() {
    finishModal.classList.add('hidden');
    finishModalOpen = false;
    setModeLabel(visualMode ? 'VISUAL' : 'NORMAL');
    focusEditor();
    ensureSelectionAnchor(false);
    ensureCaretInView();
  }

  async function finishReview() {
    if (reviewCompleted) return;

    try {
      const res = await fetch(API_BASE + '/finish', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to finish review.');
      }
      hideFinishModal();
      reviewCompleted = true;

      // Show a done state
      finishButton.textContent = '✓ Done';
      finishButton.disabled = true;
      finishButton.style.opacity = '0.5';

      if (data.mode === 'pull_request') {
        const prLabel = data.pullRequest ? data.pullRequest.owner + '/' + data.pullRequest.repo + '#' + data.pullRequest.number : 'the pull request';
        showToast(
          'Review complete! ' + data.inlineComments + ' inline and ' + data.fallbackComments + ' fallback comment(s) submitted to ' + prLabel + '.',
          'success'
        );
      } else if (data.sourceKind === 'html') {
        showToast('Review complete! ' + data.commentsWritten + ' comment(s) written to sidecar.', 'success');
      } else {
        showToast('Review complete! ' + data.commentsWritten + ' comment(s) written to file.', 'success');
      }

      // Best-effort: browsers often block tab closing unless script-opened.
      setTimeout(() => {
        try {
          window.close();
        } catch (_) {
          // no-op
        }
      }, 100);

      // Fallback when auto-close is blocked.
      setTimeout(() => {
        if (!document.hidden) {
          showToast('Finished. You can close this tab (⌘W / Ctrl+W).', 'success');
        }
      }, 500);
    } catch (err) {
      showToast('Error finishing review: ' + err.message, 'error');
    }
  }

  // ─── Sidebar ───
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('sidebar-open', sidebarOpen);
    sidebar.classList.toggle('sidebar-closed', !sidebarOpen);
  }

  // ─── Help ───
  function toggleHelp() {
    helpOpen = !helpOpen;
    helpOverlay.classList.toggle('hidden', !helpOpen);
  }

  // ─── Toast ───
  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'success');
    toast.textContent = message;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── Keyboard handling ───
  document.addEventListener('keydown', function(e) {
    // When comment popup is open, handle popup keys
    if (commentPopupOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideCommentPopup();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitComment();
        return;
      }
      // Let typing happen in the textarea
      return;
    }

    // Finish modal
    if (finishModalOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideFinishModal();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        finishReview();
        return;
      }
      return;
    }

    // Help overlay
    if (helpOpen) {
      if (e.key === '?' || e.key === 'Escape') {
        e.preventDefault();
        toggleHelp();
        return;
      }
      return;
    }

    // Global shortcuts
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      if (!reviewCompleted) {
        showFinishModal();
      }
      return;
    }

    // Vim-style navigation (only when not in an input)
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

    const now = Date.now();
    const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (keyLower === 'v') {
      e.preventDefault();
      if (visualMode) {
        exitVisualMode();
      } else {
        enterVisualMode();
      }
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (e.key === 'Escape' && visualMode) {
      e.preventDefault();
      exitVisualMode();
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (e.ctrlKey && keyLower === 'd') {
      e.preventDefault();
      pageScroll(1);
      if (visualMode) {
        ensureCaretInView();
      } else {
        ensureSelectionAnchor(true);
        ensureCaretInView();
      }
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (e.ctrlKey && keyLower === 'u') {
      e.preventDefault();
      pageScroll(-1);
      if (visualMode) {
        ensureCaretInView();
      } else {
        ensureSelectionAnchor(true);
        ensureCaretInView();
      }
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (keyLower === 'g' && lastKey === 'g' && now - lastKeyTime < 500) {
      e.preventDefault();
      scrollToTop();
      placeCaretAtBoundary(false);
      lastKey = '';
      lastKeyTime = now;
      return;
    }

    if (e.key === 'G') {
      e.preventDefault();
      scrollToBottom();
      placeCaretAtBoundary(true);
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (keyLower === 'c') {
      // Comment on current selection
      if (sourceKind === 'html') {
        if (htmlFrameSelection && htmlFrameSelection.selectedText) {
          e.preventDefault();
          const frameRect = htmlReviewFrame ? htmlReviewFrame.getBoundingClientRect() : { left: 0, top: 0 };
          const selectionRect = htmlFrameSelection.rect || { left: 24, bottom: 48 };
          showCommentPopup(
            buildPendingSelection(htmlFrameSelection.selectedText, htmlFrameSelection),
            frameRect.left + selectionRect.left,
            frameRect.top + selectionRect.bottom,
          );
        } else {
          showToast('Select text inside the HTML preview first, then press c.', 'error');
        }
        lastKey = keyLower;
        lastKeyTime = now;
        return;
      }

      const sel = window.getSelection();
      const selectedText = sel ? sel.toString().trim() : '';
      if (selectedText) {
        e.preventDefault();
        rememberCaretFromSelection();
        const pending = buildPendingSelection(selectedText);
        if (!pending) {
          showToast('Could not match selection to source markdown. Try selecting a smaller portion of text.', 'error');
        } else {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          showCommentPopup(pending, rect.left, rect.bottom);
        }
      }
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (e.key === '\\\\') {
      e.preventDefault();
      toggleSidebar();
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      toggleHelp();
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    if (visualMode) {
      const extend = e.shiftKey;
      switch (keyLower) {
        case 'h':
          e.preventDefault();
          moveCaret('backward', 'character', extend);
          break;
        case 'l':
          e.preventDefault();
          moveCaret('forward', 'character', extend);
          break;
        case 'j':
          e.preventDefault();
          moveCaret('forward', 'line', extend);
          break;
        case 'k':
          e.preventDefault();
          moveCaret('backward', 'line', extend);
          break;
      }
      lastKey = keyLower;
      lastKeyTime = now;
      return;
    }

    switch (keyLower) {
      case 'j':
        e.preventDefault();
        moveCaret('forward', 'line', false);
        break;
      case 'k':
        e.preventDefault();
        moveCaret('backward', 'line', false);
        break;
    }

    lastKey = keyLower;
    lastKeyTime = now;
  });

  // ─── Mouse: selection comment trigger ───
  contentEl.addEventListener('mouseup', function(e) {
    // Only offer comment on double-click or deliberate selection, not popup
    if (commentPopupOpen) return;
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString().trim() : '';
    // We don't auto-popup; user presses 'c' to comment on selection
  });

  // ─── Button handlers ───
  document.getElementById('toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('close-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('finish-btn').addEventListener('click', showFinishModal);
  document.getElementById('popup-cancel').addEventListener('click', hideCommentPopup);
  document.getElementById('popup-submit').addEventListener('click', submitComment);
  document.getElementById('finish-cancel').addEventListener('click', hideFinishModal);
  document.getElementById('finish-confirm').addEventListener('click', finishReview);

  // ─── Start ───
  init().catch(err => {
    console.error('Failed to initialize review page:', err);
    showToast('Failed to load document: ' + err.message, 'error');
  });

})();
`;
}
