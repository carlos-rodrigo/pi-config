# loop-monitor

Live Pi TUI dashboard for background loop tasks in the current project.

## Usage

- `/loops`
- `Ctrl+Shift+L`

The overlay reads only the current project's `.pi/loop-jobs/` statuses and matching `.features/{feature}/` task state. It refreshes every 1.5 seconds and shows the selected task's current iteration from `artifacts/loop/loop.log`.

## Controls

- `Tab` / `Shift+Tab` — change task
- `Up` / `Down`, `j` / `k`, `PageUp` / `PageDown` — scroll the log
- `G` / `End` — resume following new output
- `r` — refresh now
- `q` / `Esc` — close
