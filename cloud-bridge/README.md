# cloud-bridge

> task #16 / slock task #15。把本地 agent 生成的 review HTML 通过 cloudflared tunnel
> 暴露给浏览器，让用户在公网上编辑剪辑决策。保存（draft）/ 提交（commit）通过
> HTTP POST 写回本地 agent，agent fs.watch 拾起 commit 文件后继续 pipeline。

## 架构

```
local agent (Mac mini)         browser (anywhere)
─────────────────              ──────────────────
  generate review.html
  ↓
  create session_dir
  ↓
  node server.js  :8765
  ↓                                 ↓
  cloudflared tunnel ──URL──→ open /r/<session>
  ↓                                 ↓
  send URL via chat            render review HTML
                                    ↓
                              user edits
                                    ↓
                              💾 → POST /api/<session>/save → write draft
                              ✓  → POST /api/<session>/commit → write final
                                    ↓
  fs.watch sees state.committed.json
  ↓
  edit-chat skill continues pipeline
```

## 一次性 setup

### 1. cloudflared 安装

```bash
brew install cloudflared
```

### 2. （MVP 用 quick tunnel，无需 cloudflare 账号）

```bash
cloudflared tunnel --url http://localhost:8765
```

输出会包含 `https://<random>.trycloudflare.com` —— 这就是公网 URL。
URL 在 cloudflared 重启后会变（quick tunnel 是 ephemeral）。

### 3.（可选，v2 用固定域名）

quick tunnel 的 URL 每次重启都变。生产环境用 named tunnel 固定子域名
（如 `bridge.example.com`）：

```bash
cloudflared tunnel login
cloudflared tunnel create podcastcut-bridge
cloudflared tunnel route dns podcastcut-bridge bridge.yourdomain.com
cloudflared tunnel run podcastcut-bridge
```

完整文档：[`docs/named-tunnel-setup.md`](docs/named-tunnel-setup.md)
配置模板：[`config.yml.example`](config.yml.example)

何时切换 v1 → v2：第一次发现自己往 chat 里再粘一遍 `trycloudflare.com`
URL 时。

## 启动 server

```bash
cd cloud-bridge
PORT=8765 SESSIONS_DIR=./sessions node server.js
```

输出：
```
cloud-bridge listening on http://127.0.0.1:8765
sessions dir: /Users/xxx/cloud-bridge/sessions
expose via: cloudflared tunnel --url http://localhost:8765
```

## edit-chat skill 集成（agent 用）

> 推荐用 `cloud-bridge/scripts/*` 三件套（PR #42 merged）：
> `create_session.sh`、`watch_commit.sh`、`extract_commit_to_export.sh`。

下面是手写完整流程供 reference（实际生产用 scripts/ 包装）：

```bash
SESSION=$(uuidgen | tr A-Z a-z | sed 's/-//g' | cut -c1-12)
SDIR="$CLOUD_BRIDGE_ROOT/sessions/$SESSION"
mkdir -p "$SDIR"

# 写 session meta（agent 在哪里、html/audio 路径在哪里）
cat > "$SDIR/meta.json" <<EOF
{
  "session": "$SESSION",
  "base_dir": "$BASE_DIR",
  "review_html_path": "$BASE_DIR/review_roughcut.html",
  "audio_path": "$BASE_DIR/1_转录/audio_seekable.mp3",
  "created_at": $(date +%s)000,
  "status": "viewing",
  "stage": "roughcut"
}
EOF

# 在 chat 里把 URL 发给用户
echo "审查页：$TUNNEL_URL/r/$SESSION"

# 等 commit signal
while [ ! -f "$SDIR/state.committed.json" ]; do
  sleep 5
  # 可选：超时 / 用户喊停 / 7 天 expire
done

# pickup commit 状态 → 写 delete_segments_*.json → pipeline 继续
node -e "
const s = require('$SDIR/state.committed.json');
const out = {
  version: 'roughcut_v1',
  exported_at: new Date().toISOString(),
  sentence_deletes: s.sentence_deletes || [],
  partial_deletes: s.partial_deletes || {},
  segments: s.segments || [],
};
require('fs').writeFileSync('$BASE_DIR/2_分析/delete_segments_roughcut.json', JSON.stringify(out, null, 2));
"
```

## API contract

| Endpoint | Method | Purpose |
|---|---|---|
| `/r/:session` | GET | Serve review HTML (injects `window.__CLOUD_BRIDGE__ = {session: ...}`) |
| `/api/:session/state` | GET | Return last saved/committed state (or `{initial:true}`) |
| `/api/:session/save` | POST | Save draft. Body = JSON state. Returns `{ok, status}` |
| `/api/:session/commit` | POST | Commit final. Body = JSON state. Returns `{ok, status}` |
| `/api/:session/audio` | GET | Serve `audio_seekable.mp3` with HTTP Range support |
| `/health` | GET | `{ok: true, sessions_dir}` |

