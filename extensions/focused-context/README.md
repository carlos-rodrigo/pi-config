# focused-context

Durable topic briefs for short coding sessions.

Focused Context keeps one active brief in view, refreshes it from bounded sources, and warns when the session is getting stale.

## Install

```bash
pi install ./extensions/focused-context
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/brief-list` | Lists available brief topics from project and global storage |
| `/brief-pin <query>` | Pins an existing brief for the current session, with fuzzy topic/alias matching |
| `/brief-new <topic>` | Creates a brand-new brief for a topic, while avoiding duplicate existing briefs |
| `/brief-refresh` | Refreshes the current active/pinned brief |
| `/brief-capture [query]` | Recovers a brief from work already done in this session lineage |
| `/brief [query]` | Opens the current brief, or fuzzy-opens a matching brief by topic/alias |
| `brief_ensure` tool | Agent-callable create/reuse/refresh path that returns a compact brief slice |

## Where briefs live

Focused Context loads briefs from both places:

- project: `.pi/briefs/*.md`
- global: `~/.pi/agent/briefs/*.md`

Project briefs win if both locations define the same topic.

Briefs are markdown files with light frontmatter. The generated sections are refreshed automatically, but `## Manual Notes` is preserved across refreshes.

## Mental model

There are two kinds of brief commands:

- **Viewer commands**: help you inspect the current state
- **Action commands**: create or update a brief

The key UX rule is:

- **`/brief` is a true viewer** — it opens the active brief, or lets you fuzzy-open another brief with `/brief <query>`, without creating or refreshing anything.
- **Action commands** update the brief, then post a short timeline message telling you what happened. On success, they do not dump the full brief into the composer.

## Command flow

### 1. See what exists

```text
/brief-list
```

Use this first if you do not remember the topic name.

It shows available topics, aliases, source (`project` or `global`), and which topic is currently active or pinned.

### 2. Lock onto an existing topic

```text
/brief-pin billing
/brief-pin branch sw
```

Use this when the brief already exists and you want this session to stay on that topic.

`/brief-pin <query>` fuzzy-matches topic names and aliases. If the match is clear, it pins that brief. If the query is ambiguous, Focused Context shows the matching briefs so you can refine it.

Pinning matters because a **pinned** topic wins over auto-inference for the session.

### 3. Create a new brief for a new topic

```text
/brief-new billing
```

Use this when no brief exists yet.

If the input already clearly matches an existing brief, Focused Context opens that brief instead of creating a duplicate topic.

Otherwise it creates the brief from bounded sources, marks it active, and posts a short "created brief" message. After that, use `/brief` to read it.

### 4. Recover a brief after you've already done work

```text
/brief-capture
/brief-capture billing
/brief-capture branch sw
```

Use this when you forgot to start with a brief and want to recover context from the work you already did.

`/brief-capture` scans:

1. the current session
2. the parent session, if linked
3. handoff-linked ancestor sessions, if available
4. the latest handoff summary, if available

It tries to infer the topic automatically. If inference is ambiguous, pass the topic explicitly. Explicit queries can also fuzzy-match an existing brief; if the query is ambiguous, Focused Context shows the matching briefs instead of guessing:

```text
/brief-capture branch-switcher
```

This is the recovery command for "I already did the work; now make the brief intentional."

### 5. Refresh the current brief

```text
/brief-refresh
```

Use this when the current brief exists but has gone stale.

`/brief-refresh` only refreshes the **current active/pinned brief**. It does not take a topic argument.

If you want a different topic, use one of these instead:

- `/brief-pin <query>` for an existing brief
- `/brief-new <topic>` for a new brief
- `/brief-capture [query]` to recover from prior work

### 6. View the current brief

```text
/brief
/brief billing
/brief branch sw
```

Use this when you just want to read a brief.

- `/brief` opens the current active brief
- `/brief <query>` fuzzy-matches topic names and aliases, then opens the best match if it is clear
- if the query is ambiguous, Focused Context shows the matching briefs so you can refine it

In UI mode, it opens the brief via the file-opener overlay instead of replacing your draft in the composer. (`q` or `Esc` closes the viewer.)

