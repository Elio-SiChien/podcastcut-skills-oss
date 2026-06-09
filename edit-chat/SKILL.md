---
name: podcastcut:edit-chat
description: 端到端剪辑（chat 版屏 2-7）。用户传 audio attachment 触发 → 读 profile → 7 个录后复盘 → 跑 pipeline（转录/粗剪/精剪/出片）→ 各 checkpoint chat 报告 + 粗剪给 review HTML link → 成品通过 Slock attachment 返回。触发词：剪一下、新一期、podcast cut、剪辑、processing
---

<!--
input: 用户 DM 里发的 audio attachment + 已存在的 profile (没有则先调 onboarding-chat)
output: 成品音频 via slock attachment upload + 粗剪 review HTML link

pos: chat 服务的主流程 skill；调度现有 6 个 skill

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. ../onboarding-chat/SKILL.md profile 字段引用一致
3. 如果改了流程顺序，跟 web app MVP 规格.md 屏 2-7 对照
-->

# Edit（chat 版主流程）

> 用户扔 audio attachment 进对话，我负责开剪。每个阶段在 chat 里报告，关键 checkpoint 给用户决策。

## 🚨 Path bootstrap — 跑任何 bash 之前必做

Claude Code 把这个 skill 挂载在 `~/.claude/skills/podcastcut-edit-chat`（一个 symlink）。下面所有 bash snippet 都用 `$SKILL_DIR/...` 引路径，**`$SKILL_DIR` 不是环境变量自动设的**——你（agent）每次跑 bash 之前必须先解析一次：

```bash
SKILL_DIR="$(readlink -f ~/.claude/skills/podcastcut-edit-chat)"
# 现在 $SKILL_DIR = .../podcastcut-skills/edit-chat
```

跳过这步 → `$SKILL_DIR/../cloud-bridge/current_tunnel_url.txt` 展开成 `./../cloud-bridge/...`，从你 workspace cwd 找不到，会**误以为 cloud-bridge 没起、错误退回 file:// 流程**（2026-06-08 的 pike 踩坑实例）。

Cloud-bridge 实际是 launchd 永久跑着的（PR #41 + #56），URL 文件**永远在**——找不到 100% 是路径解析问题，不是服务问题。

---

## 触发

用户在 DM / channel 给我发音频 attachment（mp3 / m4a / wav）+ 任意意图文字。例如：
```
user: [audio attachment]
user: 剪一下，3 人闲聊
```

或者干脆只有附件没文字——我看到 audio attachment 默认意图就是剪辑。

**如果用户没有附件**（只说"剪一下"/"帮我剪本期"等意图）→ 走下面"前置：大文件上传"路径，cloud-bridge 开一个 upload 页让用户拖文件。

## 前置：profile

如果是 attachment 路径：调 `slock attachment view --id <attachment-id> --output <local-path>` 把 audio 下载到 local（≤50MB attachment 都走这）。
然后：
- 检查 `$SKILL_DIR/../profiles/`：没 profile → 自动跑 `podcastcut-onboarding-chat`
- 多个 profile → chat 问 "这期是哪档播客？[列出来]"
- 1 个 profile → 默认用它，chat 简短确认 "[名字]，对吧？"

profile 字段（结构见 `onboarding-chat/SKILL.md`）：
- name / tone / hosts / default_target_min / default_aggressiveness / glossary

用户 feedback 需要先按 `docs/feedback-routing-SOP.md` 判断 scope：本期一次性 / 单播客长期 / 全局通用 / agent 工作流。明显 scope 可 fast path 直接执行并在汇报或 PR 里标 `Scope:`；不明确就先问。冲突时本期明确指令 > podcast profile > global baseline；agent 工作流偏好写入 agent memory / notes，不进剪辑规则。

---

## 前置：cloud-bridge 状态

阶段 4（粗剪）与阶段 5（精剪）的审查页**默认通过 cloud-bridge 公网 URL 交付**——用户在浏览器里 toggle 完直接点 "💾 保存进度" 或 "✓ 完成开始剪"，agent 这边不用再让用户下载 JSON 拖回 DM。

启动 agent 时先检查 cloud-bridge 服务是否就绪：

```bash
# 约定：CLOUD_BRIDGE_ROOT 指向 cloud-bridge 服务安装目录
#       默认 $SKILL_DIR/../cloud-bridge（与本仓库同级）
: "${CLOUD_BRIDGE_ROOT:=$SKILL_DIR/../cloud-bridge}"

# current_tunnel_url.txt 由 launchd plist（兄弟 PR C）在开机时写入
# 内容形如：https://<random-subdomain>.trycloudflare.com
if [ -f "$CLOUD_BRIDGE_ROOT/current_tunnel_url.txt" ]; then
  TUNNEL_URL="$(cat "$CLOUD_BRIDGE_ROOT/current_tunnel_url.txt")"
else
  TUNNEL_URL=""
fi
```

