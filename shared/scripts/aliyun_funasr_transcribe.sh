#!/bin/bash
#
# 阿里云转录脚本（用于播客剪辑）
# 用法: bash aliyun_funasr_transcribe.sh <音频URL> <说话人数量> [vocabulary_id]
#
# 当前 model: paraformer-v2 + timestamp_alignment_enabled=true
#   - paraformer-v2 用 CIF predictor 出 per-token 真声学对齐时间戳（arXiv:2305.11013）
#   - timestamp_alignment_enabled=true 在播放对齐层做二次校准，消除上游 ~1s 长 utterance 漂
#
# 历史：2026-06-09 (PR #77) 曾从 paraformer-v2 回切到 fun-asr。当时归因是"paraformer 长
# utterance 漂 1.45s"。事后查证：那次测试**未传 timestamp_alignment_enabled**，所以走的是
# paraformer 默认（未对齐）路径。复测发现该 flag 把 EP21 同一段差异降到 ~180ms。
# 同时 fun-asr 暴露了新坑：在某些输入音频特性下（如 44.1kHz stereo MP3）内部走 16kHz 降采样
# pipeline + 后处理均分时间戳（所有字 234ms 等分），用户半句删和 highlight 跟读会漂 0.2-2s。
# 所以 paraformer-v2 + alignment 是更稳的默认。详见 PR #80 描述。
#
# vocabulary_id 可选：paraformer-v2 热词表 ID（见 register_hot_words.sh）。本次切回 paraformer
# 也把热词功能找回了 —— fun-asr 时期 vocabulary_id 是被无视的。
# 也可通过环境变量 VOCABULARY_ID 提供。
#

set -e

