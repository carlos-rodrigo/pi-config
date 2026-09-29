# code-intel

Non-semantic code navigation tools for Pi. Use these when exact symbols, structure, dependencies, or history are a better fit than semantic search.

## Tools

- `code_find` — orchestrates the best strategy for a query: exact text, symbols, semantic candidates, dependency impact, git history, or AST structure.
- `symbol_search` — find functions, classes, types, commands, tools, and markdown headings by name/path/signature.
- `dependency_map` — inspect direct imports and reverse dependents for a file, or high-degree files when no path is given.
- `git_pickaxe` — search git history with `git log -S` or `git log -G`.
- `ast_search` — run ast-grep structural search when `sg` or `ast-grep` is installed.

## Codemode composition

`symbol_search` remains directly callable and keeps its readable text output. Codemode callers receive `{ query, results }`, where each result contains `name`, `kind`, project-relative `path`, 1-based `line`, `signature`, and optional `score`.

After changing the extension, run `/reload` in Pi. A codemode script can search and read matching files without parsing the display text:

```js
const report = await tools.symbol_search({ query: "checkout", limit: 5 });
const paths = [...new Set(report.results.map(result => result.path))];
const reads = await Promise.allSettled(
  paths.map(path => tools.read({ path, limit: 120 }))
);
reads.forEach((result, i) => text({ path: paths[i], result }));
```

An empty search returns `{ query, results: [] }`.

## Optional ast-grep setup

```bash
brew install ast-grep
```

Use `ast_search` for code shapes like function calls, import forms, or API usage where grep is too noisy.

## Suggested use

Start with `code_find` when you are unsure which search mode fits. Use the specific tools directly when the intent is already obvious.
