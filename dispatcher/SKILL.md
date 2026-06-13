---
name: podcastcut:dispatcher
description: |
  When the operator (xiangge-li) needs to spin up a dedicated agent for a new
  podcaster client, this skill drafts the `agent:create` action card so the
  operator commits the spawn under their own identity. Each podcaster gets
  their own @podcast-editor-<slug> with isolated workspace + memory.
  触发词：为 X 创建一个 agent、给 X 建/分一个 agent、spawn 一个 agent 给 X、
  帮 X 建/创建一个 dedicated agent、新 podcaster 进来、dedicated agent for X、
  开一个专门给 X 的 agent
---

# Dispatcher — per-podcaster agent provisioning

> 配套 SOP：[`docs/dispatcher-operator-sop.md`](../docs/dispatcher-operator-sop.md) ——
> spawn flow（DM-first 6 步）、bug routing fan-in/fan-out、跨 agent 改进的
> 完整规范。本文件只覆盖 action card 怎么开；流程协作规则看 SOP。

## 🚨 Path bootstrap — 跑 bash 前必做

```bash
SKILL_DIR="$(readlink -f ~/.claude/skills/podcastcut-dispatcher)"
```

（同样原则适用所有 podcastcut skill。详见 `edit-chat/SKILL.md` 顶部踩坑笔记。）

> Background: a single @podcast-editor-agent serializes all work — when
> podcaster A is mid-episode, podcaster B's message has to wait. Once we
> have N ≥ 2 podcasters, the right move is **one Slock agent per
> podcaster**: separate processes, separate memory, true parallelism.
> Detailed analysis in
> `notes/2026-06-04_multi-podcaster-agent-architecture.md`.

## When to invoke

Trigger on any of these phrasings (and close variants — semantic
match, not exact-string match):

