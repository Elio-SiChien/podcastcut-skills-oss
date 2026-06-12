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
const { spawnSync } = require('child_process');

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
    else if (a === '--n') out.n = argv[++i];
    else if (a === '--no-llm') out.noLlm = true;
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
    '                                  [--n 8]            number of quote candidates (default 8)\n' +
    '                                  [--no-llm]         skip Claude CLI, use heuristic only\n' +
    '\n' +
    'When --cuts is given, sentences listed in sentence_deletes are dropped and\n' +
    'every kept sentence\'s start/end is remapped onto the final-cut audio timeline\n' +
    '(audio in --audio must be the cut output for click-to-play to line up).\n' +
    '\n' +
    'Quote selection uses Claude CLI by default (claude -p <prompt>); falls back to\n' +
    'a transparent heuristic on CLI failure / missing binary. Pass --no-llm to force\n' +
    'the heuristic (useful in tests / CI).\n'
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
// Kept as fallback when LLM path fails (claude CLI absent, network error, etc.).
function suggestQuotesHeuristic(sentences, n) {
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

// LLM-based quote selection — operator 2026-06-12 reported the heuristic
// picks weren't compelling enough. Use `claude -p` to score the full kept
// transcript and return ranked indices.
//
// Why claude CLI (not anthropic API SDK): we already have it as a dependency
// for enhance_punctuation.js + run_fine_analysis.js; no new auth surface.
//
// Prompt strategy:
//  - feed all kept sentences as numbered list with speaker / time / text
//  - ask for top-N quotable sentences with one-line reason per
//  - require strict JSON output for robust parse
//  - skip if transcript > ~80k chars (rough token budget); fall back to heuristic
//
// Fallback: any failure (no CLI, timeout, parse error) → heuristic. The function
// returns just the idx list (reasons stay in stderr log; can be surfaced to UI
// later if needed).
function suggestQuotesLLM(sentences, n) {
  // Drop edge zones (first 10%, last 5%) — intro/outro chatter rarely contains
  // standalone punchlines and adding them just dilutes the LLM's attention.
  const totalDur = sentences.length > 0 ? sentences[sentences.length - 1].end : 0;
  const lo = totalDur * 0.10, hi = totalDur * 0.95;
  const eligible = sentences.filter(s => s.start >= lo && s.end <= hi);
  if (eligible.length === 0) return [];

  const lines = eligible.map(s => {
    const t = (s.text || '').replace(/\s+/g, ' ').trim();
    return `${s.idx}\t${s.speaker || ''}\t${fmtTimeShort(s.start)}\t${t}`;
  });
  const body = lines.join('\n');
  // Rough char budget; Sonnet-level models tolerate ~200k tokens but we want
  // a snappy response. ~80k chars (~25k zh tokens) is generous.
  if (body.length > 80000) {
    process.stderr.write(`⚠️  transcript too long for single-call LLM quote selection (${body.length} chars), falling back to heuristic\n`);
    return suggestQuotesHeuristic(sentences, n);
  }

  const prompt = [
    `你是一个播客剪辑师，从下面的成片逐字稿里挑出最适合做"高亮金句/封面引用"的 ${n} 段（每段可以是单句，也可以是相邻 2-3 句合并）。`,
    '',
    '挑选标准（按重要性排序）：',
    '1) 表达完整、自成一段（脱离上下文也能看懂）',
    '2) 有信息密度或情感张力——观点、对比、反差、悟到、决定、警句',
    '3) 单句长度 12-80 字（一口气说完的）；如果观点用 2-3 句相邻完成才完整，可以把它们一起选（用 idx 数组）',
    '4) 避免纯陈述事实/介绍/客套',
    '5) 跨越不同时间段，不要扎堆',
    '',
    `仅输出严格 JSON 数组（不要 markdown 包裹、不要解释）。每项格式：{"idx": <number 或 number 数组>, "reason": "<≤20字理由>"}。`,
    '- 单句金句：`{"idx": 160, "reason": "..."}`',
    '- 多句合并（相邻 idx 才能合并）：`{"idx": [160, 161, 162], "reason": "..."}`',
    `按你认为的 quotable 程度从高到低排序，最多 ${n} 项。`,
    '',
    '逐字稿（一行一句，制表符分隔 idx / speaker / time / text）：',
    body,
  ].join('\n');

  const t0 = Date.now();
  const result = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180 * 1000,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stderr.write(`⚠️  claude -p failed (${dt}s): ${result.stderr?.slice(0, 200) || 'unknown'}\n   falling back to heuristic\n`);
    return suggestQuotesHeuristic(sentences, n);
  }
  const raw = (result.stdout || '').trim();
  // Strip code-fence if model adds one despite "no markdown" instruction.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    process.stderr.write(`⚠️  could not parse claude output as JSON (${dt}s); raw[0..200]: ${cleaned.slice(0, 200)}\n   falling back to heuristic\n`);
    return suggestQuotesHeuristic(sentences, n);
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(`⚠️  claude output not an array (${dt}s); falling back to heuristic\n`);
    return suggestQuotesHeuristic(sentences, n);
  }
  // Picks 现在是 array of groups: [[160], [163, 164], [443]]. 单句 group 用 [N]
  // 表示一致 shape，下游 initSuggested 直接 addQuoteGroup(group) 一行处理。
  const eligibleSet = new Set(eligible.map(s => s.idx));
  const usedIdx = new Set();
  const picks = [];
  for (const item of parsed) {
    if (picks.length >= n) break;
    if (!item) continue;
    let group;
    if (typeof item.idx === 'number') group = [item.idx];
    else if (Array.isArray(item.idx) && item.idx.every(x => typeof x === 'number')) group = item.idx;
    else continue;
    // 过滤 hallucinated idx
    group = group.filter(i => eligibleSet.has(i) && !usedIdx.has(i));
    if (group.length === 0) continue;
    // 多句 group 强制相邻 (sort + dedupe + adjacency check). 不相邻就截到第一个非邻处
    group.sort((a, b) => a - b);
    const trimmed = [group[0]];
    for (let i = 1; i < group.length; i++) {
      if (group[i] === trimmed[trimmed.length - 1] + 1) trimmed.push(group[i]);
      else break;
    }
    for (const i of trimmed) usedIdx.add(i);
    picks.push(trimmed);
    const idxStr = trimmed.length === 1 ? String(trimmed[0]) : trimmed.join('+');
    if (item.reason) process.stderr.write(`  🪄 ${idxStr}: ${String(item.reason).slice(0, 60)}\n`);
  }
  process.stderr.write(`✨ LLM picked ${picks.length}/${n} quote groups in ${dt}s\n`);
  if (picks.length > 0) return picks;
  // fallback: wrap heuristic picks as single-sentence groups for shape consistency
  return suggestQuotesHeuristic(sentences, n).map(i => [i]);
}

function fmtTimeShort(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Default entry: try LLM, fall back to heuristic.
// Both return arrays of groups: [[160], [443], [560,561,562]].
function suggestQuotes(sentences, n, opts) {
  const useLLM = opts && opts.useLLM !== false;
  if (useLLM) return suggestQuotesLLM(sentences, n);
  // Wrap heuristic single-idx picks as single-sentence groups for consistency.
  return suggestQuotesHeuristic(sentences, n).map(i => [i]);
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
  // operator 2026-06-12: 3 太少，希望 LLM 选；bump 默认到 6 候选（与模板里
  // state.quotes 6-max 上限对齐——多了也加不进去）。用户 toggle 留下喜欢的，
  // 不喜欢的取消即可（mastering 页支持 ☆ 自由增删）。
  const N = parseInt(args.n || '6', 10);
  const useLLM = args.noLlm ? false : true;
  const suggested = suggestQuotes(sentences, N, { useLLM });

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
             .replace(/__SUGGESTED_COUNT__/g, String(suggested.length))   // # of groups, not sentences
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
