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
mkdir -p "${PI_DIR}/agents"
mkdir -p "${PI_DIR}/prompts"

# --- Extensions (single files) ---
for f in "${REPO_DIR}"/extensions/*.ts; do
  [ -f "$f" ] || continue
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

# --- Extensions (directories, e.g. subagent/) ---
for d in "${REPO_DIR}"/extensions/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  target="${PI_DIR}/extensions/${name}"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -d "$target" ]; then
    echo "  ⚠ Skipping extensions/${name}/ — directory already exists (not a symlink)"
    continue
  fi
  ln -s "${d%/}" "$target"
  echo "  ✓ extensions/${name}/"
done

# --- Themes ---
for f in "${REPO_DIR}"/themes/*.json; do
  [ -f "$f" ] || continue
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

# --- Agents ---
for f in "${REPO_DIR}"/agents/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  target="${PI_DIR}/agents/${name}"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    echo "  ⚠ Skipping agents/${name} — file already exists (not a symlink)"
    continue
  fi
  ln -s "$f" "$target"
  echo "  ✓ agents/${name}"
done

# --- Prompts ---
for f in "${REPO_DIR}"/prompts/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  target="${PI_DIR}/prompts/${name}"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    echo "  ⚠ Skipping prompts/${name} — file already exists (not a symlink)"
    continue
  fi
  ln -s "$f" "$target"
  echo "  ✓ prompts/${name}"
done

echo ""
echo "Done. Restart pi or use /reload to pick up changes."
echo ""
echo "Note: AGENTS.md and skills are managed separately via the agents repo."
echo "  See: https://github.com/carlos-rodrigo/agents"
