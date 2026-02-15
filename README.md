# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions and themes.

## Install

### Via pi (extensions only)

```bash
pi install git:github.com/carlos-rodrigo/pi-config
```

### Via install.sh (extensions + themes)

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config
./install.sh
```

This symlinks all extensions and themes into `~/.pi/agent/`. Restart Pi and select a theme via `/settings`.

To update, just `git pull` — symlinks pick up changes automatically.

## Contents

### [Extensions](extensions/)

- **[bordered-editor](extensions/README.md#bordered-editor)** — Custom input box with rounded borders and embedded status info (model, context usage, cost, git branch).
- **[file-opener](extensions/README.md#file-opener)** — Open files in a syntax-highlighted overlay modal or in nvim via tmux. Adds `/open` command and `open_file` tool.

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.