### Fallback 顺序（很重要）：URL 拿不到时 agent 必须知道怎么修复

```
1. 文件存在 + curl HEAD 通 → 直接用
2. 文件存在 但 curl HEAD 404/超时（旧 tunnel） →
     问用户："tunnel URL 好像过期了，你那 cloudflared terminal 最新 URL 是？"
     **收到后写回文件**：echo "$NEW_URL" > "$CLOUD_BRIDGE_ROOT/current_tunnel_url.txt"
     下次不用再问
3. 文件不存在（首次 / 没装 launchd）→ 同 2
4. 用户说"现在不想 cloud-bridge"（明确拒绝）→ 退回路径 C（file:// 审查页 + 拖 JSON 回 DM）
```

**关键**：agent **不要每次都问** URL——current_tunnel_url.txt 存在且仍通就直接用。也**不要默认走 file:// 兜底**——cloud-bridge 是 chat-mode MVP 推荐流程，file:// 是 last resort。

> tunnel URL 的生命周期：
> - 装了 launchd（`cloud-bridge/launchd/install.sh`）→ 开机自动 + cloudflared 重启后 extract_url.sh 写文件
> - 没装 launchd（手动 `cloudflared tunnel --url ...`）→ agent 第一次跑时问用户、写文件、之后自动用
> - cloudflared 重启换 URL → 用户在 chat 告诉 agent 新 URL，agent 覆盖文件
>
> agent **不主动管 tunnel**（不启停 cloudflared）。
> 管理由 PR #41 的 launchd plist 或用户自己负责。

---

## 前置：大文件上传（>50 MB 音频 / 用户没附件就触发）

Slock 附件硬上限 50 MB；一小时长节目高码率任何选择都会超。用户也可能就直接说"剪一下"没带附件。两种情况都走 cloud-bridge upload session。

```bash
# 1. mint upload session
#    create_upload_session.sh 签名：<base_dir> <audio_dest_name> [max_bytes]
#    生成 12-char token 并把 meta.json 写到 sessions/<token>/，
#    server 端 GET /u/<token> 渲染上传页，POST /api/<token>/upload 流式写盘
UPLOAD_SESSION=$(bash "$SKILL_DIR/cloud-bridge/scripts/create_upload_session.sh" \
  "$BASE_DIR" audio_original.mp3)

# 2. chat 把上传 URL 发给用户
echo "$TUNNEL_URL/u/$UPLOAD_SESSION"

# 3. 阻塞等用户拖完
#    成功：上传完写 upload.received.json + meta.status=uploaded，exit 0
#    截断/磁盘错误：meta.status=error，exit 2
#    24h 没动静：exit 124（agent 可以再问"还剪吗？"决定是否 mint 新 session）
bash "$SKILL_DIR/cloud-bridge/scripts/watch_upload.sh" "$UPLOAD_SESSION"

# 4. audio 已经在 $BASE_DIR/1_转录/audio_original.mp3 — 进阶段 1 / 2
```

chat 文案示例：

```
chat:
比 Slock 附件能塞的大，给你个直接上传的页面：
$TUNNEL_URL/u/<session>

把音频拖进去就行，传完我立刻开剪。
```

**注意**：
- 默认接收名是 `audio_original.mp3`（剪播客 cut_audio.py 要求的原始音频文件名约定）。如果用户传的是 .wav / .m4a，文件落地后 mime 不一致没关系——cut_audio.py 用 ffmpeg 处理。但**最好让上传名贴源格式**，第二个参数传 `audio_original.<ext>` 视用户预声明而定。
- `max_bytes` 默认 2 GB，正常播客够用；如果某档播客真的会更大，加第三个参数提高上限。
- 上传完成后 audio_dest 已经在 BASE_DIR/1_转录/，**直接进阶段 2 转录**，不用再 attachment view。
- 这条 upload URL 7 天后过期（meta.created_at 决定），过期再让用户上传需要新 mint。

---

## 阶段 1：录后复盘（屏 3 chat 版）

只问关键 4 项，**不要把屏 3 全部 7 个字段塞 chat**（chat 服务核心是少而精）：

