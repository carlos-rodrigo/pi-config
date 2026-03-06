# PRD: Document Reviewer Extension

## 1) Introduction / Overview

Create a **document reviewer extension** for Pi to review PRDs, technical designs, and task documents with low cognitive load.

The reviewer must provide:
- A `/review` command flow (trigger choice: slash command)
- High-quality markdown rendering (visually beautified, readable layout)
- Mermaid diagram support (static rendering)
- Vim-style navigation for reading (`j/k`, `h/l`, `Ctrl+u`, `Ctrl+d`)
- Visual selection for text ranges and creation of **threaded comments**
- An **End Review** action that copies all review comments to clipboard in **plain-text bullet format**

Platform preference:
1. **Primary:** Pi TUI extension
2. **Fallback:** Web app reviewer if Pi TUI implementation cannot satisfy required UX/interaction constraints

---

## 2) Goals

- Enable fast, keyboard-first review of markdown docs inside Pi.
- Reduce review friction by combining reading, selection, commenting, and export in one flow.
- Provide clear visual hierarchy and low-noise UI for long documents.
- Support static Mermaid diagram rendering without breaking reading flow.
- Let reviewer finish with one action that exports all comments to clipboard.

---

## 3) User Stories

### US-001: Start a review session from slash command

**Description:** As a reviewer, I want to trigger `/review` so that I can enter a dedicated review mode for a markdown file.

**BDD Spec:**
- Given: I am in Pi and a target markdown file exists
- When: I run `/review <path>`
- Then: A review session opens with document content and review controls

**Acceptance Criteria:**

- [ ] `/review <path>` command is registered and discoverable
- [ ] Command validates target path exists and is markdown-compatible
- [ ] Review session opens with file title, path, and review status
- [ ] Invalid path produces clear, actionable error
- [ ] If primary Pi TUI mode is unsupported for required features, extension offers fallback to web reviewer

**Feedback Loop:**

Setup: Load extension, have at least one valid `.md` file and one invalid path.

Verification:
1. Run `/review .features/document-reviewer-extension/prd.md` → reviewer opens with document visible.
2. Run `/review does-not-exist.md` → inline error explains path not found and next step.
3. Run `/review package.json` → clear validation message for unsupported file type or mode.
4. If fallback condition is triggered, run `/review <valid-md>` → explicit prompt to open web fallback appears.

Edge cases:
- Path contains spaces (`"docs/My PRD.md"`) → file opens correctly.
- Relative path from nested cwd → resolves correctly.
- Empty markdown file → reviewer opens with empty-state message, no crash.

Regression: Re-run existing extension commands (`/open`, `/feature`) → still function unchanged.

---

### US-002: Read markdown with beautified layout and static Mermaid rendering

**Description:** As a reviewer, I want markdown and Mermaid diagrams rendered clearly so that I can understand documents quickly without cognitive overload.

**BDD Spec:**
- Given: A markdown file with headings, lists, code blocks, and Mermaid fences
- When: It is shown in review mode
- Then: Content is visually structured and Mermaid diagrams are rendered statically

**Acceptance Criteria:**

- [ ] Headings, paragraphs, lists, tables/code fences are rendered with readable spacing and hierarchy
- [ ] Mermaid code fences are detected and rendered as static diagrams
- [ ] Mermaid rendering failures degrade gracefully to readable source block
- [ ] Visual theme is calm/minimal (no noisy colors that compete with comment highlights)
- [ ] Rendering remains performant on long docs (no blocking or major lag)

**Feedback Loop:**

Setup: Prepare sample markdown with at least 2 Mermaid diagrams and 500+ lines.

Verification:
1. Open sample via `/review` → document shows clear section hierarchy and consistent spacing.
2. Navigate to Mermaid blocks → diagrams appear as static renderings in-view.
3. Intentionally break one Mermaid block syntax → block shows non-crashing fallback representation.
4. Scroll through long file → interaction remains responsive (no visible freeze).

