#!/usr/bin/env python3
"""
silence-snap 单测：用合成的 (delete_segs, silences) 喂 snap 函数，断言扩展后的结果。

也包括一个 e2e 回归 case，可选 --e2e 跑（需要 ffmpeg + whisper + sample audio）。

用法：
    python3 test_silence_snap.py          # 跑合成单测
    python3 test_silence_snap.py --e2e <audio.mp3>  # 加跑 e2e（需要 whisper）
"""

import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cut_audio import snap_delete_segments_to_silences


def assert_close(actual, expected, tol=0.001, label=""):
    if abs(actual - expected) > tol:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")


def test_long_delete_extends_end_to_furthest_silence():
    """长 delete（4.21s）末尾 0.07s 处有近静音、0.80s 处有远静音 → snap 到远静音"""
    deletes = [{'start': 5.72, 'end': 9.93}]  # 长 delete
    silences = [
        (5.72, 6.03),  # ASR 句子前的静音（delete 已包住）
        (9.999, 10.127),  # delete.end 后近的小静音
        (10.734, 11.161),  # delete.end 后远的真静音 — 应该 snap 到这里
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['end'], 11.161, label="long delete end snap to farthest silence")
    assert stats['snap_end_count'] == 1, f"expected 1 end snap, got {stats}"
    print("✅ test_long_delete_extends_end_to_furthest_silence")


def test_long_delete_extends_start_to_earliest_silence():
    """长 delete 头部 0.07s 处有近静音、0.80s 处有远静音 → snap 到远静音（最早）"""
    deletes = [{'start': 9.93, 'end': 14.5}]  # 长 delete
    silences = [
        (9.10, 9.50),  # 远静音
        (9.85, 9.90),  # 近静音
        (14.7, 15.0),  # 后面的静音
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['start'], 9.10, label="long delete start snap to earliest silence")
    assert stats['snap_start_count'] == 1
    print("✅ test_long_delete_extends_start_to_earliest_silence")


def test_short_delete_is_not_snapped():
    """短 delete（0.3s，filler）应保持原边界 — 不冒险吸到假静音"""
    deletes = [{'start': 572.763, 'end': 573.030}]  # 0.27s filler
    silences = [
        (572.5, 572.7),  # 近静音
        (573.05, 574.0),  # 大静音 — 短 delete 不应吸过去
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['start'], 572.763, label="short delete start unchanged")
    assert_close(snapped[0]['end'], 573.030, label="short delete end unchanged")
    assert stats['snap_start_count'] == 0 and stats['snap_end_count'] == 0
    print("✅ test_short_delete_is_not_snapped")


def test_neighbor_constraint_or_merge():
    """两个相邻长 delete 中间有静音时：
    要么 snap 各自不跨边界，要么 snap 导致重叠然后被 merge 成一个
    （都是正确行为，关键是不能产生非法 overlap segments）"""
    deletes = [
        {'start': 100.0, 'end': 105.0},
        {'start': 107.0, 'end': 112.0},
    ]
    silences = [
        (99.5, 99.8),
        (105.5, 106.5),  # 落在两个 delete 中间
        (112.2, 112.7),
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    # 结果要么是 2 个不重叠 segments，要么是 1 个合并后的
    assert len(snapped) in (1, 2), f"unexpected segments count: {len(snapped)}"
    # 所有 segments 必须升序、不重叠
    for j in range(len(snapped) - 1):
        assert snapped[j]['end'] <= snapped[j+1]['start'], f"overlap: {snapped[j]} vs {snapped[j+1]}"
    # 至少应该有 1 个 end snap（第一个 delete end 应被吸到 106.5）
    assert stats['snap_end_count'] >= 1
    print(f"✅ test_neighbor_constraint_or_merge ({len(snapped)} segments after snap)")


def test_window_limits_snap_distance():
    """超出 window 的静音不能被吸到"""
    deletes = [{'start': 100.0, 'end': 105.0}]  # 长 delete
    silences = [
        (95.0, 95.5),  # 距 start 4.5s — 远超 1.5s window
        (110.0, 111.0),  # 距 end 5.0s — 远超 window
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['start'], 100.0, label="start no snap when silence outside window")
    assert_close(snapped[0]['end'], 105.0, label="end no snap when silence outside window")
    print("✅ test_window_limits_snap_distance")


def test_no_silences_means_no_snap():
    """没有任何检测到的静音 → delete_segs 不变"""
    deletes = [{'start': 1.0, 'end': 3.0}]
    silences = []
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['start'], 1.0)
    assert_close(snapped[0]['end'], 3.0)
    print("✅ test_no_silences_means_no_snap")


def test_meta_delete_skips_snap():
    """超长 delete（meta 删整个 pre-show / 结尾）不 snap，避免吃主内容开头/结尾。
    EP21 实测 case：head 删 0-459s + 邻近主内容在 460-462s 区间。
    旧 snap 把 head.end 吸到 461.92（吃掉了'嗯嗯，大家好，欢迎来到辟客'）。
    加 max_delete=60s guard 后，head delete 保持 0-459，不动主内容。"""
    deletes = [{'start': 0.0, 'end': 459.0}]  # 459s 长，meta delete
    silences = [
        (459.443, 459.799),  # 小静音
        (461.83, 461.922),   # 主内容里的静音 — 旧逻辑会吸到这里把"辟客"吃掉
    ]
    snapped, stats = snap_delete_segments_to_silences(deletes, silences)
    assert_close(snapped[0]['end'], 459.0, label="meta delete end unchanged")
    assert stats['snap_end_count'] == 0
    print("✅ test_meta_delete_skips_snap")


def main():
    print("Running silence-snap unit tests...\n")
    test_long_delete_extends_end_to_furthest_silence()
    test_long_delete_extends_start_to_earliest_silence()
    test_short_delete_is_not_snapped()
    test_neighbor_constraint_or_merge()
    test_window_limits_snap_distance()
    test_no_silences_means_no_snap()
    test_meta_delete_skips_snap()
    print("\n✅ All 7 unit tests passed")


if __name__ == '__main__':
    main()
