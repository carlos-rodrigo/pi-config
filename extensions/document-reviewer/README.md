# document-reviewer

Markdown and HTML review sessions backed by a localhost service and browser UI.

## Install

```bash
pi install ./extensions/document-reviewer
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/review <path>` command | Validates a markdown or HTML path, creates a local review session, and opens the review URL |
| `/review-html <path>` command | Starts an HTML-only review and exports comments to `<name>.review.md` |
| Local review service (`127.0.0.1`) | Session/document APIs bound to loopback only |
| Ephemeral session token guard | Frontend API calls require `x-review-session-token`; missing/invalid tokens are rejected |
| Keyboard-first visualizer UI | Vim-style navigation with visual selection for focused markdown/HTML review |
| Background review wait | `/review` returns immediately so you can keep using the agent while the browser session is open |
| Cross-platform launcher | Opens target URL via `open` (macOS), `xdg-open` (Linux), or `start` (Windows) with manual fallback instructions |

## Usage

```text
/review docs/features/README.md
/review docs/features/my-feature/design.html
/review-html docs/features/my-feature/design.html
/review "docs/Design Notes.md"
/review help
```

## After finishing review

1. Press `Ctrl+Shift+F` in the browser to finalize.
2. Markdown reviews write `<!-- REVIEW: ... -->` annotations into the source file.
3. HTML reviews write comments to `<name>.review.md` and leave the source HTML unchanged.
4. The tab will attempt to close automatically; if your browser blocks it, close it manually.
5. Return to Pi and prompt: `Apply comments in <file>` or `Apply comments in <name>.review.md`.

## Keybindings inside reviewer UI

| Key | Action |
|-----|--------|
| `j` / `k` | Move cursor up/down in normal mode (auto-scrolls as needed) |
| `v` | Toggle visual mode (selection mode) |
| `h` / `j` / `k` / `l` | Move text cursor in visual mode |
| `Shift+h/j/k/l` | Extend selection in visual mode |
| `c` | Comment on current selection |
| `Ctrl+d` / `Ctrl+u` | Page down/up |
| `Esc` | Exit visual mode / close popup |
| `Ctrl+Shift+F` | Finish review |

## Validation behavior

- Missing path shows usage help.
- Non-existent path returns actionable file-not-found guidance.
- Directories are rejected (must be a file).
- Symlinks are rejected for workspace safety.
- `/review` accepts markdown (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`) and HTML (`.html`, `.htm`).
- `/review-html` accepts only HTML (`.html`, `.htm`).
- HTML files are rendered as the top-level review page with a CSP-nonced review overlay; source scripts/base tags are stripped for safety, hash links work normally, and comments export to a sidecar `.review.md` file.

## Troubleshooting

- **Browser did not open automatically**
  - The session still runs locally; copy the URL from the review status message and open it manually.
  - In SSH/headless environments, use the suggested `ssh -L` tunnel command from the fallback output.
- **401 from review APIs**
  - Reload the `/review` URL to refresh bootstrap token for that session.
