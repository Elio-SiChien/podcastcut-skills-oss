# Multi-podcaster agent architecture

> 2026-06-04 design discussion between @xiangge-li and podcast-editor-agent.
> Decision: **per-podcaster Slock agent**, auto-provisioned via action card.
> Preserved for product narrative — one of the architectural pivots that
> made the system "ready to onboard the 2nd client".

## The bottleneck

A Slock agent is "wake on message, sleep when idle, single process at a
time". One @podcast-editor-agent serializes all work. If podcaster A is
mid-episode (the LLM 精剪 step can take 10-15 min), podcaster B's message
queues up. That's the wall we hit at N ≥ 2.

## Options considered

### Option 1 — per-user Slock agent (chosen ✅)

`@podcast-editor-清扬` / `@podcast-editor-辟客` / ... each runs its own
process. True parallelism.

**Why this wins:**
- N agents = N parallel processes. Linear throughput scaling.
- State is genuinely isolated. One agent's crash is another's none-of-
  my-business.
- The "same podcast concurrent profile write" corner case disappears —
  different podcaster, different file.
- Per-podcaster UX is clean: each podcaster @s their own assistant,
  doesn't know other podcasters exist. The operator sees the fleet.
- Debugging is per-agent: each has its own chat log, its own memory,
  its own MEMORY.md.

**Cost:**
- Provisioning each new agent is a Slock UI click (admin-only action,
  agents can't self-spawn). The dispatcher skill drafts the action card
  so the click is one button.
- Skill code is shared across agents (same `podcastcut-skills/` repo
  mounted) — no copy-paste, but if an agent's workspace is stale and
  the operator forgets to `git pull`, the agent runs old code. Soft
  problem; doc'd in dispatcher SKILL.md.

### Option 2 — single agent + sub-agents (rejected ✗)

Main @podcast-editor-agent stays as front door, spawns sub-agents per
incoming task.

**Why this loses:**
- Main agent IS the bottleneck. Wake-on-message is still serial; the
  spawn-fan-out happens inside the main agent's turn.
- Async sub-agents (background `run_in_background: true`) would need
  state persistence across the main agent's sleep cycles, Slock token
  inheritance, failure recovery. Substantial state machine.
- Main agent's context bloats with every podcaster's conversation
  history.
- Less isolation: bug in main agent affects everyone.

## How the per-podcaster agents share

| Layer | Shared? | Notes |
|---|---|---|
| Skill code (`podcastcut-skills/`) | shared | Same git checkout mounted into each agent's workspace |
| cloud-bridge server + tunnel | shared | One launchd job, all agents POST to it; sessions are token-isolated |
| `output/<episode>/` dirs | shared filesystem, per-episode isolation | Each podcaster's episodes live under their date-slug |
| `profiles/<podcast>.json` | per-podcast | One file per podcast, lives in `profiles/` |
| `eval/results.jsonl` | shared append-log | Per-podcast aggregation via the `profile_name` field added in PR #52 |
| Agent memory (`MEMORY.md`, notes/) | per-agent | Isolated by Slock agent workspace |

## The Slock constraint that shaped this

Per `slock knowledge get agent`:

> Agents can't create other agents directly. No `slock agent create` for
> new-agent provisioning. The agent can prepare an `agent:create` action
> card via `slock action prepare` for a human to commit.

So the dispatcher is **agent-draft + human-commit**: agent posts the
card with name + description, human clicks Create Agent, picks Computer
/ Runtime / Model (agent can't prefill those), submits. ~5 seconds of
operator time per spawn, no special tooling.

## Trigger

For the prototype we keep it explicit: operator says "为 X 创建一个 agent"
or runs `dispatcher/scripts/spawn_podcaster_agent.sh` directly. A future
iteration could detect "new DM from unknown handle" and propose the
spawn automatically, but that requires the dispatcher itself to be the
@podcast-editor-agent (or a separate @dispatcher agent), and to have
opinions about who counts as a podcaster — premature for N = 1.

## What we DON'T solve here

- Cross-agent learning: per-podcaster detector_overrides stay per
  podcast (which is correct). System-wide tuning (e.g. "all my podcasts
  agree consecutive_filler should be nerfed") would need a fleet-level
  signal — future.
- Auto-delete: Slock doesn't support `agent:delete` via action card.
  When a podcaster churns, the operator removes the agent in the UI.

## Marketing soundbites (operator-facing)

- "One agent per podcast — your fleet scales linearly, not your
  cognitive load."
- "Every podcast gets its own AI editor that remembers only that
  podcast."
