# eval/

Tooling to track AI-vs-user diff across episodes so we can tell whether a
detector change (e.g. an `in_sentence_repeat` nerf) actually improved things
on real data, and catch regressions before they ship.

## Quick start

```bash
node eval/compare.js \
  --ai   output/<episode>/剪播客/2_分析/fine_analysis.json \
  --user /path/to/delete_segments_edited.json \
  --episode-name <slug> \
  --save
```

What happens:

1. Prints a per-type retention table (markdown) to stdout.
2. Appends a JSON record to `eval/results.jsonl`
   (one line per run, ever — this is the longitudinal store).
3. With `--save`, writes the same markdown to
   `eval/reports/<episode-name>-<YYYY-MM-DD>.md`.

Pure node, no npm deps.

## What the metrics mean

For each AI edit type (`stutter`, `filler_start`, `silence_merged`,
`in_sentence_repeat`, …) we count:

| metric | meaning |
|---|---|
| `total` | AI's edits of this type in `fine_analysis.json` (post-merge, post-refine). |
| `TP` (kept) | AI edit the user kept in their exported `fine_edits`. |
| `FN`/`FP` (restored) | AI edit the user disabled (restored the original audio). |
| `retention` | `TP / total` — what fraction of the AI's calls the user agreed with. |
| `precision` | `TP / (TP + FP)`. |
| `recall` | `TP / (TP + FN)`. |
| `F1` | `2·P·R / (P+R)`. |

> **Why precision == recall here.** The user cannot author a new `fine_edit`
> of an AI type — the cloud-bridge review UI only lets them toggle existing
> AI edits on/off. Anything the user adds shows up as `partial_deletes`
> (intra-sentence char-range deletes) or `sentence_deletes` (whole-sentence
> deletes). So in this setup `FP == FN`, and precision, recall, and
> retention collapse to the same number. They are still listed separately so
> the column stays meaningful if/when we extend the comparison to AI types
> the user can directly produce.

### User-added deletions

`partial_deletes` and `sentence_deletes` are reported separately as
"user-added". These are the rule layer's misses — places the AI didn't flag
that the user thought needed cutting. Watching this number drop is a strong
signal that the AI's coverage is improving.

### Join key

`(sentenceIdx, type, ord)` where `ord` is the 1-based rank of the edit
within its sentence, sorted by `deleteStart`. The user export already
carries `ord` per fine_edit; we re-derive it on the AI side. This matches
the cloud-bridge exporter's convention.

A tiny number of edits (typically 0–2 per episode) drift — usually
`silence_merged` that sits on a sentence boundary and ord-shifts by one.
These are reported as `user-side fine_edits with no AI match` in the
Diagnostics section. They are noise for now; treat them as 0 TPs / 0 FNs.

## Adding a new episode to the eval set

1. Have the user open the AI's `review_enhanced.html` in cloud-bridge,
   review, and export `delete_segments_edited.json`.
2. Drop the export into `eval/seed/<episode>_user_finecut_v<N>.json`
   so the run is reproducible without `/tmp`.
3. Run with `--save`. Commit both the seed file and the generated report.
4. The longitudinal log in `eval/results.jsonl` will gain one more line —
   that's the file you grep over to compare detector versions across
   episodes (e.g. `jq 'select(.episode_name=="meeting_02_五点一刻") | .per_type.in_sentence_repeat'`).

## Seed: `meeting_02_五点一刻` (2026-06-02)

Reproduce the seed run:

```bash
node eval/compare.js \
  --ai   output/2026-06-02_meeting_02_五点一刻/剪播客/2_分析/fine_analysis.json \
  --user eval/seed/meeting_02_user_finecut_v48.json \
  --episode-name meeting_02_五点一刻 \
  --save
```

Headline numbers (full table in
`eval/reports/meeting_02_五点一刻-2026-06-03.md`):

| type | retention |
|---|---:|
| silence | 100% |
| silence_merged | ~99% (1 ord-edge) |
| self_correction_rules | 100% |
| filler_start | 98% |
| stutter | 87% |
| consecutive_filler | 56% |
| **in_sentence_repeat** | **7%** |
| overall | 89% |

`in_sentence_repeat` is the obvious nerf target — sibling PR addresses it,
and re-running this script after that PR ships should bump the number
sharply without dragging other types down.

`consecutive_filler` at 56% is the next-largest leak after the
`in_sentence_repeat` fix lands.