Edge cases:
- Multiple adjacent Mermaid blocks → each renders independently.
- Very wide diagram → clipped/wrapped gracefully with readable fallback.
- Unsupported Mermaid syntax → error state stays local to that block.

Regression: Standard markdown files without Mermaid still render correctly.

---

### US-003: Navigate and select text with Vim-style controls

**Description:** As a keyboard-focused reviewer, I want Vim-like controls and visual selection so that I can review quickly without leaving home-row navigation.

**BDD Spec:**
- Given: Review mode is active
- When: I use navigation keys and enter visual mode
- Then: I can move through content and select ranges predictably

**Acceptance Criteria:**

- [ ] `j`/`k` moves up/down
- [ ] `h`/`l` handles left/right movement (horizontal scroll or pane focus)
- [ ] `Ctrl+u`/`Ctrl+d` page-scrolls up/down
- [ ] Visual mode can be entered and exited reliably
- [ ] Selection highlight is clear and does not lose context during scrolling

**Feedback Loop:**

Setup: Open a long markdown file in review mode.

Verification:
1. Press `j`, `k` repeatedly → cursor/viewport moves one step each action.
2. Press `Ctrl+d`, then `Ctrl+u` → viewport jumps by configured page chunk.
3. Press `h`/`l` in a horizontally constrained section (code/table/diagram) → expected horizontal behavior occurs.
4. Enter visual mode, expand selection over multiple lines, exit visual mode → selection lifecycle behaves predictably.

Edge cases:
- Start selection near top/bottom boundary → no out-of-range behavior.
- Very long wrapped lines → movement remains deterministic.
- Rapid key repeats → no mode corruption or stuck input state.

Regression: Global Pi key handling outside reviewer remains unaffected.

---

### US-004: Add and manage threaded comments anchored to selected ranges

**Description:** As a reviewer, I want to add threaded comments to selected text so that feedback stays contextual and review discussion is structured.

**BDD Spec:**
- Given: I selected a text range in visual mode
- When: I create a comment
- Then: A thread is attached to that range and visible in review UI

**Acceptance Criteria:**

- [ ] Comment creation is available immediately after selection
- [ ] Thread stores anchor metadata to map back to selection
- [ ] Multiple comments can exist per thread
- [ ] Comments are listed in a dedicated panel or structured view
- [ ] No comment classification (type/tag/severity) is required; each entry is plain comment text
- [ ] Empty comments are rejected with clear validation message

**Feedback Loop:**

Setup: Open review mode with a markdown doc containing multiple sections.

Verification:
1. Select a range in section A and add comment `C1` → thread appears linked to selection.
2. Add second reply/comment to same thread → thread shows ordered conversation.
3. Select different range in section B and add comment `C2` → second independent thread appears.
4. Confirm comment form has no type/tag/severity input and still saves correctly.
5. Jump between thread list and anchors → focus sync works both directions.

Edge cases:
- Attempt to submit empty comment → blocked with validation.
- Reopen session on same doc → comments/threads persist per chosen storage strategy.
- Any legacy/type metadata (if present in old sidecars) is ignored without breaking display.
- Document changed since comments were added → stale anchor is detected and marked clearly.

Regression: Non-comment navigation remains smooth with many threads present.

---

### US-005: End review and copy comments to clipboard (plain text)

**Description:** As a reviewer, I want to end review and copy all comments so that I can paste actionable feedback directly into chat, issue tracker, or PR discussion.

**BDD Spec:**
- Given: Review session has one or more comments
- When: I trigger End Review
- Then: All comments are compiled and copied to clipboard as plain-text bullets

**Acceptance Criteria:**

- [ ] End Review action is accessible via command/shortcut in review mode
- [ ] Export output is plain-text bullet list (as requested)
- [ ] Output includes enough context per comment (section/anchor snippet + comment text)
- [ ] Clipboard success/failure is clearly communicated
- [ ] On clipboard failure, output remains available in-view for manual copy

**Feedback Loop:**

