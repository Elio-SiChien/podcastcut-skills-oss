---
name: podcastcut:粗剪
description: |
  播客粗剪单元（pipeline 第二步）：段落级 AI 内容分析 + 句子级人工审查页。
  通读全文划分话题、按 6 类删除 + 质量优化标记大块 → semantic_deep_analysis.json，
  生成可试听/可编辑的 review_roughcut.html（含半句删除 + 句子序号），用户导出 delete_segments_roughcut.json。
  触发词：粗剪、粗剪分析、段落级分析、生成粗剪审查页、roughcut
---

<!--
input: 2_分析/sentences.txt + 1_转录/subtitles_words.json + speaker_mapping.json + audio_seekable.mp3
       （由 /podcastcut-转录 产出，经 output/.current_project 交接）
output: 2_分析/semantic_deep_analysis.json、review_roughcut.html、(用户)delete_segments_roughcut.json
        project.json(roughcut=awaiting_review)
pos: pipeline 第二步；上游=转录，下游=/podcastcut-精剪

架构守护者：generate_review.js / 模板 review.html 暂在 剪播客/scripts(templates)。
**模板与精剪共用**：精剪单元也调本生成器（额外传 --fine 和 --roughcut 激活精剪态，渲染 AI 标 + 折叠粗剪整删段），
输出叫 review_enhanced.html 以区分两阶段。改本模板前先想想对精剪页有没有影响。
未来建 _shared/ 时统一迁移并更新引用。
-->

# 粗剪单元

> 内容级删减：先看懂整期在讲什么，再把"不该进成品的大块"标出来，交给用户在审查页上确认。pipeline 的"内容粗剪"步，独立可调用。

## 这一步删什么（与精剪的分工）
- **粗剪（本单元）= 删大块**：录前准备、技术调试、跑题闲聊、隐私、重复故事、制作讨论，以及信息密度低/啰嗦的段落。**句子级**。
- **精剪（/podcastcut-精剪）= 删口癖语病**：填充词、卡顿、静音、重说纠正、残句。**词级**。
- 两步各自有审查页、各自导出，**导出命名分开**（见红线）。

## 🔴 红线
- 审查页音频用 `1_转录/audio_seekable.mp3`（CBR 192k + Xing header，VBR 会 seek 漂移）。
- 导出命名 **`delete_segments_roughcut.json`**，**不要**用 `delete_segments_edited.json`（那是精剪的最终清单，撞名会被执行单元误吃）。
- 审查页模板用占位符注入（`__SENTENCES_DATA__` 等），生成后必须校验**无样例残留**（不应出现 `雨林/潘潘/阿司` 等示例说话人）。

## 脚本位置
`$SKILL_DIR/剪播客/scripts/generate_review.js`、模板 `$SKILL_DIR/剪播客/templates/review.html`。

---

## 步骤

### 0. 定位项目

```bash
PROJECT="${PROJECT:-$(cat "$SKILL_DIR/output/.current_project")}"
BASE_DIR="$SKILL_DIR/output/$PROJECT/剪播客"
USER_ID="${PODCASTCUT_USER:-$(node -e "console.log(require('$BASE_DIR/project.json').project.user||'default')")}"
node "$SKILL_DIR/剪播客/scripts/manifest.js" set-stage "$BASE_DIR" roughcut in_progress
```
> 上游契约：`2_分析/sentences.txt`、`1_转录/subtitles_words.json`、`1_转录/audio_seekable.mp3` 应已存在（转录单元产出）。缺失则先跑 `/podcastcut-转录`。

### 1. 加载播客 profile（激进度 / 调性 / glossary）

```javascript
// chat 服务下发的播客 profile（onboarding-chat skill 生成）
// 路径：podcastcut-skills/profiles/<播客名>.json，由 edit-chat 启动时挑好后传入 BASE_DIR/profile.json
const profile = require(`${BASE_DIR}/profile.json`);
// 字段：name / tone / hosts / default_target_min / default_aggressiveness / glossary
//      （schema 见 onboarding-chat/SKILL.md § "profile JSON schema"）
```
- `profile.default_aggressiveness`（保守/适中/激进）决定删减阈值
- `profile.tone` 拼进 LLM system prompt，影响段落判定风格
- `profile.glossary` 中的术语在 AI 段落分析里"拒删"（保护专有名词所在句）
- `_debrief.json` 里 `must_keep` 段进硬保护；`privacy` 段优先标 delete

### 2. 段落级 AI 分析 → `semantic_deep_analysis.json`

