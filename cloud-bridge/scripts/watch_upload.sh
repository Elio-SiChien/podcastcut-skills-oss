#!/usr/bin/env bash
#
# watch_upload.sh — block until the user finishes dropping their audio on
# the cloud upload page (server.js writes upload.received.json), OR until a
# timeout fires. Mirror of watch_commit.sh for the inbound direction.
#
# usage:
#   bash watch_upload.sh <session> [--timeout-sec 86400]
#
#   <session>           the token returned by create_upload_session.sh
#   --timeout-sec N     wall-clock seconds before giving up. Default 86400
#                       (24 hours — uploads usually happen the same day
#                       the user kicks off the episode; if they walk away
#                       for a week, the audio's stale anyway).
#
# env:
#   SESSIONS_DIR        override session root. Default: <script_dir>/../sessions
#
# behaviour:
#   - polls $SESSIONS_DIR/<session>/upload.received.json every 5s
#   - prints a "still waiting" line to stderr every 60s
#   - on upload complete: prints "[session <s>] uploaded N bytes" to stderr,
#                         exit 0
#   - on timeout: prints "[session <s>] timeout after Ns" to stderr,
#                 exit 124
#   - on missing session dir: stderr error, exit 1
#   - if server.js wrote meta.status='error' at any point, exit 2
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: bash watch_upload.sh <session> [--timeout-sec 86400]" >&2
  exit 2
fi

SESSION="$1"
shift

TIMEOUT_SEC=86400  # 24 hours
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout-sec)
      TIMEOUT_SEC="$2"
      shift 2
      ;;
    --timeout-sec=*)
      TIMEOUT_SEC="${1#*=}"
      shift
      ;;
    *)
      echo "error: unknown arg '$1'" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
  echo "error: --timeout-sec must be a non-negative integer (got '$TIMEOUT_SEC')" >&2
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

DONE_FILE="$SDIR/upload.received.json"
META_FILE="$SDIR/meta.json"
POLL_INTERVAL=5
PROGRESS_INTERVAL=60

start_epoch=$(date +%s)
last_progress_epoch=$start_epoch

while true; do
  if [[ -f "$DONE_FILE" ]]; then
    BYTES="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).bytes||''))" "$DONE_FILE" 2>/dev/null || echo "?")"
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[session $SESSION] uploaded $BYTES bytes at $ts" >&2
    exit 0
  fi

  # Surface server-side upload failures (truncated upload, disk error, etc.)
  # without making the agent poll forever.
  if [[ -f "$META_FILE" ]]; then
    STATUS="$(node -e "
      try { process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).status||'') }
      catch { process.stdout.write('') }
    " "$META_FILE" 2>/dev/null || echo "")"
    if [[ "$STATUS" == "error" ]]; then
      ERR="$(node -e "
        try { process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).error||'unknown') }
        catch { process.stdout.write('unknown') }
      " "$META_FILE")"
      echo "[session $SESSION] upload error: $ERR" >&2
      exit 2
    fi
  fi

  now=$(date +%s)
  elapsed=$(( now - start_epoch ))
  if [[ $elapsed -ge $TIMEOUT_SEC ]]; then
    echo "[session $SESSION] timeout after ${elapsed}s" >&2
    exit 124
  fi

  since_progress=$(( now - last_progress_epoch ))
  if [[ $since_progress -ge $PROGRESS_INTERVAL ]]; then
    PROGRESS_NOTE=""
    if [[ "${STATUS:-}" == "uploading" ]]; then
      BYTES_SO_FAR="$(node -e "
        try { process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).bytes_received||0)) }
        catch { process.stdout.write('?') }
      " "$META_FILE")"
      PROGRESS_NOTE=" (in flight, $BYTES_SO_FAR bytes received)"
    fi
    echo "[session $SESSION] still waiting for upload (elapsed ${elapsed}s / timeout ${TIMEOUT_SEC}s)${PROGRESS_NOTE}" >&2
    last_progress_epoch=$now
  fi

  sleep "$POLL_INTERVAL"
done
