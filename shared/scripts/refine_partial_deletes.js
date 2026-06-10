#!/usr/bin/env node
/**
 * 精修 delete_segments_edited.json 中 partial_deletes 的字级时间戳。
 *
 * 背景：partial_deletes 来自审查页用户的"选区→标半句删"，时间戳直接消费
 * ASR 字级 start/end。对 fun-asr 这种"句首/句尾精确、句内字级均分"的 ASR，
 * 用户标记的切点会偏离实际声学边界 0.2–2s（长句尤甚）。AI 精剪标走
 * refine_fine_analysis.js 已有精修，整句删用句首/句尾精确，唯独 partial_deletes
 * 绕过精修直接被 cut_audio.py 消费。
 *
 * 在 execute SKILL.md cut_audio.py 之前执行。扫 partial_deletes 把每段的
 * start/end 调 refine_boundaries.py 做波形 onset detection，把均分误差吸附到
 * 真实音节边界。
 *
 * 用法:
 *   node refine_partial_deletes.js --analysis-dir <dir> --audio <path>
 *
 * 参数:
 *   --analysis-dir   包含 delete_segments_edited.json 的目录
 *   --audio          原始音频文件路径（不传则按 refine_fine_analysis 同样的默认查找）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let analysisDir = process.cwd();
let audioPath = null;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--analysis-dir' && process.argv[i + 1]) {
    analysisDir = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--audio' && process.argv[i + 1]) {
    audioPath = path.resolve(process.argv[++i]);
  }
}

const editedPath = path.join(analysisDir, 'delete_segments_edited.json');
const scriptDir = __dirname;
const refinePyPath = path.join(scriptDir, 'refine_boundaries.py');

if (!fs.existsSync(editedPath)) {
  console.log(`ℹ️  delete_segments_edited.json 不存在，跳过 partial_deletes 精修`);
  process.exit(0);
}

// 默认音频选择顺序与 refine_fine_analysis.js 保持一致：原始无损 > seekable > ASR 版
// onset 谷底检测对源码质量敏感，MP3 重压缩会平滑能量包络偏差几十 ms。
if (!audioPath) {
  const transcribeDir = path.join(analysisDir, '..', '1_转录');
  let originals = [];
  try {
    originals = fs.readdirSync(transcribeDir).filter(f => f.startsWith('audio_original.'));
  } catch (e) {}
  if (originals.length > 0) {
    audioPath = path.join(transcribeDir, originals[0]);
  } else {
    const seekable = path.join(transcribeDir, 'audio_seekable.mp3');
    const asrAudio = path.join(transcribeDir, 'audio.mp3');
    audioPath = fs.existsSync(seekable) ? seekable
              : fs.existsSync(asrAudio) ? asrAudio
              : null;
    if (!audioPath) {
      console.error('❌ 未指定 --audio，且默认音频路径不存在');
      process.exit(1);
    }
  }
}

const data = JSON.parse(fs.readFileSync(editedPath, 'utf8'));
const partialDeletes = data.partial_deletes || {};
const sentenceKeys = Object.keys(partialDeletes);

if (sentenceKeys.length === 0) {
  console.log(`   没有 partial_deletes，跳过精修`);
  process.exit(0);
}

// 收集所有点。每个 partial_delete 段产出 2 个点（start + end），双向搜索。
//
// search_window=0.20s 选择理由：
//   - fun-asr 均分误差量级是 0.2-0.5s（单字 0.234s × 累积偏差几个字位）
//   - 搜窗太小（0.05s）抓不回均分误差；太大（>0.5s）容易跳到远处句间静音
//     或邻词的能量谷底（refine_boundaries 已有"最深谷底而非局部谷底"风险，
//     见 docs/reference/技术陷阱与波形.md 陷阱 36）
//   - 0.20s ≈ 1 字宽度，匹配均分单字尺度
const SEARCH_WINDOW = 0.20;

const allPoints = [];
// 追踪每个 point 属于哪个 (sentenceKey, indexInList, 'start'|'end')
const pointToSeg = [];

for (const key of sentenceKeys) {
  const segs = partialDeletes[key] || [];
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg._refined) {
      // 幂等：已经精修过的不再重做（备份+复跑场景）
      continue;
    }
    allPoints.push({ time: seg.s, search_window: SEARCH_WINDOW, direction: 'both' });
    pointToSeg.push({ key, segIdx: si, end: 'start' });
    allPoints.push({ time: seg.e, search_window: SEARCH_WINDOW, direction: 'both' });
    pointToSeg.push({ key, segIdx: si, end: 'end' });
  }
}

if (allPoints.length === 0) {
  console.log(`   所有 partial_deletes 已精修过，跳过`);
  process.exit(0);
}

console.log(`🔍 Refine partial_deletes: onset detection 精修`);
console.log(`   delete_segments_edited: ${editedPath}`);
console.log(`   audio: ${audioPath}`);
console.log(`   收集到 ${allPoints.length} 个待精修点 (${allPoints.length / 2} 个 partial_delete 段)`);

const tempPointsPath = path.join(analysisDir, '_partial_refine_points_temp.json');
fs.writeFileSync(tempPointsPath, JSON.stringify(allPoints));

let results;
try {
  const cmd = `python3 "${refinePyPath}" --audio "${audioPath}" --points-file "${tempPointsPath}"`;
  const stdout = execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000
  });
  results = JSON.parse(stdout);
} catch (err) {
  console.error(`❌ refine_boundaries.py 执行失败:`, err.message);
  try { fs.unlinkSync(tempPointsPath); } catch (e) {}
  process.exit(1);
}

try { fs.unlinkSync(tempPointsPath); } catch (e) {}

// 应用精修结果。低 confidence 或位移过大都保留 ASR 原值（保守优于错切）。
//
// 最大位移上限选择：
//   - 0.5s — 比均分单字误差期望（0.2-0.5s）略宽，覆盖累积偏差
//   - 超过 0.5s 强行 refine 很可能是 onset 检测找到了远处的"更深谷底"（错位）
//     而不是真实的字边界，保守拒绝
const MAX_SHIFT_S = 0.5;

let applied = 0;
let skipped_lowConf = 0;
let skipped_overShift = 0;
let skipped_noChange = 0;
const refinedSegs = new Set();

for (let i = 0; i < results.length; i++) {
  const result = results[i];
  const { key, segIdx, end } = pointToSeg[i];
  const seg = partialDeletes[key][segIdx];

  if (result.confidence < 0.5) {
    skipped_lowConf++;
    continue;
  }
  const delta = result.refined - result.original;
  if (Math.abs(delta) < 0.001) {
    skipped_noChange++;
    continue;
  }
  if (Math.abs(delta) > MAX_SHIFT_S) {
    skipped_overShift++;
    console.log(`   ⏭️  sent#${key} seg#${segIdx} ${end}: 位移 ${(delta*1000).toFixed(0)}ms > 500ms 上限，保留 ASR 边界 ${result.original.toFixed(3)}s`);
    continue;
  }

  if (end === 'start') {
    seg._originalS = seg.s;
    seg.s = Math.round(result.refined * 1000) / 1000;
  } else {
    seg._originalE = seg.e;
    seg.e = Math.round(result.refined * 1000) / 1000;
  }
  applied++;
  refinedSegs.add(`${key}/${segIdx}`);
  console.log(`   ✅ sent#${key} seg#${segIdx} ${end}: ${result.original.toFixed(3)} → ${result.refined.toFixed(3)} (Δ${(delta * 1000).toFixed(1)}ms, conf=${result.confidence.toFixed(2)})`);
}

// 标记完成精修的段（幂等检查用）
for (const key of sentenceKeys) {
  const segs = partialDeletes[key] || [];
  for (let si = 0; si < segs.length; si++) {
    if (refinedSegs.has(`${key}/${si}`)) {
      segs[si]._refined = true;
    }
  }
}

// 重要：partial_deletes 改了时间戳，segments[] 也要同步重算。
// segments[] 是所有删除时间段的扁平合并（整句 + 半句 + 启用的 AI 精剪标），
// cut_audio.py 直接消费它。如果只改 partial_deletes 而不动 segments，
// 精修白做，cut_audio 还是用旧值。
//
// 实现策略：审查页导出时 segments 已经按时间序合并，不再有 sentence/partial/fine 来源标签。
// 这里安全做法是按"差值映射"重建：
//   对每个 partial_delete 段，找到 segments[] 里 abs(start-原s)<5ms 且 abs(end-原e)<5ms 的项，
//   替换为新 s/e。然后整体重排+合并相邻重叠段。
function syncSegments() {
  if (!Array.isArray(data.segments)) return 0;
  let replaced = 0;
  const EPS = 0.005;  // 5ms 容差
  const updates = [];  // {oldS, oldE, newS, newE}
  for (const key of sentenceKeys) {
    const segs = partialDeletes[key] || [];
    for (const seg of segs) {
      if (seg._originalS != null || seg._originalE != null) {
        updates.push({
          oldS: seg._originalS != null ? seg._originalS : seg.s,
          oldE: seg._originalE != null ? seg._originalE : seg.e,
          newS: seg.s,
          newE: seg.e,
        });
      }
    }
  }
  for (const u of updates) {
    const hit = data.segments.find(s =>
      Math.abs(s.start - u.oldS) < EPS && Math.abs(s.end - u.oldE) < EPS
    );
    if (hit) {
      hit.start = u.newS;
      hit.end = u.newE;
      replaced++;
    }
  }
  // 重排（精修后某些段可能错序）
  data.segments.sort((a, b) => a.start - b.start);
  // 合并相邻重叠段（精修可能让两个原本不重叠的段贴上或重叠）
  const merged = [];
  for (const s of data.segments) {
    if (merged.length === 0 || s.start > merged[merged.length - 1].end + 0.001) {
      merged.push({ start: s.start, end: s.end });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
    }
  }
  const mergedCount = data.segments.length - merged.length;
  data.segments = merged;
  return { replaced, mergedCount };
}

const syncResult = syncSegments();

console.log(`\n📊 精修结果:`);
console.log(`   applied: ${applied}`);
console.log(`   skipped (low confidence): ${skipped_lowConf}`);
console.log(`   skipped (over ${MAX_SHIFT_S}s shift): ${skipped_overShift}`);
console.log(`   skipped (no change): ${skipped_noChange}`);
if (syncResult) {
  console.log(`   segments[] sync: ${syncResult.replaced} replaced, ${syncResult.mergedCount} merged`);
}

// 备份
const backupPath = editedPath.replace('.json', '_pre_partial_refine.json');
fs.copyFileSync(editedPath, backupPath);
console.log(`   备份: ${backupPath}`);

if (!data.summary) data.summary = {};
data.summary.partialDeleteOnsetRefine = {
  totalPoints: allPoints.length,
  applied,
  skippedLowConf: skipped_lowConf,
  skippedOverShift: skipped_overShift,
  skippedNoChange: skipped_noChange,
};

fs.writeFileSync(editedPath, JSON.stringify(data, null, 2));
console.log(`✅ 已更新 delete_segments_edited.json（${applied} 个 partial_delete 端点精修完成）`);
