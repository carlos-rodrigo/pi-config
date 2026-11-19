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
| `/agents` | Live current-project agent manager: queue, output/errors, and safe cancellation |
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
- Both tools inherit the parent's model and thinking level when `model` is omitted in the agent definition. A pinned model keeps its own Pi thinking defaults. Agent `tools` and `model` accept comma-separated strings or YAML arrays; discovery honors Pi's agent/config directory helpers.
- Supply bounded tasks, relevant paths, constraints, and expected evidence. Keep simple work inline. Parallel writers require separate worktrees; neither tool provides filesystem isolation.

Existing `/research-bg`, `/ask-oracle-bg`, and background prompt templates retain their explicit background behavior.

## Model fallback

An agent's `model` may be an ordered list: `model: claude-bridge/claude-opus-5-5:high, openai/gpt-6.1-sol:xhigh` or a YAML list. The first entry is the primary (`AgentConfig.model`); `AgentConfig.models` holds the whole list. Both `subagent` and `agent_job_start` run the next model only when an attempt failed because its provider was unavailable:

- quota, usage or billing limits (`Claude quota exceeded … 5-hour limit`, `Subscription Sharing usage limit`, `insufficient_quota`);
- rate limits and overloaded or unavailable services;
- authentication, API-key or subscription failures;
- an unknown or unavailable model.

Classification starts from structured data: only an attempt whose last assistant message has `stopReason: "error"` can fall back, and its `errorMessage` is matched against those patterns (`model-fallback.ts`). Pi exposes no provider status code, so the text match is the documented fallback. Only when no assistant message exists (Pi failed at startup) is an `Error:` line on Pi's stderr matched. Ordinary task failures, other model errors, transport failures that Pi already retried, timeouts and cancellation (`aborted` or a forwarded signal) never fall back, and a non-zero exit by itself never falls back.

All attempts run inside the job's one `run.sh` process group, so PID, cancellation and cleanup checks are unchanged. `run.sh` asks `model-fallback-cli.ts` (run with the parent's Node) after each attempt; a classifier failure means no fallback. The current attempt always writes `events.jsonl`/`stderr.log`; an abandoned attempt's logs move to `attempt-N.events.jsonl`/`attempt-N.stderr.log`. A fallback attempt is told which model stopped and that it may have left edits in the working tree to inspect and preserve.

When the job finishes, `status.json` records `models` (the list), `attempts` (`[{ model, error? }]` in order, with each failure reason) and `model` (the model that actually ran; the primary until then). `subagent` results, `agent_job_status` text and structured `job.attempts`, and completion follow-ups show `Model: …` plus one `Unavailable model: … — reason` line per abandoned attempt. If the final attempt fails after a fallback, the job fails and `errorMessage` lists each tried model with its reason, prefixed `Every model attempt failed —` when the whole list was tried and `Failed after model fallback —` when an ordinary failure stopped it early. For a job cancelled between attempts, `model`/`attempts` are best-effort: they may name the primary or the next model rather than the one last running.

## Agent manager

`/agents` opens an interactive TUI overlay for the current project. It lists all active agent jobs and the latest 20 finished entries, including durable jobs from other sessions. Queued/launching foreground tasks and failures before a job record exists are visible only in the originating session; they are not persisted.

Select a row to inspect its task, model, session origin, follow-up setting, artifact paths, and bounded output/error previews. The overlay refreshes every 1.5 seconds while open; previews read at most 64 KiB per selected artifact and display at most 200 source lines. Reasoning content is not displayed. Use artifact paths for complete output.

- Arrows / `j` / `k`: select an agent.
- PageUp / PageDown: scroll details.
- Tab: switch output/errors.
- `c`: request cancellation of a running job; `y` / Enter confirms, `n` / Escape returns.
- `r`: refresh; `q` / Escape: close.

Cancellation uses the same trust, artifact and process-identity checks as `agent_job_cancel`. Queued/launching tasks cannot be cancelled from the overlay. Closing it never cancels jobs; ordinary session shutdown still cancels owned foreground work and leaves detached jobs independent.

Counts describe **recorded running** jobs, not verified OS process health. An exit marker awaiting lifecycle reconciliation is shown explicitly; quiet output is not treated as a dead process. Refresh errors preserve the last good snapshot with a warning. Outside the interactive TUI, use `/agent-job-status` or `agent_job_status`.

The manager does not change concurrency, launch agents, or retry jobs.

## How it works

Status, listing, and cancellation tools accept `cwd`, matching `agent_job_start`. Pass the launch project root when operating from another checkout. The command equivalent is `/agent-job-status --project-root /path/to/project [jobId]`.

Agent job launch/status/list/cancel require a trusted Pi session; cross-project targets also require saved trust for that root and its job directory. Job directories and artifacts are validated and cannot be symlinks. Untrusted or malformed jobs are not resumed automatically.

Agent artifacts stay inside the selected job. Other supplied paths, malformed records and symlinked ancestor directories fail closed.

