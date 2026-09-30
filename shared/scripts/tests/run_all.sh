#!/usr/bin/env bash
# Run all regression tests in shared/scripts/tests/.
# 用法: bash run_all.sh

set -u  # 不用 -e，让所有 test 跑完拿 summary

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONUTF8=1
PYTHON_BIN="${PYTHON:-python}"
PASS=0
FAIL=0
FAILED_TESTS=()

run_test() {
    local name="$1"
    shift
    echo "═══ $name ═══"
    if "$@"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
    echo
}

# silence-snap unit tests (skip 如果文件还没 ship——本 PR 不 ship 该测试，
# 它在 silence-snap PR #76 里；merge 后 run_all 会自动跑上)
if [[ -f "$SCRIPT_DIR/test_silence_snap.py" ]]; then
    run_test "silence-snap unit tests" "$PYTHON_BIN" "$SCRIPT_DIR/test_silence_snap.py"
else
    echo "═══ silence-snap unit tests ═══"
    echo "⏭️  跳过：test_silence_snap.py 不存在（由 PR #76 提供）"
    echo
fi

# ASR model/alignment regression
run_test "ASR model/alignment contract" bash "$SCRIPT_DIR/test_asr_model.sh"

# Punctuation density on fixture
run_test "Punctuation density (fixture)" "$PYTHON_BIN" "$SCRIPT_DIR/test_punctuation_density.py"

# CLI status/validate smoke test
run_test "CLI status/validate smoke" bash "$SCRIPT_DIR/test_cli_smoke.sh"

# KISS episode workflow guard
run_test "episode workflow guard" bash "$SCRIPT_DIR/test_episode_workflow.sh"

echo "═══ SUMMARY ═══"
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then
    echo "Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do
        echo "  - $t"
    done
    exit 1
fi
echo "✅ 全部通过"

