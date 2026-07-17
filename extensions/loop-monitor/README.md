# loop-monitor

Read-only Pi TUI monitor for tasks and background loops in the current project.

## Usage

- `/tasks` — open the Tasks view
- `/loops` — open the Loops view
- `Ctrl+Shift+L` — open the Tasks view

The Tasks sidebar reads `.features/*/tasks/*.md` and groups active briefs into **Ready** and derived **In Progress** sections. Selecting a task shows its brief on the right. When a running loop is associated with that task, the detail pane also shows its current iteration output.

The Loops sidebar reads `.pi/loop-jobs/` and groups current-project processes into **Running** and **Recent** sections. Feature-wide loops are associated with `_active.md`'s `Current` task only while running; loops without a reliable task remain unassigned in the Loops view.

The overlay refreshes every 1.5 seconds. It is intentionally read-only: it does not edit tasks or start, cancel, or restart loops.

## Controls

- `Up` / `Down`, `j` / `k` — select a task or loop
- `Tab` / `Shift+Tab` — switch Tasks and Loops views
- `PageUp` / `PageDown` — scroll task content or loop output
- `Enter` — expand or collapse the full brief for an in-progress task
- `o` — open the selected task's loop or the selected loop's task
- `G` / `End` — resume following live output
- `r` — refresh now
- `q` / `Esc` — close
