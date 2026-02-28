/**
 * Visual Generator — Transforms markdown into cinematic scroll-driven HTML.
 *
 * Produces an HTML string that gets embedded in the review web app's
 * visual presentation zone. Each manifest section becomes a `<section>`
 * with `data-section-id` for scroll tracking and comment anchoring.
 *
 * No external dependencies — pure string transformation with regex-based
 * inline formatting and basic code syntax highlighting.
 */

import type { ReviewManifest, ReviewSection } from "./manifest.js";

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate cinematic HTML from a markdown source and its manifest.
 *
 * @returns HTML string ready to be injected into the visual-zone div
 */
export function generateVisual(manifest: ReviewManifest, sourceContent: string): string {
  const lines = sourceContent.split("\n");
  const sectionHtmls: string[] = [];

  for (const section of manifest.sections) {
    const sectionLines = lines.slice(section.sourceLineStart - 1, section.sourceLineEnd);
    const sectionContent = sectionLines.join("\n");
    const html = renderSection(section, sectionContent);
    sectionHtmls.push(html);
  }

  const progressNav = generateProgressNav(manifest.sections);

  return `
    <div class="visual-container">
      ${progressNav}
      <div class="visual-content">
        ${sectionHtmls.join("\n")}
      </div>
    </div>
  `;
}

/**
 * Generate CSS for the visual presentation.
 * Appended to the page's styles or injected inline.
 */
export function generateVisualStyles(): string {
  return VISUAL_CSS;
}

// ── Section Renderer ───────────────────────────────────────────────────────

function renderSection(section: ReviewSection, content: string): string {
  const sectionHtml = renderMarkdown(content);
  const title = section.headingPath[section.headingPath.length - 1] ?? "";

  return `
    <section class="review-section" data-section-id="${escapeAttr(section.id)}">
      <button class="section-comment-btn" data-section-id="${escapeAttr(section.id)}" title="Add comment on: ${escapeAttr(title)}">💬</button>
      ${sectionHtml}
    </section>
  `;
}

// ── Markdown → HTML Renderer ───────────────────────────────────────────────

function renderMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = processInline(headingMatch[2]!);
      output.push(`<h${level} class="visual-heading visual-heading-${level}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push('<hr class="visual-divider">');
      i++;
      continue;
    }

    // Code block (fenced)
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      const code = highlightCode(codeLines.join("\n"), lang);
      output.push(`<div class="visual-code-block"><pre><code class="lang-${escapeAttr(lang || "text")}">${code}</code></pre></div>`);
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && /^\|[\s:|-]+\|/.test(lines[i + 1]!.trim())) {
      const tableResult = parseTable(lines, i);
      output.push(tableResult.html);
      i = tableResult.endIndex;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith(">") || (lines[i]!.trim() !== "" && quoteLines.length > 0 && !lines[i]!.startsWith("#")))) {
        if (lines[i]!.startsWith(">")) {
          quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        } else {
          break;
        }
        i++;
      }
      const quoteHtml = processInline(quoteLines.join("\n"));
      output.push(`<blockquote class="visual-blockquote">${quoteHtml}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const listResult = parseList(lines, i, "ul");
      output.push(listResult.html);
      i = listResult.endIndex;
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s/.test(line)) {
      const listResult = parseList(lines, i, "ol");
      output.push(listResult.html);
      i = listResult.endIndex;
      continue;
    }

    // Paragraph (default)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.match(/^#{1,6}\s/) &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith(">") &&
      !/^\s*[-*+]\s/.test(lines[i]!) &&
      !/^\s*\d+\.\s/.test(lines[i]!) &&
      !lines[i]!.includes("|") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      output.push(`<p class="visual-paragraph">${processInline(paraLines.join("\n"))}</p>`);
    }
  }

  return output.join("\n");
}

// ── List Parser ────────────────────────────────────────────────────────────

