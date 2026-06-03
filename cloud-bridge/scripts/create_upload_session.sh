#!/usr/bin/env bash
#
# create_upload_session.sh — provision a cloud-bridge UPLOAD session so a
# user can drop a big audio file into a browser and have it land directly
# in $base_dir/1_转录/<name>. Mirror of create_session.sh for the inbound
# direction.
#
# Why this exists: Slock attachments cap at 50 MB. A 1-hour podcast in any
# reasonable bitrate exceeds that, so the chat-mode skill needs an
# out-of-band way to receive the raw audio. Reusing cloud-bridge means we
# don't add a third-party file service to the dep graph.
#
# usage:
#   bash create_upload_session.sh <base_dir> <audio_dest_name> [max_bytes]
#
#   base_dir          absolute path of the episode base dir
#                     (e.g. <output>/<date>_<slug>/剪播客)
#   audio_dest_name   filename to write under <base_dir>/1_转录/
#                     (e.g. audio_original.mp3)
#   max_bytes         optional cap. Default 2 GiB.
#
# Behaviour:
#   - generates a 12-char lowercase-alphanumeric token
#   - creates $SESSIONS_DIR/<token>/meta.json with kind="upload"
#   - prints ONLY the token on stdout (so chat agent can capture it)
#
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: bash create_upload_session.sh <base_dir> <audio_dest_name> [max_bytes]" >&2
  exit 2
fi

BASE_DIR="$1"
AUDIO_DEST_NAME="$2"
MAX_BYTES="${3:-}"

if [[ ! -d "$BASE_DIR" ]]; then
  echo "error: base_dir does not exist: $BASE_DIR" >&2
  exit 1
fi
case "$AUDIO_DEST_NAME" in
  */*) echo "error: audio_dest_name must be a filename, not a path: $AUDIO_DEST_NAME" >&2; exit 2 ;;
  '')  echo "error: audio_dest_name empty" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSIONS_DIR="${SESSIONS_DIR:-$CLOUD_BRIDGE_DIR/sessions}"
mkdir -p "$SESSIONS_DIR"

AUDIO_DEST="$BASE_DIR/1_转录/$AUDIO_DEST_NAME"

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

CREATED_AT_MS="$(node -e "process.stdout.write(String(Date.now()))")"

node -e "
const fs = require('fs');
const meta = {
  session: process.argv[1],
  kind: 'upload',
  base_dir: process.argv[2],
  audio_dest: process.argv[3],
  created_at: Number(process.argv[4]),
  status: 'viewing',
};
if (process.argv[5]) meta.max_bytes = Number(process.argv[5]);
fs.writeFileSync(process.argv[6], JSON.stringify(meta, null, 2));
" "$SESSION" "$BASE_DIR" "$AUDIO_DEST" "$CREATED_AT_MS" "$MAX_BYTES" "$SDIR/meta.json"

echo "$SESSION"
