#!/usr/bin/env bash
# uninstall.sh — remove podcastcut cloud-bridge + cloudflared launchd agents
#
# Reverses install.sh: bootout running agents, then delete the plists from
# ~/Library/LaunchAgents/. Log files under ~/Library/Logs/podcastcut/ are
# kept on purpose — delete manually if you want a clean slate.

set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

PLISTS=(
    "com.podcastcut.cloud-bridge.plist"
    "com.podcastcut.cloudflared.plist"
)

for plist in "${PLISTS[@]}"; do
    DST="$LAUNCH_AGENTS_DIR/$plist"
    LABEL="${plist%.plist}"

    if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
        echo "==> bootout ${DOMAIN}/${LABEL}"
        launchctl bootout "${DOMAIN}/${LABEL}" || true
    else
        echo "==> ${LABEL} not loaded; skipping bootout"
    fi

    if [[ -f "$DST" ]]; then
        echo "==> removing $DST"
        rm -f "$DST"
    else
        echo "==> $DST not present; skipping rm"
    fi
done

echo "uninstalled. logs under ~/Library/Logs/podcastcut/ left in place."