function parseList(
  lines: string[],
  startIndex: number,
  type: "ul" | "ol",
): { html: string; endIndex: number } {
  const items: string[] = [];
  let i = startIndex;
  const pattern = type === "ul" ? /^\s*[-*+]\s(.+)$/ : /^\s*\d+\.\s(.+)$/;

  while (i < lines.length) {
    const match = lines[i]!.match(pattern);
    if (match) {
      items.push(match[1]!);
      i++;
    } else if (lines[i]!.trim() === "") {
      // Empty line might end the list
      if (i + 1 < lines.length && lines[i + 1]!.match(pattern)) {
        i++; // skip blank line within list
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const listItems = items
    .map((item, idx) => {
      // Check for checkbox
      const checkMatch = item.match(/^\[([ xX])\]\s(.+)$/);
      if (checkMatch) {
        const checked = checkMatch[1] !== " ";
        const text = processInline(checkMatch[2]!);
        return `<li class="visual-list-item visual-checkbox" style="--stagger-index: ${idx}">
          <span class="checkbox-indicator ${checked ? "checked" : ""}">${checked ? "✓" : ""}</span>
          <span class="${checked ? "checkbox-checked-text" : ""}">${text}</span>
        </li>`;
      }
      return `<li class="visual-list-item" style="--stagger-index: ${idx}">${processInline(item)}</li>`;
    })
    .join("\n");

  return {
    html: `<${type} class="visual-list">${listItems}</${type}>`,
    endIndex: i,
  };
}

// ── Table Parser ───────────────────────────────────────────────────────────

function parseTable(lines: string[], startIndex: number): { html: string; endIndex: number } {
  let i = startIndex;
  const headerLine = lines[i]!;
  i++; // skip header
  i++; // skip separator

  const headers = parseTableRow(headerLine);
  const rows: string[][] = [];

  while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
    rows.push(parseTableRow(lines[i]!));
    i++;
  }

  const headerHtml = headers
    .map((h) => `<th>${processInline(h)}</th>`)
    .join("");

  const rowsHtml = rows
    .map(
      (row, idx) =>
        `<tr class="visual-table-row" style="--stagger-index: ${idx}">${row.map((cell) => `<td>${processInline(cell)}</td>`).join("")}</tr>`,
    )
    .join("\n");

  return {
    html: `<div class="visual-table-wrapper"><table class="visual-table">
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`,
    endIndex: i,
  };
}

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

// ── Inline Formatting ──────────────────────────────────────────────────────

function processInline(text: string): string {
  let result = escapeHtml(text);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/_(.+?)_/g, "<em>$1</em>");

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, '<code class="visual-inline-code">$1</code>');

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" class="visual-link" target="_blank" rel="noopener">$1</a>',
  );

  // Line breaks
  result = result.replace(/\n/g, "<br>");

  return result;
}

// ── Code Syntax Highlighting ───────────────────────────────────────────────

const KEYWORDS = new Set([
  // TypeScript/JavaScript
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "switch", "case", "break", "continue", "new", "this", "class", "extends",
  "import", "export", "from", "default", "async", "await", "try", "catch",
  "throw", "typeof", "instanceof", "interface", "type", "enum", "implements",
  "abstract", "public", "private", "protected", "static", "readonly",
  // Python
  "def", "class", "import", "from", "return", "if", "elif", "else",
  "for", "while", "try", "except", "raise", "with", "as", "pass", "None",
  "True", "False", "self", "yield", "lambda", "in", "not", "and", "or",
  // Common
  "null", "undefined", "true", "false", "void", "string", "number", "boolean",
  "any", "never", "unknown", "Promise",
]);