> 方法论详见 `基础剪辑规则/10-内容分析方法论.md`。采用**两级分析**：先段落级扫描标记大块删除区间，再对边界逐句微调。

**Profile / debrief 注入**（这一步是 LLM 调用，agent 自己读 SKILL.md 当 prompt 跑，所以"喂"profile = 在分析过程中显式参考下列字段）：

> 用户 feedback 要先按 `docs/feedback-routing-SOP.md` 判断 scope。当前 episode 明确指令覆盖 podcast profile，podcast profile 覆盖 global baseline；只有单播客长期偏好才写 profile，跨播客通用能力才改 shared skill。

| Profile / debrief 字段 | 喂进 LLM 的方式 |
|---|---|
| `profile.tone` | 段落级判定时**作为风格基线**："这档播客调性：『{tone}』。这意味着自然停顿、笑声、轻闲聊可能是节目特色，标 delete 前要确认它跟调性是否冲突。" |
| `profile.default_aggressiveness`（保守/适中/激进） | 决定 `suggest_delete` 的阈值。保守：只标 100% 确定的；适中：含信息密度低；激进：含跑题闲聊和细枝末节展开。**目标删除比例**：保守 10-20% / 适中 20-35% / 激进 35-50%。⚠️ 2026-06-08 教训：**目标比例是 anchor 不是天花板**——agent 实际跑出 8% 然后"诚实交代密度高"是失职，应该按"激进就真的激进"硬扫到 30%+：除了 cue / production_talk 外，重复内容（嘉宾长独白内部同义重述）和与主题弱关联的细节也要标 delete。如果扫不到 30%，**说明扫描信号不够，回去再扫一遍**而不是把责任推给用户在审查页加 |
| `profile.glossary` | **"拒删名词"列表**：含 glossary 词的句子默认不进 delete，且避免在 glossary 词所在句中切边界（防止切断专有名词上下文） |
| `profile.default_target_min` | 目标时长 anchor（覆盖 fallback 90 min） |
| `profile.cue_patterns`（可选） | **per-podcast 串场语扩展清单**（数组）。下方"中文圆桌通用 cue / turn-taking 信号"清单是 baseline 默认应用；如果某档播客有 idiosyncratic 串场语（例 "那么来到我们的 X 环节"），可以加在此字段里，**与 glossary 同样的注入模式**：含这些 pattern 的句子默认保留，并可当段落边界锚点。辟客 / 五点一刻当前都没设，跑空数组即可 |
| `_debrief.json` 里 `must_keep`（用户钦定必留段） | **硬保护**：覆盖到的句子强制 `keep`，即使匹配 6 种删除类型 |
| `_debrief.json` 里 `privacy`（用户标的隐私段） | 优先标 `delete` type=`privacy`，无视激进度阈值 |
| `_debrief.json` 里 `incidents`（录制意外） | 提示 LLM 重点扫描 tech_debug 段，把意外段一并打到 tech_debug 块里 |
| `_debrief.json` 里 `smoothness`（顺畅 / 还行 / 磕磕绊绊） | "磕磕绊绊"→ 提示更多 self_correction 段落；"顺畅"→ 减少误标 |

#### 中文圆桌通用 cue / turn-taking 信号（默认保留，非辟客专属）

⚠️ **整套删/留判断里最关键的一条认知** —— 串场 / cue / turn-taking 短语是
**结构性过渡信号**，**不是口癖**。它们做的事是"让节奏顺起来"（让位 / 引出
下一位 / 收口当前话题 / 切换话题）。LLM 默认保留，并可作为段落边界锚点。
删了反而让节目跳切感强。

下表为中文圆桌 / 访谈类播客通用 baseline（不限辟客），每档播客特殊的串场
语可加在 `profile.cue_patterns`：

| 类型 | 自然语 pattern 示例 |
|---|---|
| 自荐讲下一段 | "那我来说一下" / "那我先说" / "我先来" / "OK 我来" |
| 点名 cue 嘉宾 | "X 你来说" / "X 你想讲讲吗" / "要不要 X 来说一下" / "我觉得让 X 来" |
| 用 "cue" / "Q" 字面 | "那我来 cue 一下" / "我 Q 一下" / "帮帮他 Q 一下吧" / "继续吧" |
| 段落收口 | "差不多就是这样" / "就这些" / "我先讲到这里" / "我的部分讲完了" / "OK，我说完了" |
| 段落切换 | "那我们换一个话题" / "可以聊下一个吗" / "要不要直接到第 N 段" / "那么下面" |
| 时长 / 节奏调度 | "时间差不多了" / "我们时间是 N 小时" / "这段还是有比较多理论" / "我们快一点" |
| 元讨论 | "现在到哪了" / "我们可以收尾了" / "这段直接 PaaS 掉都 ok" / "看一下大纲" |
| 接话 / turn-taking | "对，我接一下" / "我补充一下" / "我也想说一句" |

