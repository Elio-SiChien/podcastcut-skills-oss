#!/usr/bin/env bash
# Offline smoke test for tools/podcastcut.mjs.
#
# Creates a tiny project fixture and verifies that status/validate can read the
# same handoff files a real agent depends on.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BASE_DIR="$TMP_DIR/output/smoke_fixture/剪播客"
mkdir -p "$BASE_DIR/1_转录" "$BASE_DIR/2_分析" "$BASE_DIR/3_成品"

touch "$BASE_DIR/1_转录/audio_original.mp3"
touch "$BASE_DIR/1_转录/audio_seekable.mp3"
printf '{"speakers":{"0":"Host"}}\n' > "$BASE_DIR/1_转录/speaker_mapping.json"
printf '[]\n' > "$BASE_DIR/1_转录/subtitles_words.json"
printf '0|0.00|Host|这是一句测试。\n' > "$BASE_DIR/2_分析/sentences.txt"
printf '{"chapters":[]}\n' > "$BASE_DIR/2_分析/semantic_deep_analysis.json"
printf '{"delete_segments":[]}\n' > "$BASE_DIR/2_分析/fine_analysis.json"
printf '{"segments":[],"sentence_deletes":[],"partial_deletes":{}}\n' > "$BASE_DIR/2_分析/delete_segments_roughcut.json"
printf '[]\n' > "$BASE_DIR/2_分析/delete_segments_edited.json"
cat > "$BASE_DIR/episode_preferences.json" <<'JSON'
{
  "version": "episode_preferences_v1",
  "speaker_count": 1,
  "speakers": [{"name": "Host", "role": "主持"}],
  "editing_style": "smoke test",
  "aggressiveness": "moderate",
  "target_minutes": 30,
  "must_keep": [],
  "must_delete": [],
  "privacy": [],
  "glossary": []
}
JSON
cat > "$BASE_DIR/episode_review_gate.json" <<'JSON'
{
  "roughcut": {"approved": true, "source": "test"},
  "fine": {"approved": true, "source": "test"}
}
JSON
touch "$BASE_DIR/3_成品/smoke_fixture.m4a"

cat > "$BASE_DIR/project.json" <<'JSON'
{
  "schema_version": "1.0",
  "project": {
    "id": "smoke_fixture",
    "title": "CLI Smoke Fixture"
  },
  "current_stage": "fine",
  "pipeline": [
    { "id": "transcribe", "label": "转录", "status": "done" },
    { "id": "roughcut", "label": "粗剪", "status": "approved" },
    { "id": "fine", "label": "精剪", "status": "in_progress" },
    { "id": "execute", "label": "执行剪辑", "status": "pending" },
    { "id": "qa", "label": "质检", "status": "pending" },
    { "id": "audio_quality", "label": "音质处理", "status": "pending" },
    { "id": "post", "label": "后期", "status": "pending" }
  ]
}
JSON

STATUS_OUT="$(node "$REPO_ROOT/tools/podcastcut.mjs" status "$BASE_DIR")"
if ! grep -q "Project: smoke_fixture" <<< "$STATUS_OUT"; then
  echo "❌ status did not print project id" >&2
  echo "$STATUS_OUT" >&2
  exit 1
fi

if ! grep -q "> fine" <<< "$STATUS_OUT"; then
  echo "❌ status did not mark current stage" >&2
  echo "$STATUS_OUT" >&2
  exit 1
fi

FOOTER_OUT="$(node "$REPO_ROOT/tools/podcastcut.mjs" footer "$BASE_DIR" roughcut)"
if ! grep -q "当前已完成：粗剪" <<< "$FOOTER_OUT"; then
  echo "❌ footer did not print completed stage" >&2
  echo "$FOOTER_OUT" >&2
  exit 1
fi

if ! grep -q "下一步：精剪（词级口癖删减，自动）" <<< "$FOOTER_OUT"; then
  echo "❌ footer did not print expected next step" >&2
  echo "$FOOTER_OUT" >&2
  exit 1
fi

for stage in transcribe roughcut fine execute qa audio_quality post; do
  node "$REPO_ROOT/tools/podcastcut.mjs" validate "$BASE_DIR" "$stage" >/dev/null
done

INSTALL_ROOT="$TMP_DIR/install"
mkdir -p \
  "$INSTALL_ROOT/podcastcut-shared/scripts" \
  "$INSTALL_ROOT/podcastcut-shared/templates" \
  "$INSTALL_ROOT/podcastcut-edit-chat" \
  "$INSTALL_ROOT/podcastcut-dispatcher" \
  "$INSTALL_ROOT/cloud-bridge/scripts" \
  "$INSTALL_ROOT/profiles"

cat > "$INSTALL_ROOT/podcastcut-shared/install_manifest.json" <<'JSON'
{
  "installed_at": "2026-06-12T00:00:00Z",
  "source_dir": "/tmp/podcastcut-skills",
  "git_commit": "smoke-test",
  "git_branch": "main",
  "git_dirty": false,
  "schema_version": 1
}
JSON
touch "$INSTALL_ROOT/podcastcut-edit-chat/SKILL.md"
touch "$INSTALL_ROOT/podcastcut-dispatcher/SKILL.md"
ln -s "../podcastcut-shared" "$INSTALL_ROOT/podcastcut-edit-chat/shared"
ln -s "../podcastcut-shared" "$INSTALL_ROOT/podcastcut-dispatcher/shared"
printf 'https://smoke.trycloudflare.com\n' > "$INSTALL_ROOT/cloud-bridge/current_tunnel_url.txt"
printf '{"name":"smoke"}\n' > "$INSTALL_ROOT/profiles/smoke.json"

FRESH_PODCAST_OUT="$(node "$REPO_ROOT/tools/podcastcut.mjs" fresh-agent --role podcast --install-root "$INSTALL_ROOT" --output-dir "$TMP_DIR/output")"
if ! grep -q "podcastcut fresh-agent (podcast)" <<< "$FRESH_PODCAST_OUT"; then
  echo "❌ fresh-agent podcast did not print role header" >&2
  echo "$FRESH_PODCAST_OUT" >&2
  exit 1
fi

FRESH_DISPATCHER_OUT="$(node "$REPO_ROOT/tools/podcastcut.mjs" fresh-agent --role dispatcher --install-root "$INSTALL_ROOT" --output-dir "$TMP_DIR/output")"
if ! grep -q "podcastcut fresh-agent (dispatcher)" <<< "$FRESH_DISPATCHER_OUT"; then
  echo "❌ fresh-agent dispatcher did not print role header" >&2
  echo "$FRESH_DISPATCHER_OUT" >&2
  exit 1
fi

echo "✅ CLI smoke status/validate/footer/fresh-agent passed"
