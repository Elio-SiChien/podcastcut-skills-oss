#!/usr/bin/env bash
# Regression test: ensure ASR model in aliyun_funasr_transcribe.sh is 'fun-asr'.
#
# 背景：辟客 EP21 task #7（2026-06-09）发现 paraformer-v2 在长 utterance 上
# 时间戳偏 1s+，下游 cut_audio.py 切在词中间漏剪/误剪。回切到 fun-asr。
# 之后未来再换模型必须经过 timestamp accuracy validation——
# 这个测试守住"别人不小心在脚本里换回 paraformer-v2 而没跑回归"的 case。
#
# 用法: bash test_asr_model.sh [path/to/aliyun_funasr_transcribe.sh]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_SCRIPT="$SCRIPT_DIR/../aliyun_funasr_transcribe.sh"
SCRIPT="${1:-$DEFAULT_SCRIPT}"

if [[ ! -f "$SCRIPT" ]]; then
    echo "❌ 找不到脚本: $SCRIPT" >&2
    exit 1
fi

# 期望的 model 字段
EXPECTED_MODEL="fun-asr"

# 抓取实际 model: '<value>' 字符串（应当只有一处）
ACTUAL=$(grep -oE "model: '[^']+'" "$SCRIPT" | head -1 | sed -E "s/model: '([^']+)'/\1/")

if [[ -z "$ACTUAL" ]]; then
    echo "❌ 在 $SCRIPT 里找不到 model 字段" >&2
    exit 1
fi

if [[ "$ACTUAL" != "$EXPECTED_MODEL" ]]; then
    echo "❌ ASR model regression: 期望 '$EXPECTED_MODEL'，实际 '$ACTUAL'" >&2
    echo "   如果故意要换模型，请先跑词级时间戳 validation：" >&2
    echo "   - 取一段已知音频，跑新 ASR + Whisper，对比各词时间戳偏差 ≤ 0.3s" >&2
    echo "   - 通过后再改本脚本 + 更新本测试的 EXPECTED_MODEL" >&2
    exit 1
fi

echo "✅ ASR model = '$ACTUAL'"
