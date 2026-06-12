# Fresh Agent Onboarding

This repo is a Claude Code Skills-based podcast editing pipeline. A fresh agent should first prove the local machine and project state are sane before reading the long stage runbooks.

## First Five Minutes

```bash
git clone https://github.com/luoyuweidu1/podcastcut-skills.git
cd podcastcut-skills
npm install
npm run doctor
npm test
```

If Python audio dependencies live in a virtualenv, point `doctor` at it:

```bash
PYTHON=.venv/bin/python npm run doctor
```

`doctor` is allowed to warn about runtime-only setup such as `DASHSCOPE_API_KEY`, `cloudflared`, or the current tunnel URL. Required failures mean the agent should stop and fix the local machine before editing a real episode.

## Main Entry Points

| Command | Purpose |
|---------|---------|
| `npm run doctor` | Check local machine prerequisites and runtime configuration. |
| `npm test` | Run offline regression tests. No network or API key required. |
| `npm run status -- [BASE_DIR]` | Print the current or specified project's pipeline state from `project.json`. |
| `npm run validate -- [BASE_DIR] [STAGE]` | Check that the files needed for a stage are present. |

If `BASE_DIR` is omitted, `status` and `validate` read `output/.current_project` and resolve it to `output/<project>/剪播客`.

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

For chat-mode orchestration, read `edit-chat/SKILL.md` after the self-check commands pass.

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

- Work in the project `剪播客/` directory, not the repo root.
- Keep generated episode artifacts under `output/`; it is intentionally ignored by git.
- When a stage pauses for human review, report the review URL or exact file path and stop that stage.
- If cloud-bridge is unavailable, fix or explicitly fall back before asking the user to move files manually.
- Update `project.json` when a stage changes state so `status` remains useful.
