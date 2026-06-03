---
name: podcastcut:onboarding-chat
description: 首次接触用户时通过对话设置播客 profile（chat 版屏 1）。问 6 个字段：播客名、调性、固定主播+角色、默认目标时长、默认删减力度、Glossary 词库。存到 podcastcut-skills/profiles/<播客名>.json。触发词：onboarding、首次使用、新播客、setup、setup profile、新建档案
---

<!--
input: 用户首次对话 / 没有 profile
output: profiles/<播客名>.json 存到 podcastcut-skills/profiles/

pos: chat 服务的入口 skill；后续 edit-chat 读这个 profile

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. ../edit-chat/SKILL.md 的 profile 字段引用
-->

# Onboarding（chat 版）

> 通过对话设置一档播客的 profile，复用屏 1 的 6 个字段。一档播客一次 onboarding；之后每期剪辑都用这个 profile。

## 使用场景

- 新用户第一次发音频 → 没 profile → 自动跑这个 skill
- 老用户切换到新播客 → 显式说"新建档案"
- 用户想改已有 profile → 说"改 profile"

## 流程（2 步，不再 6 轮）

**2026-06-03 反馈调整**：以前一次一个问题、6 轮 back-and-forth 太慢、AI 味重。改成 **2 步**：
- **Step 0（可选）**：先问小宇宙 URL（可以一句话拿到名字+主播+简介，省后面打字）
- **Step 1**：一次性把剩下 5 个字段（调性 / 主播角色 / 时长 / 力度 / 术语）放一条消息让用户填

文案目标：**像朋友帮你建档**，不是 form 表单。少用 emoji，多用日常口语。

### Step 0 — 小宇宙 URL（可选）

第一条消息：

```
嗨～建你这档播客的档案，让我以后剪起来更顺手。

你的播客在小宇宙上有主页吗？发我链接我自动拉名字 + 简介 + 主播 + 往期，
你少打字。没有也行，回我「跳过」我换另一种方式问。
```

如果给了 URL → 调 helper：

```bash
node $SKILL_DIR/fetch_xiaoyuzhou.js <URL>
```

stdout 拿到 JSON：
```json
{
  "name": "硅谷101",
  "description": "分享当下最新鲜的技术、知识与思想",
  "hosts": ["泓君Jane"],
  "past_episode_titles": ["E238｜..", ...],
  "subscriber_count": 565473,
  "url": "..."
}
```

把 name / description / hosts 拿来当 Step 1 的默认值。

**fail-safe**：URL fetch 失败 / 用户「跳过」→ 进 Step 1，profile 字段为 null。

### Step 1 — 剩下 5 个字段一次问完

第二条消息（有 URL 来源就用拉到的内容预填；没有就空着让用户从头填）：

```
好嘞，剩下几个问题，一条消息回我就行：

1. **调性**：这档播客是几个人聊？氛围怎么样？随便几句话描述一下。
   （比如「俩人深聊、节奏不快、保留笑声」「三人闲聊偶尔有嘉宾」之类）
{有 URL 时多加一行：}
   📝 小宇宙简介是「{description}」，你想用这个、加几句、还是重新写？

2. **主播**：{有 URL 时：「拉到 N 个主播：A、B。每人是主持还是嘉宾？」}
   {没 URL：「谁是固定主播？告诉我名字 + 角色（主持/嘉宾）。」}

3. **每期目标时长**：一般想剪到多长？没特别想法的话默认 50 分钟。

4. **删减力度**：默认想多激进？
   - 保守：只删明显口癖（嗯啊呃）
   - 适中：口癖 + 重复 + 长停顿（**推荐**）
   - 激进：上面 + 跑题 + 录制讨论

5. **术语 / 名词**：有没有特殊词需要 ASR 识别准？人名、品牌、行话之类——
   我已经把播客名 + 主播名加上了，你补几个就行。
```

用户一次回完 → 解析（用 LLM 自然语言理解抓 5 个字段）→ 写 profile.json → 进交付确认。

### 字段存储 schema

每个字段最终存到 `profiles/<播客名>.json`（详见下面 § profile JSON schema）：

