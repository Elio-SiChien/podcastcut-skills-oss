#!/usr/bin/env bash
# install.sh — install podcastcut cloud-bridge + cloudflared launchd agents
#
# Copies both plists into ~/Library/LaunchAgents/, ensures log dir exists,
# then bootstraps the agents into the current GUI session.
#
# Re-run safe: bootout existing instances first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/podcastcut"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

PLISTS=(
    "com.podcastcut.cloud-bridge.plist"
    "com.podcastcut.cloudflared.plist"
)

echo "==> ensuring log directory: $LOG_DIR"
mkdir -p "$LOG_DIR"

echo "==> ensuring LaunchAgents directory: $LAUNCH_AGENTS_DIR"
mkdir -p "$LAUNCH_AGENTS_DIR"

for plist in "${PLISTS[@]}"; do
    SRC="$SCRIPT_DIR/$plist"
    DST="$LAUNCH_AGENTS_DIR/$plist"
    LABEL="${plist%.plist}"

    if [[ ! -f "$SRC" ]]; then
        echo "!! missing source plist: $SRC" >&2
        exit 1
    fi

    echo "==> validating $plist with plutil"
    plutil -lint "$SRC"

    # If already loaded, bootout first so bootstrap won't fail with "service already loaded".
    if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
        echo "==> $LABEL already loaded; bootout first"
        launchctl bootout "${DOMAIN}/${LABEL}" || true
    fi

    echo "==> copying $plist -> $DST"
    cp "$SRC" "$DST"

    echo "==> bootstrapping $LABEL into $DOMAIN"
    launchctl bootstrap "$DOMAIN" "$DST"

    echo "==> kickstart $LABEL"
    launchctl kickstart -k "${DOMAIN}/${LABEL}" || true
done

cat <<EOF

installed; restart shell to take effect or run:
  launchctl start com.podcastcut.cloud-bridge
  launchctl start com.podcastcut.cloudflared

logs:
  $LOG_DIR/cloud-bridge.out.log
  $LOG_DIR/cloud-bridge.err.log
  $LOG_DIR/cloudflared.out.log
  $LOG_DIR/cloudflared.err.log

status:
  launchctl list | grep podcastcut
EOF
