#!/usr/bin/env bash
# extract_url.sh — extract the latest cloudflared quick-tunnel URL from the
# log and write it to cloud-bridge/current_tunnel_url.txt so downstream
# skills (edit-chat) can read it without parsing logs themselves.
#
# Designed to be run on a loop (every ~30s) via cron, a tiny launchd
# StartInterval job, or invoked manually after cloudflared boots.
#
# Limitation: quick-tunnel URLs are ephemeral and rotate every time
# cloudflared restarts. See sibling PR (named tunnel) for a stable URL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${CLOUDFLARED_LOG:-$HOME/Library/Logs/podcastcut/cloudflared.out.log}"
ERR_LOG_FILE="$HOME/Library/Logs/podcastcut/cloudflared.err.log"
OUT_FILE="$BRIDGE_DIR/current_tunnel_url.txt"

# cloudflared writes the URL line on stderr typically. Check both files.
URL=""
for f in "$LOG_FILE" "$ERR_LOG_FILE"; do
    [[ -f "$f" ]] || continue
    # Match URLs like https://<sub>.trycloudflare.com — last occurrence wins.
    found="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$f" | tail -n1 || true)"
    if [[ -n "$found" ]]; then
        URL="$found"
    fi
done

if [[ -z "$URL" ]]; then
    echo "!! no trycloudflare URL found in logs yet" >&2
    exit 1
fi

# Only rewrite if changed, to avoid spurious mtime churn for watchers.
if [[ -f "$OUT_FILE" ]] && [[ "$(cat "$OUT_FILE" 2>/dev/null || true)" == "$URL" ]]; then
    echo "== unchanged: $URL"
    exit 0
fi

echo "$URL" > "$OUT_FILE"
echo "wrote $OUT_FILE -> $URL"
