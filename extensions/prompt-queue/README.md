# prompt-queue

Interactive prompt queue for Pi.

## Commands

- `/queue` — open the queue palette
- `/queue-add <prompt>` — add a prompt to the queue
- `/queue-run` — run queued prompts serially, one at a time
- `/queue-stop` — stop after the current queued prompt

## Shortcut

- `Ctrl+Q` — open the queue palette
- `Alt+Q` — add the current editor text to the queue and clear the editor

## Palette keys

- `↑/↓` or `j/k` — select prompt
- `Enter` or `r` — run selected prompt and remove it from the queue after it finishes
- `p` — paste selected prompt into the editor without changing queue state
- `R` — run all queued prompts serially
- `a` — add prompt
- `e` — edit prompt
- `d` — delete prompt
- `Space` — toggle queued/done
- `s` — stop draining after current prompt
- `c` — clear done prompts
- `Esc` — close

Queued prompts are persisted as custom entries in the current Pi session, so the queue follows session history and reloads.
