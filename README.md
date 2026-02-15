# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions and themes.

## Install

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config
./install.sh
```

This symlinks all extensions and themes into `~/.pi/agent/`. Restart Pi and select a theme via `/settings`.

To update, just `git pull` — symlinks pick up changes automatically.

## Contents

### [Extensions](extensions/)

- **bordered-editor** — Custom input box with rounded borders (`╭╮│╰╯`) and embedded status info (model, context usage, cost, git branch).

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.
