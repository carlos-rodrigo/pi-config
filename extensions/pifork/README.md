# pifork

Open a fork of the current Pi session in another tmux pane/window.

## Command

```text
/pifork [--split horizontal|vertical|window|popup] [prompt]
```

Default is `horizontal` (side-by-side pane). With no prompt, it opens an interactive fork. With prompt text, it starts the request in a forked session, then reopens that same fork interactively so you can ask follow-up questions.

The fork uses `pi --fork <current-session-file>`, so the new Pi instance gets the same saved context but writes to a separate session file.

## Busy-session helper

On every `session_start`, this extension writes:

```text
.pi/pifork/current-session
.pi/pifork/open-fork.sh
```

When the current Pi UI is busy, run this from a tmux pane in the same project:

```bash
.pi/pifork/open-fork.sh
.pi/pifork/open-fork.sh "answer this in parallel"
```

You can bind that script in tmux, for example:

```tmux
bind-key P run-shell -b 'cd "#{pane_current_path}" && ./.pi/pifork/open-fork.sh'
```
