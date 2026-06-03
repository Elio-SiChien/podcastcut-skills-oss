#!/usr/bin/env bash
#
# extract_commit_to_export.sh — take the raw state.committed.json that the
# browser POSTed via server.js and write the canonical
# delete_segments_{roughcut,edited}.json file that the rest of the pipeline
# (粗剪 → 精剪 → 执行) reads.
#
# The browser commit blob is the same shape as the legacy local "export"
# blob (review.html's doExport() builds both), but server.js doesn't enforce
# the schema — fields like exported_at/version are derived per-export by the
# page. We normalize here so downstream readers (粗剪 SKILL.md / 执行
# scripts) don't have to special-case "did this come from cloud or local".
#
# usage:
#   bash extract_commit_to_export.sh <session> <stage>
#
#   <session>   session token returned by create_session.sh
#   <stage>     "roughcut" | "fine"
#
# env:
#   SESSIONS_DIR   override session root. Default: <script_dir>/../sessions
#
# behaviour:
#   - reads $SESSIONS_DIR/<session>/meta.json to find base_dir
#   - reads $SESSIONS_DIR/<session>/state.committed.json
#   - normalises into the expected delete_segments_* schema:
#       version           "roughcut_v1" | "edited_v1"
#       exported_at       now (ISO)
#       original_duration / roughcut_duration / removed_duration
#                         best-effort: pull from state if present, else 0
#       segments          state.segments || []
#       sentence_deletes  state.sentence_deletes || []
#       partial_deletes   state.partial_deletes || {}
#       fine_edits        present iff stage=fine AND state has it
#   - writes to <base_dir>/2_分析/delete_segments_<filename>.json
#     where <filename> = roughcut (for stage=roughcut)
#                      = edited   (for stage=fine — matches the local
#                                  export naming review.html uses today)
#   - prints the absolute output path on stdout
#
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: bash extract_commit_to_export.sh <session> <stage>" >&2
  echo "       stage = roughcut | fine" >&2
  exit 2
fi

SESSION="$1"
STAGE="$2"

if [[ "$STAGE" != "roughcut" && "$STAGE" != "fine" ]]; then
  echo "error: stage must be 'roughcut' or 'fine' (got '$STAGE')" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSIONS_DIR="${SESSIONS_DIR:-$CLOUD_BRIDGE_DIR/sessions}"
SDIR="$SESSIONS_DIR/$SESSION"

if [[ ! -d "$SDIR" ]]; then
  echo "error: session dir not found: $SDIR" >&2
  exit 1
fi

META_FILE="$SDIR/meta.json"
COMMIT_FILE="$SDIR/state.committed.json"

if [[ ! -f "$META_FILE" ]]; then
  echo "error: meta.json missing: $META_FILE" >&2
  exit 1
fi
if [[ ! -f "$COMMIT_FILE" ]]; then
  echo "error: state.committed.json missing — has the user committed yet? ($COMMIT_FILE)" >&2
  exit 1
fi

# Delegate the actual JSON transform to node — much safer than jq for this
# project (jq is not a hard dep anywhere else).
OUT_PATH="$(node -e "
const fs = require('fs');
const path = require('path');

const metaPath = process.argv[1];
const commitPath = process.argv[2];
const stage = process.argv[3];

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(commitPath, 'utf8'));

if (!meta.base_dir) {
  console.error('error: meta.json has no base_dir');
  process.exit(1);
}

const isFine = stage === 'fine';
const filenameStage = isFine ? 'edited' : 'roughcut';
const versionTag = isFine ? 'edited_v1' : 'roughcut_v1';

const out = {
  version: versionTag,
  exported_at: new Date().toISOString(),
  original_duration: Number(state.original_duration) || 0,
  roughcut_duration: Number(state.roughcut_duration) || 0,
  removed_duration: Number(state.removed_duration) || 0,
  segments: Array.isArray(state.segments) ? state.segments : [],
  sentence_deletes: Array.isArray(state.sentence_deletes) ? state.sentence_deletes : [],
  partial_deletes: (state.partial_deletes && typeof state.partial_deletes === 'object')
    ? state.partial_deletes : {},
};

// fine_edits only for fine stage AND only if the state actually carries it.
// review.html's doExport() attaches fine_edits in fine stage; the commit
// blob is just doExport's payload POSTed up, so we pass it through verbatim.
if (isFine && Array.isArray(state.fine_edits)) {
  out.fine_edits = state.fine_edits;
}

const outDir = path.join(meta.base_dir, '2_分析');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'delete_segments_' + filenameStage + '.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
process.stdout.write(outPath);
" "$META_FILE" "$COMMIT_FILE" "$STAGE")"

echo "$OUT_PATH"
