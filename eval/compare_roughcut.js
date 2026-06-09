#!/usr/bin/env node
/**
 * eval/compare_roughcut.js
 *
 * 粗剪版本的 eval/compare.js —— 把 AI 的 semantic_deep_analysis.json 和用户在
 * 审查页 commit 后导出的 delete_segments_roughcut.json 对比，输出 per-type
 * precision / recall 和"AI 帮你做了什么"的交付级 chat message。
 *
 * 跟精剪版的区别：
 *   - 粗剪是句级（不是词级），每条 AI prediction = 1 句
 *   - AI predicted delete = semantic_deep_analysis.sentences[i].action === 'delete'
 *   - User predicted delete = delete_segments_roughcut.sentence_deletes (Set<sentenceIdx>)
 *   - TP = AI 标删 ∩ 用户标删；FN = AI 标删 - 用户标删（用户恢复）
 *   - User-only = 用户标删 - AI 标删（用户手动补加）
 *   - per-type 用 AI sentence 的 type（chit_chat / production_talk / pre_show / etc.）
 *
 * Usage:
 *   node eval/compare_roughcut.js \
 *        --ai output/.../semantic_deep_analysis.json \
 *        --user /path/to/delete_segments_roughcut.json \
 *        [--episode-name <name>] [--profile <name>] [--save] [--format delivery-msg]
 *
 * Outputs:
 *   - 默认: Markdown 表格到 stdout + 追加一行到 eval/results_roughcut.jsonl
 *   - --format delivery-msg: 交付级短段落（chat 友好）
 *   - --save: 同时写 eval/reports/<episode>-roughcut-<date>.md
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { save: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ai') out.ai = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--episode-name') out.episodeName = argv[++i];
    else if (a === '--profile') out.profileName = argv[++i];
    else if (a === '--save') out.save = true;
    else if (a === '--format') out.format = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node eval/compare_roughcut.js --ai <semantic_deep_analysis.json> --user <delete_segments_roughcut.json>\n' +
    '                                     [--episode-name <name>] [--profile <name>] [--save] [--format delivery-msg]\n'
  );
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function safeArray(x) { return Array.isArray(x) ? x : []; }

// ---------- core ----------
function computeStats(aiSentences, userDeleteSet) {
  // perType: {total, tp, fn} for AI-marked sentences, keyed by sentence.type
  const perType = {};
  for (const s of aiSentences) {
    if (s == null || s.action !== 'delete') continue;
    const t = s.type || 'unknown';
    perType[t] ||= { total: 0, tp: 0, fn: 0 };
    perType[t].total++;
    if (userDeleteSet.has(s.sentenceIdx)) perType[t].tp++;
    else perType[t].fn++;
  }
  const aiDeleteSet = new Set(
    aiSentences.filter(s => s && s.action === 'delete').map(s => s.sentenceIdx)
  );
  // User-only = user deleted but AI didn't mark (rule-layer miss equivalent)
  let userOnly = 0;
  for (const idx of userDeleteSet) {
    if (!aiDeleteSet.has(idx)) userOnly++;
  }
  let total = 0, tp = 0, fn = 0;
  for (const t in perType) {
    total += perType[t].total;
    tp += perType[t].tp;
    fn += perType[t].fn;
  }
  return { perType, totals: { total, tp, fn }, userOnly };
}

function f1(p, r) { return p + r === 0 ? 0 : (2 * p * r) / (p + r); }
function pct(n, d) { return d ? n / d : 0; }
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

function buildMarkdown(stats, ctx) {
  const { perType, totals, userOnly } = stats;
  const lines = [];
  lines.push(`# Eval report (粗剪): ${ctx.episodeName}`);
  lines.push('');
  lines.push(`- Generated: ${ctx.timestamp}`);
  lines.push(`- AI file: \`${ctx.aiPath}\``);
  lines.push(`- User file: \`${ctx.userPath}\``);
  lines.push('');
  lines.push('## Per-type AI-delete retention');
  lines.push('');
  lines.push('| type | total | kept (TP) | restored (FN) | retention | precision | recall | F1 |');
  lines.push('|------|------:|----------:|--------------:|----------:|----------:|-------:|---:|');
  const typeNames = Object.keys(perType).sort();
  for (const t of typeNames) {
    const s = perType[t];
    const r = pct(s.tp, s.total);
    lines.push(
      `| ${t} | ${s.total} | ${s.tp} | ${s.fn} | ${fmtPct(r)} | ${fmtPct(r)} | ${fmtPct(r)} | ${f1(r, r).toFixed(3)} |`
    );
  }
  const r = pct(totals.tp, totals.total);
  lines.push(
    `| **all** | **${totals.total}** | **${totals.tp}** | **${totals.fn}** | **${fmtPct(r)}** | **${fmtPct(r)}** | **${fmtPct(r)}** | **${f1(r, r).toFixed(3)}** |`
  );
  lines.push('');
  lines.push('## User-added deletions (AI misses)');
  lines.push('');
  lines.push(`- 用户手动新增的整句删除（AI 没标的）: **${userOnly}**`);
  return lines.join('\n');
}

const ROUGHCUT_TYPE_NAMES = {
  pre_show: '录前准备',
  tech_debug: '技术调试',
  chit_chat: '跑题闲聊',
  privacy: '隐私段',
  repeated_content: '重复内容',
  production_talk: '录制讨论 / cue 流程',
  unknown: '其它',
};

function buildDeliveryMsg(stats, ctx, aiJson) {
  const { perType, totals } = stats;
  const aiSentences = safeArray(aiJson.sentences);

  // 估算每 type 的删除时长（句子级，没有 deleteStart/End，用 sentence 的总时长粗估）
  // semantic_deep_analysis.sentences 没有 timing；时长信息在 blocks[].duration（"M:SS" 字符串）
  // 简化：用全期总时长 × (per-type tp / total sentences) 当估值。如果有 blocks 就累加。
  const durByType = {};
  const blocks = safeArray(aiJson.blocks);
  for (const b of blocks) {
    if (!b || !b.type) continue;
    const sec = parseDuration(b.duration);
    if (!sec) continue;
    durByType[b.type] = (durByType[b.type] || 0) + sec;
  }

  const perTypeWithDur = Object.entries(perType)
    .map(([type, s]) => ({
      type,
      label: ROUGHCUT_TYPE_NAMES[type] || type,
      kept: s.tp,
      total: s.total,
      // 估值：blocks 总时长 × (kept / total)
      savedSec: durByType[type] ? durByType[type] * (s.tp / Math.max(s.total, 1)) : 0,
    }))
    .filter(t => t.kept > 0);

  perTypeWithDur.sort((a, b) => b.savedSec - a.savedSec || b.kept - a.kept);

  const lines = ['粗剪 AI 帮你做的：'];
  const topN = perTypeWithDur.slice(0, 5);
  for (const t of topN) {
    if (t.savedSec > 0) {
      lines.push(`✓ 抓了 ${t.kept} 段${t.label} = 省 ${fmtTime(t.savedSec)}`);
    } else {
      lines.push(`✓ 抓了 ${t.kept} 段${t.label}`);
    }
  }
  if (stats.userOnly > 0) {
    lines.push(`你额外加了：${stats.userOnly} 段（AI 漏标）`);
  }
  const agreementPct = totals.total > 0 ? Math.round((totals.tp / totals.total) * 100) : 0;
  lines.push('');
  lines.push(`这次你接受了我 ${agreementPct}% 的粗剪决策——下次继续这样剪。`);
  return lines.join('\n');
}

function parseDuration(s) {
  if (typeof s !== 'string') return 0;
  // "1:06" or "12:34" or "1:23:45"
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number(s) || 0;
}

function fmtTime(sec) {
  if (sec < 60) return `${sec.toFixed(0)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${m} 分钟`;
}

function isoDateOnly(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function main() {
  let args;
  try { args = parseArgs(process.argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); usage(); process.exit(2); }
  if (args.help || !args.ai || !args.user) { usage(); process.exit(args.help ? 0 : 2); }

  const episodeName = args.episodeName || path.basename(path.dirname(args.ai));
  let profileName = args.profileName || null;
  if (!profileName) {
    try {
      const baseDir = path.resolve(path.dirname(args.ai), '..');
      const profilePath = path.join(baseDir, 'profile.json');
      if (fs.existsSync(profilePath)) {
        const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        if (prof && typeof prof.name === 'string') profileName = prof.name;
      }
    } catch { /* optional */ }
  }

  const aiJson = readJson(args.ai);
  const userJson = readJson(args.user);

  const aiSentences = safeArray(aiJson.sentences);
  const userSentenceDeletes = safeArray(userJson.sentence_deletes);
  const userDeleteSet = new Set(userSentenceDeletes.map(Number));

  const stats = computeStats(aiSentences, userDeleteSet);

  const ctx = {
    episodeName,
    timestamp: new Date().toISOString(),
    aiPath: args.ai,
    userPath: args.user,
  };

  if (args.format === 'delivery-msg') {
    process.stdout.write(buildDeliveryMsg(stats, ctx, aiJson) + '\n');
    return;
  }

  const md = buildMarkdown(stats, ctx);
  process.stdout.write(md + '\n');

  const evalDir = path.dirname(path.resolve(__filename));
  const resultsPath = path.join(evalDir, 'results_roughcut.jsonl');
  const record = {
    episode_name: episodeName,
    profile_name: profileName,
    timestamp: ctx.timestamp,
    ai_path: args.ai,
    user_path: args.user,
    totals: stats.totals,
    per_type: stats.perType,
    user_added_sentences: stats.userOnly,
  };
  fs.appendFileSync(resultsPath, JSON.stringify(record) + '\n');

  if (args.save) {
    const reportsDir = path.join(evalDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const safeName = episodeName.replace(/[^\w一-鿿.-]+/g, '_');
    const outPath = path.join(reportsDir, `${safeName}-roughcut-${isoDateOnly()}.md`);
    fs.writeFileSync(outPath, md + '\n');
    process.stderr.write(`saved report: ${outPath}\n`);
  }
}

main();
