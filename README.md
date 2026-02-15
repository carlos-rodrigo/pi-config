# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions and themes.

## Setup

Add this repository as a package in your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["path/to/pi-config"]
}
```

Or symlink the contents into your Pi agent directory:

```bash
# Extensions
ln -s path/to/pi-config/extensions/*.ts ~/.pi/agent/extensions/

# Themes
ln -s path/to/pi-config/themes/*.json ~/.pi/agent/themes/
```

Then restart Pi and select the theme via `/settings`.

## Contents

### [Extensions](extensions/)

- **bordered-editor** — Custom input box with rounded borders (`╭╮│╰╯`) and embedded status info (model, context usage, cost, git branch).

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.
