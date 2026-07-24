#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/home/.pi/agent/extensions" "$FIXTURE/home/.pi/agent/skills/existing" "$FIXTURE/home/.pi/agent/skills/migrate" "$FIXTURE/home/.agents/skills/existing" "$FIXTURE/bin"
printf 'legacy copy\n' > "$FIXTURE/home/.pi/agent/skills/existing/SKILL.md"
printf 'new copy\n' > "$FIXTURE/home/.agents/skills/existing/SKILL.md"
printf 'move me\n' > "$FIXTURE/home/.pi/agent/skills/migrate/SKILL.md"
ln -s "$ROOT/extensions/pifork" "$FIXTURE/home/.pi/agent/extensions/pifork"
cat > "$FIXTURE/bin/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FIXTURE/bin/npm"

HOME="$FIXTURE/home" PATH="$FIXTURE/bin:$PATH" bash "$ROOT/install.sh" >/dev/null

test -f "$FIXTURE/home/.pi/agent/skills/existing/SKILL.md"
test "$(cat "$FIXTURE/home/.pi/agent/skills/existing/SKILL.md")" = "legacy copy"
test "$(cat "$FIXTURE/home/.agents/skills/existing/SKILL.md")" = "new copy"
test "$(cat "$FIXTURE/home/.agents/skills/migrate/SKILL.md")" = "move me"
test ! -e "$FIXTURE/home/.pi/agent/skills/migrate"
test ! -L "$FIXTURE/home/.pi/agent/extensions/pifork"
