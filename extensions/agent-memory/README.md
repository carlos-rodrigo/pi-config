# Agent Memory

Default-on, local Agent Memory for Pi. The extension provides visible controls, inspectable project/global memories, bounded prompt-time recall, and append-only review corrections.

## Status and controls

Pi publishes one of these footer states on `session_start` and after control commands:

- `mem: running`
- `mem: paused`
- `mem: disabled`

Use:

```text
/agent-memory status
/agent-memory pause
/agent-memory resume
/agent-memory disable
/agent-memory enable
/agent-memory reset
```

Pause is session-local. Disable and enable persist per project in `.pi/agent-memory/settings.json`. `/agent-memory reset` restores default-on control settings without changing memory records; scoped memory reset uses the commands below.

Startup and status output identify the project and global data roots, the local-only Ollama requirement, and the available controls.

## Manual seed memories

Create one atomic lesson with:

```text
/agent-memory add project "Use scripts/run_silent.sh for quiet verification"
/agent-memory add global "Prefer small focused changes"
```

Project records append to `<project-root>/.pi/agent-memory/memories.jsonl`; global records append to `$HOME/.pi/agent-memory/memories.jsonl`. The project root follows Verify's nearest `scripts/verify.sh`/Git-root resolution, so launching Pi from a repository subdirectory still uses the repository store. Confirmation shows the stored lesson, scope, manual command source, redaction result, and active/review state.

Obvious Authorization values, API keys, tokens, passwords, and secrets are replaced with `[REDACTED]`. Because that changes the user-approved final text, redacted records are stored as review candidates; unchanged explicit project/global additions are active. Vector work is queued in an atomically replaced `vectors.json` request cache using the configured embedding model; the first later recall resolves pending vectors through local Ollama and subsequent recalls reuse them.

## Prompt-time recall

For each normal prompt while memory is running, `before_agent_start`:

1. loads the latest active records from the project and global stores,
2. embeds the query and any uncached lessons with local Ollama,
3. applies hybrid semantic/lexical scoring with strict project-before-global precedence,
4. appends a bounded, explicitly advisory pack to that turn's system prompt, and
5. writes the influencing IDs and scoped details to `<project-root>/.pi/agent-memory/recall-log.jsonl`.

The pack is not posted or persisted as a session message. Status changes from `mem: recalling` to either `mem: ready · project N · global N` or `mem: ready · no matches`. Recall evidence is persisted before injection; if one scope fails, only successfully counted items are injected and a visible warning identifies skipped evidence. An audit-log failure also remains visible but does not cancel an already-counted injection. Candidate, archived, and later tombstoned records are excluded before embedding and scoring. Pause or disable skips recall.

## Verification feedback

The extension consumes automatic `self-improvement:verification` outcomes from the Verify extension. A ready recall keeps one session-local, same-project pending set; the next matching pass/fail consumes it once. Fire-and-forget feedback writes are drained before another recall, command, or shutdown, and the event subscription is replaced/removed with the Pi session lifecycle. Only the recalled content revisions that are still active receive append-only evidence updates; later edits or inactive states invalidate pending scoring while concurrent evidence-only revisions remain mergeable. Recall itself appends accurate `recalled` and `lastRecalledAt` evidence; passes increase `passed` and confidence, failures increase `failed` and reduce confidence, and confidence modestly adjusts later recall ranking.

A failed outcome with scored memories also creates one project-scoped `gotcha` candidate for review. The draft references the redacted verification command rather than storing raw failure output. Failure-only or sensitive text remains inactive until explicit review, and verification never creates or promotes a global candidate automatically. No recalled IDs, another project, disabled/paused memory, stale revisions, and repeated outcomes are no-ops.

## Setup failures

When active memories require recall but Ollama, the embedding model, vector cache, or local recall setup fails, the hook resolves without changing the current system prompt or blocking the requested task. It publishes:

```text
mem: failed · embeddings unavailable · /agent-memory status
```

The failed event is appended to the project `recall-log.jsonl` with a categorized reason, configured embedding/generation model names, manual recovery steps, and the disabled cloud-fallback policy. `/agent-memory status` and `/agent-memory review` show the same setup evidence, including recovery commands. An empty active store remains a normal no-match and does not contact Ollama; paused or disabled memory does not run setup checks.

## Review and corrections

Run `/agent-memory review` for text-first recent recall/setup events and current project/global records. Output includes IDs, scope/type/state, original source references, timestamps, evidence counters, revision metadata, promotion origins, and command-addressable actions.

Corrections append revisions or tombstones to `memories.jsonl`; they do not rewrite prior records. Scope writes use an atomic filesystem lock in addition to in-process serialization so concurrent Pi processes preserve append and vector-cache updates:

```text
/agent-memory archive project <id>
/agent-memory edit project|global <id> "corrected lesson"
/agent-memory delete project|global <id>
/agent-memory reject project|global <candidate-id>
/agent-memory approve project|global <candidate-id>
/agent-memory restore project|global <archived-id>
/agent-memory reset project|global|all
```

Archive can be restored. Deleted, rejected, and reset memories stay terminal and review output gives an `/agent-memory add ...` command to recreate the lesson deliberately. Only the latest `active` revision can be embedded, scored, or recalled; candidates and every inactive/tombstoned state are excluded before retrieval.

Project-to-global promotion is two-step:

```text
/agent-memory promote <project-id>
/agent-memory approve global <generated-candidate-id>
```

Promotion first creates an inactive global candidate. Path/client-specific, redacted, sensitive, or preference text must be generalized with `edit global` before approval succeeds. No promoted global record influences another project until the explicit approval command appends its active revision.

## Model configuration

[`config.json`](config.json) keeps the user-controlled remote Ollama defaults used by vector requests and recall:

- Effective tunnel URL: `http://127.0.0.1:11435`
- SSH target: `charleshippo@otto`
- Memory embeddings: `mxbai-embed-large`
- Generation/drafting: `qwen2.5-coder:14b`
- Cloud fallback: disabled

`OLLAMA_BASE_URL` or `OLLAMA_HOST` overrides the checked-in endpoint, including a fallback port selected by `/ollama-tunnel`. Start the shared tunnel before recall when it is not already running.

Recall uses the configured caps for project items, global items, total items, prompt characters, and minimum hybrid score. Memory retrieval is independent of semantic-search's code-file indexes.

## Manual workflow smoke

With the shared Ollama tunnel running:

```text
/ollama-tunnel
/agent-memory add project "Use scripts/run_silent.sh for quiet verification"
```

Then send a matching normal prompt such as `How should I run quiet verification?`; expect `mem: recalling` followed by `mem: ready · project 1 · global 0`. Run `/agent-memory review` and verify the memory ID, recall score, `recalled:1`, and `lastRecalledAt` are visible. Use `/agent-memory delete project <id>` or a disposable project so the smoke does not leave durable test memory.

## Test

```bash
npm run test:agent-memory
```
