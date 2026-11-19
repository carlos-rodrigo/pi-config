# task-monitor

Read-only Pi TUI monitor for unfinished tasks in the current project.

## Usage

- `/tasks` — open the Tasks view
- `Ctrl+Shift+L` — open the Tasks view

The Tasks sidebar reads `.features/*/tasks/*.md` and groups task briefs by **feature name**, sorted by feature and task ID. Each row shows the brief's frontmatter `status:` from the simple-tasks lifecycle: **todo**, **in-progress**, or **blocked**. Any other value (for example a legacy `ready`) is shown as-is in the warning color and marked unrecognized in the detail pane. Tasks marked **done** are hidden, and features with no unfinished tasks are omitted. Task status is never read from `_active.md`. Feature headers stay visible when scrolling within a group.

Selecting a task shows its feature, stored status and Markdown-formatted brief on the right. Headings, emphasis, lists, links, tables and syntax-highlighted code blocks use Pi’s active theme; scrolling follows rendered lines. Press **Enter** to focus the full task content: `j` / `k` or the arrow keys scroll one line without changing the selected task. **Enter** or **Escape** returns to the task list. Focus returns to the list automatically if the task is completed or removed during refresh.

The overlay refreshes every 1.5 seconds. It is intentionally read-only: it does not edit tasks.

## Controls

- `Up` / `Down`, `j` / `k` (also `J` / `K`) — select a task; scroll one line while task content is focused
- `PageUp` / `PageDown` — scroll task content
- `Home` / `g` — scroll task content to the top
- `Enter` — switch between the task list and full task content
- `r` — refresh now
- `q` — close; `Esc` — return from focused task content to the list, otherwise close
