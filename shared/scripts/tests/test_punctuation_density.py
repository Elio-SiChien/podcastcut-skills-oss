#!/usr/bin/env python3
"""
Regression test: long sentences must have enough punctuation.

背景：fun-asr 在长 utterance 上 suppress 句中标点 → 句子变成 100+ 字的
no-punct blob，下游审查页/LLM 分句很糟糕。enhance_punctuation.js (PR #29)
专门给这种 utterance 喂 LLM 补标点，恢复 readability。

这个测试守住"enhance_punctuation 步骤被人不小心 skip 了 / LLM 调用挂了 /
脚本路径搬迁后 wiring 断了"等 silent regression。

用法:
    python3 test_punctuation_density.py [path/to/sentences.txt]

Default fixture 是 paraformer-v2 + enhance_punctuation 处理后的 EP21 头
50 句——已知标点密度健康，跑回归看后续修改是否打破这个标准。
"""

import os
import sys


PUNCT_CHARS = set('，。！？、；：…,.!?;:')


def parse_sentences(path):
    """读 sentences.txt，返回 [(idx, speaker, text), ...]"""
    out = []
    with open(path) as f:
        for line in f:
            parts = line.rstrip('\n').split('|')
            if len(parts) < 4:
                continue
            out.append({
                'idx': int(parts[0]),
                'speaker': parts[2],
                'text': parts[3],
            })
    return out


def count_punctuation(text):
    return sum(1 for c in text if c in PUNCT_CHARS)


def assert_long_sentences_have_punctuation(path, max_no_punct_chars=50,
                                            min_punct_for_long=2,
                                            max_violation_ratio=0.1):
    """
    断言：每个长度 > max_no_punct_chars 的句子至少有 min_punct_for_long 个标点。
    允许 max_violation_ratio (default 10%) 的句子违反规则（避免太严苛对特殊场景）。
    """
    sentences = parse_sentences(path)
    long_sentences = [s for s in sentences if len(s['text']) > max_no_punct_chars]

    if not long_sentences:
        print(f"⚠️  {path}: 没有长度 > {max_no_punct_chars} 的句子，跳过密度检查")
        return

    violations = []
    for s in long_sentences:
        punct_count = count_punctuation(s['text'])
        if punct_count < min_punct_for_long:
            violations.append({
                'idx': s['idx'],
                'len': len(s['text']),
                'punct_count': punct_count,
                'text_preview': s['text'][:80] + ('...' if len(s['text']) > 80 else ''),
            })

    violation_ratio = len(violations) / len(long_sentences)
    if violation_ratio > max_violation_ratio:
        print(f"❌ 标点密度回归：{len(violations)}/{len(long_sentences)} 长句标点 < {min_punct_for_long}")
        print(f"   违规比例 {violation_ratio:.1%} > 允许上限 {max_violation_ratio:.1%}")
        print(f"   样例违规句:")
        for v in violations[:5]:
            print(f"   - S{v['idx']} (len={v['len']}, punct={v['punct_count']}): {v['text_preview']!r}")
        print(f"   排查方向：")
        print(f"   - 看 转录/SKILL.md step 6.5：enhance_punctuation.js 还 wired 着吗？")
        print(f"   - 跑 enhance_punctuation.js --dry-run 看 LLM 调用是否成功")
        print(f"   - 是否换了 ASR 模型却没跑这一步")
        sys.exit(1)

    print(f"✅ 标点密度健康：{len(long_sentences)} 个长句，"
          f"{len(violations)} 违规 ({violation_ratio:.1%} ≤ {max_violation_ratio:.1%})")


def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
    else:
        # Default: built-in fixture
        path = os.path.join(os.path.dirname(__file__), 'fixtures', 'sentences_good_punct.txt')

    if not os.path.isfile(path):
        print(f"❌ Fixture file 不存在: {path}", file=sys.stderr)
        sys.exit(1)

    print(f"Testing punctuation density on {path}")
    assert_long_sentences_have_punctuation(path)


if __name__ == '__main__':
    main()
