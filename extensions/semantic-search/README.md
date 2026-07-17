# semantic-search

Local hybrid code search for Pi, backed by required local Ollama semantic-card summaries and embeddings plus lexical/symbol ranking.

## Tools

- `semantic_search` — natural-language code search over a local index. Uses local Ollama-generated semantic-card summaries plus chunk/card embeddings by default. If Ollama or a required model is unavailable, it reports setup instructions instead of silently falling back to lexical search. Returns ranked paths, line ranges, summary-based reasons, symbols, semantic-card matches, and compact previews.
- `repo_map` — clusters indexed files by reusable code concepts such as `auth`, `billing`, `search`, `ui`, and `agent`.
- `index_status` — shows whether the index exists and is fresh.

## Commands

```bash
/index status            # show index freshness
/index rebuild           # start Ollama summary+embedding rebuild in the background
/index build             # alias for /index rebuild
/index rebuild nomic-embed-text # lighter embedding override
/index rebuild --summary-model qwen2.5-coder:14b # lighter summary override
/index rebuild --status  # show background rebuild pid/state/progress/ETA/log and current index freshness
/index rebuild --foreground # explicit blocking rebuild escape hatch
/index rebuild --no-summaries # background diagnostic: embeddings without generated card summaries
/index lexical           # diagnostic: rebuild lexical-only in the foreground
/code-search <q>         # run a natural-language search and show results in the session
/ollama-tunnel           # start localhost SSH tunnel to default remote Ollama (charleshippo@otto)
/ollama-tunnel user@host # override the SSH target
/ollama-tunnel status    # check whether the configured local Ollama URL is reachable
/ollama-tunnel local     # stop using the tunnel and point Pi at local Ollama
/ollama-tunnel stop      # kill matching SSH tunnel processes and point Pi at local Ollama
```

The index is stored under `.pi/semantic-search/index.json` in each project and is ignored by this repo's git settings. `worktree-manager` copy-on-write clones this index into new worktrees; relative paths and content-hash freshness checks make the clone reusable even though its absolute project path and checkout mtimes differ.

## Requirements

Default `semantic_search`, `/code-search`, and `/index rebuild` require local Ollama and the models configured in `extensions/semantic-search/config.json`. This repo currently configures:

```bash
# Start Ollama if it is not already managed by the desktop app/service:
ollama serve

ollama pull mxbai-embed-large
ollama pull qwen2.5-coder:14b
# optional alternatives
ollama pull nomic-embed-text
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5-coder:32b
```

Lexical-only paths still exist for diagnostics (`/index lexical`, `/index rebuild --no-summaries`, or `semantic_search` with `useEmbeddings=false/useSummaries=false`), but they are explicit lower-quality escape hatches, not the default.

### Remote Ollama over SSH tunnel

For heavier rebuilds on a stronger SSH-accessible machine, keep Ollama bound to localhost on the remote host and tunnel it to Pi:

```bash
# On the remote machine, make sure Ollama and models are ready:
ollama serve
ollama pull mxbai-embed-large
ollama pull qwen2.5-coder:14b
```

Then in Pi:

```bash
/ollama-tunnel           # defaults to charleshippo@otto
/index rebuild
/index rebuild --status
```

Or override the SSH target:

```bash
/ollama-tunnel user@remote-host
```

The command runs the equivalent of:

```bash
ssh -f -N -L 127.0.0.1:11434:127.0.0.1:11434 -o ExitOnForwardFailure=yes -o BatchMode=yes user@remote-host
```

If local port `11434` is already occupied (for example because local Ollama is running), `/ollama-tunnel` automatically tries `11435` through `11444` and points the current Pi process at the selected port via `OLLAMA_BASE_URL`. You can still force a specific port:

```bash
/ollama-tunnel --local-port 11435
/index rebuild
```

Use `--print` to show the SSH command without starting it. The tunnel command requires SSH key/agent auth because it runs with `BatchMode=yes`; it will not prompt for passwords inside Pi.

To disable remote Ollama without restarting Pi:

```bash
/ollama-tunnel local # reset this Pi process to http://127.0.0.1:11434
/ollama-tunnel stop  # also terminate matching SSH tunnel processes
```