# 自动加载 .env（如果 DASHSCOPE_API_KEY 未设置）
# 自动检测项目根目录（脚本所在目录向上两级）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${SKILL_DIR:+$SKILL_DIR/.env}"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
if [ -z "$DASHSCOPE_API_KEY" ] && [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
fi

# 检查参数
if [ -z "$1" ]; then
    echo "❌ 错误：请提供音频URL"
    echo ""
    echo "用法: bash aliyun_funasr_transcribe.sh <音频URL> <说话人数量> [vocabulary_id]"
    echo "示例: bash aliyun_funasr_transcribe.sh \"https://example.com/audio.mp3\" 3 vocab-podcst-xxx"
    exit 1
fi

AUDIO_URL="$1"
SPEAKER_COUNT="${2:-2}"  # 默认2个说话人
VOCABULARY_ID="${3:-${VOCABULARY_ID:-}}"  # 可选：CLI 第 3 参数 或 env VOCABULARY_ID

# 检查API Key
if [ -z "$DASHSCOPE_API_KEY" ]; then
    echo "❌ 错误：未设置DASHSCOPE_API_KEY环境变量"
    echo ""
    echo "请设置API Key:"
    echo "  export DASHSCOPE_API_KEY='your-api-key'"
    echo ""
    echo "或在 $ENV_FILE 中配置"
    exit 1
fi

API_KEY="$DASHSCOPE_API_KEY"

echo "🎤 提交阿里云转录任务 (paraformer-v2 + timestamp_alignment_enabled)"
echo "   音频URL: $AUDIO_URL"
echo "   说话人数: $SPEAKER_COUNT"
if [ -n "$VOCABULARY_ID" ]; then
  echo "   热词表: $VOCABULARY_ID"
fi
echo ""

# 用 node 构造 body，避免 shell 字符串拼接漏 escape 或字段位置出错
REQUEST_BODY=$(node -e "
  const url = process.argv[1];
  const speakerCount = parseInt(process.argv[2], 10);
  const vocabId = process.argv[3] || '';
  const params = {
    diarization_enabled: true,
    speaker_count: speakerCount,
    channel_id: [0],
    // timestamp_alignment_enabled: 把 paraformer-v2 CIF 输出的 token 时间戳再做一次播放对齐校准。
    // 不开的话 paraformer-v2 在长 utterance 上有时偏 1s+（PR #77 把这归因为 paraformer 不可靠）。
    // 开了以后实测 EP21 同一段漂从 1.45s 降到 ~180ms（refine_boundaries.py 能覆盖）。
    timestamp_alignment_enabled: true
  };
  if (vocabId) params.vocabulary_id = vocabId;
  const body = {
    model: 'paraformer-v2',
    input: { file_urls: [url] },
    parameters: params
  };
  process.stdout.write(JSON.stringify(body));
" "$AUDIO_URL" "$SPEAKER_COUNT" "$VOCABULARY_ID")

# DRY_RUN：仅打印 body，不调用 API（测试用）
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[DRY_RUN] 转录请求 body:"
  echo "$REQUEST_BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
  echo "[DRY_RUN] 跳过实际 API 调用"
  exit 0
fi

# 提交任务
RESPONSE=$(echo "$REQUEST_BODY" | curl -s -X POST "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-DashScope-Async: enable" \
  -d @-)

# 检查提交结果
TASK_ID=$(echo "$RESPONSE" | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TASK_ID" ]; then
  echo "❌ 提交失败"
  echo "$RESPONSE"
  exit 1
fi

echo "✅ 任务已提交"
echo "   任务ID: $TASK_ID"
echo ""
echo "⏳ 等待转录完成（预计3-15分钟）..."

# 轮询结果
ATTEMPT=0
MAX_ATTEMPTS=300  # 最多等待25分钟

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 5
  ATTEMPT=$((ATTEMPT + 1))

  QUERY_RESPONSE=$(curl -s -X GET "https://dashscope.aliyuncs.com/api/v1/tasks/$TASK_ID" \
    -H "Authorization: Bearer $API_KEY")

  STATUS=$(echo "$QUERY_RESPONSE" | grep -o '"task_status":"[^"]*"' | cut -d'"' -f4)

  if [ "$STATUS" = "SUCCEEDED" ]; then
    echo ""
    echo "✅ 转录完成！"

    # 保存API响应
    echo "$QUERY_RESPONSE" > aliyun_funasr_result.json
    echo "   已保存API响应: aliyun_funasr_result.json"

    # 提取转录 URL —— 用 node 精确解析单个 URL
    # （旧 bug：grep 会匹配到多个 transcription_url[output层+results嵌套层] → 变量多行多值 → curl 失败 → 静默 0 字节）
    TRANSCRIPTION_URL=$(node -e "const r=JSON.parse(require('fs').readFileSync('aliyun_funasr_result.json','utf8'));process.stdout.write((r.output&&r.output.results&&r.output.results[0]&&r.output.results[0].transcription_url)||(r.output&&r.output.transcription_url)||'')")

    if [ -n "$TRANSCRIPTION_URL" ]; then
      echo "   下载转录内容..."
      curl -sL "$TRANSCRIPTION_URL" -o aliyun_funasr_transcription.json   # -L 跟随 OSS 重定向
      # 校验：非空且合法 JSON（旧版这里会静默产出 0 字节）
      if [ ! -s aliyun_funasr_transcription.json ] || ! node -e "JSON.parse(require('fs').readFileSync('aliyun_funasr_transcription.json','utf8'))" 2>/dev/null; then
        echo "❌ 转录结果下载失败或为空。transcription_url: $TRANSCRIPTION_URL"
        exit 1
      fi
      echo "   已保存转录结果: aliyun_funasr_transcription.json"

      # 统计信息
      SENTENCE_COUNT=$(grep -o '"sentence_id"' aliyun_funasr_transcription.json | wc -l | tr -d ' ')
      echo ""
      echo "📊 转录统计:"
      echo "   总句数: $SENTENCE_COUNT"

      # 说话人分布
      node << 'EOF'
const data = require('./aliyun_funasr_transcription.json');
const sentences = data.transcripts[0].sentences;
const speakers = {};
sentences.forEach(s => {
  speakers[s.speaker_id] = (speakers[s.speaker_id] || 0) + 1;
});
console.log('   说话人分布:');
Object.keys(speakers).sort().forEach(spk => {
  const count = speakers[spk];
  const pct = (count / sentences.length * 100).toFixed(1);
  console.log(`     Speaker ${spk}: ${count}句 (${pct}%)`);
});
EOF
    fi

    exit 0

  elif [ "$STATUS" = "FAILED" ]; then
    echo ""
    echo "❌ 转录失败"
    echo "$QUERY_RESPONSE"
    exit 1
  else
    if [ $((ATTEMPT % 12)) -eq 0 ]; then
      echo "   处理中... ($((ATTEMPT * 5)) 秒) 状态: $STATUS"
    else
      echo -n "."
    fi
  fi
done

echo ""
echo "❌ 超时（等待 $((MAX_ATTEMPTS * 5)) 秒）"
exit 1
