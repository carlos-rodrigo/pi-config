# semantic-search

Local hybrid code search for Pi, backed by Ollama embeddings plus lexical/symbol ranking.

## Tools

- `semantic_search` — natural-language code search over a local index. Uses local Ollama-generated semantic-card summaries plus embeddings by default, with lexical fallback. Returns ranked paths, line ranges, summary-based reasons, symbols, semantic-card matches, and compact previews.
- `repo_map` — clusters indexed files by reusable code concepts such as `auth`, `billing`, `search`, `ui`, and `agent`.
- `index_status` — shows whether the index exists and is fresh.

## Commands

```bash
/index status            # show index freshness
/index rebuild           # rebuild with Ollama summaries + embeddings
/index build             # alias for /index rebuild
/index rebuild mxbai-embed-large
/index rebuild --summary-model qwen2.5-coder:32b
/index rebuild --background
/index rebuild --status  # show background rebuild pid/state/log and current index freshness
/index rebuild --no-summaries
/index lexical           # rebuild lexical-only
/code-search <q>         # run a natural-language search and show results in the session
```

The index is stored under `.pi/semantic-search/index.json` in each project and is ignored by this repo's git settings.

## Ollama setup

```bash
ollama pull nomic-embed-text
ollama pull qwen2.5-coder:14b
# optional stronger/larger embedding model
ollama pull mxbai-embed-large
```

Configuration:

- `OLLAMA_HOST` or `OLLAMA_BASE_URL` — defaults to `http://127.0.0.1:11434`
- `OLLAMA_EMBED_MODEL` or `PI_SEMANTIC_SEARCH_EMBED_MODEL` — embedding model, defaults to `nomic-embed-text`
- `PI_SEMANTIC_SEARCH_SUMMARY_MODEL` — generation model for semantic-card summaries, defaults to `qwen2.5-coder:14b`
- `PI_SEMANTIC_SEARCH_SUMMARIES=false` — disable Ollama summary generation and use deterministic local summaries
- `PI_SEMANTIC_SEARCH_SUMMARY_CONCURRENCY` — parallel summary requests, defaults to `2`
- `PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS` — max characters sent per Ollama embedding input before adaptive retries; defaults to `6000`
- `PI_SEMANTIC_SEARCH_SUMMARY_MAX_CHARS` — max characters sent per Ollama summary prompt; defaults to `10000`

## Notes

- Calls only your local Ollama server; no cloud embedding service is used.
- Builds semantic cards for each file and detected symbols (classes, modules, methods, functions, markdown headings). Cards include path role, symbols, calls/references, comments, inferred concepts, and an Ollama-generated concise summary for meaning-oriented queries.
- Summary generation runs in parallel during embedding index builds and caches unchanged card summaries under `.pi/semantic-search/summaries.json`.
- `/index rebuild --background` starts the slower summary+embedding rebuild in a detached Node process and logs to `.pi/semantic-search/rebuild.log`.
- `/index rebuild --status` reports whether the last background rebuild is running, succeeded, failed, or unknown, plus recent log lines and current index freshness.
- Caps and adaptively shrinks embedding inputs before retrying Ollama context-length failures, so one oversized code chunk or semantic card should not abort the whole index build.
- Combines Ollama embedding similarity over raw chunks and semantic cards, lexical terms, paths, symbols, lightweight vector scoring, and code-concept expansion.
- Treat results as candidates: read the returned file range before editing.
