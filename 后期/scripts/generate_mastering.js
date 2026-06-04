#!/usr/bin/env node
/**
 * generate_mastering.js — bake the mastering review HTML for one episode.
 *
 * Reads:
 *   - sentences.txt (剪播客 transcript output) → renders the quote-pick list
 *   - subtitles_words.json (剪播客 transcript output) → sentence-level start/end times
 *   - profile.json (optional) → for episode title
 *
 * Writes:
 *   - <out>/mastering.html with __SENTENCES_DATA__ / __SUGGESTED_DATA__ /
 *     __TITLE__ / __BASE_DIR__ / __AUDIO_SRC__ inlined
 *
 * Suggested-quote heuristic (3 sentences):
 *   The goal is just to give the user a *starting point* — they can always
 *   tweak. So we use a simple, transparent scoring rule rather than an LLM:
 *
 *     - sentence length between 12 and 80 chars (one-breath punchline, not
 *       a long ramble)
 *     - contains at least one signal word: 其实 / 真的 / 最 / 觉得 / 重要 /
 *       关键 / 决定 / 一定 / 永远 / 难 / 但是 / 不过 / 所以
 *     - has ? or ! or 。结尾 (terminal punctuation)
 *     - sentence is in the middle 60% of the episode (skip intro/outro
 *       prefab content)
 *
 *   Top 3 by score; ties broken by earliest position (so the first few
 *   suggestions feel chronological as a starting point).
 *
 * usage:
 *   node generate_mastering.js \
 *     --sentences <path>           sentences.txt
 *     --words <path>               subtitles_words.json
 *     --audio <path>               URL/path the page should stream from
 *     --output <path>              output HTML
 *     [--title "<text>"]           default: derived from base dir name
 *     [--base-dir <path>]          shown in topbar (informational)
 *
 *  Pure node, no npm deps.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sentences') out.sentences = argv[++i];
    else if (a === '--words') out.words = argv[++i];
    else if (a === '--audio') out.audio = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--base-dir') out.baseDir = argv[++i];
    else if (a === '--cuts') out.cuts = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('unknown arg: ' + a);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node generate_mastering.js --sentences <path> --words <path> --audio <path> --output <path>\n' +
    '                                  [--cuts delete_segments_edited.json]\n' +
    '                                  [--title <text>] [--base-dir <path>]\n' +
    '\n' +
    'When --cuts is given, sentences listed in sentence_deletes are dropped and\n' +
    'every kept sentence\'s start/end is remapped onto the final-cut audio timeline\n' +
    '(audio in --audio must be the cut output for click-to-play to line up).\n'
  );
}

// Snap t into the nearest kept frame, then map to the cut-audio timeline.
// Returns { t: number, snapped: boolean } or null if no kept frame exists
// (e.g., t is past the end of every segment in some degenerate case).
//
// Snapping rule: if t lies inside a cut segment, treat it as if the speaker
// resumes at seg.end (most podcast cuts are tiny stutter snips — snapping
// a sentence boundary 200 ms forward is invisible).
function remapTimeSnapped(t, segments) {
  let cumCut = 0;
  let snapped = false;
  for (const seg of segments) {
    if (seg.start >= t) break;        // future cuts don't shift this t
    if (seg.end <= t) {
      cumCut += seg.end - seg.start;  // fully past, subtract its width
      continue;
    }
    // t is inside this cut — snap to seg.end on the original timeline
    cumCut += seg.end - seg.start;
    t = seg.end;
    snapped = true;
  }
  return { t: Number((t - cumCut).toFixed(2)), snapped };
}

// Drop sentences whose idx is in sentence_deletes; remap kept sentences
// onto the cut-audio timeline; rebuild each kept sentence's visible text
// from only the words that survive the cut (so per-fine-edit phrase
// deletes like "多一点，这个多一点" → "多一点" are reflected in the
// displayed text, not just in the audio).
//
// `segments[]` in delete_segments_edited.json is the union of all cut
// sources (sentence_deletes, partial_deletes, fine_edits) — filtering
// words against it covers per-word fine-cut edits too.
function applyCuts(sentences, words, cutsPath) {
  const raw = JSON.parse(fs.readFileSync(cutsPath, 'utf8'));
  const segs = (raw.segments || [])
    .map(s => Array.isArray(s) ? { start: s[0], end: s[1] } : s)
    .filter(s => s && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const deletedSet = new Set((raw.sentence_deletes || []).map(Number));

  const out = [];
  let dropped = 0, snappedCount = 0, degenerate = 0, textTrimmed = 0;
  for (const s of sentences) {
    if (deletedSet.has(s.idx)) { dropped++; continue; }
    const a = remapTimeSnapped(s.start, segs);
    const b = remapTimeSnapped(s.end, segs);
    if (a.snapped || b.snapped) snappedCount++;
    if (b.t <= a.t) { degenerate++; continue; }
    const rebuilt = rebuildText(s, words, segs);
    const finalText = typeof rebuilt === 'string' ? rebuilt : rebuilt.text;
    if (typeof rebuilt === 'object' && rebuilt.dropped > 0) textTrimmed++;
    out.push({
      idx: s.idx,
      start: a.t,
      end: b.t,
      duration: Number((b.t - a.t).toFixed(2)),
      speaker: s.speaker,
      text: finalText,
      _orig_start: s.start,
      _orig_end: s.end,
    });
  }
  process.stderr.write(
    `   cut-aware: kept ${out.length}/${sentences.length} sentences ` +
    `(sentence_deletes: ${dropped}, snapped-boundary: ${snappedCount}, ` +
    `text-trimmed: ${textTrimmed}, degenerate: ${degenerate})\n`
  );
  return out;
}

function loadSentences(sentencesPath, wordsPath) {
  const rawWords = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const actual = rawWords.filter(w => !w.isGap && !w.isSpeakerLabel);
  const lines = fs.readFileSync(sentencesPath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const idx = parseInt(parts[0], 10);
    const [a, b] = parts[1].split('-').map(Number);
    if (!Number.isFinite(idx) || !actual[a] || !actual[b]) continue;
    out.push({
      idx,
      start: Number(actual[a].start.toFixed(2)),
      end: Number(actual[b].end.toFixed(2)),
      duration: Number((actual[b].end - actual[a].start).toFixed(2)),
      speaker: parts[2] || '',
      text: parts.slice(3).join('|'),
      // Kept for text reconstruction when --cuts is applied.
      word_range: [a, b],
    });
  }
  return { sentences: out, words: actual };
}

// Rebuild a sentence's visible text by skipping any words whose timing
// falls inside a cut segment. Preserves the original sentences.txt text
// when no word is affected (most sentences).
function rebuildText(sentence, words, segs) {
  const [a, b] = sentence.word_range || [];
  if (a == null || b == null) return sentence.text;
  let kept = '';
  let dropped = 0;
  for (let i = a; i <= b; i++) {
    const w = words[i];
    if (!w) continue;
    if (isInsideAny(w.start, w.end, segs)) { dropped++; continue; }
    kept += w.text;
  }
  return { text: kept || sentence.text, dropped };
}

function isInsideAny(s, e, segs) {
  for (const seg of segs) {
    if (seg.start >= e) break;
    if (seg.end <= s) continue;
    // overlap exists — count the word as cut if its centre is inside.
    // (Catch cases where the cut nicks a word's edge but lets most of it
    // through.) Using midpoint keeps us robust to small ASR boundary drift.
    const mid = (s + e) / 2;
    if (mid >= seg.start && mid < seg.end) return true;
  }
  return false;
}

// Lightweight punchline scoring — no LLM, fully reproducible.
function suggestQuotes(sentences, n) {
  const SIGNALS = ['其实','真的','最','觉得','重要','关键','决定','一定','永远','难','但是','不过','所以','发现','改变'];
  const totalDur = sentences.length > 0 ? sentences[sentences.length - 1].end : 0;
  const lo = totalDur * 0.20, hi = totalDur * 0.85;
  const scored = sentences.map(s => {
    let score = 0;
    const len = [...s.text].length; // char count, not byte count
    if (len >= 12 && len <= 80) score += 2;
    else if (len > 80) score += 0;
    else score -= 1;
    for (const w of SIGNALS) if (s.text.includes(w)) { score += 1; break; }
    if (/[？！]$/.test(s.text)) score += 1;
    if (s.duration >= 4 && s.duration <= 25) score += 1;
    if (s.start < lo || s.end > hi) score -= 2;
    return { idx: s.idx, score, start: s.start };
  });
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  return scored.slice(0, n).map(x => x.idx);
}

function main() {
  let args;
  try { args = parseArgs(process.argv); }
  catch (e) { process.stderr.write('error: ' + e.message + '\n'); usage(); process.exit(2); }
  if (args.help || !args.sentences || !args.words || !args.audio || !args.output) {
    usage(); process.exit(args.help ? 0 : 2);
  }

  const loaded = loadSentences(args.sentences, args.words);
  let sentences = loaded.sentences;
  if (args.cuts) {
    if (!fs.existsSync(args.cuts)) {
      process.stderr.write(`error: --cuts file not found: ${args.cuts}\n`);
      process.exit(1);
    }
    sentences = applyCuts(sentences, loaded.words, args.cuts);
  }
  const suggested = suggestQuotes(sentences, 3);

  const tmplPath = path.join(__dirname, '..', 'templates', 'mastering.html');
  let html = fs.readFileSync(tmplPath, 'utf8');

  const baseDir = args.baseDir || path.dirname(path.resolve(args.output));
  // Episode name: parent dir of base_dir is typically the date-slug folder
  // (e.g. `output/2026-06-02_meeting_02_五点一刻/剪播客`). Strip the date
  // prefix for the sidebar headline so the name reads naturally.
  const baseFolderName = path.basename(path.resolve(baseDir, '..'));
  const episodeName = baseFolderName.replace(/^\d{4}-\d{2}-\d{2}[_-]?/, '') || baseFolderName;
  const title = args.title || ('后期 · ' + episodeName);
  // Sidebar `proj` short label — last two path segments only.
  const segs = baseDir.split(path.sep).filter(Boolean);
  const baseDirShort = segs.slice(-2).join('/');

  html = html.replace(/__SENTENCES_DATA__/g, JSON.stringify(sentences))
             .replace(/__SUGGESTED_DATA__/g, JSON.stringify(suggested))
             .replace(/__TITLE__/g, escapeHtml(title))
             .replace(/__EPISODE_NAME__/g, escapeHtml(episodeName))
             .replace(/__BASE_DIR_SHORT__/g, escapeHtml(baseDirShort))
             .replace(/__AUDIO_SRC__/g, escapeAttr(args.audio));

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, html);
  process.stderr.write(`✅ wrote ${args.output} (${sentences.length} sentences, suggested ${suggested.length} quotes: ${suggested.join(', ')})\n`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }

main();
