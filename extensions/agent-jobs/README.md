# agent-jobs

Delegate to specialized Pi agents in the foreground or as detached background jobs. Both use the same durable launcher, trust checks, and artifacts. The launcher works in Herdr, tmux, and plain terminals.

## Install

```bash
pi install ./extensions/agent-jobs
```

## What it adds

| Feature | Description |
|---------|-------------|
| `subagent` tool | Waits for one agent or parallel tasks, shows progress, and returns results directly |
| `agent_job_start` tool | Starts an agent as a detached process and returns immediately |
| `agent_job_status` tool | Checks one job or lists recent jobs |
| `agent_job_cancel` tool | Requests cancellation of a running process group |
| `/research-bg` | Runs the `researcher` agent in the background |
| `/ask-oracle-bg` | Runs the `oracle` agent in the background |
| `/deep-review-bg` | Runs `oracle` with a parent-generated git diff review snapshot |

## Foreground delegation

Use `subagent` when the parent needs results in the current workflow. Use `agent_job_start` for explicitly background work. Do not install the example's separate `subagent` extension alongside this one.

```js
subagent({ agent: "researcher", task: "Trace authentication and cite relevant paths." })
subagent({ tasks: [
  { agent: "researcher", task: "Inspect authentication implementation." },
  { agent: "oracle", task: "Inspect authentication test coverage." }
] })
```

- Provide exactly one mode: `agent` + `task` (optional `cwd`), or `tasks` with per-task `cwd`.
- Up to eight tasks, four concurrent **per call**. Results remain in input order. Chains, global scheduling, and enforced nesting limits are not included.
- Progress is polled from bounded event-log tails; this is not token-by-token streaming. Direct output is capped at 5 KB/200 lines per task, with artifact paths for further inspection.
- Foreground jobs never send completion follow-ups or terminate the calling turn. A failed single task throws; parallel results report each success/failure without discarding successful siblings.
- Tool abort and session shutdown cancel owned foreground jobs with the existing process-identity checks, escalating after one second if needed. Detached background jobs remain independent. A hard parent crash leaves durable jobs available through status/cancel tools; it cannot run foreground cleanup.
- Both tools inherit the parent's model and thinking level when `model` is omitted in the agent definition. A pinned model keeps its own Pi thinking defaults. Agent `tools` accepts comma-separated strings or YAML arrays; discovery honors Pi's agent/config directory helpers.
- Supply bounded tasks, relevant paths, constraints, and expected evidence. Keep simple work inline. Parallel writers require separate worktrees; neither tool provides filesystem isolation.

Existing `/research-bg`, `/ask-oracle-bg`, and background prompt templates retain their explicit background behavior.

## How it works

Status, listing, and cancellation tools accept `cwd`, matching `agent_job_start`. Pass the launch project root when operating from another checkout. The command equivalent is `/agent-job-status --project-root /path/to/project [jobId]`.

Agent job launch/status/list/cancel require a trusted Pi session; cross-project targets also require saved trust for that root. Job directories and artifacts must stay inside the selected job and cannot be symlinks. Untrusted or malformed agent jobs are not resumed automatically.

Project-controlled agents require confirmation by default, including tool launches. If no confirmation UI is available, launch fails closed. `confirmProjectAgents: false` is an explicit caller opt-out, not a headless fallback.

Each job gets a directory under `.pi/agent-jobs/<jobId>/` containing:

- `status.json` — job metadata and state
- `events.jsonl` — child `pi --mode json` event stream
- `stderr.log` — child process stderr
- `result.md` — parsed final assistant output
- `review-context.md` — only for review jobs
- `run.sh` — the detached process entrypoint

The extension spawns `bash run.sh` as a detached process group, returns immediately, then watches `exit.json`. The same process launcher is used for background loop jobs. When an agent finishes, the extension parses the JSON events, writes `result.md`, and sends a follow-up user message into the originating Pi session.

Jobs with `followUp: true` end the calling agent turn and resume through that completion message. Jobs with `followUp: false` keep the caller active so a parent agent can launch several children, poll them with `agent_job_status`, and synthesize their results. Do not disable the follow-up unless the caller will poll explicitly.

Each new job records its originating Pi session id and session file. A different session may finalize the durable result, but it will not consume the completion follow-up. Delivery is acknowledged only when the follow-up reaches the originating session. If a reload, session switch, or transient delivery failure interrupts the handoff, the unfinished notification remains in `status.json` and is retried when that project session starts again. Jobs created before session routing was added retain the legacy project-session delivery behavior.

Agent cancellation checks the PID file and uses `ps` to verify that the PID is the process-group leader running this job's `bash run.sh` before sending SIGTERM. The existing `killWindow` option requests SIGKILL after another identity check. Missing processes finalize as cancelled; mismatched identities, unavailable process inspection, and legacy tmux-only jobs fail closed without signalling. These checks reduce stale-PID risk but are not an OS-level atomic process handle.

Review jobs snapshot `git status`, staged/unstaged diffs, diff stats, and safe untracked file previews before launching oracle. This lets the read-only oracle review current work without needing shell access.
