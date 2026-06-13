#!/usr/bin/env bash
#
# Install / update podcastcut skills as a self-contained snapshot under
# ~/.claude/skills/. Replaces the symlink-based install: each per-skill dir
# becomes a real directory with a copied SKILL.md + a shared/ symlink that
# points to a single canonical copy of shared/ (also under ~/.claude/skills/).
#
# Why: the old `ln -s "$PODCASTCUT_DIR/粗剪" ~/.claude/skills/podcastcut-粗剪`
# made $SKILL_DIR/shared/scripts/<x> path-resolve back into the live dev repo
# via SKILL.md's `$SKILL_DIR/shared/...` convention. When the dev repo's
# checkout drifted to a different branch, agents silently ran old/wrong code
# (see 2026-06-10 五点一刻 EP1 incident where wdyk's review was generated from
# a stale template because the shared checkout was on fix/finecut-dui-overdeletion).
# Snapshotting at install time decouples runtime behavior from dev repo state.
#
# Usage:
#   PODCASTCUT_DIR=/path/to/podcastcut-skills bash install.sh
#   # or — if invoked from within the repo:
#   cd /path/to/podcastcut-skills && bash 安装/install.sh
#
# OUTPUT_DIR env override:
#   OUTPUT_DIR=/somewhere bash install.sh   # default /Volumes/T9/claude_skill/podcastcut/output
#
# Re-running this script updates the install. Re-run after a `git pull` to
# refresh the snapshot.

set -euo pipefail

# ── Resolve PODCASTCUT_DIR ───────────────────────────────────────────────
if [ -z "${PODCASTCUT_DIR:-}" ]; then
  # Try: this script lives at <repo>/安装/install.sh → repo is one level up
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CANDIDATE="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ -d "$CANDIDATE/shared/scripts" ] && [ -d "$CANDIDATE/粗剪" ]; then
    PODCASTCUT_DIR="$CANDIDATE"
  else
    echo "❌ PODCASTCUT_DIR not set and could not auto-detect. Set it explicitly:" >&2
    echo "   PODCASTCUT_DIR=/path/to/podcastcut-skills bash $0" >&2
    exit 1
  fi
fi

if [ ! -d "$PODCASTCUT_DIR/shared/scripts" ]; then
  echo "❌ \$PODCASTCUT_DIR ($PODCASTCUT_DIR) does not look like a podcastcut-skills checkout (no shared/scripts/)" >&2
  exit 1
fi

OUTPUT_DIR="${OUTPUT_DIR:-/Volumes/T9/claude_skill/podcastcut/output}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.claude/skills}"
SHARED_DIR="$INSTALL_ROOT/podcastcut-shared"
CLOUD_BRIDGE_DIR="$INSTALL_ROOT/cloud-bridge"

# Skills to install. Order is arbitrary; 安装 itself is included so users can
# run the install skill / sync from inside Claude Code.
SKILLS=(
  安装
  粗剪
  精剪
  转录
  执行
  后期
  质检
  音质处理
  edit-chat
  onboarding-chat
  dispatcher
)

echo "🔧 podcastcut-skills install"
echo "   PODCASTCUT_DIR = $PODCASTCUT_DIR"
echo "   INSTALL_ROOT   = $INSTALL_ROOT"
echo "   OUTPUT_DIR     = $OUTPUT_DIR"
echo ""

mkdir -p "$INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT/profiles"

if [ -f "$PODCASTCUT_DIR/profiles/README.md" ]; then
  cp "$PODCASTCUT_DIR/profiles/README.md" "$INSTALL_ROOT/profiles/README.md"
fi

# ── Step 1: snapshot shared/ ─────────────────────────────────────────────
# rsync would be cleaner but cp -R is in posix and avoids the rsync dependency.
# Two-step (rm + cp) is safe because INSTALL_ROOT is user-owned.
echo "📦 Snapshotting shared/ → $SHARED_DIR"
rm -rf "$SHARED_DIR"
cp -R "$PODCASTCUT_DIR/shared" "$SHARED_DIR"

if [ -f "$PODCASTCUT_DIR/AGENT_ONBOARDING.md" ]; then
  cp "$PODCASTCUT_DIR/AGENT_ONBOARDING.md" "$SHARED_DIR/QUICKSTART_AGENT.md"
fi

echo "🌉 Snapshotting cloud-bridge/ → $CLOUD_BRIDGE_DIR"
rm -rf "$CLOUD_BRIDGE_DIR"
cp -R "$PODCASTCUT_DIR/cloud-bridge" "$CLOUD_BRIDGE_DIR"
rm -rf "$CLOUD_BRIDGE_DIR/sessions" "$CLOUD_BRIDGE_DIR/pending" "$CLOUD_BRIDGE_DIR/current_tunnel_url.txt"

