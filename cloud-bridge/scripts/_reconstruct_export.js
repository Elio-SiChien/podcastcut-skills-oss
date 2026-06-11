#!/usr/bin/env node
/**
 * _reconstruct_export.js — internal helper for extract_commit_to_export.sh.
 *
 * Takes a cloud-bridge session commit and writes the canonical
 * delete_segments_{roughcut,edited}.json that cut_audio.py + eval/compare.js
 * + edit-chat 阶段 6 all expect.
 *
 * usage:
 *   node _reconstruct_export.js <meta.json> <state.committed.json> <stage>
 *
 * stage = "roughcut" | "fine"
 *
 * Output path is printed on stdout. Errors go to stderr with non-zero exit.
 *
 * Why this exists: the cloud-bridge commit POST in review.html's
 * setupCloudBridge() only sends {sentence_deletes, partial_deletes, fdis,
 * rdExp}. The doExport()-computed segments[] array (which cut_audio.py
 * actually reads) is *not* in the commit blob. We rebuild it here from
 * fine_analysis.json + the per-edit fdis toggles.
 *
 * Ord assignment matches generate_review.js (shared/scripts/generate_review.js
 * around line 270): for each fine edit in file order, increment a per-
 * sentenceIdx counter starting at 1. The fdis key format is `${idx}@${ord}`.
 *
 * Merge tolerance 0.05s matches doExport() in shared/templates/review.html
 * (around line 1431) — kept tight on purpose so a self_correction keepText
 * sandwiched between two stutter deletes doesn't get swallowed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const [, , metaPath, commitPath, stage] = process.argv;

if (!metaPath || !commitPath || !stage) {
  console.error('usage: node _reconstruct_export.js <meta.json> <state.committed.json> <stage>');
  process.exit(2);
}
if (stage !== 'roughcut' && stage !== 'fine') {
  console.error(`error: stage must be 'roughcut' or 'fine' (got '${stage}')`);
  process.exit(2);
}

const meta = readJson(metaPath);
const state = readJson(commitPath);

if (!meta.base_dir) {
  console.error('error: meta.json has no base_dir');
  process.exit(1);
}

const isFine = stage === 'fine';
const filenameStage = isFine ? 'edited' : 'roughcut';
const versionTag = isFine ? 'edited_v1' : 'roughcut_v1';

const analysisDir = path.join(meta.base_dir, '2_分析');
const sentencesPath = path.join(analysisDir, 'sentences.txt');
const wordsPath = path.join(meta.base_dir, '1_转录', 'subtitles_words.json');
const finePath = path.join(analysisDir, 'fine_analysis.json');

// Sentence timing — needed in both stages to turn integer sentence_deletes
// into [start, end] ranges (review.html does the same in doExport).
const sentByIdx = loadSentenceTimes(sentencesPath, wordsPath);

const sentenceDeletes = Array.isArray(state.sentence_deletes) ? state.sentence_deletes : [];
const partialDeletes = (state.partial_deletes && typeof state.partial_deletes === 'object')
  ? state.partial_deletes : {};
const fdis = new Set(Array.isArray(state.fdis) ? state.fdis : []);

// Active fine_edits live with proper idx + ord (only meaningful in fine stage).
let activeFineEdits = [];
let segmentsFromFine = [];
if (isFine) {
  // User-kept sentences (idx NOT in fine sentence_deletes) — used to drop stale
  // silence_merged edits that were generated against the older roughcut.
  const sentenceDeletesSet = new Set(sentenceDeletes);
  const keptRanges = buildKeptSentenceRanges(sentByIdx, sentenceDeletesSet);
  const rebuilt = rebuildActiveFineEdits(finePath, fdis, keptRanges);
  activeFineEdits = rebuilt.activeEdits;
  segmentsFromFine = rebuilt.ranges;
  if (rebuilt.staleSilenceDropped > 0) {
    console.error(`[_reconstruct_export] dropped ${rebuilt.staleSilenceDropped} stale silence_merged/silence edits that fully contained user-kept sentences`);
  }
}

// Build the union of [start, end] ranges that need to be cut from the audio.
//   - sentence_deletes  → whole-sentence ranges
//   - partial_deletes   → user-drawn intra-sentence ranges
//   - fine_edits        → AI edits the user didn't toggle off
//
// If the client already POSTed a non-empty segments[] (future enhancement
// when review.html starts forwarding doExport's output), trust it verbatim
// and skip the rebuild — keeps a path forward for fixing the POST side
// without re-shipping this script.
let segments;
if (Array.isArray(state.segments) && state.segments.length > 0) {
  segments = normaliseSegments(state.segments);
} else {
  const rawRanges = [];
  // Sentence_deletes: walk in index order. When consecutive deleted sentences
  // are also adjacent in INDEX (i, i+1), merge them as one range covering
  // [first.start, last.end] — this absorbs the inter-sentence silence gap
  // between them. Without this, gaps (3-5s of silence/breath/laughter) leak
  // into the output as kept audio. Bug surfaced on 支无不言 EP23: 59 gaps
  // totalling ~54s leaked, audible as the "laughter/碎音" at the very start.
  // tolerance-based merge in mergeRanges() can't fix this because gaps are
  // 0.5-5s wide, far above any sane audio-time tolerance.
  const sortedDel = sentenceDeletes.slice().sort((a, b) => a - b);
  let runStart = null;
  let runEnd = null;
  let runStartIdx = null;
  let lastIdx = null;
  for (const i of sortedDel) {
    const meta = sentByIdx.get(i);
    if (!meta) continue;
    if (runStart == null) {
      runStart = meta.start;
      runEnd = meta.end;
      runStartIdx = i;
      lastIdx = i;
      continue;
    }
    if (i === lastIdx + 1) {
      // Adjacent sentence index → extend the run to include this sentence's
      // end, absorbing the gap between lastIdx.end and meta.start.
      runEnd = meta.end;
      lastIdx = i;
    } else {
      rawRanges.push([runStart, runEnd]);
      runStart = meta.start;
      runEnd = meta.end;
      runStartIdx = i;
      lastIdx = i;
    }
  }
  if (runStart != null) rawRanges.push([runStart, runEnd]);

  for (const sIdxKey of Object.keys(partialDeletes)) {
    const sIdx = Number(sIdxKey);
    if (sentenceDeletes.includes(sIdx)) continue;
    const arr = partialDeletes[sIdxKey];
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (r && r.s != null && r.e != null) rawRanges.push([r.s, r.e]);
      else if (Array.isArray(r) && r.length >= 2) rawRanges.push([r[0], r[1]]);
    }
  }
  for (const r of segmentsFromFine) rawRanges.push(r);
  segments = mergeRanges(rawRanges, 0.05);
  if (segments.length > 0 && segments[0].start < 5) segments[0].start = 0;
}

const removed = segments.reduce((s, x) => s + (x.end - x.start), 0);
const totalDur = inferTotalDuration(wordsPath, state);
const out = {
  version: versionTag,
  exported_at: new Date().toISOString(),
  original_duration: Number(state.original_duration) || Math.round(totalDur),
  roughcut_duration: Number(state.roughcut_duration) || Math.max(0, Math.round(totalDur - removed)),
  removed_duration: Number(state.removed_duration) || Math.round(removed),
  segments,
  sentence_deletes: sentenceDeletes,
  partial_deletes: partialDeletes,
};
if (isFine) {
  out.fine_edits = activeFineEdits;
}

fs.mkdirSync(analysisDir, { recursive: true });
const outPath = path.join(analysisDir, `delete_segments_${filenameStage}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
process.stdout.write(outPath);

// ──────────────── helpers ────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`error: cannot read ${p}: ${e.message}`); process.exit(1); }
}

function loadSentenceTimes(sentencesPath, wordsPath) {
  const m = new Map();
  if (!fs.existsSync(sentencesPath) || !fs.existsSync(wordsPath)) return m;
  const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const actual = words.filter(w => !w.isGap && !w.isSpeakerLabel);
  const lines = fs.readFileSync(sentencesPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const idx = parseInt(parts[0], 10);
    const [a, b] = parts[1].split('-').map(Number);
    if (!Number.isFinite(idx) || !actual[a] || !actual[b]) continue;
    m.set(idx, { start: actual[a].start, end: actual[b].end });
  }
  return m;
}

// Compute the time ranges of sentences the user committed as kept (i.e. NOT in
// final sentence_deletes). Stale silence_merged edits generated by
// merge_llm_fine.js before the user reverted some sentences in fine review
// will fully contain these kept ranges — we filter them out below.
//
// Background: merge_llm_fine reads delete_segments_roughcut.json for "deleted
// regions" and emits silence_merged edits bridging adjacent deleted sentences.
// If the user later reverts some sentences in fine review, the silence_merged
// is stale: it still spans across the now-user-kept sentence, telling
// cut_audio to delete it. Fix at export time: drop any silence_merged/silence
// edit whose [ds, de] fully contains a sentence that's user-kept in the
// committed fine sentence_deletes.
function buildKeptSentenceRanges(sentByIdx, sentenceDeletesSet) {
  const ranges = [];
  for (const [idx, meta] of sentByIdx) {
    if (sentenceDeletesSet.has(idx)) continue;
    ranges.push({ idx, start: meta.start, end: meta.end });
  }
  return ranges;
}

function editSwallowsKeptSentence(ds, de, keptRanges) {
  // FULLY contains a kept sentence — i.e., edit range includes the sentence's
  // entire start..end. 0.05s slack accommodates ASR timestamp fuzz at sentence
  // boundaries.
  for (const r of keptRanges) {
    if (ds <= r.start + 0.05 && de >= r.end - 0.05) return r.idx;
  }
  return null;
}

function rebuildActiveFineEdits(finePath, fdis, keptRanges) {
  if (!fs.existsSync(finePath)) {
    console.error(`warning: ${finePath} missing — fine_edits will be empty`);
    return { activeEdits: [], ranges: [], staleSilenceDropped: 0 };
  }
  const fa = JSON.parse(fs.readFileSync(finePath, 'utf8'));
  const edits = (fa.fine_edits || fa.edits || []).concat(fa.extraFineEdits || []);
  const ordBySent = {};
  const activeEdits = [];
  const ranges = [];
  let staleSilenceDropped = 0;
  for (const ed of edits) {
    if (ed.sentenceIdx == null) continue;
    const ord = (ordBySent[ed.sentenceIdx] = (ordBySent[ed.sentenceIdx] || 0) + 1);
    const key = `${ed.sentenceIdx}@${ord}`;
    if (fdis.has(key)) continue;
    const ds = ed.deleteStart != null ? ed.deleteStart : ed.ds;
    const de = ed.deleteEnd != null ? ed.deleteEnd : ed.de;
    if (ds == null || de == null) continue;
    // Drop silence_merged/silence edits that fully contain a user-kept sentence
    // (stale edit from roughcut-based gap cleanup; user reverted the sentence
    // in fine review but the silence_merged didn't get re-evaluated).
    const isSilenceType = ed.type === 'silence_merged' || ed.type === 'silence';
    if (isSilenceType && keptRanges) {
      const swallowedKept = editSwallowsKeptSentence(ds, de, keptRanges);
      if (swallowedKept != null) {
        staleSilenceDropped++;
        continue;
      }
    }
    activeEdits.push({
      idx: ed.sentenceIdx,
      sentenceIdx: ed.sentenceIdx,
      ord,
      type: ed.type || 'unknown',
      s: ds,
      e: de,
      deleteText: ed.deleteText || '',
    });
    ranges.push([ds, de]);
  }
  return { activeEdits, ranges, staleSilenceDropped };
}

function mergeRanges(ranges, tolerance) {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = { start: sorted[0][0], end: sorted[0][1] };
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r[0] - cur.end < tolerance) {
      if (r[1] > cur.end) cur.end = r[1];
    } else {
      out.push(cur);
      cur = { start: r[0], end: r[1] };
    }
  }
  out.push(cur);
  return out;
}

function normaliseSegments(segs) {
  return segs.map(s => {
    if (Array.isArray(s) && s.length >= 2) return { start: s[0], end: s[1] };
    if (s && s.start != null && s.end != null) return { start: s.start, end: s.end };
    return null;
  }).filter(Boolean);
}

function inferTotalDuration(wordsPath, state) {
  if (Number.isFinite(state.original_duration) && state.original_duration > 0) {
    return Number(state.original_duration);
  }
  if (!fs.existsSync(wordsPath)) return 0;
  try {
    const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
    const actual = words.filter(w => !w.isGap && !w.isSpeakerLabel);
    if (actual.length === 0) return 0;
    return actual[actual.length - 1].end;
  } catch { return 0; }
}
