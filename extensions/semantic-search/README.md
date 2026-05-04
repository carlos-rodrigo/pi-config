# semantic-search

Local hybrid code search for Pi, backed by Ollama embeddings plus lexical/symbol ranking.

## Tools

- `semantic_search` — natural-language code search over a local index. Uses local Ollama embeddings by default, with lexical fallback. Returns ranked paths, line ranges, reasons, symbols, semantic-card matches, and compact previews.
- `repo_map` — clusters indexed files by reusable code concepts such as `auth`, `billing`, `search`, `ui`, and `agent`.
- `index_status` — shows whether the index exists and is fresh.

## Commands

```bash
/index status            # show index freshness
/index rebuild           # rebuild with Ollama embeddings (default model: nomic-embed-text)
/index rebuild mxbai-embed-large
/index lexical           # rebuild lexical-only
/code-search <q>         # run a natural-language search and show results in the session
```

The index is stored under `.pi/semantic-search/index.json` in each project and is ignored by this repo's git settings.

## Ollama setup

```bash
ollama pull nomic-embed-text
# optional stronger/larger model
ollama pull mxbai-embed-large
```

Configuration:

- `OLLAMA_HOST` or `OLLAMA_BASE_URL` — defaults to `http://127.0.0.1:11434`
- `OLLAMA_EMBED_MODEL` or `PI_SEMANTIC_SEARCH_EMBED_MODEL` — defaults to `nomic-embed-text`
- `PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS` — max characters sent per Ollama embedding input before adaptive retries; defaults to `6000`

## Notes

- Calls only your local Ollama server; no cloud embedding service is used.
- Builds deterministic semantic cards for each file and detected symbols (classes, modules, methods, functions, markdown headings). Cards include path role, symbols, calls/references, comments, inferred concepts, and a concise summary for meaning-oriented queries.
- Caps and adaptively shrinks embedding inputs before retrying Ollama context-length failures, so one oversized code chunk or semantic card should not abort the whole index build.
- Combines Ollama embedding similarity over raw chunks and semantic cards, lexical terms, paths, symbols, lightweight vector scoring, and code-concept expansion.
- Treat results as candidates: read the returned file range before editing.