## State JSON schema

POST body to `/save` or `/commit`:

```json
{
  "sentence_deletes": [0, 1, 5, 12, ...],
  "partial_deletes": {"3": [{"cs":0,"ce":8,"s":0,"e":2.5}], ...},
  "fdis": ["56@3", "78@1", ...],
  "rdExp": [...],
  "timestamp": 1717428000000
}
```

Server appends `received_at` and writes to disk.

## Security notes

- **No auth in MVP**: anyone with the URL can edit/commit. Mitigated by:
  - 8-12 char random session token in URL → unguessable
  - Server binds to `127.0.0.1` only, only reachable via cloudflared tunnel
  - User is told to not share the URL beyond intended editors
- **v2**: optionally enable Cloudflare Access for allowlist auth.

## Limits

- Max body size: 1 MB (rejected larger)
- One session = one URL = one editor (no real-time collaboration)
- cloudflared quick tunnel URLs are ephemeral; restart = new URL

## 自启 setup（macOS launchd，PR #41）

Mac mini 重启后，server 和 cloudflared 自动起来不用人工碰。用 user-level
LaunchAgents 实现（不要 sudo）。

### Install

```bash
cd cloud-bridge/launchd
./install.sh
```

会做：

1. `plutil -lint` 验证两份 plist
2. 创建 `~/Library/Logs/podcastcut/`
3. 复制两份 plist 到 `~/Library/LaunchAgents/`
4. 对每份 plist 跑 `launchctl bootstrap gui/$(id -u) …`
5. `launchctl kickstart -k` 立即启动

### Uninstall

```bash
cd cloud-bridge/launchd
./uninstall.sh
```

bootout + 删 plist。日志文件保留——想干净 slate 自己 `rm -rf ~/Library/Logs/podcastcut`。

### Log paths

| Service       | stdout                                                  | stderr                                                  |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| cloud-bridge  | `~/Library/Logs/podcastcut/cloud-bridge.out.log`        | `~/Library/Logs/podcastcut/cloud-bridge.err.log`        |
| cloudflared   | `~/Library/Logs/podcastcut/cloudflared.out.log`         | `~/Library/Logs/podcastcut/cloudflared.err.log`         |

### Tunnel URL 提取

`cloudflared tunnel --url http://localhost:8765` 每次重启印一个新的 URL。
edit-chat skill 不应该 tail logs 自己解 —— 用：

```bash
./extract_url.sh
```

grep cloudflared 日志找最新 `*.trycloudflare.com` 写到 `cloud-bridge/current_tunnel_url.txt`。

选择：

- 手动跑（每次 cloudflared 重启后）
- cron 每分钟跑一次：
  ```cron
  * * * * * /Users/xiangli/Coding/podcastcut-skill-v2/podcastcut-skills/cloud-bridge/launchd/extract_url.sh >/dev/null 2>&1
  ```
- 或加一份 `StartInterval=30` 的额外 launchd plist

### Homebrew prefix

cloudflared plist 写死 `/opt/homebrew/bin/cloudflared`（Apple Silicon）。
Intel Mac 上 `which cloudflared` 看一下，把 plist 里两处 `/opt/homebrew/bin` 改成
`/usr/local/bin`，再跑 `install.sh`。

node 也一样：如果不在 `/usr/local/bin/node`（nvm / fnm 常见），改
`com.podcastcut.cloud-bridge.plist` 的 `ProgramArguments[0]`，或者建个 symlink。

### Troubleshooting

```bash
# 两个 agent 都 loaded 吗
launchctl list | grep podcastcut

# 详细状态
launchctl print gui/$(id -u)/com.podcastcut.cloud-bridge
launchctl print gui/$(id -u)/com.podcastcut.cloudflared

# 手动启停
launchctl kickstart -k gui/$(id -u)/com.podcastcut.cloud-bridge
launchctl kill SIGTERM gui/$(id -u)/com.podcastcut.cloudflared

# tail 日志
tail -F ~/Library/Logs/podcastcut/cloud-bridge.err.log
tail -F ~/Library/Logs/podcastcut/cloudflared.out.log

# 改 plist 后重装
cd cloud-bridge/launchd && ./uninstall.sh && ./install.sh
```

## Files in this dir

- `server.js` — HTTP server（~150 行，0 npm deps）
- `sessions/` — per-session 子目录（按需创建）
- `README.md` — 本文件
- `scripts/` — `create_session.sh` / `watch_commit.sh` / `extract_commit_to_export.sh`（PR #42）
- `launchd/` — plists + install/uninstall + extract_url（PR #41）
- `docs/named-tunnel-setup.md` — v2 固定 URL 方案（PR #43）
- `config.yml.example` — named tunnel 配置模板（PR #43）
