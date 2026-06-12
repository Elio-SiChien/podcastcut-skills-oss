#!/usr/bin/env node
/**
 * check_cross_podcast_promotion.js — scan all per-podcast lessons.jsonl files
 * and find semantic clusters across podcasts that warrant promoting the rule
 * to baseline (SKILL.md).
 *
 * Trigger model: agent calls this after appending a new lesson. If the new
 * lesson's cluster reaches the `--min-podcasts` threshold (default 3), the
 * script emits a promotion candidate that the agent then surfaces to the
 * human via DM.
 *
 * Usage:
 *   node eval/check_cross_podcast_promotion.js \
 *     --scope <roughcut|fine> \
 *     [--profiles-dir <dir>]   default $SKILL_DIR/profiles
 *     [--min-podcasts N]       default 3
 *     [--similarity-threshold T] default 0.4 (Jaccard on 2-3-gram tokens)
 *     [--focus <lesson_id>]    only emit clusters containing this lesson
 *     [--format markdown|json] default markdown
 *
 * Output:
 *   markdown — human-readable promotion candidate list
 *   json — machine-readable for chained tooling
 *
 * Similarity (MVP): tokenize rule text into 2-3-gram char-grams (works for
 * Chinese without segmentation), Jaccard. Cheap; works well for "嘉宾 anecdote"
 * vs "guest 个人故事" overlap. Swap for embeddings later if recall is poor.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { minPodcasts: 3, similarityThreshold: 0.4, format: 'markdown' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') args.scope = argv[++i];
    else if (a === '--profiles-dir') args.profilesDir = argv[++i];
    else if (a === '--min-podcasts') args.minPodcasts = Number(argv[++i]);
    else if (a === '--similarity-threshold') args.similarityThreshold = Number(argv[++i]);
    else if (a === '--focus') args.focus = argv[++i];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.error('usage: node eval/check_cross_podcast_promotion.js --scope <roughcut|fine> [--min-podcasts 3] [--similarity-threshold 0.4] [--focus <id>] [--format markdown|json]');
}

const args = parseArgs(process.argv);
if (args.help) { usage(); process.exit(0); }
if (!args.scope) { usage(); process.exit(2); }
if (args.scope !== 'roughcut' && args.scope !== 'fine') {
  console.error('--scope must be "roughcut" or "fine"');
  process.exit(2);
}

const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
const profilesDir = args.profilesDir || path.join(scriptDir, '..', 'profiles');

const suffix = `.${args.scope}.lessons.jsonl`;
const files = fs.readdirSync(profilesDir).filter(f => f.endsWith(suffix));

// Load all lessons tagged with podcast name (file stem)
const lessons = [];
for (const f of files) {
  const podcastName = f.slice(0, -suffix.length);
  const raw = fs.readFileSync(path.join(profilesDir, f), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const l = JSON.parse(t);
      if (l.promoted_to_baseline) continue;
      l._podcast = podcastName;
      lessons.push(l);
    } catch {}
  }
}

// 2-3-gram char-gram tokenizer (works for Chinese without segmentation)
function ngrams(text, ns = [2, 3]) {
  const s = (text || '').replace(/\s+/g, '');
  const set = new Set();
  for (const n of ns) {
    for (let i = 0; i + n <= s.length; i++) set.add(s.substring(i, i + n));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Pre-tokenize
for (const l of lessons) l._gram = ngrams(l.rule);

// Build similarity clusters: union-find by threshold
const parent = new Map();
function find(x) {
  if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
  return parent.get(x);
}
function union(a, b) { parent.set(find(a), find(b)); }
for (let i = 0; i < lessons.length; i++) parent.set(i, i);

for (let i = 0; i < lessons.length; i++) {
  for (let j = i + 1; j < lessons.length; j++) {
    const sim = jaccard(lessons[i]._gram, lessons[j]._gram);
    if (sim >= args.similarityThreshold) union(i, j);
  }
}

const clustersById = new Map();
for (let i = 0; i < lessons.length; i++) {
  const root = find(i);
  if (!clustersById.has(root)) clustersById.set(root, []);
  clustersById.get(root).push(lessons[i]);
}

const promotionCandidates = [];
for (const cluster of clustersById.values()) {
  const uniquePodcasts = new Set(cluster.map(l => l._podcast));
  if (uniquePodcasts.size < args.minPodcasts) continue;
  if (args.focus) {
    const focusInCluster = cluster.some(l => l.id === args.focus);
    if (!focusInCluster) continue;
  }
  promotionCandidates.push({
    podcasts: [...uniquePodcasts].sort(),
    lessons: cluster.map(l => ({
      id: l.id, podcast: l._podcast, rule: l.rule,
      evidence_episodes: l.evidence_episodes || [],
      source: l.source, weight: l.weight, added_at: l.added_at,
    })),
  });
}

if (args.format === 'json') {
  process.stdout.write(JSON.stringify({
    scope: args.scope,
    total_lessons_scanned: lessons.length,
    promotion_candidates: promotionCandidates,
  }, null, 2));
  process.exit(0);
}

if (promotionCandidates.length === 0) {
  process.stdout.write(`No promotion candidates (scanned ${lessons.length} ${args.scope} lessons across ${files.length} podcasts; min ${args.minPodcasts} podcasts per cluster).\n`);
  process.exit(0);
}

const lines = [`## ${args.scope} promotion candidates (${promotionCandidates.length})`, ''];
for (let i = 0; i < promotionCandidates.length; i++) {
  const c = promotionCandidates[i];
  lines.push(`### Candidate ${i + 1} — across ${c.podcasts.length} podcasts: ${c.podcasts.join(', ')}`);
  lines.push('');
  for (const l of c.lessons) {
    const eps = (l.evidence_episodes || []).join('/');
    lines.push(`- **${l.podcast}** \`${l.id}\` (weight ${l.weight}, ${eps ? 'ep ' + eps + ', ' : ''}source ${l.source}): ${l.rule}`);
  }
  lines.push('');
  lines.push('→ Suggested action: open a PR adding this rule to baseline (粗剪 or 精剪 SKILL.md), mark all source lessons `promoted_to_baseline: <ISO date>`.');
  lines.push('');
}
process.stdout.write(lines.join('\n'));