- "为 X 创建一个 agent"
- "给 X 建 / 建一个 / 分配一个 agent"
- "帮 X 建 / 创建一个 agent" (when context = X is a podcaster, not "X
  is asking for editing help")
- "为 X 单独建一个 agent" / "为 X 专门建一个 agent" / "open dedicated agent for X"
- "spawn 一个 agent 给 X" / "spawn X agent"
- "新 podcaster 进来" / "新客户接入" + 任何 spawn 语义
- 操作者明确说"我要给我每个 podcaster 一个独立的 agent" 这类架构 intent

Common signal words: **spawn / 新建 / 单独 / 专门 / dedicated /
分配 / 分一个 / 建一个 / 给 X 一个 / 多 podcaster 隔离**.

If a podcaster only has one episode planned and the shared agent isn't
saturated, **just use the shared agent** — provisioning is reversible
later but does add an @-mention to remember.

## ❌ When NOT to invoke

The trigger phrase is intentionally narrow because edit-chat shares
overlapping vocabulary. **Do NOT** invoke dispatcher when:

- "帮 X 剪一下这期" / "帮 X 剪辑" / "为 X 处理这个音频" → this is
  edit-chat, not dispatcher. The operator wants the **current agent**
  to do the editing for X, not to spawn a new agent.
- "我是 X 的剪辑 agent" / "你是辟客的助手吧" → identity / role
  framing; the answer is to BE the agent, not to spawn a new one.
- "帮辟客创建一个播客剪辑 agent" without further "单独/新/dedicated" —
  AMBIGUOUS. Default: ask the operator one clarifying question
  ("你是想新开一个专门给辟客的 agent 还是让我（当前 agent）当辟客的助手？")
  rather than guess.
- Anything where the new agent's name wouldn't be `@podcast-editor-<slug>`
  — dispatcher is purpose-built for the per-podcaster pattern, not a
  general agent-spawning utility.

When in doubt: **clarify first, draft second**. A wrong action card
posts spam to the operator's DM and costs them a delete; a clarifying
question costs them one sentence.

## What it does

Wraps `slock action prepare` with `type: "agent:create"` (note: the
agent-knowledge docs use the word "variant" in prose but the actual
JSON field is `type` — confirmed via INVALID_ACTION rejection on
2026-06-08). The operator sees a one-click "Create Agent" card in
chat with the right name +
description pre-filled. The operator clicks → standard Create Agent
dialog opens with prefilled values → operator picks Computer / Runtime
/ Model (agent can't prefill those) → submit.

Slock's design intentionally keeps human commit in the loop here —
admin-level identity actions don't get fully delegated to agents.
See [Action Cards](https://slock.dev/docs/action-cards) for why.

## Usage

```bash
bash "$SKILL_DIR/scripts/spawn_podcaster_agent.sh" \
  <slug> <display_name> [target] [description]
```

| arg | example | notes |
|---|---|---|
| `slug` | `qingyang` / `pike` | ASCII-only handle (Slock @mentions don't carry Unicode in v0). Final agent becomes `@podcast-editor-<slug>`. |
| `display_name` | `清扬` / `辟客` | The human-readable name. Can be Unicode — only the @mention slug needs to be ASCII. |
| `target` | `dm:@xiangge-li` (default) | Where to post the action card. |
| `description` | (optional) | Custom description. If omitted, generated from the display_name. |

Example:

```bash
bash scripts/spawn_podcaster_agent.sh \
  pike "辟客" \
  "dm:@xiangge-li" \
  "辟客（雨林 + 阿思 + 嘉宾）的播客剪辑助手 — 转录、粗剪、精剪、音质、后期、出片，全流程。"
```

After the card is posted, the operator clicks **Create Agent**. The
spawned agent gets:

- Its own `~/.slock/agents/<id>/` workspace
- Empty memory — it doesn't see other podcaster agents' history
- Same `podcastcut-skills/` repo mounted (skill code is shared, agent
  identity is what's per-podcaster)
- Same Slock scopes the operator grants it

## After spawn — DM-first initialization

新 agent boot 起来后 **全程在 operator ↔ dispatcher ↔ new-agent 的 DM 里完成
初始化，然后再拉进 podcast channel**。podcaster 第一次看到新 agent 就是 channel-join
greeting，不是 spawn 配置 noise。完整 6 步流程见 `docs/dispatcher-operator-sop.md`
的 "Spawn flow — DM-first" 段；这里只列 dispatcher 在 DM 里需要做的：

1. 跑 `npm run fresh-agent -- --role podcast` readiness check（PR #111 引入；注意 npm 的 `--` 分隔符）。
2. 确认 installed runtime profile `~/.claude/skills/profiles/<播客名>.json` 已 seed（onboarding-chat 或 dispatcher 写入这里；repo-local `profiles/` 是 docs/templates，runtime 不读那）。
3. 必要时 `bash 安装/install.sh` 刷 snapshot 到 latest。
4. DM 一条 readiness 报告给 operator，operator 决定何时把 agent + podcaster
   拉进 podcast channel。

被拉进 channel 后，PR #110 的 channel-join 触发 0 greeting 接力。

> Cross-agent coordination caveat: per-podcaster agents don't share
> memory. If you want them to learn from each other (e.g. detector
> tuning patterns generalising across podcasts), that's a future Stage
> 4 of the self-iterating loop — not in scope for this skill.

## Bug routing — dispatcher is the shared-code PR owner

per-podcast agent 报 bug → dispatcher 修一次 → install snapshot 扇出给所有 agent。
避免每个 podcast agent 在自己 MEMORY 里各自记一份 workaround。完整流程见
`docs/dispatcher-operator-sop.md` 的 "Bug routing" 段。本 skill 不直接处理 bug
fix（dispatcher 走标准 worktree → PR → squash merge → `bash 安装/install.sh`
→ DM 受影响 agent）；只是提醒：**shared code 的修改路径在 dispatcher 手上**，
per-podcast agent 想改 shared 必须经过 dispatcher review。

## What this skill does NOT do

- Doesn't create the new agent directly — that's admin-only, requires
  human commit per Slock's design. See agent-knowledge `agent` topic
  for the explicit constraint list.
- Doesn't tear down existing agents — `agent:delete` has no action
  card variant in Slock today.
- Doesn't migrate state from the shared `@podcast-editor-agent`. After
  the spawn, the operator copies/symlinks relevant profile + history
  manually (one-time).

## Slug convention

ASCII lowercase + hyphens. Avoid emojis or any character that Slock's
@mention parser doesn't accept. Recommended max length 16. If in doubt
ask the operator before drafting.
