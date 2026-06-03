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

```bash
cloudflared tunnel login
cloudflared tunnel create podcastcut-bridge
cloudflared tunnel route dns podcastcut-bridge bridge.yourdomain.com
cloudflared tunnel run podcastcut-bridge
```

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

agent 生成 review HTML 后：

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
  // 其他 fields 从 s 拷过来
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

## Files in this dir

- `server.js` — the HTTP server (~150 lines, no deps beyond node built-ins)
- `sessions/` — per-session subdirectories (created on demand)
- `README.md` — this file
- `start.sh` (TODO) — launchd / pm2 wrapper for auto-restart
