#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${HOME}/.pi/agent"
AGENTS_DIR="${HOME}/.agents"
AGENTS_SKILLS_DIR="${AGENTS_DIR}/skills"
LEGACY_PI_SKILLS_DIR="${PI_DIR}/skills"

echo "Installing pi-config from ${REPO_DIR}"
echo ""
echo "Note: For extensions only, you can also use:"
echo "  pi install git:github.com/carlos-rodrigo/pi-config"
echo ""

# Install npm dependencies into ~/.pi/agent so symlinked extensions can resolve them
echo "Installing dependencies..."
npm install --prefix "${PI_DIR}" --silent diff turndown
echo ""

# Create target directories
mkdir -p "${PI_DIR}/extensions"
mkdir -p "${PI_DIR}/themes"
mkdir -p "${PI_DIR}/agents"
mkdir -p "${PI_DIR}/prompts"
mkdir -p "${AGENTS_SKILLS_DIR}"

# Migrate legacy skills out of ~/.pi/agent/skills to ~/.agents/skills.
if [ -d "${LEGACY_PI_SKILLS_DIR}" ] || [ -L "${LEGACY_PI_SKILLS_DIR}" ]; then
  echo "Migrating legacy skills from ${LEGACY_PI_SKILLS_DIR} to ${AGENTS_SKILLS_DIR}..."
  migrated=0
  skipped=0
  for skill in "${LEGACY_PI_SKILLS_DIR}"/*; do
    [ -e "$skill" ] || [ -L "$skill" ] || continue
    name="$(basename "$skill")"
    target="${AGENTS_SKILLS_DIR}/${name}"

    if [ -e "$target" ] || [ -L "$target" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    cp -RL "$skill" "$target"
    echo "  ✓ migrated skill ${name}"
    migrated=$((migrated + 1))
  done

  rm -rf "${LEGACY_PI_SKILLS_DIR}"
  echo "  ✓ removed legacy ${LEGACY_PI_SKILLS_DIR} (migrated ${migrated}, skipped ${skipped})"
  echo ""
fi

# Remove stale symlinks (old single-file layout, dead links, test files).
for stale in "${PI_DIR}"/extensions/*.ts "${PI_DIR}"/extensions/*.test.ts; do
  [ -L "$stale" ] || continue
  rm "$stale"
  echo "  ✓ removed stale symlink $(basename "$stale")"
done
for stale in "${PI_DIR}"/extensions/lib; do
  [ -L "$stale" ] || continue
  rm "$stale"
  echo "  ✓ removed stale symlink $(basename "$stale")"
done

# --- Extensions (each extension is a directory with index.ts) ---
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
echo "  Skills location: ~/.agents/skills (legacy ~/.pi/agent/skills is removed by this installer)"
echo "  See: https://github.com/carlos-rodrigo/agents"
