#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${HOME}/.pi/agent"

echo "Installing pi-config from ${REPO_DIR}"
echo ""
echo "Note: For extensions only, you can also use:"
echo "  pi install git:github.com/carlos-rodrigo/pi-config"
echo ""

# Install npm dependencies into ~/.pi/agent so symlinked extensions can resolve them
echo "Installing dependencies..."
npm install --prefix "${PI_DIR}" --silent diff
echo ""

# Create target directories
mkdir -p "${PI_DIR}/extensions"
mkdir -p "${PI_DIR}/themes"

# Symlink extensions
for f in "${REPO_DIR}"/extensions/*.ts; do
  name="$(basename "$f")"
  target="${PI_DIR}/extensions/${name}"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    echo "  ⚠ Skipping extensions/${name} — file already exists (not a symlink)"
    continue
  fi
  ln -s "$f" "$target"
  echo "  ✓ extensions/${name}"
done

# Symlink themes
for f in "${REPO_DIR}"/themes/*.json; do
  name="$(basename "$f")"
  target="${PI_DIR}/themes/${name}"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    echo "  ⚠ Skipping themes/${name} — file already exists (not a symlink)"
    continue
  fi
  ln -s "$f" "$target"
  echo "  ✓ themes/${name}"
done

echo ""
echo "Done. Restart Pi and select a theme via /settings."