```
chat:
快速复盘一下这期，4 个问题：
1. 录的怎么样？顺畅 / 还行 / 磕磕绊绊？
2. 录制过程有意外吗？（录前准备、设备问题、有人离开...）说一下
3. 有没有不便公开的内容？（隐私 / 敏感话题 / 未公开项目）
4. 印象最深的 1-2 段内容是？(给 AI 保护信号)

用户答完按"剪辑！"开始。
```

用户答的内容存到 `$BASE_DIR/剪播客/_debrief.json`（结构 ≈ `{smoothness, incidents, privacy, must_keep}`）。

**关键：用户可以省略任意一条**，agent 默认 "顺畅 / 无意外 / 无隐私 / 无特殊保留"。

---

## 阶段 2：上传 + 跑转录（屏 4-5）

```
chat: 收到，开始转录...
（5-10 分钟）
```

调 `podcastcut-转录` skill。完成后 → speaker 识别 checkpoint。

### 2a. 热词注册（task #15）

如果当前 profile 的 `glossary` 非空，**在调转录脚本之前**先注册阿里云 paraformer-v2 热词表，拿到 `vocabulary_id`，作为转录脚本第 3 个参数传入——避免 ASR 把人名/品牌错转成同音字（如 "清扬" → "庆扬"）。

```bash
# profile 已在前置阶段 cp 到 $BASE_DIR/profile.json
if [ "$(node -e "const p=require('$BASE_DIR/profile.json');process.stdout.write(String((p.glossary||[]).length))")" -gt 0 ]; then
  cd "$BASE_DIR/1_转录"
  bash "$SKILL_DIR/shared/scripts/register_hot_words.sh" "@$BASE_DIR/profile.json" "$BASE_DIR/1_转录/vocabulary_id.txt"
fi
# 调转录脚本时把第 3 个参数 vocabulary_id 传进去（不存在则空字符串，脚本忽略）
VOCAB_ID=""
[ -f "$BASE_DIR/1_转录/vocabulary_id.txt" ] && VOCAB_ID="$(cat "$BASE_DIR/1_转录/vocabulary_id.txt")"
bash "$SKILL_DIR/shared/scripts/aliyun_funasr_transcribe.sh" "$AUDIO_URL" "$SPEAKER_COUNT" "$VOCAB_ID"
```

注意：每个 DashScope 账户最多 10 个 vocabulary。重复跑同 profile 会重复创建——后续 task 可考虑缓存 vocabulary_id（按 glossary hash key）跳过已注册。MVP 暂时每次重创建。

---

## 阶段 3：说话人确认 checkpoint（屏 4 chat 版）

**⚠️ 关键流程顺序（Bug C 教训，2026-06-02）**：

`speaker_mapping.json` **必须在 `generate_subtitles_from_aliyun.js` 之前写**——否则 subtitles_words.json + sentences.txt 里说话人字段是 `"Speaker 0"`、`"Speaker 1"` 而不是真名。
（generate_subtitles 用 mapping 把 `speaker_id` 替换成名字，写完 subtitle 后再改 mapping **不会回写到已经生成的 subtitles/sentences**——除非重新跑这两个脚本。）

### 正确顺序

1. **阶段 2 转录完**：阿里云 FunASR 产 `aliyun_funasr_transcription.json`，知道 speaker_id 数量（如 2 个）。
2. **写 best-guess speaker_mapping.json**：
   - 读 profile.hosts（拿到 1-2 个候选名字 + 角色）
   - 统计每个 speaker_id 的发言占比（在 transcription.json 里数 sentences）
   - **规则**：访谈/采访类（profile.tone 含"访谈"/"嘉宾"）→ 占比最大的 speaker_id 通常是嘉宾（被采访的人讲得多）；闲聊类 → 默认按 profile 顺序。
   - 写：`{"0": "嘉宾名", "1": "主持名"}` 或反之到 `1_转录/speaker_mapping.json`
3. **跑 `generate_subtitles_from_aliyun.js aliyun_funasr_transcription.json speaker_mapping.json`** → subtitles_words.json 里说话人字段是真名
4. **跑 `generate_sentences.js`** → sentences.txt 里也是真名
5. **切 10s audio sample** per speaker → upload via Slock attachment

   用 `shared/scripts/extract_speaker_samples.py` —— 它从每个 speaker 最长的连续独白段里抽样（不是第一段），避开 intro 音乐和说话人交替段。两个失败模式（音乐 sample、混音 sample）在 EP20 实测撞过，详见脚本顶 docstring：

   ```bash
   python3 "$SKILL_DIR/shared/scripts/extract_speaker_samples.py" \
     "$BASE_DIR/1_转录/aliyun_funasr_transcription.json" \
     "$BASE_DIR/1_转录/audio_original.mp3" \
     "$BASE_DIR/1_转录" \
     --mapping "$BASE_DIR/1_转录/speaker_mapping.json"
   # 产出 $BASE_DIR/1_转录/spk{0,1,2,...}_sample.mp3
   ```