# Record the dev-repo commit hash and timestamp at snapshot time. This is the
# debugging anchor when an agent reports stale behavior — it lets you ask
# "what does install_manifest.json say?" without crawling git logs.
INSTALL_MANIFEST="$SHARED_DIR/install_manifest.json"
GIT_COMMIT=$(cd "$PODCASTCUT_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(cd "$PODCASTCUT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
GIT_STATUS_DIRTY=$(cd "$PODCASTCUT_DIR" && git diff --quiet 2>/dev/null && echo "false" || echo "true")
cat > "$INSTALL_MANIFEST" <<EOF
{
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_dir": "$PODCASTCUT_DIR",
  "git_commit": "$GIT_COMMIT",
  "git_branch": "$GIT_BRANCH",
  "git_dirty": $GIT_STATUS_DIRTY,
  "schema_version": 1
}
EOF

# ── Step 2: per-skill install ────────────────────────────────────────────
for s in "${SKILLS[@]}"; do
  SRC="$PODCASTCUT_DIR/$s"
  DST="$INSTALL_ROOT/podcastcut-$s"

  if [ ! -d "$SRC" ]; then
    echo "  ⚠️  skip podcastcut-$s — source dir missing at $SRC"
    continue
  fi
  if [ ! -f "$SRC/SKILL.md" ]; then
    echo "  ⚠️  skip podcastcut-$s — no SKILL.md at $SRC"
    continue
  fi

  # Wipe-and-replace is safest. Migration from the old symlink layout: if the
  # existing entry is a symlink (old install), `rm -rf` removes the link only.
  rm -rf "$DST"
  mkdir -p "$DST"

  # SKILL.md is a real file copy. Avoids the "edit SKILL.md in dev repo and
  # have it silently change the installed skill" surprise.
  cp "$SRC/SKILL.md" "$DST/SKILL.md"

  # shared/ via symlink to the canonical snapshot. Inside one INSTALL_ROOT
  # this is effectively pointer-deduplication: one snapshot, ~11 references.
  # Symlink (not copy) is fine here because the target is itself a snapshot
  # under ~/.claude/skills/, not the live dev repo — branch drift is solved
  # at the snapshot level (step 1), not at this link.
  ln -s "../podcastcut-shared" "$DST/shared"

  # output/ is project state, not skill code. Stays a symlink to OUTPUT_DIR.
  ln -s "$OUTPUT_DIR" "$DST/output"

  # Optional per-skill extra files (templates, fixtures) — copy whatever lives
  # alongside SKILL.md so the skill dir is genuinely self-contained for any
  # idiosyncratic resources. Excludes shared/, output/ (handled above) and dotfiles.
  for extra in "$SRC"/*; do
    name=$(basename "$extra")
    case "$name" in
      SKILL.md|shared|output|.*) continue ;;
    esac
    if [ -e "$extra" ]; then
      cp -R "$extra" "$DST/$name"
    fi
  done

  echo "  ✅ podcastcut-$s"
done

# ── Step 3: pre-flight verify ────────────────────────────────────────────
# Cheap path existence check on the just-installed tree. Catches missing/
# broken links before the agent first invokes a script and silently fails.
echo ""
echo "🔍 Pre-flight: verifying installed paths …"
FAIL=0
for path in "$SHARED_DIR/QUICKSTART_AGENT.md" "$CLOUD_BRIDGE_DIR/scripts"; do
  if [ ! -e "$path" ]; then
    echo "  ❌ missing: $path"
    FAIL=$((FAIL + 1))
  fi
done
for s in "${SKILLS[@]}"; do
  DST="$INSTALL_ROOT/podcastcut-$s"
  [ -d "$DST" ] || continue
  for path in "$DST/SKILL.md" "$DST/shared/scripts" "$DST/shared/templates"; do
    if [ ! -e "$path" ]; then
      echo "  ❌ missing: $path"
      FAIL=$((FAIL + 1))
    fi
  done
done
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "❌ $FAIL path(s) missing after install. Something went wrong."
  exit 1
fi
echo "  ✅ all paths present"

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo "✅ Install complete."
echo "   Snapshot at $SHARED_DIR (git=$GIT_COMMIT, branch=$GIT_BRANCH$([ "$GIT_STATUS_DIRTY" = "true" ] && echo " DIRTY"))"
echo "   To update later: bash $0  (re-run after \`git pull\` in $PODCASTCUT_DIR)"
