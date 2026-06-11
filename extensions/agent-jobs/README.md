# agent-jobs

Run specialized Pi agents in detached tmux windows without blocking the main workflow session.

## Install

```bash
pi install ./extensions/agent-jobs
```

## What it adds

| Feature | Description |
|---------|-------------|
| `agent_job_start` tool | Starts an agent in a detached tmux window and returns immediately |
| `agent_job_status` tool | Checks one job or lists recent jobs |
| `agent_job_cancel` tool | Sends `Ctrl+C` to a running job window |
| `/research-bg` | Runs the `researcher` agent in the background |
| `/ask-oracle-bg` | Runs the `oracle` agent in the background |
| `/deep-review-bg` | Runs `oracle` with a parent-generated git diff review snapshot |

## How it works

Each job gets a directory under `.pi/agent-jobs/<jobId>/` containing:

- `status.json` — job metadata and state
- `events.jsonl` — child `pi --mode json` event stream
- `stderr.log` — child process stderr
- `result.md` — parsed final assistant output
- `review-context.md` — only for review jobs
- `run.sh` — the tmux window entrypoint

The extension starts `tmux new-window -d ...`, returns immediately, then watches `exit.json`. When the job finishes it parses the JSON events, writes `result.md`, and sends a follow-up user message into the main Pi session.

Review jobs snapshot `git status`, staged/unstaged diffs, diff stats, and safe untracked file previews before launching oracle. This lets the read-only oracle review current work without needing shell access.
