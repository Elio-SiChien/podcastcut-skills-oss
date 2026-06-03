#!/usr/bin/env node
/**
 * check_detector_overrides.js — Stage 2 self-iterating loop trigger.
 *
 * After every episode (edit-chat 阶段 6), the agent runs this to decide
 * whether to prompt the user with a Tier 2 "want me to permanently tune
 * this detector?" suggestion. See notes/2026-06-03_self-iterating-product-loop.md
 * for the full product framing.
 *
 * Inputs:
 *   --profile <name>           Profile name to evaluate (required).
 *   --results <path>           eval/results.jsonl (default: eval/results.jsonl next to this script)
 *   --profiles-dir <path>      Where profile JSONs live (default: <repo>/profiles)
 *   --episodes <N>             How many recent episodes to aggregate (default 3)
 *   --threshold <0..1>         Retention threshold below which to trigger (default 0.70)
 *   --min-total-per-episode    Skip a detector if its avg total per episode is below this
 *                              (default 5 — too few samples = noisy retention)
 *   --cooldown <N>             After user says "再观察", skip this many future
 *                              episodes before re-checking (default 5)
 *
 * Output (stdout, JSON):
 *   { triggers: [{ detector, episodes_used, avg_retention, avg_total_per_ep,
 *                  suggested_message }],
 *     skipped: [{ detector, reason }] }
 *
 * Exit code 0 always (a no-trigger result is normal — the SKILL.md flow
 * just no-ops in that case). Non-zero only for hard errors.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.dirname(path.resolve(__filename));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const out = {
    results: path.join(SCRIPT_DIR, 'results.jsonl'),
    profilesDir: path.join(REPO_ROOT, 'profiles'),
    episodes: 3,
    threshold: 0.70,
    minTotalPerEpisode: 5,
    cooldown: 5,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--results') out.results = argv[++i];
    else if (a === '--profiles-dir') out.profilesDir = argv[++i];
    else if (a === '--episodes') out.episodes = parseInt(argv[++i], 10);
    else if (a === '--threshold') out.threshold = parseFloat(argv[++i]);
    else if (a === '--min-total-per-episode') out.minTotalPerEpisode = parseInt(argv[++i], 10);
    else if (a === '--cooldown') out.cooldown = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node eval/check_detector_overrides.js --profile <name>\n' +
    '       [--episodes 3] [--threshold 0.70] [--min-total-per-episode 5] [--cooldown 5]\n'
  );
}

function loadResults(resultsPath) {
  if (!fs.existsSync(resultsPath)) return [];
  const raw = fs.readFileSync(resultsPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadProfile(profilesDir, name) {
  const p = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(p)) return { path: p, exists: false, data: { name } };
  return { path: p, exists: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function buildSuggestionMessage(detector, avgRetention, episodesUsed) {
  // Friendly framing from notes/2026-06-03_self-iterating-product-loop.md:
  // "user-as-expert, AI-as-student" — never "AI got it wrong"
  const pct = Math.round(avgRetention * 100);
  return (
    `（顺便）最近 ${episodesUsed} 期我注意到 \`${detector}\` 你只保留了 ${pct}%。` +
    `你 podcast 的节奏里这类信号可能不是卡顿。` +
    `要不要在这档**永久关掉这个 detector**？「关掉」/「再观察几期」/「忽略」`
  );
}

function main() {
  let args;
  try { args = parseArgs(process.argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); usage(); process.exit(2); }
  if (args.help || !args.profile) { usage(); process.exit(args.help ? 0 : 2); }

  const all = loadResults(args.results);
  const forProfile = all
    .filter(r => r.profile_name === args.profile)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const recent = forProfile.slice(-args.episodes);
  const profileBundle = loadProfile(args.profilesDir, args.profile);
  const overrides = (profileBundle.data && profileBundle.data.detector_overrides) || {};
  const checkHistory = (profileBundle.data && profileBundle.data.detector_check_history) || {};

  // Not enough data yet — quiet no-op (no trigger, no skipped).
  if (recent.length < args.episodes) {
    process.stdout.write(JSON.stringify({
      triggers: [],
      skipped: [],
      diagnostics: {
        profile: args.profile,
        episodes_seen: forProfile.length,
        episodes_required: args.episodes,
        reason: 'not enough episodes yet',
      },
    }) + '\n');
    return;
  }

  // Aggregate per-detector across the recent window.
  const agg = {};
  for (const rec of recent) {
    const pt = rec.per_type || {};
    for (const [detector, stats] of Object.entries(pt)) {
      if (!agg[detector]) agg[detector] = { total: 0, tp: 0, episodes: 0 };
      agg[detector].total += stats.total || 0;
      agg[detector].tp += stats.tp || 0;
      agg[detector].episodes += 1;
    }
  }

  const triggers = [];
  const skipped = [];

  for (const [detector, a] of Object.entries(agg)) {
    // Already disabled — agent does not re-suggest something the user has tuned off.
    if (overrides[detector] && overrides[detector].enabled === false) {
      skipped.push({ detector, reason: 'already disabled in profile' });
      continue;
    }
    // Cooldown — user said "再观察" recently.
    const history = checkHistory[detector];
    if (history && history.cooldown_until_episode_count != null
        && forProfile.length < history.cooldown_until_episode_count) {
      skipped.push({
        detector,
        reason: `cooldown until episode ${history.cooldown_until_episode_count} ` +
                `(current ${forProfile.length})`,
      });
      continue;
    }
    // Permanent ignore — user said "忽略".
    if (history && history.last_user_action === '忽略') {
      skipped.push({ detector, reason: 'user permanently ignored' });
      continue;
    }
    // Too few samples — retention noise will dominate.
    const avgTotal = a.total / a.episodes;
    if (avgTotal < args.minTotalPerEpisode) {
      skipped.push({
        detector,
        reason: `avg ${avgTotal.toFixed(1)} firings/episode below min ${args.minTotalPerEpisode}`,
      });
      continue;
    }
    const retention = a.total === 0 ? 1 : a.tp / a.total;
    if (retention < args.threshold) {
      triggers.push({
        detector,
        episodes_used: a.episodes,
        avg_retention: Number(retention.toFixed(3)),
        avg_total_per_ep: Number(avgTotal.toFixed(1)),
        suggested_message: buildSuggestionMessage(detector, retention, a.episodes),
      });
    } else {
      skipped.push({
        detector,
        reason: `retention ${(retention * 100).toFixed(0)}% above threshold ` +
                `${(args.threshold * 100).toFixed(0)}%`,
      });
    }
  }

  // One trigger per call — Tier 2 design says "single line, easy to dismiss"
  // so we never stack two prompts on the same delivery message. If multiple
  // detectors qualify, pick the one with lowest retention (most painful).
  triggers.sort((a, b) => a.avg_retention - b.avg_retention);
  const top = triggers.slice(0, 1);
  const deferred = triggers.slice(1).map(t => ({ detector: t.detector, reason: 'deferred — only one trigger per delivery' }));

  process.stdout.write(JSON.stringify({
    triggers: top,
    skipped: skipped.concat(deferred),
    diagnostics: {
      profile: args.profile,
      episodes_used: recent.length,
      threshold: args.threshold,
      min_total_per_episode: args.minTotalPerEpisode,
    },
  }) + '\n');
}

main();
