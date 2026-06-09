# Feedback Routing SOP

> 用户给 feedback 时，先判断应用范围，再决定写到哪里。不要把"这一期的剪辑意见"悄悄沉淀成"所有播客永久规则"。

## Scope labels

所有反馈汇报、PR 描述、长期记忆更新都固定写一行：

```text
Scope: episode / podcast / global / agent-workflow
```

| Scope | 适用范围 | 落点 | 例子 |
|---|---|---|---|
| `episode` | 只影响当前项目 / 当前审查结果 | 当前 project 的 `_debrief.json`、analysis 修正、工作记录 | "这期这段别删"、"这个嘉宾名字识别错了"、"这期主题其实偏 X" |
| `podcast` | 影响某档播客未来所有期数 | `profiles/<播客名>.json`、专属 agent SOP / memory | "《辟客》cue 语默认保留"、"《辟客》整体剪辑更激进"、固定主持人/嘉宾名字写法 |
| `global` | 所有播客都应受益的剪辑能力 / UI / 脚本规则 | shared `SKILL.md`、scripts、templates、docs | 审查页选中文字不应自动播放、中文圆桌通用 turn-taking cue 默认保留、激进档自检 gate |
| `agent-workflow` | agent 怎么协作、汇报、开 PR、执行流程 | 各 agent 的 `MEMORY.md` / `notes/`，或 shared agent SOP | "不要先汇报 plan 再做"、"PR 描述写中文"、"跳过 SKILL.md 步骤前要 chat 确认" |

`agent-workflow` 不直接改变剪辑产物，不能塞进 shared 剪辑 skill 里。它影响的是 agent 的协作方式。

## Decision flow

1. **先识别 feedback 的 scope**。
2. **明显 scope 走 fast path**：直接执行，但在汇报 / PR 里写清楚 `Scope: ...`。
3. **scope 不明确就先问一句**：例如"这条是只改本期，还是以后《辟客》都这样？"、"这是某档播客风格，还是希望全局通用？"
4. **默认从窄到宽**：先按 `episode` 处理；重复出现或用户明确说"以后都这样"再升到 `podcast`；跨播客都成立、且不是单播客口味，才升到 `global`。
5. **冲突时窄层优先**：当前 episode 明确指令 > podcast profile > global baseline。
6. **shared PR 必须说明为什么不是单播客偏好**，必要时提供可选的 profile override，而不是把偏好硬写死。

## Where to apply

### episode

用于一次性修正：

- 当前项目 `_debrief.json`
- 当前 `semantic_deep_analysis.json` / `fine_analysis.json`
- 当前审查页手改结果
- 本次工作记录

不要写回 `profiles/<播客名>.json`，除非用户明确说以后也这样。

### podcast

用于某档播客长期偏好：

- `profiles/<播客名>.json`
- 专属 agent memory / SOP
- per-podcast 可选字段，例如已有的 `profile.cue_patterns`

只有有真实 use case 时才加 profile schema 字段。不要预留空槽如
`delete_style_overrides` / `keep_style_overrides` / `review_ui_preferences`，等第二个具体例子出现后再抽象。

### global

用于跨播客通用能力：

- shared stage `SKILL.md`
- shared scripts / templates
- top-level `docs/`
- `剪播客/基础剪辑规则/` 中的剪辑信号规则

判断标准：

- 是否对多数中文播客成立？
- 是否不是某档节目的调性偏好？
- 是否有明确的误删 / 漏删 / UI 行为问题？
- 是否能被 profile / debrief 覆盖，而不是强制所有播客采用同一风格？

### agent-workflow

用于 agent 协作偏好：

- 本 agent 的 `MEMORY.md`
- 本 agent 的 `notes/`
- 多 agent 共用的协作 SOP

不要写进剪辑规则，除非它改变的是剪辑产物本身。

## Reporting format

每次 agent 表示"我会记住 / 我会改 prompt / 我会开 PR"时，必须可见地写出：

```text
Scope: <episode|podcast|global|agent-workflow>
Landing: <具体文件或记忆位置>
Reason: <为什么是这个 scope>
```

示例：

```text
Scope: podcast
Landing: profiles/辟客.json
Reason: 用户说"以后辟客都这样"，且这是辟客剪辑风格，不是所有播客的通用规则。
```

```text
Scope: global
Landing: 剪播客/templates/review.html
Reason: "选中文字不应自动播放"是审查页通用交互问题，所有播客都受益。
```

## Examples from 2026-06-09 feedback

| Feedback | Scope | Landing | Result |
|---|---|---|---|
| 审查页点行 / 选中文字不要 auto-play，多选更好用 | `global` | shared template | 通用 UI 行为，所有播客受益 |
| 后期 mastering 金句多选合并为一段 | `global` | shared mastering template | 通用 UI 行为 |
| cue patterns + context disambiguation | `global` + optional `podcast` slot | `粗剪/SKILL.md` baseline + `profile.cue_patterns` | 中文圆桌通用，特殊串场语再进 profile |
| 粗剪更激进 / 自检 gate | `global` | `粗剪/SKILL.md` | 激进档语义是通用能力，不是单播客偏好 |
| "阿司 / 阿思" 拼写 | `podcast` | `profiles/辟客.json` 或专属记忆 | 单播客名字写法 |
| 跳过 SKILL.md 步骤前要 chat 确认 | `agent-workflow` | agent memory / notes | 改变 agent 工作流，不改变剪辑规则 |

## Anti-patterns

- 用户说"这期这段别删"，agent 写进 global SKILL.md。
- 用户说"辟客以后更激进"，agent 不标 scope 就改所有播客默认删除比例。
- 用户说"PR 描述写中文"，agent 写进剪辑 prompt。
- 为了"以后可能用到"提前加一堆空 profile schema 字段。
- PR 只写"按 feedback 更新 prompt"，不说明 feedback 的 scope 和 landing。
