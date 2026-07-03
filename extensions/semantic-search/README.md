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
/index rebuild mxbai-embed-large
/index rebuild --summary-model qwen2.5-coder:32b
/index rebuild --status  # show background rebuild pid/state/progress/ETA/log and current index freshness
/index rebuild --foreground # explicit blocking rebuild escape hatch
/index rebuild --no-summaries # background diagnostic: embeddings without generated card summaries
/index lexical           # diagnostic: rebuild lexical-only in the foreground
/code-search <q>         # run a natural-language search and show results in the session
```

The index is stored under `.pi/semantic-search/index.json` in each project and is ignored by this repo's git settings.

## Requirements

Default `semantic_search`, `/code-search`, and `/index rebuild` require local Ollama and these models:

```bash
# Start Ollama if it is not already managed by the desktop app/service:
ollama serve

ollama pull nomic-embed-text
ollama pull qwen2.5-coder:7b
# optional stronger/larger embedding model
ollama pull mxbai-embed-large
```

Lexical-only paths still exist for diagnostics (`/index lexical`, `/index rebuild --no-summaries`, or `semantic_search` with `useEmbeddings=false/useSummaries=false`), but they are explicit lower-quality escape hatches, not the default.

Configuration:

- `OLLAMA_HOST` or `OLLAMA_BASE_URL` — defaults to `http://127.0.0.1:11434`
- `OLLAMA_EMBED_MODEL` or `PI_SEMANTIC_SEARCH_EMBED_MODEL` — embedding model, defaults to `nomic-embed-text`
- `PI_SEMANTIC_SEARCH_SUMMARY_MODEL` — generation model for semantic-card summaries, defaults to `qwen2.5-coder:7b`
- `PI_SEMANTIC_SEARCH_SUMMARIES=false` — disables default summary generation and now causes the required default path to fail; prefer explicit lexical/debug commands when you intentionally want lower-quality local summaries
- `PI_SEMANTIC_SEARCH_SUMMARY_CONCURRENCY` — parallel summary requests, defaults to `2`
- `PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS` — max characters sent per Ollama embedding input before adaptive retries; defaults to `6000`
- `PI_SEMANTIC_SEARCH_SUMMARY_MAX_CHARS` — max characters sent per Ollama summary prompt; defaults to `10000`

## Notes

- Calls only your local Ollama server; no cloud embedding service is used.
- Default search/index rebuilds require Ollama summaries and embeddings; missing Ollama/models are treated as setup errors, not automatic lexical fallback.
- Builds semantic cards for each file and detected symbols (classes, modules, methods, functions, markdown headings). Cards include path role, symbols, calls/references, comments, inferred concepts, and an Ollama-generated concise summary for meaning-oriented queries.
- Summary generation runs in parallel during embedding index builds and caches unchanged card summaries under `.pi/semantic-search/summaries.json`.
- `/index rebuild` starts the slower summary+embedding rebuild in a detached Node process by default, so the main session does not block. While it runs, the composer/footer status shows a compact `index: ...` indicator. Use `/index rebuild --foreground` only when you explicitly want to wait in-session.
- `/index rebuild --status` reports whether the last background rebuild is running, succeeded, failed, or unknown, plus progress phase/count/ETA when available, recent log lines, and current index freshness.
- Caps and adaptively shrinks embedding inputs before retrying Ollama context-length failures, so one oversized code chunk or semantic card should not abort the whole index build.
- Combines Ollama embedding similarity over raw chunks and semantic cards, lexical terms, paths, symbols, lightweight vector scoring, and code-concept expansion.
- Treat results as candidates: read the returned file range before editing.
