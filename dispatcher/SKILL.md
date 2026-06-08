---
name: podcastcut:dispatcher
description: |
  When the operator (xiangge-li) needs to spin up a dedicated agent for a new
  podcaster client, this skill drafts the `agent:create` action card so the
  operator commits the spawn under their own identity. Each podcaster gets
  their own @podcast-editor-<slug> with isolated workspace + memory.
  触发词：新 podcaster、给 X 创建一个 agent、spawn agent
---

# Dispatcher — per-podcaster agent provisioning

> Background: a single @podcast-editor-agent serializes all work — when
> podcaster A is mid-episode, podcaster B's message has to wait. Once we
> have N ≥ 2 podcasters, the right move is **one Slock agent per
> podcaster**: separate processes, separate memory, true parallelism.
> Detailed analysis in
> `notes/2026-06-04_multi-podcaster-agent-architecture.md`.

## When to invoke

- A new podcaster client joins the workspace and wants edits.
- The operator says "为 X 创建一个 agent" / "spawn 一个 agent 给 X".
- The operator decides an existing podcaster needs a dedicated agent
  separate from the shared @podcast-editor-agent.

If a podcaster only has one episode planned and the shared agent isn't
saturated, **just use the shared agent** — provisioning is reversible
later but does add an @-mention to remember.

## What it does

Wraps `slock action prepare --variant agent:create` so the operator
sees a one-click "Create Agent" card in chat with the right name +
description pre-filled. The operator clicks → standard Create Agent
dialog opens with prefilled values → operator picks Computer / Runtime
/ Model (agent can't prefill those) → submit.

Slock's design intentionally keeps human commit in the loop here —
admin-level identity actions don't get fully delegated to agents.
See [Action Cards](https://slock.dev/docs/action-cards) for why.

## Usage

```bash
bash "$SKILL_DIR/dispatcher/scripts/spawn_podcaster_agent.sh" \
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
bash dispatcher/scripts/spawn_podcaster_agent.sh \
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

## After spawn — what the new agent should do

Once the new `@podcast-editor-<slug>` boots, the operator should DM it
once to:

1. Copy or symlink the podcaster's `profile.<name>.json` into the new
   agent's workspace at a canonical path (e.g. `profile.json`) so
   `edit-chat/SKILL.md` finds it.
2. Confirm the agent has access to `cloud-bridge/` and the project
   `output/` dir (shared filesystem).
3. Have the podcaster DM the new agent directly going forward.

> Cross-agent coordination caveat: per-podcaster agents don't share
> memory. If you want them to learn from each other (e.g. detector
> tuning patterns generalising across podcasts), that's a future Stage
> 4 of the self-iterating loop — not in scope for this skill.

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
