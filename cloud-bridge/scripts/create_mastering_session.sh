#!/usr/bin/env bash
#
# create_mastering_session.sh — mint a cloud-bridge mastering session so a
# user can pick 金句, set 片头/片尾 music duration, and drop intro/outro
# music files into one page. Mirror of create_session.sh (review) and
# create_upload_session.sh (raw audio upload).
#
# usage:
#   bash create_mastering_session.sh <base_dir> <mastering_html_path> <audio_path>
#
#   base_dir              absolute path of the episode base dir
#                         (e.g. <output>/<date>_<slug>/剪播客). Uploads
#                         land under <base_dir>/3_后期/theme_<slot>.<ext>.
#   mastering_html_path   absolute path to the generated mastering.html
#                         (produced by 后期/scripts/generate_mastering.js).
#   audio_path            absolute path to the podcast audio to stream in
#                         the page's player (the mastered/cut output).
#                         Reuses server.js handleAudio Range support.
#
# env:
#   SESSIONS_DIR          override session root. Default: <script_dir>/../sessions
#
# Behaviour:
#   - generates a 12-char lowercase-alphanumeric token
#   - writes $SESSIONS_DIR/<token>/meta.json with kind="mastering"
#   - prints ONLY the token on stdout
#
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: bash create_mastering_session.sh <base_dir> <mastering_html_path> <audio_path>" >&2
  exit 2
fi

BASE_DIR="$1"
HTML_PATH="$2"
AUDIO_PATH="$3"

if [[ ! -d "$BASE_DIR" ]]; then
  echo "error: base_dir does not exist: $BASE_DIR" >&2
  exit 1
fi
if [[ ! -f "$HTML_PATH" ]]; then
  echo "error: mastering_html_path does not exist: $HTML_PATH" >&2
  exit 1
fi
if [[ ! -f "$AUDIO_PATH" ]]; then
  echo "error: audio_path does not exist: $AUDIO_PATH" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSIONS_DIR="${SESSIONS_DIR:-$CLOUD_BRIDGE_DIR/sessions}"
mkdir -p "$SESSIONS_DIR"

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
  kind: 'mastering',
  base_dir: process.argv[2],
  mastering_html_path: process.argv[3],
  audio_path: process.argv[4],
  created_at: Number(process.argv[5]),
  status: 'viewing',
};
fs.writeFileSync(process.argv[6], JSON.stringify(meta, null, 2));
" "$SESSION" "$BASE_DIR" "$HTML_PATH" "$AUDIO_PATH" "$CREATED_AT_MS" "$SDIR/meta.json"

echo "$SESSION"
