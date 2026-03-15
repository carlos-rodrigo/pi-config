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
      <p id="finish-description">This will insert <strong id="finish-count">0</strong> comment(s) as <code>&lt;!-- REVIEW: ... --&gt;</code> annotations into the original markdown file.</p>
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

export interface ReviewSelectionMetadata {
	offsetStart: number;
	offsetEnd: number;
	lineStart?: number;
	lineEnd?: number;
	inlineEligible?: boolean;
	fallbackReason?: string;
}

export function computeSelectionMetadata(markdown: string, selectedText: string): ReviewSelectionMetadata {
	const exactMatchIndex = markdown.indexOf(selectedText);
	const trimmedSelection = selectedText.trim();
	const trimmedMatchIndex = exactMatchIndex === -1 && trimmedSelection ? markdown.indexOf(trimmedSelection) : -1;
	const offsetStart = exactMatchIndex !== -1 ? exactMatchIndex : trimmedMatchIndex;
	const matchedText =
		exactMatchIndex !== -1 ? selectedText : trimmedMatchIndex !== -1 ? trimmedSelection : "";
	const offsetEnd = offsetStart === -1 ? -1 : offsetStart + matchedText.length;

	if (offsetStart === -1 || offsetEnd === -1 || matchedText.length === 0) {
		return {
			offsetStart,
			offsetEnd,
		};
	}

	const lineStart = markdown.slice(0, offsetStart).split("\n").length;
	const lineEnd = markdown.slice(0, Math.max(offsetStart, offsetEnd - 1) + 1).split("\n").length;
	const inlineEligible = lineStart === lineEnd;

	return {
		offsetStart,
		offsetEnd,
		lineStart,
		lineEnd,
		inlineEligible,
		fallbackReason: inlineEligible ? undefined : "multi_line_selection",
	};
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
  const computeSelectionMetadata = ${computeSelectionMetadata.toString()};

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
  let lastCaretRange = null;
  let sessionMode = 'document';
  let sessionFilePath = '';
  let pullRequestContext = null;

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
  const finishCountEl = document.getElementById('finish-count');
  const finishDescriptionEl = document.getElementById('finish-description');
  const finishButton = document.getElementById('finish-btn');
  const finishConfirmButton = document.getElementById('finish-confirm');
  const helpOverlay = document.getElementById('help-overlay');
  const vimModeEl = document.getElementById('vim-mode');

  // ─── Init ───
  async function init() {
    const res = await fetch(API_BASE + '/document');
    const data = await res.json();
    originalMarkdown = data.markdown;
    sessionMode = data.mode || 'document';
    sessionFilePath = data.filePath || '';
    pullRequestContext = data.pullRequest || null;

    renderSessionContext();
    renderFinishCopy();

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

  function isPullRequestMode() {
    return sessionMode === 'pull_request' && !!pullRequestContext;
  }

  function renderSessionContext() {
    if (!isPullRequestMode()) {
      sessionContextEl.classList.add('hidden');
      sessionContextEl.textContent = '';
      sessionContextEl.removeAttribute('title');
      return;
    }

    const prLabel = pullRequestContext.owner + '/' + pullRequestContext.repo + '#' + pullRequestContext.number;
    const fileLabel = pullRequestContext.filePath || sessionFilePath;
    const contextText = prLabel + (fileLabel ? ' · ' + fileLabel : '');
    sessionContextEl.textContent = contextText;
    sessionContextEl.title = contextText;
    sessionContextEl.classList.remove('hidden');
  }

  function renderFinishCopy() {
    if (isPullRequestMode()) {
      finishDescriptionEl.innerHTML = 'This will submit <strong id="finish-count">' + comments.length + '</strong> comment(s) to the GitHub pull request review. Single-line selections stay inline when possible; multi-line selections are grouped under <code>Fallback comments</code>.';
      finishConfirmButton.textContent = 'Finish & Submit';
      finishButton.title = 'Finish review and submit PR comments';
      return;
    }

    finishDescriptionEl.innerHTML = 'This will insert <strong id="finish-count">' + comments.length + '</strong> comment(s) as <code>&lt;!-- REVIEW: ... --&gt;</code> annotations into the original markdown file.';
    finishConfirmButton.textContent = 'Finish & Save';
    finishButton.title = 'Finish review and write comments to file';
  }

  function getLineLabel(lineStart, lineEnd) {
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return '';
    return lineStart === lineEnd ? 'Line ' + lineStart : 'Lines ' + lineStart + '–' + lineEnd;
  }

  function buildCommentMetaHtml(comment) {
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

  function buildPendingSelection(selectedText) {
    const metadata = computeSelectionMetadata(originalMarkdown, selectedText);
    return {
      selectedText,
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
    const body = {
      selectedText: selection.selectedText,
      comment: commentText,
      offsetStart: selection.offsetStart,
      offsetEnd: selection.offsetEnd,
      ...(isPullRequestMode() && selection.lineStart !== undefined && selection.lineEnd !== undefined
        ? {
            lineStart: selection.lineStart,
            lineEnd: selection.lineEnd,
          }
        : {}),
    };

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
      const sel = window.getSelection();
      const selectedText = sel ? sel.toString().trim() : '';
      if (selectedText) {
        e.preventDefault();
        rememberCaretFromSelection();
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        showCommentPopup(buildPendingSelection(selectedText), rect.left, rect.bottom);
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
