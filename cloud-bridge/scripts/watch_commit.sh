#!/usr/bin/env bash
#
# watch_commit.sh — block until the user clicks "完成开始剪" on the cloud
# review page (which causes server.js to write state.committed.json), OR
# until a timeout fires.
#
# usage:
#   bash watch_commit.sh <session> [--timeout-sec 604800]
#
#   <session>           the token returned by create_session.sh
#   --timeout-sec N     wall-clock seconds before giving up. Default 604800
#                       (7 days — matches the session-expiry budget in
#                       cloud-bridge/README.md).
#
# env:
#   SESSIONS_DIR        override session root. Default: <script_dir>/../sessions
#
# behaviour:
#   - polls $SESSIONS_DIR/<session>/state.committed.json every 5s
#   - prints a "still waiting" line to stderr every 60s
#   - on commit: prints "[session <s>] committed at <iso8601>" to stderr,
#                exit 0
#   - on timeout: prints "[session <s>] timeout after Ns" to stderr,
#                 exit 124 (same convention as coreutils `timeout`)
#   - on missing session dir: stderr error, exit 1
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: bash watch_commit.sh <session> [--timeout-sec 604800]" >&2
  exit 2
fi

SESSION="$1"
shift

TIMEOUT_SEC=604800  # 7 days
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

COMMIT_FILE="$SDIR/state.committed.json"
POLL_INTERVAL=5
PROGRESS_INTERVAL=60

start_epoch=$(date +%s)
last_progress_epoch=$start_epoch

while true; do
  if [[ -f "$COMMIT_FILE" ]]; then
    # iso8601 in UTC; portable across mac/linux date(1)
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[session $SESSION] committed at $ts" >&2
    exit 0
  fi

  now=$(date +%s)
  elapsed=$(( now - start_epoch ))
  if [[ $elapsed -ge $TIMEOUT_SEC ]]; then
    echo "[session $SESSION] timeout after ${elapsed}s" >&2
    exit 124
  fi

  since_progress=$(( now - last_progress_epoch ))
  if [[ $since_progress -ge $PROGRESS_INTERVAL ]]; then
    echo "[session $SESSION] still waiting for commit (elapsed ${elapsed}s / timeout ${TIMEOUT_SEC}s)" >&2
    last_progress_epoch=$now
  fi

  sleep "$POLL_INTERVAL"
done
