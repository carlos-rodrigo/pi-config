# web-tools

Web search and web fetch tools for agent use, modeled after Opencode-style `websearch` and `webfetch` behavior.

## Install

```bash
pi install ./extensions/web-tools
```

## What it adds

| Tool | Description |
|------|-------------|
| `websearch` | Searches the web using **Exa** by default, with optional **Tavily** support |
| `webfetch` | Fetches a URL and returns content as `text`, `markdown`, or raw `html` |

## Usage

**Ask the agent:**

```text
Search the web for the latest Pi package docs
Fetch https://example.com/docs as markdown
Search for Next.js caching docs, only from nextjs.org
```

## websearch

Parameters:
- `query` — search query string
- `provider` — `exa` or `tavily` (defaults to `exa`, matching Opencode)
- `allowed_domains` — optional allowlist
- `blocked_domains` — optional blocklist
- `limit` — optional result count cap

Environment variables:
- `EXA_API_KEY` for `provider=exa`
- `TAVILY_API_KEY` for `provider=tavily`

## webfetch

Parameters:
- `url` — fully formed `http`/`https` URL (`http` auto-upgrades to `https`)
- `format` — `text`, `markdown`, or `html`
- `maxChars` — optional output size cap

Behavior:
- Read-only
- Short in-memory cache window
- HTML pages are converted to markdown/text when requested