6. **Chat 问用户确认**：

```
chat:
转录完了，识别出 N 个说话人。按 profile 我猜：
- Speaker 0 → 清扬（嘉宾，发言占 75%）— 听 10s 样本: [audio attachment]
- Speaker 1 → 响歌歌（主持，发言占 25%）— 听 10s 样本: [audio attachment]

「对」→ 继续粗剪
「反了」→ 我把 0 和 1 对调 + **重生** subtitles/sentences
「N 是别人 [名字]」→ 我改 mapping + **重生** subtitles/sentences
```

7. **如果用户说错了**：更新 speaker_mapping.json + **重新跑** generate_subtitles + generate_sentences。两个脚本都 idempotent（覆盖输出），重跑安全。**不要**手动 sed sentences.txt 改名——会跟 subtitles_words.json 不一致。

### 不要做的事

- ❌ 先 generate_subtitles 再写 mapping → sentences.txt 会是"Speaker 0/1"
- ❌ 跳过 audio sample → 用户没法识别哪个 speaker 是谁
- ❌ 用户改 mapping 后只改 speaker_mapping.json 不重生 subtitles/sentences → 数据不一致

### Code snippet 参考

```bash
# 在转录脚本跑完后、写 mapping 之前，先 best-guess
node -e "
const fa = require('$BASE_DIR/1_转录/aliyun_funasr_transcription.json');
const profile = require('$BASE_DIR/profile.json');
const counts = {};
fa.transcripts[0].sentences.forEach(s => counts[s.speaker_id] = (counts[s.speaker_id]||0) + 1);
const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
const hosts = profile.hosts.map(h => h.name);
// Interview heuristic: speaker with most utterances = guest if profile has '嘉宾' role
const guest = profile.hosts.find(h => h.role === '嘉宾')?.name;
const host = profile.hosts.find(h => h.role === '主持')?.name;
const mapping = {};
if (guest && host && sorted.length >= 2) {
  mapping[sorted[0][0]] = guest;  // top talker = guest
  mapping[sorted[1][0]] = host;
} else {
  // Fallback: profile order
  sorted.forEach(([sid], i) => { mapping[sid] = hosts[i] || \`Speaker \${sid}\`; });
}
require('fs').writeFileSync('$BASE_DIR/1_转录/speaker_mapping.json', JSON.stringify(mapping, null, 2));
console.log('Best-guess mapping:', mapping);
"
```

---

## 阶段 4：粗剪（屏 6 chat 版）

**调 `podcastcut-粗剪` skill 前，先把 profile + debrief 投递到 BASE_DIR**（粗剪 skill 在那里读）：

```bash
# 把选中的播客 profile 复制为本期 profile.json
cp "$SKILL_DIR/profiles/<播客名>.json" "$BASE_DIR/profile.json"
# debrief 在阶段 1 已写到 $BASE_DIR/_debrief.json
ls "$BASE_DIR/profile.json" "$BASE_DIR/_debrief.json"
```

粗剪 skill 的 LLM 分析步骤会读这两个文件（profile.tone/aggressiveness/glossary + debrief.must_keep/privacy/incidents），影响段落判定阈值与硬保护/硬删除。详见 `粗剪/SKILL.md § "Profile / debrief 注入"`。

**调完粗剪、生成 review HTML 之前，先 check `semantic_deep_analysis.json` 有没有 `chapters` 字段**（用户在审查页靠章节导航跳话题，缺失会导致章节无 summary、对筛选无用）：

```bash
# semantic_deep_analysis.json 必须有 chapters 数组，每项含 range/title/desc 三字段
if ! node -e "
  const a = require('$BASE_DIR/2_分析/semantic_deep_analysis.json');
  if (!Array.isArray(a.chapters) || a.chapters.length === 0) {
    console.error('❌ chapters 数组缺失或为空');
    process.exit(1);
  }
  const bad = a.chapters.filter(c => !c.range || !c.title || !c.desc);
  if (bad.length > 0) {
    console.error('❌ 有', bad.length, '个章节缺 range/title/desc:', bad);
    process.exit(1);
  }
  console.log('✅ chapters OK:', a.chapters.length, '个章节');
"; then
  echo "回到粗剪 SKILL.md 步骤 8 补 chapters 再继续"
  exit 1
fi
```