Setup: Create at least 3 comments across 2 sections.

Verification:
1. Trigger End Review → confirmation shows number of exported comments.
2. Paste clipboard into plain text editor → content is bullet-formatted and readable.
3. Verify each bullet includes context + associated comment.
4. Simulate clipboard unavailability → user sees fallback text output path.

Edge cases:
- No comments yet → End Review reports nothing to export without error.
- Very large comment set (100+) → export completes without truncating critical content.
- Unicode/emoji in comments → preserved in output.

Regression: Ending one review does not delete comments from unrelated documents.

---

## 4) Functional Requirements

- **FR-1:** The system must provide a `/review <path>` slash command.
- **FR-2:** The system must validate file existence and supported type before opening review mode.
- **FR-3:** The system must open a dedicated review UI with document viewport and review context.
- **FR-4:** The system must render markdown with readable typography/layout in terminal constraints.
- **FR-5:** The system must detect Mermaid code fences and render static diagram output.
- **FR-6:** The system must provide graceful fallback when Mermaid rendering fails.
- **FR-7:** The system must support keyboard navigation keys: `j`, `k`, `h`, `l`, `Ctrl+u`, `Ctrl+d`.
- **FR-8:** The system must support visual selection mode for text range selection.
- **FR-9:** The system must allow creating threaded comments from a selected range.
- **FR-10:** The system must maintain comment anchors with enough metadata to relocate selections.
- **FR-11:** The system must display comment threads in a structured, navigable review panel.
- **FR-12:** The system must provide an End Review action that compiles all comments.
- **FR-13:** End Review export must copy output to clipboard as plain-text bullet list.
- **FR-14:** If clipboard write fails, the system must show a manual-copy fallback.
- **FR-15:** The system must prefer Pi TUI implementation and provide web-app fallback when required UX cannot be met in TUI.
- **FR-16:** The system must treat all feedback as plain comments only; no required classification fields (type/tag/severity/status) in the comment input flow.

---

## 5) Non-Goals (Out of Scope)

- Real-time multi-user collaborative review.
- AI-generated auto-comments or comment rewriting.
- Full markdown editing workflow (this feature is review-first).
- Rich media beyond markdown + static Mermaid in MVP.
- External sync to GitHub/Jira/Linear APIs in MVP.

---

## 6) Design Considerations

- Keep UI calm and uncluttered: high contrast for content, muted chrome, minimal decorative elements.
- Keep mode awareness visible (e.g., NORMAL/VISUAL/COMMENT) to reduce confusion.
- Use a two-region layout where possible: content focus + contextual comments.
- Keep selection and comment highlight semantics distinct.
- Ensure keyboard-only operation is first-class.

---

## 7) Technical Considerations

- Primary target is Pi extension architecture (`registerCommand`, custom UI/editor interactions).
- Mermaid rendering strategy should support static output and deterministic fallback.
- Clipboard strategy must be cross-platform (macOS/Linux/Windows paths or abstraction).
- Comment anchor strategy should avoid brittle line-only references where possible.
- Fallback mode needs explicit capability checks and user-visible transition.

---

## 8) Success Metrics

- Reviewer can start session from `/review` in <= 5 seconds.
- Reviewer can add first anchored comment in <= 20 seconds from session start.
- 100% of created comments appear in End Review clipboard export.
- Mermaid blocks render or degrade gracefully with zero hard crashes.
- Keyboard-only review path is usable end-to-end without mouse.

---

## 9) Open Questions

1. For Pi TUI mode, should Mermaid default to image rendering (when terminal supports it) or always deterministic ASCII-style rendering in MVP?
2. What is the canonical persistence location for comment threads (session entry vs sidecar file)?
3. Should End Review also include an optional markdown export mode later (currently fixed to plain text bullets)?
4. Should `h/l` prioritize pane focus changes or horizontal scrolling when both are possible?
5. What exact threshold defines “TUI unsupported” and triggers mandatory web fallback?
