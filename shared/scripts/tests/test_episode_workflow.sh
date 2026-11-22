#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE_DIR="$(mktemp -d)/episode/剪播客"
mkdir -p "$BASE_DIR/2_分析"

cat > "$BASE_DIR/project.json" <<'JSON'
{
  "project": {"id": "episode-test", "updated_at": ""},
  "current_stage": "roughcut",
  "speakers": {"count": null, "mapping": {}, "verified": false},
  "pipeline": [
    {"id":"transcribe","status":"done","outputs":{},"summary":{}},
    {"id":"roughcut","status":"awaiting_review","outputs":{},"summary":{},"review":{}},
    {"id":"fine","status":"awaiting_review","outputs":{},"summary":{},"review":{}},
    {"id":"execute","status":"pending","outputs":{},"summary":{}}
  ]
}
JSON

if node "$REPO_ROOT/tools/podcastcut.mjs" episode start "$BASE_DIR" > "$BASE_DIR/missing.out" 2>&1; then
  echo "expected missing preferences to fail"
  exit 1
fi
grep -q 'PREFERENCE_REQUIRED' "$BASE_DIR/missing.out"

node "$REPO_ROOT/tools/podcastcut.mjs" episode start "$BASE_DIR" \
  --speaker-count 2 \
  --speaker "甲:主持" \
  --speaker "乙:嘉宾" \
  --editing-style "科研访谈" \
  --aggressiveness moderate \
  --target-minutes 50 \
  --glossary "Hydro90,CSC" >/dev/null

test -f "$BASE_DIR/episode_preferences.json"
test -f "$BASE_DIR/profile.json"
test -f "$BASE_DIR/_debrief.json"

if node "$REPO_ROOT/tools/podcastcut.mjs" episode execute "$BASE_DIR" > "$BASE_DIR/blocked.out" 2>&1; then
  echo "expected execute gate to fail before review approval"
  exit 1
fi
grep -q '需要审查或明确 OK 后才能出片' "$BASE_DIR/blocked.out"

printf '{"segments":[],"sentence_deletes":[],"partial_deletes":{}}\n' > "$BASE_DIR/2_分析/delete_segments_roughcut.json"
printf '{"segments":[],"sentence_deletes":[],"partial_deletes":{},"fine_edits":[]}\n' > "$BASE_DIR/2_分析/delete_segments_edited.json"
node "$REPO_ROOT/tools/podcastcut.mjs" episode review "$BASE_DIR" roughcut --ok >/dev/null
node "$REPO_ROOT/tools/podcastcut.mjs" episode review "$BASE_DIR" fine --ok >/dev/null
cat > "$BASE_DIR/2_分析/fine_analysis.json" <<'JSON'
{"edits":[
 {"sentenceIdx":1,"type":"stutter","deleteStart":1,"deleteEnd":1.2,"deleteText":"嗯"},
 {"sentenceIdx":2,"type":"stutter","deleteStart":2,"deleteEnd":2.2,"deleteText":"啊"},
 {"sentenceIdx":3,"type":"stutter","deleteStart":3,"deleteEnd":3.2,"deleteText":"呃"},
 {"sentenceIdx":4,"type":"stutter","deleteStart":4,"deleteEnd":4.2,"deleteText":"嗯"},
 {"sentenceIdx":5,"type":"stutter","deleteStart":5,"deleteEnd":5.2,"deleteText":"啊"}
]}
JSON
node "$REPO_ROOT/tools/podcastcut.mjs" episode learn "$BASE_DIR" fine >/dev/null
grep -q 'requires_user_confirmation' "$BASE_DIR/2_分析/learning_candidates.json"
node "$REPO_ROOT/tools/podcastcut.mjs" episode execute "$BASE_DIR" | grep -q 'OK execution gate passed'

echo "✅ episode workflow guard smoke passed"