function highlightCode(code: string, _lang: string): string {
  const escaped = escapeHtml(code);
  const lines = escaped.split("\n");

  return lines
    .map((line) => {
      let result = line;

      // Comments (// and #)
      result = result.replace(
        /(\/\/.*$|#.*$)/gm,
        '<span class="code-comment">$1</span>',
      );

      // Strings (double and single quoted)
      result = result.replace(
        /(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g,
        '<span class="code-string">$1</span>',
      );

      // Template literals approximation
      result = result.replace(
        /(`[^`]*?`)/g,
        '<span class="code-string">$1</span>',
      );

      // Keywords (word boundary)
      for (const kw of KEYWORDS) {
        const regex = new RegExp(`\\b(${kw})\\b`, "g");
        result = result.replace(regex, '<span class="code-keyword">$1</span>');
      }

      // Numbers
      result = result.replace(
        /\b(\d+\.?\d*)\b/g,
        '<span class="code-number">$1</span>',
      );

      // Types (PascalCase words)
      result = result.replace(
        /\b([A-Z][a-zA-Z]+)\b/g,
        '<span class="code-type">$1</span>',
      );

      return result;
    })
    .join("\n");
}

// ── Progress Navigation ────────────────────────────────────────────────────

function generateProgressNav(sections: ReviewSection[]): string {
  const items = sections
    .map((section) => {
      const title = section.headingPath[section.headingPath.length - 1] ?? "";
      const indent = Math.max(0, section.headingLevel - 1);
      return `<a class="progress-item progress-level-${section.headingLevel}" 
        data-section-id="${escapeAttr(section.id)}"
        style="padding-left: ${12 + indent * 12}px"
        href="#${escapeAttr(section.id)}">${escapeHtml(title)}</a>`;
    })
    .join("\n");

  return `
    <nav class="progress-nav" id="progress-nav">
      <div class="progress-nav-title">Contents</div>
      ${items}
    </nav>
  `;
}

// ── Escape Helpers ─────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Visual CSS ─────────────────────────────────────────────────────────────

const VISUAL_CSS = `
/* ── Visual Presentation Styles ─────────────────────────────────────────── */

.visual-container {
  display: flex;
  gap: 0;
  height: 100%;
}

.progress-nav {
  width: 220px;
  min-width: 180px;
  padding: 16px 0;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100%;
  background: var(--bg-primary);
}

.progress-nav-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 16px 8px;
}

.progress-item {
  display: block;
  padding: 4px 16px;
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: none;
  transition: all var(--transition);
  border-left: 2px solid transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.progress-item:hover {
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}

.progress-item.active {
  color: var(--accent-light);
  border-left-color: var(--accent);
  background: var(--bg-tertiary);
}

.progress-level-1 { font-weight: 600; }
.progress-level-2 { font-weight: 500; }
.progress-level-3, .progress-level-4, .progress-level-5, .progress-level-6 {
  font-size: 11px;
}

.visual-content {
  flex: 1;
  padding: 32px 48px;
  overflow-y: auto;
  max-width: 800px;
}

/* ── Sections (scroll animation) ────────────────────────────────────────── */

.review-section {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.6s ease, transform 0.6s ease;
  margin-bottom: 32px;
  position: relative;
  padding: 4px 0;
}

.review-section.visible {
  opacity: 1;
  transform: translateY(0);
}

.section-comment-btn {
  position: absolute;
  top: 4px;
  right: -40px;
  background: none;
  border: 1px solid transparent;
  font-size: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition);
  padding: 4px;
  border-radius: var(--radius-sm);
}

.review-section:hover .section-comment-btn {
  opacity: 0.6;
}

.section-comment-btn:hover {
  opacity: 1 !important;
  border-color: var(--border-light);
  background: var(--bg-tertiary);
}

/* ── Headings ───────────────────────────────────────────────────────────── */

.visual-heading {
  color: var(--text-primary);
  margin-bottom: 16px;
  line-height: 1.3;
}

.visual-heading-1 {
  font-size: 2em;
  background: linear-gradient(135deg, var(--accent-light), var(--text-primary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 24px;
}

.visual-heading-2 {
  font-size: 1.5em;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin-top: 24px;
}

.visual-heading-3 {
  font-size: 1.2em;
  color: var(--accent-light);
  margin-top: 20px;
}

.visual-heading-4, .visual-heading-5, .visual-heading-6 {
  font-size: 1em;
  color: var(--text-secondary);
  margin-top: 16px;
}

/* ── Paragraphs ─────────────────────────────────────────────────────────── */

.visual-paragraph {
  color: var(--text-secondary);
  margin-bottom: 12px;
  max-width: 65ch;
  line-height: 1.7;
}

/* ── Lists ──────────────────────────────────────────────────────────────── */

.visual-list {
  margin-bottom: 16px;
  padding-left: 24px;
}

.visual-list-item {
  color: var(--text-secondary);
  margin-bottom: 6px;
  line-height: 1.6;
  opacity: 0;
  transform: translateX(-10px);
  transition: opacity 0.4s ease, transform 0.4s ease;
  transition-delay: calc(var(--stagger-index, 0) * 0.06s);
}

.review-section.visible .visual-list-item {
  opacity: 1;
  transform: translateX(0);
}

/* Checkboxes */
.visual-checkbox {
  list-style: none;
  margin-left: -24px;
  padding-left: 0;
}

.checkbox-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  margin-right: 8px;
  font-size: 10px;
  vertical-align: middle;
}

.checkbox-indicator.checked {
  background: var(--color-approval);
  border-color: var(--color-approval);
  color: white;
}

.checkbox-checked-text {
  color: var(--text-muted);
  text-decoration: line-through;
}

/* ── Code ───────────────────────────────────────────────────────────────── */

.visual-code-block {
  margin-bottom: 16px;
  border-radius: var(--radius);
  background: #1a1a2e;
  border: 1px solid var(--border);
  overflow-x: auto;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.5s ease, transform 0.5s ease;
  transition-delay: 0.2s;
}

.review-section.visible .visual-code-block {
  opacity: 1;
  transform: translateY(0);
}

.visual-code-block pre {
  margin: 0;
  padding: 16px;
  overflow-x: auto;
}

.visual-code-block code {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.code-keyword { color: #c792ea; }
.code-string { color: #c3e88d; }
.code-comment { color: #546e7a; font-style: italic; }
.code-number { color: #f78c6c; }
.code-type { color: #ffcb6b; }

.visual-inline-code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--accent-light);
}

/* ── Tables ─────────────────────────────────────────────────────────────── */

.visual-table-wrapper {
  margin-bottom: 16px;
  overflow-x: auto;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.visual-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.visual-table th {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-weight: 600;
  text-align: left;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-light);
}

.visual-table td {
  padding: 8px 14px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.visual-table-row {
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 0.3s ease, transform 0.3s ease;
  transition-delay: calc(var(--stagger-index, 0) * 0.05s);
}

.review-section.visible .visual-table-row {
  opacity: 1;
  transform: translateY(0);
}

.visual-table tr:hover td {
  background: var(--bg-hover);
}

/* ── Blockquotes ────────────────────────────────────────────────────────── */

.visual-blockquote {
  border-left: 3px solid var(--accent);
  margin: 0 0 16px 0;
  padding: 12px 20px;
  background: var(--bg-tertiary);
  border-radius: 0 var(--radius) var(--radius) 0;
  color: var(--text-secondary);
  font-style: italic;
}

/* ── Dividers ───────────────────────────────────────────────────────────── */

.visual-divider {
  border: none;
  height: 1px;
  background: linear-gradient(to right, transparent, var(--accent-dim), transparent);
  margin: 32px 0;
}

/* ── Links ──────────────────────────────────────────────────────────────── */

.visual-link {
  color: var(--accent-light);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color var(--transition);
}

.visual-link:hover {
  border-bottom-color: var(--accent-light);
}
`;
