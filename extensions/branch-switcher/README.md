# branch-switcher

Switch git branches from inside pi.

## Install

```bash
pi install ./extensions/branch-switcher
```

## Commands

| Command | Description |
|---------|-------------|
| `/branch` | Open an interactive branch picker |
| `/branch <query>` | Switch to a branch by exact name or fuzzy match |
| `/branch list` | Write available switch targets into the editor |
| `/branch current` | Show the current branch |

## Notes

- The picker shows local branches first and only includes remote branches that do not already exist locally.
- Typing `/branch origin/feature/foo` explicitly switches to that remote branch with `git switch --track`.
- If a unique remote branch exists without a local checkout, `/branch feature/foo` will create the local tracking branch automatically.
- `/branch <query>` also supports fuzzy matching, so queries like `/branch remote on` can resolve to `origin/feature/remote-only` when the match is clear.
- If a fuzzy query is ambiguous, the extension writes the matching branches into the editor so you can refine the query.