如果上面 fail，回粗剪 skill 补完再走 `generate_review.js`——**不要让粗剪审查页在 chapters 缺失下交给用户**（2026-06-08 pike 实例 EP19 因为漏写 chapters 被 @xiangge-li 当场反馈）。

完成后给**总结 + 3 种回复方式**（语气温暖，不要 enumerated 命令感）：

```
chat:
粗剪完了。删了 5 个大段、总共 -8 分钟，原 65 min → 现在 57 min。

1. [22:33-23:45] 录音失败重录段
2. [34:12-35:00] 跑题闲聊（咖啡店选择）
3. [48:20-49:10] 制作讨论（"要不要重录这段？"）
4. [55:00-56:30] 听众反馈段（之前用过）
5. [62:00-62:45] 设备问题段

你可以这样跟我说：
- "OK" / "可以" / "继续" → 我直接进精剪
- "把第 3 段留着" / "1 和 4 别删" → 我把那几段从删除列表里拿出来，重新给你看一版
- "想自己改" → 我开个网页给你 toggle，你点保存我这边自动 pickup
```

用户决策路径：

**A. 用户口头确认 "OK"** → 继续精剪。

**B. 用户口头指示改某些块**（用自然语言，如 "把第 3 段留着"、"1 和 4 别删"、"再把 7 段也删掉"）：
1. agent 解析 → 修改 `semantic_deep_analysis.json` 中对应 block 的 `action`（delete ↔ keep）或新增 block
2. 用更新后的 analysis **重新生成 `review_roughcut.html`** —— 让用户在网页上看到当前的删除决策视觉效果
3. 把改动总结 + 新 review HTML 路径 chat 出来，再等用户 confirm（如果同时也用了 cloud-bridge URL 流程，刷新页面即可）

```
chat:
好，第 3 段（制作讨论）留着了。粗剪现在剩 4 段删除、总共 -7 分钟：

1. [22:33-23:45] ...
2. [34:12-35:00] ...
4. [55:00-56:30] ...
5. [62:00-62:45] ...

刷新刚才那个审查页就能看到新版本，确认回"OK"。
```

**C. 用户要在网页上自己改 —— 默认走 cloud-bridge 公网 URL（推荐）**：

```bash
# 1. Mint session for this stage
#    create_session.sh 由兄弟 PR A 提供，签名：
#      create_session.sh <stage> <review_html_path> <audio_path>
#    TODO: PR A (task-16-cloud-helpers) merge 后此引用即可用
SESSION=$(bash "$SKILL_DIR/cloud-bridge/scripts/create_session.sh" \
  roughcut \
  "$BASE_DIR/review_roughcut.html" \
  "$BASE_DIR/1_转录/audio_seekable.mp3")

# 2. Tell user (chat) —— TUNNEL_URL 已在前置阶段从
#    $CLOUD_BRIDGE_ROOT/current_tunnel_url.txt 读出
echo "审查页：$TUNNEL_URL/r/$SESSION"

# 3. Block until user commits（用户点 "✓ 完成开始剪"，server 写
#    state.committed.json；点 "💾 保存进度" 写 state.draft.json，不解除阻塞）
bash "$SKILL_DIR/cloud-bridge/scripts/watch_commit.sh" "$SESSION"

# 4. Translate committed state to expected file
#    extract_commit_to_export.sh 把 state.committed.json 转成
#    $BASE_DIR/2_分析/delete_segments_roughcut.json
bash "$SKILL_DIR/cloud-bridge/scripts/extract_commit_to_export.sh" "$SESSION" roughcut

# 5. 计算粗剪 eval stats → 拼进 chat 报告（"AI 帮你做了什么"）
EVAL_MSG=$(node "$SKILL_DIR/eval/compare_roughcut.js" \
  --ai   "$BASE_DIR/2_分析/semantic_deep_analysis.json" \
  --user "$BASE_DIR/2_分析/delete_segments_roughcut.json" \
  --episode-name "$(basename "$BASE_DIR")" \
  --format delivery-msg)
# 把 EVAL_MSG 原样贴进下一条 chat（用户看到 AI 这次帮了多少）
```

chat 文案示例：

```
chat:
打开这个看你的删除决策（手机/电脑都行）：
https://<tunnel>.trycloudflare.com/r/<session>

随时点 "💾 保存进度"（我等着、不开剪）；
都满意了点 "✓ 完成开始剪"，我立刻继续精剪。
```

用户 commit 之后下一条 chat 把 EVAL_MSG（"AI 帮你做了什么"）贴上去：

```
chat:
粗剪 AI 帮你做的：
✓ 抓了 100 段录制讨论 / cue 流程 = 省 7:25
✓ 抓了 89 段录前准备 = 省 7:23
你额外加了：7 段（AI 漏标）

这次你接受了我 90% 的粗剪决策——下次继续这样剪。

进精剪。
```

