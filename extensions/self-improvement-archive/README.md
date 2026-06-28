# self-improvement-archive

Quiet, local evidence capture for human-gated Pi config improvement.

## What it records

While Pi is active, the extension appends compact JSONL records to:

```text
.pi/self-improvement/archive.jsonl
```

Records include run duration, model/mode when available, tool counts, touched files, tool failures, structured verification outcomes, warnings, and notes. It does **not** store full prompts or session transcripts by default.

## Commands

```bash
/improve-archive status
/improve-archive last 10
/improve-archive failures
/improve-archive trends
/improve-archive proposal
/propose-improvement
```

`proposal` writes a human-gated improvement draft to the editor. It includes a deterministic low/medium/high scorecard for evidence strength, reproducibility, expected metric, effort, risk, rollback clarity, test coverage, and confidence, plus compound-engineering questions about how the change helps the next similar task and how to verify the learning. It does not edit code or launch agents.

## Tool

- `archive_analysis` — status, last, failures, trends, or proposal output for the agent.

## Visibility

This is quiet by default. It records local evidence while Pi is running. Background jobs only happen when a user explicitly starts `agent-jobs`, `loop-bg`, or another command that launches work.
