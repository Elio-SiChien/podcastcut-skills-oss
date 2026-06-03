# Named tunnel setup — stable public URL for cloud-bridge

> task #16 follow-up. Upgrade the cloud-bridge from a **quick tunnel** (ephemeral
> `https://<random>.trycloudflare.com` URL that changes on every restart) to a
> **named tunnel** with a fixed custom subdomain (e.g. `bridge.example.com`)
> that survives restarts.

## Why upgrade

| | Quick tunnel (MVP) | Named tunnel (v2) |
|---|---|---|
| Command | `cloudflared tunnel --url http://localhost:8765` | `cloudflared tunnel run podcastcut-bridge` |
| Cloudflare account | not required | required (free tier OK) |
| Domain on Cloudflare DNS | not required | required |
| Public URL | `https://<random>.trycloudflare.com` | `https://bridge.<your-domain>.com` |
| Stable across restarts | NO — new URL each time | YES — same URL forever |
| chat-mode UX | agent has to re-send URL after each cloudflared restart | URL baked into skill config; never re-send |
| Setup time | 0 min | ~10 min one-off |

Switch from quick → named the first time the user gets tired of re-pasting the
trycloudflare URL into chat. That's the v2 trigger.

## Prerequisites

1. A Cloudflare account (free tier is fine — sign up at <https://dash.cloudflare.com/sign-up>).
2. A domain whose **nameservers** are pointing at Cloudflare (the domain does
   not need to host anything — Cloudflare DNS is the only requirement). If you
   don't have one, the cheapest path is to register a `.com` / `.dev` via any
   registrar and follow Cloudflare's [add-a-site flow](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
   to delegate the nameservers. This is a one-off ~5 min step.
3. `cloudflared` installed (`brew install cloudflared`). Already done if the
   quick-tunnel MVP is running.

## One-off setup (server owner only)

> All commands run on the Mac mini that hosts the cloud-bridge server.

### 1. Authenticate cloudflared with your Cloudflare account

```bash
cloudflared tunnel login
```

This opens a browser window and asks you to pick the Cloudflare zone (domain)
you want this machine to manage. Pick the domain you set up above. cloudflared
writes a cert to `~/.cloudflared/cert.pem` — keep this file; it's how the CLI
proves it can edit your account's tunnels.

Docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/tunnel-guide/local/>

### 2. Create the named tunnel

```bash
cloudflared tunnel create podcastcut-bridge
```

Output looks like:

```
Tunnel credentials written to /Users/xiangli/.cloudflared/<tunnel-uuid>.json.
cloudflared chose this file based on where your origin certificate was found.
Created tunnel podcastcut-bridge with id <tunnel-uuid>
```

Copy the tunnel UUID (you'll need it twice in step 4). The credentials JSON at
`~/.cloudflared/<tunnel-uuid>.json` is a secret — don't commit it.

### 3. Route a DNS record from your domain to the tunnel

Pick the subdomain you want — e.g. `bridge.example.com`:

```bash
cloudflared tunnel route dns podcastcut-bridge bridge.example.com
```

This creates a CNAME `bridge.example.com → <tunnel-uuid>.cfargotunnel.com` in
your Cloudflare DNS automatically. No DNS dashboard clicks needed.

### 4. Write the local config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /Users/xiangli/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: bridge.example.com
    service: http://localhost:8765
  - service: http_status:404
```

(See `cloud-bridge/config.yml.example` in this repo for a copy-paste template.)

Key rules from the [Cloudflare config-file reference](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/):

- `tunnel:` must equal the UUID from step 2.
- `credentials-file:` is the absolute path written by step 2.
- The last ingress rule **must** be a catch-all (`http_status:404` or similar).
  Rules are evaluated top-to-bottom; first match wins.
- `service: http://localhost:8765` must match the port the cloud-bridge
  `server.js` is listening on (`PORT=8765` in the MVP).

### 5. Run the tunnel

```bash
cloudflared tunnel run podcastcut-bridge
```

You should see lines like:

```
INF Starting tunnel tunnelID=<tunnel-uuid>
INF Connection registered connIndex=0 location=...
```

Open `https://bridge.example.com/health` in a browser — you should get
`{"ok":true,"sessions_dir":"..."}` from the cloud-bridge server.

### 6. Verify (optional)

```bash
cloudflared tunnel info podcastcut-bridge
```

Lists active connections and their datacenters.

## Swapping into the launchd autostart plist

Once the named tunnel works manually, point the launchd plist (added by the
sibling launchd-autostart PR) at the `run` command instead of `--url`.

**Before (quick tunnel, MVP):**

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/cloudflared</string>
  <string>tunnel</string>
  <string>--url</string>
  <string>http://localhost:8765</string>
</array>
```

**After (named tunnel, v2):**

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/cloudflared</string>
  <string>tunnel</string>
  <string>run</string>
  <string>podcastcut-bridge</string>
</array>
```

(Confirm the `cloudflared` binary path with `which cloudflared` — it's
`/opt/homebrew/bin/cloudflared` on Apple Silicon Homebrew,
`/usr/local/bin/cloudflared` on Intel.)

Then reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.podcastcut.cloudflared.plist
launchctl load   ~/Library/LaunchAgents/com.podcastcut.cloudflared.plist
```

The plist itself doesn't change otherwise; same `RunAtLoad` + `KeepAlive`
semantics, just a different command line.

## chat-mode skill: stop re-sending the URL

With a stable URL, the agent's chat reply can hard-code the public origin
instead of polling cloudflared logs:

```bash
# In edit-chat or wherever the URL gets composed:
TUNNEL_URL="https://bridge.example.com"   # was: parsed from cloudflared stdout
echo "审查页：$TUNNEL_URL/r/$SESSION"
```

The session token still rotates per cut, so only the host is fixed.

## Troubleshooting

- **`tunnel credentials file not found`** — the `credentials-file` path in
  `config.yml` is wrong, or you ran `cloudflared tunnel create` under a
  different user. Re-run step 2 as the same user that runs the launchd job.
- **`DNS record already exists`** when running `route dns` — delete the old
  record in the Cloudflare dashboard (DNS → Records), or pick a different
  hostname.
- **502 Bad Gateway in browser** — `server.js` isn't running on `localhost:8765`,
  or the `service:` port in `config.yml` doesn't match. Hit
  `http://127.0.0.1:8765/health` locally first to confirm.
- **Tunnel keeps reconnecting** — check `cloudflared tunnel info
  podcastcut-bridge`; if it shows 0 connections, look at the launchd stderr
  log (path configured in the plist).

## References

- Locally-managed tunnel guide:
  <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/tunnel-guide/local/>
- Config file reference (ingress rules, credentials-file):
  <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/>
- Get-started overview (account + zone prerequisites):
  <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/>
- Add a site to Cloudflare DNS:
  <https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/>
