#!/usr/bin/env node
/**
 * eval/compare.js
 *
 * Compare AI's fine_analysis.json against the user's hand-edited
 * delete_segments_edited.json (exported from cloud-bridge), and emit a
 * per-type precision / recall / F1 / restoration-rate table.
 *
 * Join key: (sentenceIdx, type, ord)
 *   - AI side:   sentenceIdx is `edit.sentenceIdx`; ord is the 1-based rank
 *                of the edit within its sentence, sorted by deleteStart
 *                (matches the convention used by the cloud-bridge exporter).
 *   - User side: each fine_edits entry already carries (idx, type, ord)
 *                where `idx` IS the sentence index.
 *
 * Metrics, per type:
 *   total      = AI edits of this type
 *   TP (kept)  = AI edits the user kept in fine_edits
 *   FN (restored / FP) = AI edits the user removed (restored sentence)
 *   retention% = TP / total
 *   precision  = TP / (TP + FP) — same as retention here because the user
 *                cannot add fine_edits of these AI types; every "user-added"
 *                delete shows up as partial_deletes or sentence_deletes.
 *   recall     = TP / (TP + FN) — same as precision here, so we report the
 *                shared "retention" number and call it out in the README.
 *   F1         = 2*P*R/(P+R)
 *
 * User-added deletions (rule-layer misses):
 *   partial_deletes  -> tallied & reported separately
 *   sentence_deletes -> tallied & reported separately
 *
 * Usage:
 *   node eval/compare.js \
 *        --ai output/.../fine_analysis.json \
 *        --user /path/to/delete_segments_edited.json \
 *        [--episode-name <name>] \
 *        [--save]
 *
 * Outputs:
 *   - Markdown table to stdout
 *   - Appends a JSON record to eval/results.jsonl
 *   - With --save: writes eval/reports/<episode-name>-<YYYY-MM-DD>.md
 */

const fs = require('fs');
const path = require('path');

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = { save: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ai') out.ai = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--episode-name') out.episodeName = argv[++i];
    else if (a === '--save') out.save = true;
    else if (a === '--format') out.format = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node eval/compare.js --ai <fine_analysis.json> --user <delete_segments_edited.json> [--episode-name <name>] [--save]\n'
  );
}

// ---------- io ----------
function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

// ---------- core ----------
/**
 * Assign 1-based ord to each AI edit within its sentenceIdx, sorted by
 * deleteStart. Returns a Map<key, edit> keyed by `${sentenceIdx}|${type}|${ord}`.
 */
function buildAiIndex(aiEdits) {
  const bySent = new Map();
  for (const e of aiEdits) {
    if (e == null || e.sentenceIdx == null || !e.type) continue;
    const k = e.sentenceIdx;
    if (!bySent.has(k)) bySent.set(k, []);
    bySent.get(k).push(e);
  }
  const index = new Map();
  for (const [sentIdx, list] of bySent) {
    list.sort((a, b) => (a.deleteStart ?? 0) - (b.deleteStart ?? 0));
    list.forEach((e, i) => {
      const ord = i + 1;
      const key = `${sentIdx}|${e.type}|${ord}`;
      index.set(key, e);
    });
  }
  return index;
}

/**
 * Build a Set of user-kept keys from user.fine_edits.
 * Each user fine_edit carries (idx == sentenceIdx, type, ord) — same shape
 * as the AI index above.
 */
function buildUserKeptSet(userFineEdits) {
  const kept = new Set();
  for (const e of userFineEdits) {
    if (e == null || e.idx == null || !e.type || e.ord == null) continue;
    kept.add(`${e.idx}|${e.type}|${e.ord}`);
  }
  return kept;
}

function computeStats(aiIndex, userKept) {
  // per-type {total, tp, fn}
  const perType = {};
  for (const [key, edit] of aiIndex) {
    const t = edit.type;
    perType[t] ||= { total: 0, tp: 0, fn: 0 };
    perType[t].total++;
    if (userKept.has(key)) perType[t].tp++;
    else perType[t].fn++;
  }
  // User-side keys that don't appear in AI (rare; usually edge-case ord drift).
  let userOnly = 0;
  const userOnlyByType = {};
  for (const k of userKept) {
    if (!aiIndex.has(k)) {
      userOnly++;
      const t = k.split('|')[1];
      userOnlyByType[t] = (userOnlyByType[t] || 0) + 1;
    }
  }
  // Totals
  let total = 0,
    tp = 0,
    fn = 0;
  for (const t in perType) {
    total += perType[t].total;
    tp += perType[t].tp;
    fn += perType[t].fn;
  }
  return { perType, totals: { total, tp, fn }, userOnly, userOnlyByType };
}

