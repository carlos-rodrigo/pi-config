# loop-monitor

Read-only Pi TUI monitor for tasks and background loops in the current project.

## Usage

- `/tasks` — open the Tasks view
- `/loops` — open the Loops view
- `Ctrl+Shift+L` — open the Tasks view

The Tasks sidebar reads `.features/*/tasks/*.md` and groups task briefs by **feature name**, sorted by feature and task ID. Each row shows the brief's frontmatter `status:` from the simple-tasks lifecycle: **todo**, **in-progress**, or **blocked**. Any other value (for example a legacy `ready`) is shown as-is in the warning color and marked unrecognized in the detail pane. Tasks marked **done** are hidden, and features with no unfinished tasks are omitted. Running-loop activity appears as a separate `● iteration/total` badge rather than replacing the stored status. Feature headers stay visible when scrolling within a group.

Selecting a task shows its feature, stored status and Markdown-formatted brief on the right. Headings, emphasis, lists, links, tables and syntax-highlighted code blocks use Pi’s active theme; scrolling follows rendered lines. When a running loop is associated with that task, the detail pane also shows its current iteration output. Press **Enter** to focus the full task content: `j` / `k` or the arrow keys scroll one line without changing the selected task. **Enter** or **Escape** returns to the task list. Focus returns to the list automatically if the task is completed or removed during refresh.

The Loops sidebar reads `.pi/loop-jobs/` and groups current-project processes into **Running** and **Recent** sections. Task status is never read from `_active.md`; its only use is a `- Current: TASK-…` line, which associates a running feature-wide loop with that task; loops without a reliable task remain unassigned in the Loops view.

The overlay refreshes every 1.5 seconds. It is intentionally read-only: it does not edit tasks or start, cancel, or restart loops.

## Controls

- `Up` / `Down`, `j` / `k` (also `J` / `K`) — select a task or loop; scroll one line while task content is focused
- `Tab` / `Shift+Tab` — switch Tasks and Loops views
- `PageUp` / `PageDown` — scroll task content or loop output
- `Enter` — switch between the task list and full task content
- `o` — open the selected task's loop or the selected loop's task
- `G` / `End` — resume following live output
- `r` — refresh now
- `q` — close; `Esc` — return from focused task content to the list, otherwise close