##### ⚠️ 重要：context disambiguation — 同 pattern 看后续动作判定

**同一个 pattern 在不同上下文是不同的处理方向**：

- **cue 信号 → 保留**：例 "X 你来说" 后面**真的换嘉宾发言**了 = 给嘉宾让位
  的过渡 → keep
- **production_talk → 删除**：例 "这段直接 PaaS 掉都 ok" / "现在到哪了" /
  "我们可以收尾了" 后面**继续在讨论录制本身**（节奏 / 分工 / 剪辑） →
  delete（type=`production_talk`）

判定方式：**LLM 看 pattern 之后的 2-3 句**：
- 后面真换话题 / 换人 / 进入新内容 → cue（保留）
- 后面继续聊"录制 / 剪辑 / 时长 / 节奏" → production_talk（删）
- 这一条不写清楚，LLM 很容易把 "我们可以收尾了" 这种误当 cue 保留。

##### 与 `production_talk` 判别原则的关系

下方步骤 7a 的"激进档专扫"和后面的 `production_talk` 判别原则那一节都引用
本表 —— **本表是"长什么样"的清单 + 默认 keep 原则，下方 production_talk
那节是"判 delete 的边界条件"**。两个都给 LLM 才稳。

**流程**：
1. 通读 `2_分析/sentences.txt` 全文，划分话题段落
2. **先盖硬规则**：把 `_debrief.must_keep` 句子标 `keep`、`_debrief.privacy` 段标 `delete`
3. 按 6 种基础类型（见下表）识别确定性删除
4. 计算各块时长，对比 `profile.default_target_min`
5. 如仍需删减，按 `profile.default_aggressiveness` 阈值识别信息密度低的段落 → `delete`
6. **质量优化扫描**（始终执行）：扫描啰嗦重复/过度展开/弱相关细节 → `suggest_delete`，但 glossary 词所在句不进
7. **激进档专扫**（aggressiveness=激进 时必跑）：
   a. **cue/production_talk 自然语扫描**：以上方"中文圆桌通用 cue / turn-taking 信号"表为 baseline pattern 集合，叠加 `profile.cue_patterns`（per-podcast 扩展）。**严格按 disambiguation 原则**：pattern 后面真换话题/换人 → 保留（cue）；后面继续聊录制本身 → 标 production_talk
   b. **重复内容扫描**：在 ≥2 分钟连续嘉宾独白里，找同一观点用 ≥2 段不同措辞反复说的段，标 `repeated_content`
   c. **弱关联细节扫描**：跟核心话题（用户 onboarding 给的话题大纲 / debrief.must_keep）关联度低的细枝末节，标 `chit_chat` 或 `suggest_delete`
   d. **节目结尾后段扫描**：从最后一句正式收尾（如"我们下期再见"/"stay tuned"）开始到文件末，全部标 `production_talk`
8. 微调每个删除块的边界切点（避免在 glossary 词上切）
9. **写章节导航**：基于通读时划分的话题段落，写出 `chapters` 数组（详见下面 schema）—— **必填**，用户在审查页靠这个跳话题筛选
10. 写出 `2_分析/semantic_deep_analysis.json`
11. **自检删除率**：跑完后核对实际 `summary.deleteRatio` vs 目标比例。**保守差距 < 5%、适中差距 < 10%、激进差距 < 10%** 才算合格。如果距离太远，回步骤 7 加大扫描深度，**别交付低删除率的版本让用户自己加**。

**6 种删除类型**：

| 类型 | 标识 | 说明 |
| --- | --- | --- |
| 录前准备 | `pre_show` | 正式开场白之前的一切内容 |
| 技术调试 | `tech_debug` | 设备问题、录制中断、音频检查 |
| 跑题闲聊 | `chit_chat` | 与主题无关的闲聊 |
| 隐私信息 | `privacy` | 说话人要求删除或敏感个人信息 |
| 重复内容 | `repeated_content` | 同一段故事讲两遍（保简版删详版）；同一个观点用不同措辞反复 |
| 制作讨论 | `production_talk` | 录制中讨论剪辑策略、cue 流程、节奏调度 |

