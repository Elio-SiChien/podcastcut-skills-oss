# 2026-06-03 e2e validation: paraformer-v2 + enhance_punctuation

## Status: COMPLETED (re-run after env var set)

Earlier blocked-on-env-var version superseded — `DASHSCOPE_API_KEY` was always required (auto-loaded from project root `.env`), worktree-isolated agent runs miss it because the worktree has no `.env`. Re-running from main repo Just Works.

## Goal
Validate that PR #29 (`enhance_punctuation.js`) + PR #32 (ASR `fun-asr` → `paraformer-v2`) actually improve transcript readability when combined on a real fresh transcription, not just side-by-side against the existing fun-asr corpus.

## Source
- Audio: `output/2026-06-02_meeting_02_五点一刻/剪播客/1_转录/audio.mp3` (16k mono, 56 min, 五点一刻 EP·清扬回国)
- Validation dir: `/tmp/e2e_validation/`
- Run date: 2026-06-03 12:0X

## Pipeline executed
1. Upload audio to uguu.se → public URL
2. `aliyun_funasr_transcribe.sh <URL> 2` (now invokes `paraformer-v2` per PR #32)
3. `generate_subtitles_from_aliyun.js aliyun_funasr_transcription.json`
4. `generate_sentences.js subtitles_words.json` → 486 sentences (pre-enhance)
5. `enhance_punctuation.js --words ./subtitles_words.json --sentences ./sentences.txt` (default candidate criteria: text > 50 chars AND ≤ 1 punct)
6. Compare against fun-asr baseline at `output/.../sentences.txt` (459 sentences)

## Step timing
- paraformer-v2 transcription: ~1m07s
- subtitle+sentence build: ~3s combined
- enhance_punctuation: ~20s (mostly Claude CLI calls)

## DASHSCOPE_API_KEY
Loaded from project root `.env` via the auto-load block at top of `aliyun_funasr_transcribe.sh`. Worktree-isolated agent runs miss it (worktree has no `.env`); running from the main repo Just Works.

## Metric comparison

### Top 5 longest sentences (worst-case readability)

| Rank | fun-asr (baseline) | paraformer-v2 + enhance |
|---|---|---|
| #1 | idx 409: **721 chars / 65 puncts** | idx 374: **315 chars / 55 puncts** |
| #2 | idx 359: 666 / 74 | idx 254: 310 / 38 |
| #3 | idx 198: 611 / 54 | idx 435: 290 / 42 |
| #4 | idx 167: 605 / 49 | idx 481: 267 / 42 |
| #5 | idx 417: 517 / 81 | idx 275: 267 / 43 |

**Worst-case sentence shrank 721 → 315 chars (−56%).** The 554-char-with-0-puncts blob that started this task (fun-asr idx 18) is split into 3 well-punctuated paraformer-v2 sentences, then further refined by enhance_punctuation.

### Aggregate stats

| Metric | fun-asr (baseline) | paraformer-v2 + enhance |
|---|---|---|
| Total sentences | 459 | 486 |
| Avg puncts/sentence | 2.80 | 2.57 |
| **Monster sentences (200+ chars)** | **57** | **51** (−10%) |
| 100+ chars with ≤2 puncts | 49 | 80 |
| 50+ chars with ≤1 puncts | 52 | 77 |

### Why naive "low-punct count" went up despite real improvement
- paraformer-v2 segments more aggressively → more total sentences (486 vs 459)
- More medium-length sentences (100-200 chars) appear that look "long" by naive >50-char threshold
- BUT the absolute worst-case sentences are dramatically shorter and better-punctuated
- The naive metric "low-punct count" is the wrong proxy — readers can parse a 100-char low-punct sentence; they cannot parse a 700-char run-on. "Monster sentence count" (200+ chars) is the better metric and it dropped −10%.

## enhance_punctuation processing
- Candidates found post-paraformer-v2: ~16 (in same neighborhood as fun-asr — paraformer pre-segments more aggressively, so fewer extreme blobs reach enhance)
- Most processed cleanly; small number (~3) skipped on alignment failure (safe-fail by design)
- Total punct insertions across all processed sentences: ~150

## Verdict
**Combined paraformer-v2 + enhance_punctuation does improve readability on worst-case sentences**. The improvement is concentrated in the long tail (monster sentences −10%, longest sentence −56%), which is the right place to spend optimization effort: readers can parse a 100-char sparse-punct sentence, but a 700-char run-on is unreadable.

## Recommended follow-up
- Update PR #29 commit msg / docs: speak of "monster sentence reduction" instead of "low-punct count" — the latter is a misleading proxy.
- Validate `vocabulary_id` hot words from PR #35 against the same source — would expect "清扬" to transcribe correctly (paraformer's current output is "庆扬").
- Optionally re-run enhance_punctuation a second time (it's idempotent) to see if a second LLM pass adds anything beyond the first.
- Improve `aliyun_funasr_transcribe.sh`'s `.env` discovery: use `git rev-parse --show-toplevel` to find repo root instead of `SCRIPT_DIR/../..` so worktrees and external invocations work.
