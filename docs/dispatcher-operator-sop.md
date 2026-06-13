# Dispatcher / Operator SOP

> 多 podcaster 拓扑下，谁干什么、在哪里干、出了 bug 怎么走。
> 配套 SOP：[`feedback-routing-SOP.md`](./feedback-routing-SOP.md)（feedback 写到哪里）+
> [`dispatcher/SKILL.md`](../dispatcher/SKILL.md)（spawn action card 怎么开）。

## Topology

| 角色 | Slock 身份 | 职责 |
|---|---|---|
| Operator | @xiangge-li | 拥有所有播客客户、commit action cards、最终 review 权 |
| Dispatcher | @podcast-editor-agent | 单一"大总管"。spawn 新 agent、跨 agent bug fix、install snapshot 维护。**默认在播客 channel 静默**。 |
| Per-podcast agent | @podcast-editor-`<slug>`（pike / wdyk / zwby / …） | 该播客的剪辑全流程（转录 → 粗剪 → 精剪 → 出片 → 后期）。 |

Backup dispatcher 暂不开。需要时只做 cold backup（导出 `MEMORY.md` + `notes/` 到 `docs/dispatcher-state/`）；不要 hot 双 dispatcher，会产生 ownership 模糊。

## Spawn flow — DM-first

新 podcaster 接入，**全程在 operator ↔ dispatcher 的 DM 里完成**，等 agent 准备好再拉进 podcast channel。这样 podcaster 看到的第一条消息就是 agent 打招呼，而不是 spawn action card / 配置 noise。

1. **Operator DM dispatcher**：报 podcaster 名字 + slug 提议 + hosts + 主题方向。
2. **Dispatcher prepares action card** in DM via `slock action prepare`（参考 `dispatcher/SKILL.md`）。包括：
   - `name`: `podcast-editor-<slug>`
   - `description`: 该播客的剪辑专属 agent + 固定主持人 + glossary 关键词
   - workspace 模板 / skills 列表
3. **Operator commits** the card → 新 agent 进程起来。
4. **Dispatcher initializes** in same DM thread：
   - 跑 fresh-agent readiness check：`npm run fresh-agent -- --role podcast`（PR #111 引入；注意 npm 需要 `--` 分隔符把 `--role` 传给 script）
   - 确认 **installed runtime profile** `~/.claude/skills/profiles/<播客名>.json` 已 seed（onboarding-chat 或 dispatcher 写入这里；repo-local `profiles/` 只是 docs/templates，运行时不读那）
   - 确认 install snapshot 是 latest（必要时 `bash 安装/install.sh`）
   - DM 一条"runtime checklist 通过 / waiting for first audio" 给 operator
5. **Operator pulls everyone into the podcast channel**（podcaster + dispatcher + new agent）。
6. **New agent posts channel-join greeting**（PR #110 触发 0）：自我介绍 + 直接进入 stage 2 转录 if audio 已 attach。

### Anti-patterns

- spawn action card 直接发到 podcast channel — podcaster 看到陌生的 JSON 卡片。
- 新 agent 还没跑 readiness check 就被拉进 channel，第一条消息是 error。
- Dispatcher 在 podcast channel 里多嘴 — 默认只有 spawn / bug / cross-agent 改进时才发言。

## Bug routing — fan-in to dispatcher, fan-out via snapshot

per-podcast agent 离 bug 最近（看见的是真实剪辑产物），dispatcher 是修一次扇出给所有 podcast 的"根"。这样避免 pike 在自己 MEMORY 里修，过两周 wdyk 撞同样的 bug。

```
per-podcast agent  ──①报告──▶  dispatcher  ──②PR──▶  origin/main
                                                          │
                                              ③install snapshot
                                                          │
                            ┌────────────────┬────────────┴────────────┐
                            ▼                ▼                         ▼
                          pike             wdyk                       zwby
                       (pull latest)   (pull latest)             (pull latest)
```

### Steps

1. **Report (per-podcast agent)**：在 dispatcher 的 DM 或 `#podcast-cut-debug` thread 里报。包含：
   - 复现 input（session id / project path / 哪一句）
   - expected vs actual
   - 已经定位到的文件 / 函数（如果有）
   - Scope label（按 `feedback-routing-SOP.md`）—— `episode` / `podcast` 的不必走 dispatcher，自己改本地或 profile 即可；只有 `global` / `agent-workflow` 影响 shared code 的才走。