Config file shape:

```json
{
  "excludePaths": [
    "**/.*/**",
    "docs/features/**/*.html"
  ],
  "ollama": {
    "embeddingModel": "mxbai-embed-large",
    "summaryModel": "qwen2.5-coder:14b"
  },
  "tunnel": {
    "sshTarget": "charleshippo@otto",
    "localHost": "127.0.0.1",
    "localPort": 11434,
    "remoteHost": "127.0.0.1",
    "remotePort": 11434
  }
}
```

Configuration:

- `extensions/semantic-search/config.json` — repo-local defaults for excluded paths, Ollama models, and SSH tunnel settings
- `excludePaths` — git-style path globs omitted from indexing; useful for hidden tool state (`**/.*/**`) and generated/planning HTML that should not make code search stale
- `PI_SEMANTIC_SEARCH_CONFIG` — optional path to an alternate JSON config file
- `OLLAMA_HOST` or `OLLAMA_BASE_URL` — overrides the configured Ollama URL; fallback is `http://127.0.0.1:11434`
- `OLLAMA_EMBED_MODEL` or `PI_SEMANTIC_SEARCH_EMBED_MODEL` — overrides the configured embedding model
- `PI_SEMANTIC_SEARCH_SUMMARY_MODEL` — overrides the configured generation model for semantic-card summaries
- `PI_SEMANTIC_SEARCH_SUMMARIES=false` — disables default summary generation and now causes the required default path to fail; prefer explicit lexical/debug commands when you intentionally want lower-quality local summaries
- `PI_SEMANTIC_SEARCH_SUMMARY_CONCURRENCY` — parallel summary requests, defaults to `2`
- `PI_OLLAMA_SSH_HOST` — override the configured SSH target for `/ollama-tunnel`
- `PI_OLLAMA_TUNNEL_LOCAL_PORT` / `PI_OLLAMA_TUNNEL_REMOTE_PORT` — override configured tunnel ports
- `PI_SEMANTIC_SEARCH_AUTO_REBUILD=false` — disable the automatic background rebuild after successful `write`/`edit` tool changes leave the index stale
- `PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS` — max characters sent per Ollama embedding input before adaptive retries; defaults to `6000`
- `PI_SEMANTIC_SEARCH_SUMMARY_MAX_CHARS` — max characters sent per Ollama summary prompt; defaults to `10000`

## Notes

- Calls only your local Ollama server; no cloud embedding service is used.
- Never indexes `.env`, `.env.*`, or `.envrc` files, even when they are not gitignored.
- Default search/index rebuilds require Ollama summaries and embeddings; missing Ollama/models are treated as setup errors, not automatic lexical fallback.
- Builds semantic cards for each file and detected symbols (classes, modules, methods, functions, markdown headings). Cards include path role, symbols, calls/references, comments, inferred concepts, and an Ollama-generated concise summary for meaning-oriented queries.
- Summary generation runs in parallel during embedding index builds and caches unchanged card summaries under `.pi/semantic-search/summaries.json`.
- `/index rebuild` starts the slower summary+embedding rebuild in a detached Node process by default, so the main session does not block. While it runs, the composer/footer status shows a compact `idx: ...` indicator. Use `/index rebuild --foreground` only when you explicitly want to wait in-session.
- After successful `write`/`edit` tool changes, `agent_end` checks freshness and starts the same background rebuild automatically when the index is stale. The composer/footer indicator shows running progress and briefly shows `idx: done` or `idx: failed`; only failures display a follow-up message with the final status/log path.
- `/index rebuild --status` reports whether the last background rebuild is running, succeeded, failed, or unknown, plus progress phase/count/ETA when available, recent log lines, and current index freshness.
- Caps and adaptively shrinks embedding inputs before retrying Ollama context-length failures, so one oversized code chunk or semantic card should not abort the whole index build.
- Combines Ollama embedding similarity over raw chunks and semantic cards, lexical terms, paths, symbols, lightweight vector scoring, and code-concept expansion.
- Treat results as candidates: read the returned file range before editing.
