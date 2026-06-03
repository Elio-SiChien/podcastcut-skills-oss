#!/usr/bin/env node
/**
 * 步骤 5.5（在 generate_sentences 之后、粗剪之前）：长句标点补全
 *
 * 触发：task #13 — 阿里云 FunASR 标点模型在长 utterance 上 suppress 句中标点，
 * 导致约 10% 的句子是 50+ 字符无标点 blob，审查页 readability 极差，下游 LLM 精剪
 * 分析时句界模糊。
 *
 * 算法：
 *   1. 读 sentences.txt + subtitles_words.json
 *   2. 找 "长 + 少标点" 的句子（默认: text > 50 chars AND punct < 2）
 *   3. 每个候选句喂 Claude CLI（`claude -p '<prompt>'`）补全标点
 *   4. 对齐原文 vs LLM 输出，找出新增标点位置
 *   5. 把新增标点 append 到对应 word.text
 *   6. 重写 subtitles_words.json + 重跑 generate_sentences.js（idempotent）
 *
 * 用法：
 *   cd <BASE_DIR>/2_分析
 *   node enhance_punctuation.js
 *
 * 可选 flag：
 *   --threshold <n>  长句最小字符数（默认 50）
 *   --max-punct <n>  最大允许已有标点数（默认 1）
 *   --internal-only  仅插入句中标点（逗号/顿号/分号/冒号），跳过句尾终止符（。！？）。
 *                    用此模式可在 *已有粗/精剪分析的项目* 上跑，因为不会新增句界 →
 *                    generate_sentences 重跑后句索引不变，下游 delete_segments_*.json /
 *                    semantic_deep_analysis.json / fine_analysis.json 仍然有效。
 *                    不带此 flag = 完整模式（允许 LLM 把长 run-on 切成多个句子），
 *                    **必须在跑粗剪/精剪之前**用，否则句索引偏移导致分析数据失效。
 *   --dry-run        只打印不写入
 *
 * 推荐流程位置：
 *   转录 step 6（generate_sentences）后 + 粗剪开始前 → 走完整模式（无 --internal-only）
 *   存量项目想补 readability → 用 --internal-only 保索引兼容
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ===== Args =====
const args = process.argv.slice(2);
const THRESHOLD = parseInt(getArg('--threshold', '50'));
const MAX_PUNCT = parseInt(getArg('--max-punct', '1'));
const DRY_RUN = args.includes('--dry-run');
const INTERNAL_ONLY = args.includes('--internal-only');
const SENTENCE_END_PUNCT = /[。！？!?]/;
const WORDS_PATH = getArg('--words', '../1_转录/subtitles_words.json');
const SENT_PATH = getArg('--sentences', 'sentences.txt');

function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// ===== Chinese punctuation set (what counts as "existing") =====
const PUNCT_CHARS = /[，,。！？!?；;：:、…—\.]/g;

// ===== Load data =====
if (!fs.existsSync(WORDS_PATH)) {
  console.error(`❌ subtitles_words.json not found at ${WORDS_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(SENT_PATH)) {
  console.error(`❌ sentences.txt not found at ${SENT_PATH}`);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
const sentLines = fs.readFileSync(SENT_PATH, 'utf8').trim().split('\n');

// Build sentence → word index range map by parsing sentences.txt
const sentences = sentLines.map(line => {
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const idx = parseInt(parts[0]);
  const [ws, we] = parts[1].split('-').map(Number);
  const sp = parts[2];
  const text = parts.slice(3).join('|');
  return { idx, ws, we, sp, text };
}).filter(Boolean);

// Identify candidates: long + low-punct
function countPunct(s) {
  return (s.match(PUNCT_CHARS) || []).length;
}

const candidates = sentences.filter(s => {
  const text = s.text;
  const len = text.length;
  const np = countPunct(text);
  return len > THRESHOLD && np <= MAX_PUNCT;
});

console.log(`📊 sentences total: ${sentences.length}`);
console.log(`📌 long + low-punct candidates (>${THRESHOLD} chars, ≤${MAX_PUNCT} puncts): ${candidates.length}`);
if (candidates.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

// Need actual_words (the indexable list filtering gaps/speaker labels) to match word indices in sentences.txt
const realWords = words.filter(w => !w.isGap && !w.isSpeakerLabel);

// ===== Call Claude per candidate =====
const PROMPT = '给下面这段中文口语补全合理的标点（中文逗号、句号、问号），保留所有原字符不变（包括英文和数字）。只返回补完后的文本，不要任何其他文字、解释、引号、换行。';

function callClaude(text) {
  // Use spawnSync to pipe text via stdin (safe for special chars)
  const result = spawnSync('claude', ['-p', PROMPT], {
    input: text,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 90 * 1000,
  });
  if (result.status !== 0) {
    console.error(`  ⚠️ claude CLI failed: ${result.stderr?.slice(0, 200) || 'unknown'}`);
    return null;
  }
  return result.stdout.trim();
}

// ===== Align original vs punctuated text, find inserted-punct positions =====
function findInsertedPuncts(orig, punctuated) {
  // Walk both strings; when chars equal, advance both. When punctuated has
  // a char that's PUNCT and not in orig, record (origPos, punctChar).
  // Returns array of { origPos, punct } sorted ascending. origPos = char
  // index in orig AFTER which the punct should be inserted.
  const inserts = [];
  let i = 0, j = 0;
  while (i < orig.length && j < punctuated.length) {
    if (orig[i] === punctuated[j]) {
      i++; j++;
    } else if (PUNCT_CHARS.test(punctuated[j])) {
      // Reset regex (g-flag stateful)
      PUNCT_CHARS.lastIndex = 0;
      inserts.push({ origPos: i, punct: punctuated[j] });
      j++;
    } else {
      // Mismatch on non-punct (Claude changed a character) → bail, return null
      console.error(`  ⚠️ char mismatch at orig[${i}]=${JSON.stringify(orig[i])} vs llm[${j}]=${JSON.stringify(punctuated[j])} — skipping this sentence`);
      return null;
    }
    PUNCT_CHARS.lastIndex = 0;
  }
  // Catch any trailing punctuation in punctuated (orig exhausted)
  while (j < punctuated.length) {
    if (PUNCT_CHARS.test(punctuated[j])) {
      PUNCT_CHARS.lastIndex = 0;
      inserts.push({ origPos: orig.length, punct: punctuated[j] });
    } else {
      // Extra non-punct char at end — bail
      console.error(`  ⚠️ trailing non-punct char in llm[${j}]=${JSON.stringify(punctuated[j])} — skipping`);
      return null;
    }
    j++;
  }
  // If origPos < orig.length but i didn't fully consume → bail
  if (i < orig.length) {
    console.error(`  ⚠️ orig not fully consumed (i=${i}/${orig.length}) — skipping`);
    return null;
  }
  return inserts;
}

// ===== Apply inserts to words =====
// Each word in sentence range covers char[wordCharStart..wordCharEnd). Find which
// word an insert position belongs to (the word whose char range ends >= origPos).
// Then append the punct char to that word.text. Mutates realWords in place.
function applyInserts(sentence, inserts) {
  if (!inserts.length) return 0;
  const wordRange = realWords.slice(sentence.ws, sentence.we + 1);
  // Compute char start positions per word
  let cc = 0;
  const wordCharRanges = wordRange.map(w => {
    const start = cc;
    const end = cc + w.text.length;
    cc = end;
    return { word: w, start, end };
  });
  let appliedCount = 0;
  // Process inserts in REVERSE so earlier indices stay valid as we modify text lengths
  for (const ins of inserts.slice().reverse()) {
    // Find the word whose range CONTAINS origPos (right-inclusive boundary)
    // Insert AFTER the word that just ended at origPos, i.e., word whose end === origPos
    // Or if origPos is in the middle of a word, insert at boundary inside word — we
    // collapse to "append to that word.text" to keep tokens intact (avoid splitting words).
    let target = null;
    for (let k = wordCharRanges.length - 1; k >= 0; k--) {
      const wr = wordCharRanges[k];
      if (wr.end >= ins.origPos) {
        target = wr;
        if (wr.end === ins.origPos) break;  // exact word-end match preferred
      }
    }
    if (!target) target = wordCharRanges[wordCharRanges.length - 1];
    target.word.text += ins.punct;
    appliedCount++;
  }
  return appliedCount;
}

// ===== Main loop =====
let processed = 0, skipped = 0, totalAppliedPuncts = 0;
const startMs = Date.now();

for (const cand of candidates) {
  process.stdout.write(`  [${cand.idx}] ${cand.text.slice(0, 30)}... `);
  const punctuated = callClaude(cand.text);
  if (!punctuated || punctuated.length === 0) {
    console.log('SKIP (LLM failed/empty)');
    skipped++;
    continue;
  }
  const inserts = findInsertedPuncts(cand.text, punctuated);
  if (inserts === null) {
    console.log('SKIP (alignment failed)');
    skipped++;
    continue;
  }
  // INTERNAL_ONLY: drop句尾终止符（。！？）以保持句索引不变
  let effectiveInserts = inserts;
  if (INTERNAL_ONLY) {
    const before = inserts.length;
    effectiveInserts = inserts.filter(ins => !SENTENCE_END_PUNCT.test(ins.punct));
    const dropped = before - effectiveInserts.length;
    if (dropped > 0) {
      process.stdout.write(`(dropped ${dropped} sent-end) `);
    }
  }
  if (effectiveInserts.length === 0) {
    console.log('no inserts');
    continue;
  }
  if (DRY_RUN) {
    console.log(`+${effectiveInserts.length} puncts (dry-run)`);
  } else {
    const applied = applyInserts(cand, effectiveInserts);
    console.log(`+${applied} puncts`);
    totalAppliedPuncts += applied;
  }
  processed++;
}

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n📈 done: ${processed} processed, ${skipped} skipped, ${totalAppliedPuncts} puncts added (${elapsed}s)`);

if (DRY_RUN) {
  console.log('Dry-run: no files written.');
  process.exit(0);
}

// ===== Write back =====
// realWords were mutated in place but they are filtered FROM `words` (shared object
// references, since filter returns a new array of same elements). So `words` already
// reflects the changes. Just write it back.
fs.writeFileSync(WORDS_PATH, JSON.stringify(words, null, 2));
console.log(`✅ wrote ${WORDS_PATH}`);

// Re-run generate_sentences.js so sentences.txt picks up new punctuation
const genSentScript = path.join(__dirname, 'generate_sentences.js');
const sentDir = path.dirname(SENT_PATH);
try {
  execSync(`node ${JSON.stringify(genSentScript)} ${JSON.stringify(path.resolve(WORDS_PATH))}`, {
    cwd: sentDir || '.',
    stdio: 'inherit',
  });
  console.log(`✅ regenerated sentences.txt`);
} catch (e) {
  console.error(`⚠️ generate_sentences.js failed: ${e.message}`);
  console.error(`  subtitles_words.json was updated; you may need to re-run generate_sentences manually.`);
  process.exit(1);
}

console.log('\n✨ punctuation enhancement complete.');