2. **Diagnose + PR (dispatcher)**：在 dev repo 开 worktree，写 fix + 必要时单测 + PR 描述写明 Scope + Landing + Reason。
3. **Merge + snapshot refresh (dispatcher)**：squash merge → `git pull origin main` → `bash 安装/install.sh` → 验证 install snapshot manifest commit hash。
4. **Notify per-podcast agents (dispatcher)**：DM 所有 dedicated agents 一条简短 "PR #N merged, install snapshot 已刷到 commit `<sha>`, 影响 `<area>`, 你下次操作前请 …"。**只 DM 真正受影响的 agent**；不要群发噪音。
5. **Per-podcast agent confirms** they've picked up the fix（必要时 readiness check 重跑）。

### Open question — notification timing

目前 dispatcher 是 merge 后立刻 DM 各 agent。另一种选择是 lazy：只在下次该 agent 上线 / 下次它做相关操作时再提示。

- **Immediate DM**（current）：每个 agent 都知道新 fix，但有 chat 噪音；如果该 agent 当下 idle，DM 也只是堆在 inbox。
- **Lazy notify**：dispatcher 维护一个"待 push to agents"的小队列，agent 启动时拉。需要新机制，但更安静。

待真的因为噪音被 flag 时再做 lazy。

## Cross-agent improvements

跨 agent 的能力升级（不是 bug 修复，而是新功能 / 流程改造）：

- 谁先提出（pike / wdyk / dispatcher 都可以）。
- Dispatcher 仍然是 PR owner + merge handler，确保 shared code 收敛在一处。
- 设计阶段开在 `#podcast-cut-debug`（不是单个 podcast channel），让所有 agent + operator 都能看到。
- 落地后 dispatcher DM 各 agent；per-podcast agent 不需要复述给其 podcaster，除非影响用户可见行为。

## 跟其他 SOP 的关系

| SOP | 管什么 |
|---|---|
| `feedback-routing-SOP.md` | 用户 feedback → episode / podcast / global / agent-workflow，决定写到哪里 |
| `dispatcher-operator-sop.md`（本文件） | dispatcher / per-podcast agent / operator 之间，spawn / bug / cross-agent 协作怎么走 |
| `dispatcher/SKILL.md` | spawn action card 怎么实际开（命令 / 字段） |

简单口诀：**用户的话**走 feedback-routing；**agent 之间 / 跟 operator 之间**的协作走本文件。

## Host state vs repo state

本文件 + `dispatcher/SKILL.md` 都是 **repo 内的协作 SOP**。下面这些是 **host-local launchd / fs 状态**，不在 repo 里：

- `~/Library/LaunchAgents/com.podcastcut.cloud-bridge.plist` — cloud-bridge 守护进程指向 snapshot 还是 dev repo。**这个 PR 不改 plist**；plist 是每台 host 自己维护。
- `~/.claude/skills/cloud-bridge/` — install snapshot 副本（PR #111 引入）。
- `~/.claude/skills/profiles/<播客名>.json` — runtime profile source of truth。
- `<cloud-bridge>/sessions/` — 活的 review session（PR #109 live preview 之类）。

如果 SOP 操作（如 spawn 后 readiness check）报"snapshot 不一致 / cloud-bridge 404"，先查 host 状态，再查 repo / snapshot manifest。

## Failure modes & rollback

- **Spawn 完新 agent 没起来 / readiness check 失败**：dispatcher 在 DM 里报，operator 决定 retry vs 删 agent 重来（`slock` 不支持 agent delete by self；operator 是唯一 commit 权方）。不要把半死的 agent 拉进 channel。
- **Install snapshot 刷新后某 podcast agent 行为退化**：先 `cat ~/.claude/skills/podcastcut-shared/install_manifest.json` 看 commit hash 是否对，然后回滚到 previous commit + `bash 安装/install.sh`。同时在 `#podcast-cut-debug` 报 incident，dispatcher 开 hotfix PR。
- **Per-podcast agent 漂移 / 自己改了 shared 行为**：dispatcher 是 shared code 的唯一 PR owner。per-podcast agent 想改 shared 必须经过 dispatcher review。
