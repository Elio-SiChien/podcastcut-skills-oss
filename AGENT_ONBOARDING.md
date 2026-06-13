# Fresh Agent Onboarding

This repo is a Claude Code Skills-based podcast editing pipeline. A fresh agent should first identify its role, then prove the installed snapshot and local project state are sane before reading the long stage runbooks.

## First Five Minutes

For a dev or infra agent working in the repo:

```bash
git clone https://github.com/luoyuweidu1/podcastcut-skills.git
cd podcastcut-skills
npm install
npm run doctor
npm test
```

For a newly spawned runtime agent after `安装/install.sh` has been run:

```bash
npm run fresh-agent -- --role podcast
# or
npm run fresh-agent -- --role dispatcher
```

`npm run doctor -- --fresh-agent --role podcast` is equivalent if you want one doctor-style entrypoint. If Python audio dependencies live in a virtualenv, point `doctor` at it:

```bash
PYTHON=.venv/bin/python npm run doctor
```

`doctor` is allowed to warn about runtime-only setup such as `DASHSCOPE_API_KEY`, `cloudflared`, or the current tunnel URL. Required failures mean the agent should stop and fix the local machine before editing a real episode.

## Pick The Right Role

| Role | Use when | Read first | Do not do |
|------|----------|------------|-----------|
| Dev / infra agent | You are changing this repo, opening PRs, or debugging shared scripts. | `AGENT_ONBOARDING.md`, then the files you are editing. | Do not edit installed snapshots directly. |
| Dispatcher / shared agent | The operator asks you to create or route a dedicated per-podcast agent. | `dispatcher/SKILL.md` | Do not run the edit-chat episode pipeline. |
| Per-podcast editing agent | You are dedicated to one podcast and should help a user finish episodes end to end. | Installed `podcastcut-edit-chat/SKILL.md` | Do not use a random dev repo checkout as your runtime source. |

For per-podcast agents, the installed skill snapshot is the source of truth. Resolve it before running snippets:

```bash
SKILL_DIR="$(readlink -f ~/.claude/skills/podcastcut-edit-chat)"
```

For dispatcher agents:

```bash
SKILL_DIR="$(readlink -f ~/.claude/skills/podcastcut-dispatcher)"
```

Do not `cd` into a cloned dev repo just because it exists in your workspace. The dev repo can be on a PR branch; installed skills are intentionally snapshotted so runtime behavior does not drift with development work.

## Main Entry Points

| Command | Purpose |
|---------|---------|
| `npm run doctor` | Check local machine prerequisites and runtime configuration. |
| `npm run footer -- [BASE_DIR] [COMPLETED_STAGE]` | Render the standard checkpoint footer for customer-facing updates. |
| `npm run fresh-agent -- --role podcast` | Check installed snapshot, edit-chat skill, profile, output dir, and cloud-bridge readiness. |
| `npm run fresh-agent -- --role dispatcher` | Check installed snapshot, dispatcher skill, output dir, and cloud-bridge visibility. |
| `npm test` | Run offline regression tests. No network or API key required. |
| `npm run status -- [BASE_DIR]` | Print the current or specified project's pipeline state from `project.json`. |
| `npm run validate -- [BASE_DIR] [STAGE]` | Check that the files needed for a stage are present. |

If `BASE_DIR` is omitted, `status` and `validate` read `output/.current_project` and resolve it to `output/<project>/剪播客`.

## Installed Snapshot Checklist

Runtime agents should be able to answer these from one command:

```bash
npm run fresh-agent -- --role podcast
```

Expected installed paths:

```text
~/.claude/skills/
├── podcastcut-shared/
│   ├── install_manifest.json
│   ├── QUICKSTART_AGENT.md
│   └── scripts/
├── podcastcut-edit-chat/
│   ├── SKILL.md
│   ├── shared -> ../podcastcut-shared
│   └── output -> <configured output dir>
├── podcastcut-dispatcher/
├── cloud-bridge/
│   ├── scripts/
│   └── current_tunnel_url.txt   # runtime file, may be absent until launchd/manual tunnel writes it
└── profiles/
    └── <podcast>.json
```

`install_manifest.json` is the debug anchor. If behavior looks stale, report its `git_commit`, `git_branch`, `git_dirty`, and `installed_at` instead of guessing which repo checkout is active.

## Profiles

Installed runtime profile location is:

```text
~/.claude/skills/profiles/<podcast>.json
```

Per-podcast agents should normally have exactly one `*.json` profile there. If none exist, run or ask for onboarding before starting a real episode. If multiple profiles exist, ask the operator/user which podcast this episode belongs to before continuing.

The repo's `profiles/` directory is documentation and templates for development. Runtime agents should read the installed `~/.claude/skills/profiles/` directory.

## Cloud-Bridge

Review pages and upload pages should use cloud-bridge by default. A fresh per-podcast agent should check:

```bash
npm run fresh-agent -- --role podcast
```

Fallback order when the tunnel URL is missing or stale:

1. If `~/.claude/skills/cloud-bridge/current_tunnel_url.txt` exists and the URL responds, use it.
2. If the file exists but the URL is stale, ask the operator for the current cloudflared URL and write it back to that file.
3. If the file is missing, ask the operator for the current URL or have them install/start the launchd tunnel.
4. Use `file://` review pages only when the user explicitly declines cloud-bridge or the tunnel cannot be restored.

Agents should not silently default to `file://`; that breaks the browser commit flow and makes users shuttle JSON manually.

## Pipeline Shape

The normal episode flow is:

```text
transcribe -> roughcut -> fine -> execute -> qa -> audio_quality -> post
```

Stage docs live in the matching skill directories:

| Stage | Skill doc |
|-------|-----------|
| transcribe | `转录/SKILL.md` |
| roughcut | `粗剪/SKILL.md` |
| fine | `精剪/SKILL.md` |
| execute | `执行/SKILL.md` |
| qa | `质检/SKILL.md` |
| audio_quality | `音质处理/SKILL.md` |
| post | `后期/SKILL.md` |

Per-podcast chat-mode agents normally start with `edit-chat/SKILL.md`, then let that skill route into stage docs. Dispatcher agents normally never read or run stage docs.

## Required Project Layout

A project base dir is the `剪播客/` directory:

```text
output/<project-id>/剪播客/
├── project.json
├── 1_转录/
│   ├── audio_original.<ext>
│   ├── audio_seekable.mp3
│   ├── speaker_mapping.json
│   └── subtitles_words.json
├── 2_分析/
│   ├── sentences.txt
│   ├── semantic_deep_analysis.json
│   ├── fine_analysis.json
│   └── delete_segments_edited.json
└── 3_成品/
    └── <episode>.m4a
```

Use `npm run validate -- <BASE_DIR> <STAGE>` before invoking a stage. Treat missing required files as a contract failure, not as something to paper over in prose.

## ASR Contract

The current transcription default is DashScope `paraformer-v2` with `timestamp_alignment_enabled: true`. Do not switch models or disable alignment without a word-level timestamp validation run. The offline guard is `shared/scripts/tests/test_asr_model.sh`.

## Handoff Rules

- Work in the installed skill/project `剪播客/` runtime paths, not a dev repo root.
- Keep generated episode artifacts under `output/`; it is intentionally ignored by git.
- When a stage pauses for human review, report the review URL or exact file path and stop that stage.
- If cloud-bridge is unavailable, follow the fallback order above before asking the user to move files manually.
- Update `project.json` when a stage changes state so `status` remains useful.
