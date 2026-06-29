# checkpoint-rollback

Human-controlled git checkpoints for reversible Pi experiments.

## Commands

```bash
/checkpoint create [label]
/checkpoint list
/checkpoint preview [id|last]
/checkpoint rollback [id|last] [--confirm] [--force]
```

Rollback previews by default and only changes files with `--confirm`.

## Behavior

- Checkpoints are stored under `.pi/self-improvement/checkpoints/`.
- Each checkpoint records the current `HEAD`, branch, `git status --short`, a dirty diff summary, and a binary tracked-file patch from `git diff --binary HEAD`.
- Untracked file names are recorded, but untracked contents are not captured to avoid archiving secrets by surprise.
- Rollback restores tracked files to `HEAD`, reapplies the checkpoint patch, and refuses newly-created untracked files unless `--force` is provided.
- The extension never commits and does not run `git reset --hard`.

## Tool

Agents may call `checkpoint_rollback` with `action: create | list | preview | rollback`. `rollback` modifies files only when `confirm: true`.