| 字段 | 存什么 | 用处 |
|---|---|---|
| name | 中文/英文名（也用作 .json 文件名） | profile key |
| tone | 整段自由文本 | 拼进精剪 LLM system prompt |
| hosts | `[{name, role}]` array | speaker_mapping best-guess + glossary 默认 |
| default_target_min | 数字 20-90 | 每期目标基准（debrief 可覆盖） |
| default_aggressiveness | `"conservative" / "moderate" / "aggressive"` | 删减阈值 |
| glossary | string array | ASR vocabulary_id（task #15）+ 精剪 LLM 拒删名词 |
| xiaoyuzhou_* | URL + desc + past episodes | 风格 reference + 留作 v2 LLM 训练样本 |

**默认把播客名 + 主播名加入 glossary**——用户不必重复输入。

---

## profile JSON schema

存到 `$SKILL_DIR/../profiles/<播客名>.json`：

```json
{
  "version": "profile_v1",
  "name": "辟客",
  "xiaoyuzhou_url": "https://www.xiaoyuzhoufm.com/podcast/...",
  "xiaoyuzhou_desc": "原 ta 自己在小宇宙写的播客简介（fetch 时存下来，可作为风格 reference）",
  "xiaoyuzhou_past_episodes": ["往期 1 标题", "往期 2 标题", ...],
  "tone": "三人闲聊 + 嘉宾访谈，氛围轻松但有深度。保留自然的笑声、反应和思考停顿。不追求极致紧凑。",
  "hosts": [
    {"name": "阿司", "role": "主持"},
    {"name": "雨林", "role": "嘉宾"}
  ],
  "default_target_min": 50,
  "default_aggressiveness": "moderate",
  "glossary": ["辟客", "阿司", "雨林", "珊瑚词典", "小宇宙"],
  "created_at": "2026-06-02T..." ,
  "updated_at": "2026-06-02T..."
}
```

如果 00 跳过 / 失败：`xiaoyuzhou_*` 字段全为 null 或省略，profile 仍合法。

## 交付确认（Step 1 用户答完后）

文案温度调一下，别像表单：

```
搞定，存好了：

- 名字：辟客
- 调性：三人闲聊 + 嘉宾访谈，氛围轻松但有深度...
- 主播：阿司（主持）、雨林（嘉宾）
- 每期 50 分钟、适中力度
- 5 个术语词

下次扔音频过来我直接开剪。哪条想改跟我说"改 XX"。
```

如果用户漏答某项（如没说删减力度），不要再追问一轮——**用默认值 + 标注**：

```
好的，剩下没说的我先用默认：50 分钟 / 适中力度。
你之后想改随时跟我说。
```

## 后续

下一期 podcast cut：用户扔音频 → `podcastcut-edit-chat` skill 自动读 profile.json → 直接进 debrief 流程。

## 不在 MVP

- 小宇宙 URL 自动导入往期信息（v2）
- 多 profile 切换 UI（chat 里 "切到 [名字]" 就够）
- profile 学习更新（每期 debrief 可能写回 profile，先不做）

---

## 实现指引

triggered by: user message containing onboarding 触发词，或 detected first-time (no profiles dir / empty profiles)。

agent 行为：
1. 检查 `$SKILL_DIR/../profiles/` 是否有 profile，**如有**则问 "用现有 [名字] 还是建新的？"
2. **2 步流程**：
   - Step 0：先问小宇宙 URL（一条消息，可选）
   - Step 1：一次性把剩下 5 字段放一条消息让用户答完
3. 用户答完 → 解析他的自然语言（不要要求结构化输入；自己抓字段） → 写 profile.json → echo 确认
4. 漏答的字段用默认（**不再追问**）：调性=空 / 主播=空 / target=50 / aggressiveness=moderate / glossary=播客名+主播名
5. 语气：温暖、口语，**不要像表单 / 不用 emoji 堆砌 / 不要"我会"、"我将"这种正式词**

不要在 onboarding 流程里跑 cut_audio.py 或其他 pipeline——这个 skill 只管 profile。

### 旧版"一次问一个"的设计反思（reverted 2026-06-03）

之前为了"对话感"采取一次问一个的策略，实测 @xiangge-li 反馈："太慢了、AI 味重"。教训：**chat 不等于慢节奏**。批量收集 + 单次 echo 反而像朋友帮你 setup，对话感来自语气而不是消息数量。