### `production_talk` 判别原则

如果该句**对内容主题没有贡献，纯粹是在讨论节目本身的节奏/分工/时长**，就标 `production_talk`。**别因为它是嘉宾说的、礼貌的、衔接流畅的就以为是正文。**

⚠️ 重点：本节判 **delete**，上面 "#### 中文圆桌通用 cue / turn-taking 信号" 那节判 **keep（默认）**。两节里**列的 pattern 有大量重合**，靠 disambiguation 原则区分（看 pattern 后面 2-3 句的走向）。两节都看，别只看一节就下结论。

per-podcast 真有 idiosyncratic 串场语再写进 `profile.cue_patterns`（schema 见上方 profile 注入表）—— shared baseline 已经覆盖中文圆桌绝大多数情况，辟客 / 五点一刻当前都不需要。

### `repeated_content` 重复识别（重点 — 长嘉宾独白展开）

⚠️ **2026-06-08 反馈（同期）**：嘉宾长独白里经常**同一个观点用 3-4 段不同措辞反复说**，AI 一律保留就让节目啰嗦。识别原则：

| 重复模式 | 示例 |
| --- | --- |
| 段内同义重述 | 一段 5 句话里前 2 句说"X 不好"、后 3 句又说"X 不好"换措辞 |
| 跨段呼应 | 嘉宾在 5 分钟后又把刚才已经说过的同一个故事 / 例子重新讲一遍 |
| 总结性重复 | "所以我刚才说的就是..."后面整段是对前文的复述 |
| 引言反复 | 把同一个引言 / 概念在不同小节里都开头一遍 |

判别原则：**只保留信息量最大、最完整、最自然的那一次**。重复的那次（无论是先说的还是后说的）标 `repeated_content` 进 delete。**嘉宾说得长不等于干货密**——尤其要警惕单一嘉宾连续讲 ≥ 2 分钟时段内的内部重复。

**输出格式**（两级结构）：
```json
{
  "version": "5.0",
  "analysisType": "two_level",
  "totalDuration": "2:08:06 (128min)",
  "targetDuration": "90min",
  "blocks": [
    { "id": 1, "range": [0, 19], "type": "pre_show", "reason": "录前准备：测噪音、谁先开口", "duration": "1:06" }
  ],
  "sentences": [
    { "sentenceIdx": 0, "speaker": "响歌歌", "action": "delete", "blockId": 1, "type": "pre_show" },
    { "sentenceIdx": 20, "speaker": "清扬", "action": "keep" }
  ],
  "chapters": [
    { "range": [20, 230], "title": "嘉宾自我介绍 + 工作背景", "desc": "清扬讲她从 X 大学博士到现在做 Y 行业的路径；为下面的访谈定基调。" },
    { "range": [231, 580], "title": "Y 行业的日常工作流", "desc": "拆解日常 task：上午做 A、下午做 B；穿插一个跟 P 项目相关的故事。" }
  ],
  "summary": { "totalSentences": 1404, "deleteSentences": 227, "deleteBlocks": 13, "totalDeleteDuration": "14:23", "deleteRatio": "16.2%" }
}
```
- `blocks` — 段落级，供人工审核看大块删了什么
- `sentences` — 逐句级，供审查页/下游脚本消费；删句 `action:"delete"`、质量优化 `action:"suggest_delete"`、保留 `action:"keep"`
- `chapters` — **必填**字段，用户在审查页靠章节导航跳话题做筛选。三字段约束：
  - `range: [startIdx, endIdx]` — 章节覆盖的 sentence idx 区间，**必须连续覆盖全期**（前一章节 endIdx + 1 = 下一章节 startIdx）
  - `title` — 一句概括的话题标题（**不是**第一句话原文）。示例 "嘉宾自我介绍 + 工作背景"、"⭐ 核心观点：物的一生"（用户钦点段加 ⭐ 前缀）
  - `desc` — 2-3 句话总结这一章节聊了什么、出现了哪些关键概念/嘉宾故事。用户没有 desc 就无法在不试听的情况下判断要不要删整章
- 反例（错误的 chapters 写法 — 不要这样做）：
  ```json
  { "range": [20, 230], "title": "好的，那我们来聊一下你的工作。", "desc": "" }   ❌ title 是第一句话原文
  { "range": [20, 230], "title": "工作", "desc": "" }                                ❌ desc 留空
  ```

> ⚠️ 如果 `chapters` 缺失，`generate_review.js` fallback 会用"取每段第一句作 title、desc 留空"自动均分，对用户筛选**完全无用**。脚本会打 WARNING。看到 WARNING 必须回来补 `chapters`，不要让它跑过去。