Project-controlled agents require confirmation by default, including tool launches. If no confirmation UI is available, launch fails closed. `confirmProjectAgents: false` is an explicit caller opt-out, not a headless fallback.

Each job gets a directory under `.pi/agent-jobs/<jobId>/` containing:

- `status.json` — job metadata and state
- `events.jsonl` — child `pi --mode json` event stream
- `stderr.log` — child process stderr
- `result.md` — parsed final assistant output
- `attempt-N.events.jsonl`, `attempt-N.stderr.log` — logs of attempts abandoned for an unavailable provider
- `review-context.md` — only for review jobs
- `run.sh` — the detached process entrypoint

The extension spawns `bash run.sh` as a detached process group, returns immediately, then watches `exit.json`. When an agent finishes, the extension parses the JSON events, writes `result.md`, and sends a follow-up user message into the originating Pi session.

Jobs with `followUp: true` end the calling agent turn and resume through that completion message. Jobs with `followUp: false` keep the caller active so a parent agent can launch several children, poll them with `agent_job_status`, and synthesize their results. Do not disable the follow-up unless the caller will poll explicitly.

Each new job records its originating Pi session id and session file. Other sessions may finalize the durable result but cannot consume its follow-up. Delivery is acknowledged only when the message reaches the originating conversation with its in-memory token; unrelated comments, unmatched tokens and other sessions cannot acknowledge a job. Appended instructions and combined dequeued completions acknowledge every matching marker. Plain receipts survive `/reload` in the same process without writing tokens into job artifacts. A received message whose acknowledgement write fails retries persistence only—not delivery. Legacy jobs without session routing retain project-session delivery behavior.

If a queued completion is moved into the editor and discarded, an idle, empty queue releases the gate after five seconds so later completions can proceed. The discarded message is not automatically resent or marked delivered; its token remains valid and its result remains durable. Session replacement (`new`/`resume`/`fork`) destroys the old queue and releases outgoing unreceived suppression, allowing recovery when the originating session resumes. Reload preserves queued and editor-owned receipts.

Pi's void send API does not expose asynchronous acceptance. Unknown attempts are therefore not blindly resent by polling or reload. Use `/agent-notification-retry <job-id>` in the originating conversation to explicitly retry: it requires an idle, empty queue and interactive confirmation, and refuses a matching editor-owned message. An explicit retry may duplicate a late dispatch; it never restarts the job. Received receipts retry their acknowledgement write instead. Restarting Pi also permits recovery of durable unacknowledged notifications.

Agent cancellation checks the PID file and uses `ps` to verify that the PID is the process-group leader running this job's `bash run.sh` before sending SIGTERM. The existing `killWindow` option requests forced process-group cleanup. Escalation checks surviving members’ PID, start time and process-group identity, including descendants left after the wrapper exits; unverifiable ownership fails closed. Missing processes finalize as cancelled; mismatched identities, unavailable process inspection, and legacy tmux-only jobs fail closed without signalling. These checks reduce stale-PID risk but are not an OS-level atomic process handle. Ordinary duplicate cancellation requests remain deduplicated, but explicit forced requests may retry or escalate an earlier pending request after fresh ownership checks. If a crash interrupted PID persistence, a validated PID file plus matching process-group/run-script identity can recover cancellation ownership.

Status polling reconciles a verified missing supervisor and empty live process group without an exit marker as failed (or cancelled when cancellation was requested). A missing supervisor with surviving descendants remains uncertain. It rechecks the exit marker after probing so normal completion wins a race. Mismatched identities, legacy records and unavailable process inspection remain uncertain—not presumed dead. The manager itself remains an observer and does not infer process health from quiet output.

A status-persistence failure after spawning triggers identity-checked process-group cleanup before reporting launch failure. Cleanup checks the whole live group, not only the wrapper PID; foreground abort uses the same descendant-aware escalation. If cleanup cannot be verified, the record retains its running state and PID with the cleanup error when persistence is possible. An internal `.cleanup-pending.json` journal prevents a wrapper’s exit marker from erasing that uncertainty; only verified absence of live group members clears it. Journals never authorize signals. In-memory member evidence can support a verified retry while the current extension runtime remains active; after reload or restart, surviving descendants without a verifiable supervisor remain uncertain rather than being blindly killed. Generated script diagnostics quote names and paths as literal data.

Lifecycle read/modify/write transitions are serialized per job, including across Pi processes, so polling, cancellation and acknowledgement cannot overwrite each other’s newer state. Internal `.lifecycle/` contender files order mutations; only the current caller’s file is removed. Verified dead owners are ignored, while unknown ownership fails closed. This does not limit job execution concurrency or add a scheduler.

Job history is retained; the manager’s latest-20 terminal-row limit is a display limit, not automatic deletion. No retention policy or global scheduler is introduced by these recovery checks.

Review jobs snapshot `git status`, staged/unstaged diffs, diff stats, and safe untracked file previews before launching oracle. This lets the read-only oracle review current work without needing shell access.
