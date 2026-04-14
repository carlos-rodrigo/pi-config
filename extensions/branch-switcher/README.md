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
| `/branch <name>` | Switch to a local branch or a unique remote-only branch |
| `/branch list` | Write available switch targets into the editor |
| `/branch current` | Show the current branch |

## Notes

- The picker shows local branches first and only includes remote branches that do not already exist locally.
- Typing `/branch origin/feature/foo` explicitly switches to that remote branch with `git switch --track`.
- If a unique remote branch exists without a local checkout, `/branch feature/foo` will create the local tracking branch automatically.