### 3. 生成句子级审查页 `review_roughcut.html`

```bash
cd "$BASE_DIR/2_分析"
node "$SKILL_DIR/剪播客/scripts/generate_review.js" \
  --sentences sentences.txt \
  --words "$BASE_DIR/1_转录/subtitles_words.json" \
  --analysis semantic_deep_analysis.json \
  --audio "1_转录/audio_seekable.mp3" \
  --output "$BASE_DIR/review_roughcut.html" \
  --title "$PROJECT 粗剪审查（可编辑）"

open "$BASE_DIR/review_roughcut.html"
```

> 模板位于 `templates/review.html`，脚本注入 `__SENTENCES_DATA__/__BLOCKS_DATA__/__CHAPTERS_DATA__`。
> 审查页能力：整句删除/恢复（勾选框）、**半句删除**（选中文字→标记，char 级精度）、句子序号、点击跳转试听（动态跳过删除段，无需预剪）、localStorage 自动保存。

### 4. 用户审查 + 导出

让用户在审查页上：
1. 浏览 AI 标记（确定删除 / 建议删除）
2. 用播放器试听效果
3. 勾选/取消勾选整句、或选中文字做半句删除
4. 点"导出"→ 下载 **`delete_segments_roughcut.json`**，拖回对话框

把导出文件放到 `2_分析/`：
```bash
# 用户把下载的 delete_segments_roughcut.json 放到 $BASE_DIR/2_分析/
ls "$BASE_DIR/2_分析/delete_segments_roughcut.json"
```

#### 4.5 计算粗剪 eval stats → 贴回 chat（"AI 帮你做了什么"）

用户 commit 完审查页 + 导出 `delete_segments_roughcut.json` 后，agent 立刻
跑 eval 把价值感知报告贴回 chat：

```bash
node "$SKILL_DIR/eval/compare_roughcut.js" \
  --ai   "$BASE_DIR/2_分析/semantic_deep_analysis.json" \
  --user "$BASE_DIR/2_分析/delete_segments_roughcut.json" \
  --episode-name "$(basename "$BASE_DIR")" \
  --format delivery-msg
```

输出形如：

```
粗剪 AI 帮你做的：
✓ 抓了 100 段录制讨论 / cue 流程 = 省 7:25
✓ 抓了 89 段录前准备 = 省 7:23
你额外加了：7 段（AI 漏标）

这次你接受了我 90% 的粗剪决策——下次继续这样剪。
```

**chat 报告里必须把这段原样贴上去**，让用户看到这一期 AI 的价值。
不传 `--format delivery-msg` 是开发者用的 markdown 表（更详细，per-type
precision/recall/F1）+ 追加到 `eval/results_roughcut.jsonl`（longitudinal
数据，未来 Phase 2 pattern 提取的数据来源）。两个都跑也行（先无 format
拿 markdown + jsonl，再 `--format delivery-msg` 拿 chat 段落）。

### 5. 写状态清单（等用户确认）

```bash
# 生成审查页后即置 awaiting_review（pipeline 在此暂停等人工审核）
DELS=$(node -e "try{const a=require('$BASE_DIR/2_分析/semantic_deep_analysis.json');console.log((a.summary&&a.summary.deleteBlocks)||0)}catch(e){console.log(0)}")
node "$SKILL_DIR/剪播客/scripts/manifest.js" set-stage "$BASE_DIR" roughcut awaiting_review \
  --outputs '{"analysis":"2_分析/semantic_deep_analysis.json","review_page":"review_roughcut.html","export":"2_分析/delete_segments_roughcut.json"}' \
  --summary "{\"deleteBlocks\":$DELS}"
```
用户确认导出无误后（口头确认或下游单元启动时）置 `approved`：
```bash
node "$SKILL_DIR/剪播客/scripts/manifest.js" set-stage "$BASE_DIR" roughcut approved --note "用户已审核导出"
```

---

## 输出契约（交给 /podcastcut-精剪）
- `2_分析/semantic_deep_analysis.json`（段落 + 逐句标记）
- `review_roughcut.html`（审查页）
- `2_分析/delete_segments_roughcut.json`（用户导出的粗剪删除清单）
- `project.json`：`roughcut.status=awaiting_review`（用户确认后 `approved`）

下游 `/podcastcut-精剪` 从 `output/.current_project` 读当前项目，对 `keep` 的句子做词级精剪。