function f1(p, r) {
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

function pct(n, d) {
  if (!d) return 0;
  return n / d;
}

function fmtPct(x) {
  return (x * 100).toFixed(1) + '%';
}

function buildMarkdown(stats, ctx) {
  const { perType, totals, userOnly, userOnlyByType } = stats;
  const lines = [];
  lines.push(`# Eval report: ${ctx.episodeName}`);
  lines.push('');
  lines.push(`- Generated: ${ctx.timestamp}`);
  lines.push(`- AI file: \`${ctx.aiPath}\``);
  lines.push(`- User file: \`${ctx.userPath}\``);
  lines.push('');
  lines.push('## Per-type AI-edit retention');
  lines.push('');
  lines.push(
    '| type | total | kept (TP) | restored (FN/FP) | retention | precision | recall | F1 |'
  );
  lines.push(
    '|------|------:|----------:|-----------------:|----------:|----------:|-------:|---:|'
  );
  const typeNames = Object.keys(perType).sort();
  for (const t of typeNames) {
    const s = perType[t];
    const retention = pct(s.tp, s.total);
    // In this setup, precision == recall == retention (see header comment).
    const precision = retention;
    const recall = retention;
    lines.push(
      `| ${t} | ${s.total} | ${s.tp} | ${s.fn} | ${fmtPct(retention)} | ${fmtPct(
        precision
      )} | ${fmtPct(recall)} | ${f1(precision, recall).toFixed(3)} |`
    );
  }
  const retentionAll = pct(totals.tp, totals.total);
  lines.push(
    `| **all** | **${totals.total}** | **${totals.tp}** | **${
      totals.fn
    }** | **${fmtPct(retentionAll)}** | **${fmtPct(retentionAll)}** | **${fmtPct(
      retentionAll
    )}** | **${f1(retentionAll, retentionAll).toFixed(3)}** |`
  );
  lines.push('');
  lines.push('## User-added deletions (rule-layer misses)');
  lines.push('');
  lines.push(`- partial_deletes: **${ctx.partialDeletesCount}**`);
  lines.push(`- sentence_deletes: **${ctx.sentenceDeletesCount}**`);
  lines.push('');
  if (userOnly > 0) {
    lines.push('## Diagnostics');
    lines.push('');
    lines.push(
      `- user-side fine_edits with no AI match (ord drift / silence_merged edge): **${userOnly}**`
    );
    const breakdown = Object.entries(userOnlyByType)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ');
    if (breakdown) lines.push(`  - by type: ${breakdown}`);
    lines.push('');
  }
  return lines.join('\n');
}

function isoDateOnly(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ---------- delivery-msg format ----------
// 给用户成片交付时塞进 chat 的短段落。
// 设计原则（2026-06-03 product discussion）：
// - 只讲"AI 帮你做了什么" + agreement %（产品价值 messaging）
// - 不讲 retention <X% 这种"误判"指标（improvement messaging 走 Stage 2 触发式）
function buildDeliveryMsg(stats, ctx, aiJson) {
  const totals = stats.totals;  // {total, tp, fn}
  const TYPE_NAMES = {
    stutter: '口吃/卡顿',
    filler_start: '句首填充词（嗯啊呃）',
    consecutive_filler: '连续填充词',
    silence_merged: '衔接片段',
    silence: '长停顿',
    self_correction_rules: '重说纠正',
    in_sentence_repeat: '句内重复',
  };
  // stats.perType[type] = {total, tp, fn}；tp = 用户接受
  const perTypeWithDur = Object.entries(stats.perType)
    .map(([type, s]) => ({
      type,
      label: TYPE_NAMES[type] || type,
      kept: s.tp,
      total: s.total,
    }))
    .filter((t) => t.kept > 0);

  // 算每 type 的真实平均 duration（从 aiJson.edits）
  const aiEdits = safeArray(aiJson.edits);
  const durByType = {};
  for (const e of aiEdits) {
    const t = e.type;
    const d = (e.deleteEnd ?? 0) - (e.deleteStart ?? 0);
    if (!durByType[t]) durByType[t] = { sum: 0, count: 0 };
    if (d > 0) {
      durByType[t].sum += d;
      durByType[t].count += 1;
    }
  }
  for (const t of perTypeWithDur) {
    const dt = durByType[t.type];
    const avgDur = dt && dt.count ? dt.sum / dt.count : 0;
    t.savedSec = t.kept * avgDur;
  }

  const totalSavedSec = perTypeWithDur.reduce((s, t) => s + t.savedSec, 0);
  perTypeWithDur.sort((a, b) => b.savedSec - a.savedSec);

  function fmtTime(sec) {
    if (sec < 60) return `${sec.toFixed(0)} 秒`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${m} 分钟`;
  }

  const lines = ['AI 帮你做的：'];
  const topN = perTypeWithDur.slice(0, 4);
  for (const t of topN) {
    lines.push(`✓ 抓了 ${t.kept} 个${t.label} = 省 ${fmtTime(t.savedSec)}`);
  }
  // 用户增加的部分
  if (ctx.partialDeletesCount > 0 || ctx.sentenceDeletesCount > 0) {
    const userAdd = [];
    if (ctx.sentenceDeletesCount > 0) userAdd.push(`${ctx.sentenceDeletesCount} 个整句`);
    if (ctx.partialDeletesCount > 0) userAdd.push(`${ctx.partialDeletesCount} 处细修`);
    lines.push(`你额外加了：${userAdd.join(' + ')}`);
  }
  // Agreement
  const agreementPct =
    totals.total > 0 ? Math.round((totals.tp / totals.total) * 100) : 0;
  lines.push('');
  lines.push(
    `这次你接受了我 ${agreementPct}% 的删除决策——下次继续这样剪。`
  );
  return lines.join('\n');
}

// ---------- main ----------
function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    usage();
    process.exit(2);
  }
  if (args.help || !args.ai || !args.user) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  const episodeName = args.episodeName || path.basename(path.dirname(args.ai));

  const aiJson = readJson(args.ai);
  const userJson = readJson(args.user);

  const aiEdits = safeArray(aiJson.edits);
  const userFineEdits = safeArray(userJson.fine_edits);
  const partialDeletes = safeArray(userJson.partial_deletes);
  const sentenceDeletes = safeArray(userJson.sentence_deletes);

  const aiIndex = buildAiIndex(aiEdits);
  const userKept = buildUserKeptSet(userFineEdits);
  const stats = computeStats(aiIndex, userKept);

  const ctx = {
    episodeName,
    timestamp: new Date().toISOString(),
    aiPath: args.ai,
    userPath: args.user,
    partialDeletesCount: partialDeletes.length,
    sentenceDeletesCount: sentenceDeletes.length,
  };

  if (args.format === 'delivery-msg') {
    const msg = buildDeliveryMsg(stats, ctx, aiJson);
    process.stdout.write(msg + '\n');
    return; // delivery-msg 模式不写 jsonl / reports
  }

  const md = buildMarkdown(stats, ctx);
  process.stdout.write(md + '\n');

  // Append to results.jsonl
  const evalDir = path.dirname(path.resolve(__filename));
  const resultsPath = path.join(evalDir, 'results.jsonl');
  const record = {
    episode_name: episodeName,
    timestamp: ctx.timestamp,
    ai_path: args.ai,
    user_path: args.user,
    totals: stats.totals,
    per_type: stats.perType,
    user_added: {
      partial_deletes: partialDeletes.length,
      sentence_deletes: sentenceDeletes.length,
    },
    diagnostics: {
      user_only_keys: stats.userOnly,
      user_only_by_type: stats.userOnlyByType,
    },
  };
  fs.appendFileSync(resultsPath, JSON.stringify(record) + '\n');

  // Optional --save
  if (args.save) {
    const reportsDir = path.join(evalDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const safeName = episodeName.replace(/[^\w一-鿿.-]+/g, '_');
    const outPath = path.join(reportsDir, `${safeName}-${isoDateOnly()}.md`);
    fs.writeFileSync(outPath, md + '\n');
    process.stderr.write(`saved report: ${outPath}\n`);
  }
}

main();