**C 备选（路径 C 退路）—— 仅在 cloud-bridge 不可用或用户明确要求时走旧流程**：
agent 给本地 review HTML 路径；用户 toggle 完点"导出"下载 `delete_segments_roughcut.json` 拖回 DM；agent 用 `slock attachment view --id <id> --output $BASE_DIR/2_分析/delete_segments_roughcut.json` 覆盖原文件 → 继续精剪。

> cloud-bridge 流程取代了原 backlog task #9（"网页直接 save、agent 自动 pickup"），#9 已并入 task #16 实现。

### 名词约定（避免 chat 文案再出现的模糊用语）

- "**删除块**" / "**第 N 段**"：指粗剪总结里编号的删除区间，**不是句子 idx**
- "**重新生成审查页**"：覆盖 `review_roughcut.html`，让网页打开后视觉同步最新决策
- 不要用 "重生"、"N 号块" 这种内部黑话——用 "第 N 段"、"重新生成审查页" 这种自然中文

---

## 阶段 5：精剪（显式 checkpoint，等用户）

调 `podcastcut-精剪` skill。@xiangge-li 明确说**不要在 chat 里追问精剪填充词细节**——只报数字 + 给可选精修入口，然后**等用户回复**，不主动往下跑。

完成后短报 + **默认开 cloud-bridge URL 审查页**（与阶段 4 同模式，stage 改成 `fine`，HTML 改成 `review_enhanced.html`，extract 阶段写 `delete_segments_edited.json`）：

```bash
# 1. Mint session for fine-cut stage
#    TODO: PR A (task-16-cloud-helpers) merge 后此引用即可用
SESSION=$(bash "$SKILL_DIR/cloud-bridge/scripts/create_session.sh" \
  fine \
  "$BASE_DIR/review_enhanced.html" \
  "$BASE_DIR/1_转录/audio_seekable.mp3")

# 2. Tell user (chat)
echo "审查页：$TUNNEL_URL/r/$SESSION"

# 3. Block until user commits（"✓ 完成开始剪" → state.committed.json）
bash "$SKILL_DIR/cloud-bridge/scripts/watch_commit.sh" "$SESSION"

# 4. Translate committed state to expected file
#    fine stage 下 extract 写
#    $BASE_DIR/2_分析/delete_segments_edited.json
bash "$SKILL_DIR/cloud-bridge/scripts/extract_commit_to_export.sh" "$SESSION" fine

# 5. 计算精剪 eval stats → 拼进 chat 报告（"AI 帮你做了什么"）
EVAL_MSG=$(node "$SKILL_DIR/eval/compare.js" \
  --ai   "$BASE_DIR/2_分析/fine_analysis.json" \
  --user "$BASE_DIR/2_分析/delete_segments_edited.json" \
  --episode-name "$(basename "$BASE_DIR")" \
  --format delivery-msg)
# 把 EVAL_MSG 原样贴进下一条 chat（用户看到 AI 这次帮了多少）
```

chat 文案示例：

```
chat:
精剪完了，删了 387 个填充词 + 60 个长停顿，再 -3 min。

想直接出片就回 "OK"——或者打开下面这页 toggle 一下，点 "✓ 完成开始剪" 我用你的版本出片：
https://<tunnel>.trycloudflare.com/r/<session>
```

用户 commit 之后下一条 chat 把 EVAL_MSG（"AI 帮你做了什么"）贴上去：

```
chat:
AI 帮你做的：
✓ 抓了 22 个衔接片段 = 省 7 分钟
✓ 抓了 251 个口吃/卡顿 = 省 1:15
✓ 抓了 165 个句首填充词（嗯啊呃） = 省 42 秒
你额外加了：228 个整句

这次你接受了我 89% 的删除决策——下次继续这样剪。

进出片。
```

用户决策（agent 等消息，不主动 fire）：
- "OK" → 跳过 watch_commit，直接进阶段 6 出片（用现有 `delete_segments_edited.json`）
- 在网页上点 "✓ 完成开始剪" → `watch_commit.sh` 返回 → `extract_commit_to_export.sh` 写新 `delete_segments_edited.json` → 进出片
- **路径 C 退路（仅在 cloud-bridge 不可用时）**：用户从本地 `file://.../review_enhanced.html` 导出 `delete_segments_edited.json` 拖回 DM → `slock attachment view --id <id> --output $BASE_DIR/2_分析/delete_segments_edited.json` 覆盖
- 长时间没回 → 不做任何事；用户下次发消息再继续

