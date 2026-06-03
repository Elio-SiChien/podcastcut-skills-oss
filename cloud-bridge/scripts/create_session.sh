#!/usr/bin/env bash
#
# create_session.sh — provision a cloud-bridge session directory for one
# checkpoint (roughcut or fine review). Wraps the manual mkdir + meta.json
# steps from cloud-bridge/README.md so edit-chat (and humans) can just call
# this helper and get a session token back.
#
# usage:
#   bash create_session.sh <stage> <review_html_path> <audio_path>
#
#   stage              "roughcut" | "fine"
#   review_html_path   absolute path to the generated review HTML
#                      (e.g. <base_dir>/review_roughcut.html or
#                            <base_dir>/review_enhanced.html)
#   audio_path         absolute path to the audio file the page will stream
#                      (typically <base_dir>/1_转录/audio_seekable.mp3)
#
# env:
#   SESSIONS_DIR       override session root. Default: <script_dir>/../sessions
#
# behaviour:
#   - generates a 12-char lowercase-alphanumeric session token
#   - creates $SESSIONS_DIR/<session>/
#   - writes meta.json with the fields server.js expects
#   - prints the session token (and ONLY the session token) on stdout
#   - exits 0 on success, non-zero on any failure
#
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: bash create_session.sh <stage> <review_html_path> <audio_path>" >&2
  echo "       stage = roughcut | fine" >&2
  exit 2
fi

STAGE="$1"
REVIEW_HTML_PATH="$2"
AUDIO_PATH="$3"

if [[ "$STAGE" != "roughcut" && "$STAGE" != "fine" ]]; then
  echo "error: stage must be 'roughcut' or 'fine' (got '$STAGE')" >&2
  exit 2
fi

if [[ ! -f "$REVIEW_HTML_PATH" ]]; then
  echo "error: review_html_path does not exist: $REVIEW_HTML_PATH" >&2
  exit 1
fi

if [[ ! -f "$AUDIO_PATH" ]]; then
  echo "error: audio_path does not exist: $AUDIO_PATH" >&2
  exit 1
fi

# Resolve script dir → cloud-bridge dir → default sessions dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSIONS_DIR="${SESSIONS_DIR:-$CLOUD_BRIDGE_DIR/sessions}"

mkdir -p "$SESSIONS_DIR"

# Derive base_dir from review_html_path's parent (matches existing convention
# in cloud-bridge/README.md integration snippet)
BASE_DIR="$(cd "$(dirname "$REVIEW_HTML_PATH")" && pwd)"

# Generate 12-char lowercase-alphanumeric token. Use node for portability
# (LC_ALL=C tr from /dev/urandom works on mac+linux but is finicky on some
# zsh setups; node is already a hard dep of this project).
SESSION="$(node -e "
const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
const buf = require('crypto').randomBytes(12);
let out = '';
for (let i = 0; i < 12; i++) out += chars[buf[i] % chars.length];
process.stdout.write(out);
")"

SDIR="$SESSIONS_DIR/$SESSION"
if [[ -e "$SDIR" ]]; then
  echo "error: session dir collision: $SDIR (re-run)" >&2
  exit 1
fi
mkdir -p "$SDIR"

# Unix ms via node (date +%s%3N is not portable on macOS)
CREATED_AT_MS="$(node -e "process.stdout.write(String(Date.now()))")"

# Use node to emit meta.json so we don't have to worry about escaping paths
# containing spaces / unicode (review_html_path often contains 中文 path
# components like 2_分析).
node -e "
const fs = require('fs');
const meta = {
  session: process.argv[1],
  base_dir: process.argv[2],
  review_html_path: process.argv[3],
  audio_path: process.argv[4],
  created_at: Number(process.argv[5]),
  status: 'viewing',
  stage: process.argv[6],
};
fs.writeFileSync(process.argv[7], JSON.stringify(meta, null, 2));
" "$SESSION" "$BASE_DIR" "$REVIEW_HTML_PATH" "$AUDIO_PATH" "$CREATED_AT_MS" "$STAGE" "$SDIR/meta.json"

echo "$SESSION"