If there is no active brief, it warns and points you back to `/brief-list` + `/brief-pin`, or to `/brief-new`.

## Which command should I use?

| Situation | Command |
|-----------|---------|
| I want to see all known topics | `/brief-list` |
| I know the topic already has a brief and I want to stay on it | `/brief-pin <query>` |
| This is a brand-new topic | `/brief-new <topic>` |
| I forgot to make a brief until after doing work | `/brief-capture [query]` |
| The current brief exists but is stale | `/brief-refresh` |
| I want to read the current brief | `/brief` |
| I want to open a brief but only remember part of the topic | `/brief <query>` |

## Composer impact

| Command | Composer behavior |
|---------|-------------------|
| `/brief-list` | Writes the topic list into the editor |
| `/brief-pin <query>` | Pins the best fuzzy match without replacing your draft; if ambiguous, shows the matching brief list |
| `/brief-new <topic>` | On success, posts a short timeline message instead of dumping the brief |
| `/brief-refresh` | On success, posts a short timeline message instead of dumping the brief |
| `/brief-capture [query]` | On success, posts a short timeline message instead of dumping the brief; if ambiguous, shows matching briefs |
| `/brief` | Opens the active brief in a viewer overlay instead of replacing your draft |
| `/brief <query>` | Fuzzy-opens a matching brief in the viewer; if ambiguous, shows the matching brief list |

## Status meanings

Focused Context publishes a compact status like:

```text
brief:billing · fresh
brief:billing · stale:C
brief:billing · stale:R · new-session?
```

### `fresh`

The current brief is still considered usable.

### `stale:T`

**T = time/session drift**

You have gone several turns since the last fresh checkpoint.

Usually do this next:

- `/brief-refresh` if you are staying in the same session on the same task

### `stale:C`

**C = changed hot files/docs**

A file or doc tracked as important by the brief was changed.

Usually do this next:

- `/brief-refresh`

### `stale:R`

**R = repeated recon / reread loop**

The session is looping on repeated `read` / `grep` / `find` / `bash` exploration.

Usually do this next:

- prefer a fresh session via `/handoff ...`
- then continue with the brief in the new session

### `stale:H`

**H = handoff or task/topic transition**

The work shifted meaningfully inside the session.

Usually do this next:

- if it is still the same topic, `/brief-refresh`
- if the topic changed, use `/brief-pin <query>` or `/brief-capture <query>`
- if the shift is large, prefer a fresh session via `/handoff ...`

### Multiple stale reasons

Reasons can stack:

```text
brief:billing · stale:T,C
```

That means more than one drift signal fired. In general:

- **one mild reason (`T` or `C`)** → refresh in place
- **`R` or `H`** → consider a fresh session soon
- **multiple reasons + `new-session?`** → prefer handoff over pushing the current session further

### `new-session?`

When Focused Context thinks the session is getting too heavy or unfocused, it adds:

```text
· new-session?
```

That is a nudge to start a fresh thread with `/handoff`, not a forced action.

## Recommended workflows

### Existing brief, same topic

```text
/brief-list
/brief-pin billing
/brief
```

### New topic

```text
/brief-new billing
/brief
```

### Forgot to start with a brief

```text
/brief-capture
/brief
```

If the inferred topic is wrong or ambiguous:

```text
/brief-capture billing
/brief
```

### Current brief went stale

```text
/brief-refresh
/brief
```

### Session is clearly degrading

When status shows something like:

```text
brief:billing · stale:R,H · new-session?
```

prefer:

1. use the suggested `/handoff ...`
2. continue in the fresh session
3. run `/brief` or `/brief-refresh` there if needed

## Agent tool

Focused Context also exposes:

```ts
brief_ensure({
  task: string,
  topic?: string,
  refresh?: "always" | "if_stale" | "never"
})
```

Use it when the agent needs one idempotent path to:

- select or infer a topic
- create a missing brief
- refresh a stale brief
- return a compact, task-relevant slice instead of the full file

Default refresh behavior is `if_stale`.
