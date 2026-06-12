# profiles/

Per-podcast configuration + accumulated learning.

## Files

For each podcast `<name>`:

| File | Owner | Purpose |
|---|---|---|
| `<name>.json` | onboarding-chat | static config (tone, hosts, glossary, default_aggressiveness) |
| `<name>.detector_overrides.json` (optional) | self-iterating loop (Stage 2, 精剪 only) | per-podcast detector enable/disable from accumulated retention metrics. See `notes/2026-06-03_self-iterating-product-loop.md` |
| `<name>.roughcut.lessons.jsonl` (optional) | agent (after each commit) | qualitative 粗剪 learnings, append-only |
| `<name>.fine.lessons.jsonl` (optional) | agent (after each commit) | qualitative 精剪 learnings, append-only |

The two `.lessons.jsonl` files are loaded by `eval/load_lessons.js` and injected into the LLM prompt at the start of stage-2 LLM analysis (see `粗剪/SKILL.md § "历史课加载"` and `精剪/SKILL.md § "fine 历史课"`).

## lessons.jsonl 字段约定

Each line is a complete JSON object. Append only; never edit or reorder existing lines.

```jsonl
{"id":"L001","scope":"roughcut","rule":"嘉宾用类比/故事讲观点 → KEEP，别标 chit_chat","evidence_episodes":["EP23"],"evidence_indices":[[271,281],[506,515]],"source":"ivy_commit_diff","added_at":"2026-06-12T13:35:00Z","weight":1.0}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique within file. Convention: L001-L999 for 粗剪, F001-F999 for 精剪 |
| `scope` | yes | `"roughcut"` or `"fine"` |
| `rule` | yes | Single-sentence generalized rule, in Chinese, conjunction-free. The LLM reads this as a directive |
| `evidence_episodes` | recommended | Array of episode names where this pattern was observed |
| `evidence_indices` | recommended | Array of `[startIdx, endIdx]` sentence index ranges illustrating the pattern |
| `source` | yes | Where the lesson came from. One of: `ivy_commit_diff` (user committed roughcut/fine), `xiangge_fine_listen_diff` (user changed粗剪 during精剪 listening — higher signal), `meta` (agent-derived calibration rule), `manual` (user said "记一下..." in chat) |
| `weight` | yes | 1.0 = baseline, 1.5 = fine-listen-discovered (audio-aware), 2.0 = meta/cross-cutting rule |
| `added_at` | yes | ISO 8601 UTC timestamp |

## When agent appends a new lesson

After each roughcut/fine commit (extract → `delete_segments_*.json` written), agent:

1. Runs `eval/compare_roughcut.js` (or `compare.js` for fine) to see retention per type
2. Reads the diff: AI-marked-but-user-restored + user-marked-but-AI-missed
3. Looks for patterns (≥2 similar examples in same episode, OR ≥1 example of a previously hypothesized rule)
4. Drafts a generalized 1-sentence rule
5. Appends to the appropriate `.lessons.jsonl`

Manual override: user can say in chat "记一下：嘉宾 anecdote 别标 chit_chat" → agent extracts rule + appends with `source: "manual"`.

## Why two stage-specific files (not one)

粗剪 and 精剪 LLM prompts have different shapes:
- 粗剪 prompt is judgment-heavy (6 types of delete, content density assessment)
- 精剪 prompt is rule/clip-heavy (per-detector pattern matching against a checklist)

A rule like "嘉宾 anecdote 别标 chit_chat" is meaningless to the 精剪 LLM (which doesn't see chit_chat). A rule like "句首 '嗯对' 应删" is meaningless to the 粗剪 LLM. Keeping the files separate lets each prompt load only the lessons it can act on, without prompt bloat.

## Migrating from a single `.lessons.jsonl`

Earlier prototype used a single file with a `scope` field. To split:

```bash
cd profiles
for f in *.lessons.jsonl; do
  name="${f%.lessons.jsonl}"
  grep '"scope":"roughcut"' "$f" > "$name.roughcut.lessons.jsonl"
  grep '"scope":"fine"' "$f" > "$name.fine.lessons.jsonl"
  rm "$f"
done
```
