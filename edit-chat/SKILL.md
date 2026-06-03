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

## 触发

用户在 DM / channel 给我发音频 attachment（mp3 / m4a / wav）+ 任意意图文字。例如：
```
user: [audio attachment]
user: 剪一下，3 人闲聊
```

或者干脆只有附件没文字——我看到 audio attachment 默认意图就是剪辑。

## 前置：profile

调 `slock attachment view --id <attachment-id> --output <local-path>` 把 audio 下载到 local。
然后：
- 检查 `$SKILL_DIR/../profiles/`：没 profile → 自动跑 `podcastcut-onboarding-chat`
- 多个 profile → chat 问 "这期是哪档播客？[列出来]"
- 1 个 profile → 默认用它，chat 简短确认 "[名字]，对吧？"

profile 字段（结构见 `onboarding-chat/SKILL.md`）：
- name / tone / hosts / default_target_min / default_aggressiveness / glossary

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
- "想自己改" → 我给你审查页地址，你在网页上 toggle 完导出 JSON 拖回来给我
```

用户决策路径：

**A. 用户口头确认 "OK"** → 继续精剪。

**B. 用户口头指示改某些块**（用自然语言，如 "把第 3 段留着"、"1 和 4 别删"、"再把 7 段也删掉"）：
1. agent 解析 → 修改 `semantic_deep_analysis.json` 中对应 block 的 `action`（delete ↔ keep）或新增 block
2. 用更新后的 analysis **重新生成 `review_roughcut.html`** —— 让用户在网页上看到当前的删除决策视觉效果
3. 把改动总结 + 新 review HTML 路径 chat 出来，再等用户 confirm

```
chat:
好，第 3 段（制作讨论）留着了。粗剪现在剩 4 段删除、总共 -7 分钟：

1. [22:33-23:45] ...
2. [34:12-35:00] ...
4. [55:00-56:30] ...
5. [62:00-62:45] ...

新的审查页：file:///.../review_roughcut.html
确认就回"OK"，再改告诉我。
```

**C. 用户要在网页上自己改** → agent 给本地 review HTML 路径；用户 toggle 完点"导出"下载 `delete_segments_roughcut.json` 拖回 DM；agent 用 `slock attachment view --id <id> --output $BASE_DIR/2_分析/delete_segments_roughcut.json` 覆盖原文件 → 继续精剪。

> 路径 D（网页直接 save、agent 自动 pickup）见 backlog task #9，MVP 不做。

### 名词约定（避免 chat 文案再出现的模糊用语）

- "**删除块**" / "**第 N 段**"：指粗剪总结里编号的删除区间，**不是句子 idx**
- "**重新生成审查页**"：覆盖 `review_roughcut.html`，让网页打开后视觉同步最新决策
- 不要用 "重生"、"N 号块" 这种内部黑话——用 "第 N 段"、"重新生成审查页" 这种自然中文

---

## 阶段 5：精剪（显式 checkpoint，等用户）

调 `podcastcut-精剪` skill。@xiangge-li 明确说**不要在 chat 里追问精剪填充词细节**——只报数字 + 给可选精修入口，然后**等用户回复**，不主动往下跑。

完成后短报：
```
chat: 精剪完了，删了 387 个填充词 + 60 个长停顿，再 -3 min。

2 个选择：
- 「OK」→ 我直接出片
- 想精修个别决策（一般不需要）：打开 file:///Volumes/.../剪播客/review_enhanced.html
  → toggle/半句删除 → 导出 delete_segments_edited.json 拖回 DM
  → 我用你的版本出片
```

用户决策（agent 等消息，不主动 fire）：
- "OK" → 进阶段 6 出片
- 拖回 `delete_segments_edited.json` 附件 → `slock attachment view --id <id> --output $BASE_DIR/2_分析/delete_segments_edited.json` 覆盖，再进出片
- 长时间没回 → 不做任何事；用户下次发消息再继续

> 关键：agent 是消息驱动的，**不要 schedule timer / reminder 来"自动往下走"**。让用户决定何时继续。

---

## 阶段 6：出片 + 交付（屏 7 chat 版）

调 `podcastcut-执行` skill 出 cut audio。**关键：成品必须 .mp3 输出**（task #12，2026-06-02 发现）——m4a 输出在 Apple QuickTime / Music 上会在播放中 auto-stop。podcast 听众大多在 Apple 设备，所以 chat 流程默认 MP3 投递。

```bash
# 调 cut_audio.py 时输出文件名必须 .mp3 后缀
python3 "$SKILL_DIR/剪播客/scripts/cut_audio.py" "<name>_精剪版.mp3" ...
# trim_silences 自动保留 .mp3 后缀

# 上传到 Slock
slock attachment upload --path "$BASE_DIR/剪播客/3_成品/<name>_trimmed.mp3" --channel <target>
# 拿到 attachment-id，作为附件发回
```

```
chat:
🎧 成品出炉：

[audio attachment: <name>_trimmed.mp3]

Changelog：
- 粗剪 5 个大段 -8 min
- 精剪 387 个填充词 -3 min
- 长停顿 60 个裁短 -1.5 min
- 总时长：65 min → 52.5 min

review HTML（可点进去看每个删除决策）：
file:///Volumes/.../review_enhanced.html

下一期直接扔过来。
```

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
| 转录 | `node $SKILL_DIR/../剪播客/scripts/aliyun_funasr_transcribe.sh` 或 `transcribe.sh` |
| 粗剪 | `podcastcut-粗剪` 走脚本 chain（generate_review.js + run_fine_analysis 之前的 5a 段） |
| 精剪 | `podcastcut-精剪` 同样脚本 chain |
| 执行（出片）| `python3 $SKILL_DIR/../剪播客/scripts/cut_audio.py` + `trim_silences.py` |

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