> 关键：agent 是消息驱动的，**不要 schedule timer / reminder 来"自动往下走"**。让用户决定何时继续。

---

## 阶段 6：出片 + 交付（屏 7 chat 版）

调 `podcastcut-执行` skill 出 cut audio。**默认 .m4a (AAC) 输出**——同质量下文件 30-50% 小于 MP3，更容易塞进 Slock 50MB 附件上限（50 min 节目 AAC 192k ≈ 45MB；MP3 192k ≈ 70MB 超限）。

> task #12 历史：2026-06-02 发现 ffmpeg AAC 输出的 elst (edit list) atom 让 Apple QuickTime / Music 播放中 auto-stop。PR #36（2026-06-03 merged）用 gpac 的 `MP4Box -edits 1=r` post-encode 步骤去掉 elst，验证 Apple 端无 hiccup。cut_audio.py 现在自动应用，**.m4a 输出对 Apple 用户完全 OK**。

```bash
# 调 cut_audio.py 默认 .m4a 输出
python3 "$SKILL_DIR/shared/scripts/cut_audio.py" "<name>_精剪版.m4a" ...
# trim_silences 自动保留 .m4a 后缀

# 上传到 Slock
slock attachment upload --path "$BASE_DIR/剪播客/3_成品/<name>_trimmed.m4a" --channel <target>
# 拿到 attachment-id，作为附件发回

# 跑 eval 算成品价值 messaging（Stage 1，task #21）
# 同时写一条带 profile_name 的记录到 results.jsonl，给 Stage 2 跨期聚合用
PROFILE_NAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$BASE_DIR/profile.json','utf8')).name||'')")
VALUE_MSG=$(node "$SKILL_DIR/eval/compare.js" \
  --ai "$BASE_DIR/2_分析/fine_analysis.json" \
  --user "$BASE_DIR/2_分析/delete_segments_edited.json" \
  --episode-name "$EPISODE_NAME" \
  --profile "$PROFILE_NAME" \
  --format delivery-msg 2>/dev/null)
# delivery-msg 模式不写 jsonl —— 单独再跑一次正常模式 append 到 results.jsonl
node "$SKILL_DIR/eval/compare.js" \
  --ai "$BASE_DIR/2_分析/fine_analysis.json" \
  --user "$BASE_DIR/2_分析/delete_segments_edited.json" \
  --episode-name "$EPISODE_NAME" \
  --profile "$PROFILE_NAME" \
  --save >/dev/null

# Stage 2：跨期 detector 性能检查
# 攒到 ≥3 期同 profile 之后，如果某 detector retention <70% → 生成 Tier 2 提示
# 给 VALUE_MSG 末尾追加一行（友好口吻，"AI 在学你的播客节奏"，不是"AI 错了"）。
TIER2_MSG=$(node "$SKILL_DIR/eval/check_detector_overrides.js" \
  --profile "$PROFILE_NAME" 2>/dev/null \
  | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
      try { const j=JSON.parse(buf);
        if (j.triggers && j.triggers[0]) process.stdout.write('\n\n' + j.triggers[0].suggested_message);
      } catch{}
    });")
# 直接拼到 VALUE_MSG 末尾即可（无 trigger 时 TIER2_MSG 为空，不影响）
VALUE_MSG="${VALUE_MSG}${TIER2_MSG}"
```

如果 Tier 2 触发：等用户回复后处理三种 case，写回 `profiles/<name>.json`：

| 用户回复 | 改动 |
|---|---|
| 「关掉」/"yes" | 在 profile 的 `detector_overrides` 加 `{<detector>: {enabled: false, reason, applied_at, evidence_episodes, evidence_retention}}` |
| 「再观察几期」 | 在 profile 的 `detector_check_history` 加 `{<detector>: {last_user_action: '再观察', cooldown_until_episode_count: 当前期数+5}}` |
| 「忽略」 | 在 profile 的 `detector_check_history` 加 `{<detector>: {last_user_action: '忽略'}}`（永久不再问） |

下次 run_fine_analysis.js 跑这个 profile 时自动读 `detector_overrides`，跳过 `enabled: false` 的类型。check_detector_overrides.js 跑下个 episode 时自动读 `detector_check_history` 决定要不要冷却或跳过。

