# agent-jobs

Run specialized Pi agents as detached OS processes without blocking the main workflow session. The launcher works in Herdr, tmux, and plain terminals.

## Install

```bash
pi install ./extensions/agent-jobs
```

## What it adds

| Feature | Description |
|---------|-------------|
| `agent_job_start` tool | Starts an agent as a detached process and returns immediately |
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
- `run.sh` — the detached process entrypoint

The extension spawns `bash run.sh` as a detached process group, returns immediately, then watches `exit.json`. The same process launcher is used for background loop jobs. When an agent finishes, the extension parses the JSON events, writes `result.md`, and sends a follow-up user message into the originating Pi session.

Each new job records its originating Pi session id and session file. A different session may finalize the durable result, but it will not consume the completion follow-up. Delivery is acknowledged only when the follow-up reaches the originating session. If a reload, session switch, or transient delivery failure interrupts the handoff, the unfinished notification remains in `status.json` and is retried when that project session starts again. Jobs created before session routing was added retain the legacy project-session delivery behavior.

Cancellation sends an interrupt to the detached process group. The existing `killWindow` option is retained for tool-call compatibility and now means force-kill the process after requesting cancellation.

Review jobs snapshot `git status`, staged/unstaged diffs, diff stats, and safe untracked file previews before launching oracle. This lets the read-only oracle review current work without needing shell access.
