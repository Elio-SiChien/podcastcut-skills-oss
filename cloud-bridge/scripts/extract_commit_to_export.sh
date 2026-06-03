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
# A subtle but critical point — the cloud-bridge commit POST in review.html's
# setupCloudBridge() only sends {sentence_deletes, partial_deletes, fdis,
# rdExp}, NOT the segments[] array that doExport() builds locally. For the
# fine stage cut_audio.py reads segments[] to know what time ranges to cut,
# so if we just passthrough the commit blob, segments stays empty and the
# final m4a comes out byte-identical to the input. This script reconstructs
# segments + the active fine_edits[] from fine_analysis.json + fdis so the
# downstream pipeline doesn't break. See task #1 in #podcastcut-testing.
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
#   - normalises into the expected delete_segments_* schema
#   - for stage=fine: reconstructs segments[] and fine_edits[] from
#     base_dir/2_分析/fine_analysis.json + state.fdis (since the cloud-bridge
#     commit POST doesn't include the doExport-computed segments)
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

# Delegate the actual JSON transform to a sibling node script — easier to
# unit-test and keeps the shell wrapper short.
RECONSTRUCT_JS="$SCRIPT_DIR/_reconstruct_export.js"
if [[ ! -f "$RECONSTRUCT_JS" ]]; then
  echo "error: missing helper $RECONSTRUCT_JS" >&2
  exit 1
fi

OUT_PATH="$(node "$RECONSTRUCT_JS" "$META_FILE" "$COMMIT_FILE" "$STAGE")"
echo "$OUT_PATH"