```
chat:
🎧 成品出炉：

[audio attachment: <name>_trimmed.m4a]

{VALUE_MSG}  ← 这块由 eval/compare.js --format delivery-msg 自动生成
（示例：
AI 帮你做的：
✓ 抓了 112 个衔接片段 = 省 3:08
✓ 抓了 390 个口吃/卡顿 = 省 1:47
✓ 抓了 140 个句首填充词 = 省 44 秒
✓ 抓了 21 个长停顿 = 省 36 秒
你额外加了：29 个整句

这次你接受了我 89% 的删除决策——下次继续这样剪。
）

总时长：65 min → 52.5 min

下一期直接扔过来。
```

> **Stage 1 价值 messaging（2026-06-03 加）**：每期成品交付都自动带这一段，让用户具象感知"AI 帮我省了多少 + 我们一致率多高"。
> 
> **Stage 2 跨期 detector 触发（2026-06-03 加）**：当同 profile ≥3 期某 detector 平均 retention <70% 且每期触发数 ≥5 → 自动在 VALUE_MSG 末尾追加 1 行 Tier 2 prompt（"我注意到你 podcast 节奏里这类信号可能不是卡顿，要不要永久关掉？"）。用户回复后写回 `profile.detector_overrides` 或 `profile.detector_check_history`。后续 `run_fine_analysis.js` 自动读 overrides 跳过禁用类型。
> 
> 详细产品设计见 `notes/2026-06-03_self-iterating-product-loop.md`。阈值可调（`eval/check_detector_overrides.js --threshold` / `--episodes` / `--min-total-per-episode`），用户使用后再 empirical 调整。

---

## 错误处理

- audio 下载失败 → "音频下载失败，重发一次？"
- 转录失败 → "ASR 服务问题，等几分钟重试"
- 粗剪/精剪/执行失败 → 找 log，截关键错误给用户 + 建议 fallback（"可以先粗剪导出试听吗？")

---

## 复用现有 skill

按现行架构调度：

| 阶段 | 调用 |
|---|---|
| 转录 | `node $SKILL_DIR/../shared/scripts/aliyun_funasr_transcribe.sh` 或 `transcribe.sh` |
| 粗剪 | `podcastcut-粗剪` 走脚本 chain（generate_review.js + run_fine_analysis 之前的 5a 段） |
| 精剪 | `podcastcut-精剪` 同样脚本 chain |
| 执行（出片）| `python3 $SKILL_DIR/../shared/scripts/cut_audio.py` + `trim_silences.py` |

不重新发明轮子，**这个 skill 只管 chat 流程编排 + 跨 skill 状态 + 用户对话**。

---

## profile + debrief 怎么影响 LLM

下游 `podcastcut-粗剪` / `podcastcut-精剪` 读 `_debrief.json` 和 profile.json，把：
- profile.tone → 拼进 LLM system prompt（"这档播客调性：...，所以..."）
- profile.aggressiveness → 决定删除阈值
- profile.glossary → ASR 词汇优先 + LLM 拒删名词
- debrief.must_keep → 保护段落不删
- debrief.privacy → 隐私段标 delete 或 censoring

**这是把 profile 真正"用上"的关键**——onboarding 收集的偏好不能存了就不读。

写入或更新 profile 前，先按 `docs/feedback-routing-SOP.md` 做 feedback routing：只有单播客长期偏好才写回 `profiles/<name>.json`；本期一次性指令留在 project debrief / analysis；跨播客通用能力走 shared skill / scripts / templates / docs PR。

> 当前 6 个 skill 是不是已经支持读 profile，**TBD**。如果不支持，作为下游 task：让 `run_fine_analysis.js` / `粗剪` 的 LLM 调用支持 `--profile` 参数。

---

## MVP 之外（v2）

- profile 自动学习：每期 debrief 用户的"必留 / 可删" textarea 写回 profile，渐进收敛偏好
- 多档播客并行剪辑（用户同时跑两期）
- 团队协作（剪辑师跑流程，主播终审）
- 章节标题自动生成 + 小宇宙发布

---

## 实现指引（给后续 agent 看）

- audio attachment 下载 → 本地 path：`slock attachment view --id <id> --output <BASE_DIR>/1_转录/audio_original.<ext>`
- 进度报告：每个阶段开始时 chat 说 "开始 [阶段]"，完成时 chat 总结结果
- 失败重试：每个 skill 调用 wrap try-catch，失败把 stderr 摘要给用户，问 "继续重试 / 跳过 / 终止"
- 状态跟踪：用 `manifest.js` 现有的 `project.json` set-stage 机制——chat 里也能看到当前在哪一步
- 用户随时打断：用户说"暂停" / "撤销" → 停 current 阶段不继续

不要尝试在一次 chat 里把 5 个阶段全跑完。**每个阶段 await 用户确认或显式 "继续" 后才进下一阶段**——保持对话感，给用户停的机会。
