#!/usr/bin/env bash
# Regression test: ensure aliyun_funasr_transcribe.sh keeps the validated ASR contract.
#
# 当前默认是 paraformer-v2 + timestamp_alignment_enabled=true。
# 背景：PR #77 曾因未开 alignment flag 的测试把 paraformer-v2 判为长 utterance 漂移；
# PR #80 复测后确认 alignment flag 能把同段漂移降到 ~180ms，并恢复热词支持。
# 这个测试守住"别人改模型或关掉 alignment 而没跑时间戳回归"的 case。
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

# 期望的 ASR contract
EXPECTED_MODEL="paraformer-v2"
EXPECTED_ALIGNMENT="true"

# 抓取实际 model: '<value>' 字符串（应当只有一处）
ACTUAL=$(grep -oE "model: '[^']+'" "$SCRIPT" | head -1 | sed -E "s/model: '([^']+)'/\1/")

if [[ -z "$ACTUAL" ]]; then
    echo "❌ 在 $SCRIPT 里找不到 model 字段" >&2
    exit 1
fi

if [[ "$ACTUAL" != "$EXPECTED_MODEL" ]]; then
    echo "❌ ASR model regression: 期望 '$EXPECTED_MODEL'，实际 '$ACTUAL'" >&2
    echo "   如果故意要换模型，请先跑词级时间戳 validation，通过后再更新本测试。" >&2
    exit 1
fi

if ! grep -qE "timestamp_alignment_enabled:[[:space:]]*$EXPECTED_ALIGNMENT" "$SCRIPT"; then
    echo "❌ ASR timestamp alignment regression: 期望 timestamp_alignment_enabled: $EXPECTED_ALIGNMENT" >&2
    echo "   如果故意关闭 alignment，请先验证 partial-delete / highlight 跟读的词级时间戳偏差。" >&2
    exit 1
fi

echo "✅ ASR model = '$ACTUAL', timestamp_alignment_enabled = $EXPECTED_ALIGNMENT"
