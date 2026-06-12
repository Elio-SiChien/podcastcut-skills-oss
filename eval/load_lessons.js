#!/usr/bin/env node
/**
 * load_lessons.js — load per-podcast lessons.jsonl files and emit a markdown
 * block ready to inject into a 粗剪 / 精剪 LLM "判断准则" prompt section.
 *
 * Two per-podcast files live next to the profile:
 *   profiles/<name>.roughcut.lessons.jsonl
 *   profiles/<name>.fine.lessons.jsonl
 *
 * Each line is a JSON object with at minimum:
 *   { id, scope, rule, evidence_episodes, source, weight, added_at }
 *
 * Usage:
 *   node eval/load_lessons.js --profile <name> --scope <roughcut|fine>
 *     [--profiles-dir <dir>]   override default $SKILL_DIR/profiles
 *     [--format markdown|json] default markdown
 *
 * Markdown output (default) — drop into a "## 学到的剪辑判断准则" section in
 * the prompt:
 *
 *   ### 历史课（这档播客 N 次审稿沉淀，判断时优先参考）
 *   - 嘉宾用类比/故事讲观点 → KEEP，别标 chit_chat (L001, weight 1.0, ep EP23)
 *   - Founders 远见 / leadership conviction → KEEP (L003, weight 1.5, ep EP23)
 *   ...
 *
 * Weight semantics:
 *   - 1.0 = baseline (user toggled in review HTML)
 *   - 1.5 = user toggled during 精剪 listening (caught what text-only missed)
 *   - 2.0 = meta-rule / agent-derived calibration
 *
 * Exit code: 0 even when no file exists (emits empty block). 2 on bad args.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') args.profile = argv[++i];
    else if (a === '--scope') args.scope = argv[++i];
    else if (a === '--profiles-dir') args.profilesDir = argv[++i];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.error('usage: node eval/load_lessons.js --profile <name> --scope <roughcut|fine> [--profiles-dir <dir>] [--format markdown|json]');
}

const args = parseArgs(process.argv);
if (args.help) { usage(); process.exit(0); }
if (!args.profile || !args.scope) { usage(); process.exit(2); }
if (args.scope !== 'roughcut' && args.scope !== 'fine') {
  console.error('--scope must be "roughcut" or "fine"');
  process.exit(2);
}

const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
const profilesDir = args.profilesDir || path.join(scriptDir, '..', 'profiles');
const lessonsPath = path.join(profilesDir, `${args.profile}.${args.scope}.lessons.jsonl`);

let lessons = [];
if (fs.existsSync(lessonsPath)) {
  const raw = fs.readFileSync(lessonsPath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { lessons.push(JSON.parse(t)); }
    catch (e) { console.error(`warning: skipping unparseable line in ${lessonsPath}: ${e.message}`); }
  }
}

lessons.sort((a, b) => (b.weight || 1.0) - (a.weight || 1.0));

const format = args.format || 'markdown';

if (format === 'json') {
  process.stdout.write(JSON.stringify(lessons, null, 2));
  process.exit(0);
}

if (lessons.length === 0) {
  process.stdout.write(`### 历史课（这档播客 ${args.scope} 学到的规则）\n\n暂无沉淀的规则。\n`);
  process.exit(0);
}

const header = `### 历史课（这档播客 ${args.scope} 沉淀的 ${lessons.length} 条规则，判断时优先参考）`;
const lines = [header, ''];
for (const l of lessons) {
  const eps = (l.evidence_episodes || []).join('/');
  const tag = [
    l.id || '',
    `weight ${l.weight ?? 1.0}`,
    eps ? `ep ${eps}` : '',
  ].filter(Boolean).join(', ');
  lines.push(`- ${l.rule}  _(${tag})_`);
}
process.stdout.write(lines.join('\n') + '\n');
