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

## 7 字段（按顺序问）

### 00 绑定小宇宙播客 URL（可选 — 跳过去直接问 01）

```
chat: 第一步：如果这档播客在小宇宙上有主页，给我链接。我会自动导入播客名、简介、主播、往期标题。没有 / 不想绑也行——回复 "跳过"。
user: https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc
```

agent 调 helper：
```bash
node $SKILL_DIR/fetch_xiaoyuzhou.js <URL>
```

stdout 拿到 JSON：
```json
{
  "name": "硅谷101",
  "description": "分享当下最新鲜的技术、知识与思想",
  "hosts": ["泓君Jane"],
  "past_episode_titles": ["E238｜..", "E237｜..", ...],
  "subscriber_count": 565473,
  "url": "..."
}
```

agent 行为：
- 把 `name` 作为 01 播客名默认（chat 里 echo："读到播客叫'硅谷101'，对吗？"）
- 把 `description` 作为 02 调性的起点（"小宇宙写的简介是'分享当下最新鲜的技术、知识与思想'。你想用这个或改一下吗？"）
- 把 `hosts` 作为 03 主播默认（但角色"主持/嘉宾"还需要 user 确认）
- `past_episode_titles` 存 profile，**MVP 不用，v2 喂 LLM 学历史风格**
- URL 存 profile `xiaoyuzhou_url`

**fail-safe**：URL fetch 失败 / 用户跳过 → 直接进 01，profile 不存 URL（schema 字段为 null）。MVP 兼容降级。

### 01 播客名（唯一标识 + 文件存储 key）

```
chat: 这档播客叫什么？
user: 辟客
```

中文名直接用做文件名（如 `profiles/辟客.json`）。

### 02 节目调性（决定 LLM 精剪 prompt 风格）

```
chat: 这档播客是什么调性？随便说几句——比如几人闲聊还是访谈、氛围紧凑还是放松、要不要保留笑声/停顿。
user: 三人闲聊 + 嘉宾访谈，氛围轻松但有深度。保留自然的笑声、反应和思考停顿。不追求极致紧凑。
```

整段自由文本存入 profile，**直接拼进精剪 LLM 的 system prompt**。

### 03 固定主播（speaker 识别 + 角色标签）

```
chat: 谁是固定主播？每人告诉我名字和角色（主持 / 嘉宾），可以多个。
user: 阿司主持，雨林嘉宾
chat: 还有别人吗？没有就跳过。
user: 没了
```

存为 `["阿司": "主持", "雨林": "嘉宾"]`。

### 04 默认目标时长（覆盖 fallback）

```
chat: 一般每期目标多长？我给你一个 50 分钟的默认，按 ± 调？
user: 50 就 50
```

范围 20-90，默认 50。每期 debrief 时可以临时覆盖。

### 05 默认删减力度（保守 / 适中 / 激进）

```
chat: 默认删减力度想多大？
- 保守：只删明显口癖（嗯啊呃）
- 适中：口癖 + 重复 + 长停顿
- 激进：上面 + 跑题段落 + 录制讨论
user: 适中
```

存为 `"moderate"` 之一。

### 06 Glossary 词库（ASR 词汇纠正）

```
chat: 这档播客有没有特殊词汇/术语？人名、品牌、行话——避免 ASR 转错。一次告诉我或一个个加都行。
user: 辟客、阿司、雨林、珊瑚词典、小宇宙
```

存为 array `["辟客", "阿司", "雨林", "珊瑚词典", "小宇宙"]`。**默认把主播名也加入 glossary**（避免重复输入）。

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

## 交付确认

跑完 6 个字段后，给用户**完整 echo 回去 confirm**：

```
chat:
存好了。给你看一下：
- 名字：辟客
- 调性：三人闲聊 + 嘉宾访谈...
- 主播：阿司（主持）、雨林（嘉宾）
- 默认目标：50 分钟、适中力度
- Glossary：5 个词

OK 的话下次你扔音频过来我直接开剪。要改哪条说"改 XXX"。
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
1. 检查 `$SKILL_DIR/../profiles/` 是否有 profile，**如有**则问"用现有 [名字] 还是建新的？"
2. 按 01-06 顺序问，**一次问一个**，不要一口气列 6 个表单（chat 服务要"对话感"）
3. 每个字段用户答完就 echo 短确认（"好，调性记下"），保持对话节奏
4. 跑完写 profile.json，给用户最终 echo + 提示下一步

不要在 onboarding 流程里跑 cut_audio.py 或其他 pipeline——这个 skill 只管 profile。
