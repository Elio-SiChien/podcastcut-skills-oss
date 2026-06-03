#!/bin/bash
#
# 阿里云 DashScope paraformer-v2 热词（vocabulary）注册脚本
#
# 把 profile.glossary 里的人名/品牌/术语注册到 DashScope，拿到 vocabulary_id
# 用法:
#   bash register_hot_words.sh '["清扬","响歌歌","辟客"]' [输出文件路径]
#   bash register_hot_words.sh @path/to/glossary.json [输出文件路径]
#
# 输出: 写 vocabulary_id 到 输出文件路径（默认 ./vocabulary_id.txt）
#
# 文档:
#   https://help.aliyun.com/zh/model-studio/custom-hot-words/
#   API: POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization
#   model: speech-biasing, action: create_vocabulary, target_model: paraformer-v2
#

set -e

# 自动加载 .env（与 aliyun_funasr_transcribe.sh 同款逻辑）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${SKILL_DIR:+$SKILL_DIR/.env}"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
if [ -z "$DASHSCOPE_API_KEY" ] && [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
fi

# 参数检查
if [ -z "$1" ]; then
    echo "❌ 错误：请提供 glossary JSON 数组（或 @文件路径）" >&2
    echo "" >&2
    echo "用法:" >&2
    echo "  bash register_hot_words.sh '[\"清扬\",\"响歌歌\"]' [输出路径]" >&2
    echo "  bash register_hot_words.sh @profile.json [输出路径]   # 从 profile.json.glossary 读" >&2
    exit 1
fi

GLOSSARY_INPUT="$1"
OUTPUT_FILE="${2:-./vocabulary_id.txt}"

if [ -z "$DASHSCOPE_API_KEY" ]; then
    echo "❌ 错误：未设置 DASHSCOPE_API_KEY" >&2
    exit 1
fi

# 解析输入 → words JSON 数组
# 支持 @file（profile.json 取 .glossary，或裸数组文件）
WORDS_JSON=$(node -e "
const fs = require('fs');
const arg = process.argv[1];
let raw;
if (arg.startsWith('@')) {
  raw = fs.readFileSync(arg.slice(1), 'utf8');
} else {
  raw = arg;
}
const parsed = JSON.parse(raw);
const words = Array.isArray(parsed) ? parsed : (parsed.glossary || []);
if (!Array.isArray(words) || words.length === 0) {
  console.error('glossary 为空或不是数组');
  process.exit(2);
}
// 阿里云约束: 单条 ≤15 个非 ASCII 字符；过滤空串/重复；最多 500 条
const seen = new Set();
const filtered = [];
for (const w of words) {
  if (typeof w !== 'string') continue;
  const t = w.trim();
  if (!t || seen.has(t)) continue;
  if ([...t].length > 15) continue;  // 阿里云上限
  seen.add(t);
  filtered.push(t);
  if (filtered.length >= 500) break;
}
if (filtered.length === 0) {
  console.error('过滤后无有效词');
  process.exit(2);
}
// 转 vocabulary 数组：默认 weight=4, lang=zh
const vocab = filtered.map(text => ({ text, weight: 4, lang: 'zh' }));
console.log(JSON.stringify(vocab));
" "$GLOSSARY_INPUT")

WORD_COUNT=$(echo "$WORDS_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).length))")

# prefix: 必须 1-10 字符，字母数字下划线；用 podcst 固定前缀，避免账户里残留过多
PREFIX="${HOT_WORDS_PREFIX:-podcst}"

echo "🔥 注册阿里云 paraformer-v2 热词" >&2
echo "   词数: $WORD_COUNT" >&2
echo "   prefix: $PREFIX" >&2

# DRY_RUN: 仅打印 payload 不调用 API
if [ "${DRY_RUN:-0}" = "1" ]; then
    PAYLOAD=$(node -e "
      const v = JSON.parse(process.argv[1]);
      const body = {
        model: 'speech-biasing',
        input: { action: 'create_vocabulary', target_model: 'paraformer-v2', prefix: process.argv[2], vocabulary: v }
      };
      process.stdout.write(JSON.stringify(body, null, 2));
    " "$WORDS_JSON" "$PREFIX")
    echo "" >&2
    echo "[DRY_RUN] 将要 POST 的 body:" >&2
    echo "$PAYLOAD" >&2
    echo "[DRY_RUN] 跳过实际 API 调用" >&2
    # DRY_RUN 写入 fake id 方便链路测试
    DRY_ID="vocab-${PREFIX}-DRYRUN0000000000000000"
    mkdir -p "$(dirname "$OUTPUT_FILE")"
    echo "$DRY_ID" > "$OUTPUT_FILE"
    echo "[DRY_RUN] 已写入 fake vocabulary_id 到 $OUTPUT_FILE: $DRY_ID" >&2
    exit 0
fi

# 构造完整 body 并 POST
RESPONSE=$(node -e "
  const v = JSON.parse(process.argv[1]);
  const body = {
    model: 'speech-biasing',
    input: { action: 'create_vocabulary', target_model: 'paraformer-v2', prefix: process.argv[2], vocabulary: v }
  };
  process.stdout.write(JSON.stringify(body));
" "$WORDS_JSON" "$PREFIX" | curl -s -X POST "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @-)

# 提取 vocabulary_id
VOCAB_ID=$(echo "$RESPONSE" | node -e "
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    try {
      const r = JSON.parse(raw);
      const id = r.output && r.output.vocabulary_id;
      if (id) process.stdout.write(id);
    } catch (e) {}
  });
")

if [ -z "$VOCAB_ID" ]; then
  echo "❌ 注册失败" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
echo "$VOCAB_ID" > "$OUTPUT_FILE"
echo "✅ 热词已注册" >&2
echo "   vocabulary_id: $VOCAB_ID" >&2
echo "   已写入: $OUTPUT_FILE" >&2

# stdout 输出 vocabulary_id 便于 pipe
echo "$VOCAB_ID"
