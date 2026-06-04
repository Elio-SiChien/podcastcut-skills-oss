#!/usr/bin/env python3
"""
按说话人分析响度（LUFS）。

用法:
  python3 analyze_loudness.py \
    --audio podcast.mp3 \
    --words subtitles_words.json \
    --speaker-mapping speaker_mapping.json \
    --output loudness_report.json

输出 JSON 包含：整体 LUFS、各说话人 LUFS、偏差、建议增益。
"""

import argparse
import json
import sys
import subprocess
import tempfile
import os
from collections import defaultdict

import numpy as np
import soundfile as sf

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


def load_speaker_segments(words_path, mapping_path=None):
    """从 subtitles_words.json 提取每个说话人的连续时间段。

    `mapping_path` 留作兼容性 — subtitles_words.json 的 speaker 字段已经
    是真名，由 generate_subtitles_from_aliyun.js 写入时映射好的，所以
    mapping_path 仅用于 sanity check（可选）。
    """
    with open(words_path) as f:
        words = json.load(f)
    if mapping_path:
        # Optional cross-check only — we don't use mapping for routing.
        try:
            with open(mapping_path) as f:
                json.load(f)  # validate it's well-formed
        except Exception:
            pass

    speaker_segments = defaultdict(list)
    current_speaker = None
    seg_start = None
    seg_end = None

    for w in words:
        if w.get('isGap') or w.get('isSpeakerLabel'):
            continue

        speaker = w.get('speaker')
        if not speaker:
            continue

        start = w.get('start', 0)
        end = w.get('end', 0)

        if speaker == current_speaker and seg_end is not None and start - seg_end < 0.5:
            seg_end = end
        else:
            if current_speaker and seg_start is not None:
                speaker_segments[current_speaker].append((seg_start, seg_end))
            current_speaker = speaker
            seg_start = start
            seg_end = end

    if current_speaker and seg_start is not None:
        speaker_segments[current_speaker].append((seg_start, seg_end))

    return dict(speaker_segments)


def decode_audio(audio_path):
    """解码音频为 numpy array + sample rate, 保留原始声道.

    Bug #2 fix: pyloudnorm 对 stereo 计算的 LUFS 跟 mono 不同（K-weighting +
    channel sum），所以分析时也要保留 stereo。
    """
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
         '-show_entries', 'stream=channels', '-of', 'csv=p=0', audio_path],
        capture_output=True, text=True, check=True,
    )
    orig_channels = max(1, int(probe.stdout.strip() or '1'))

    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    try:
        subprocess.run([
            'ffmpeg', '-i', audio_path, '-vn', '-acodec', 'pcm_s16le',
            '-ar', '48000', '-ac', str(orig_channels), '-y', tmp.name
        ], capture_output=True, check=True)
        data, sr = sf.read(tmp.name)
        return data, sr
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass


def measure_lufs(samples, sr):
    """测量 integrated LUFS（ITU-R BS.1770-4）。"""
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        # pyloudnorm 需要至少 0.4 秒
        if len(samples) < sr * 0.4:
            return None
        lufs = meter.integrated_loudness(samples)
        if np.isinf(lufs) or np.isnan(lufs):
            return None
        return round(lufs, 1)
    except Exception:
        return None


def format_duration(seconds):
    """格式化秒数为 mm:ss。"""
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def main():
    parser = argparse.ArgumentParser(description='按说话人分析响度（LUFS）')
    parser.add_argument('--audio', required=True, help='音频文件路径')
    parser.add_argument('--words', required=True, help='subtitles_words.json 路径')
    parser.add_argument('--speaker-mapping', required=True, help='speaker_mapping.json 路径')
    parser.add_argument('--output', required=True, help='输出 JSON 路径')
    parser.add_argument('--target-lufs', type=float, default=-16.0, help='目标 LUFS（默认 -16）')
    args = parser.parse_args()

    print(f"📊 开始响度分析: {args.audio}")

    # 1. 解码音频
    print("   解码音频...")
    audio_data, sr = decode_audio(args.audio)
    total_duration = len(audio_data) / sr
    print(f"   采样率: {sr}Hz, 时长: {format_duration(total_duration)}")

    # 2. 整体 LUFS
    print("   测量整体响度...")
    overall_lufs = measure_lufs(audio_data, sr)
    print(f"   整体 LUFS: {overall_lufs}")

    # 3. 加载说话人时间段
    print("   加载说话人时间段...")
    speaker_segments = load_speaker_segments(args.words, args.speaker_mapping)

    # 4. 按说话人测量
    speakers_report = {}
    for speaker, segments in sorted(speaker_segments.items()):
        print(f"   分析说话人: {speaker} ({len(segments)} 段)")

        # 拼接该说话人的所有音频段
        speaker_samples = []
        total_speaker_dur = 0.0
        for seg_start, seg_end in segments:
            s_idx = int(seg_start * sr)
            e_idx = int(seg_end * sr)
            s_idx = max(0, min(s_idx, len(audio_data)))
            e_idx = max(0, min(e_idx, len(audio_data)))
            if e_idx > s_idx:
                speaker_samples.append(audio_data[s_idx:e_idx])
                total_speaker_dur += seg_end - seg_start

        if not speaker_samples:
            print(f"   ⚠️ {speaker}: 没有有效音频段")
            continue

        combined = np.concatenate(speaker_samples)
        speaker_lufs = measure_lufs(combined, sr)

        if speaker_lufs is None:
            print(f"   ⚠️ {speaker}: 音频太短，无法测量 LUFS")
            continue

        # Force python-native float/bool so json.dump can serialize them.
        # measure_lufs returns numpy.float64 via pyloudnorm; arithmetic then
        # propagates numpy types into the report dict and breaks json.dump.
        boost_db = float(round(args.target_lufs - speaker_lufs, 1))
        needs_boost = bool(abs(boost_db) > 1.0)  # 超过 1dB 才建议调整

        speakers_report[speaker] = {
            "lufs": float(speaker_lufs),
            "segments_count": len(segments),
            "total_duration": format_duration(total_speaker_dur),
            "total_duration_seconds": round(total_speaker_dur, 1),
            "needs_boost": needs_boost,
            "boost_db": boost_db
        }
        status = "⚠️ 需要调整" if needs_boost else "✅ 正常"
        print(f"   {speaker}: {speaker_lufs} LUFS (偏差 {boost_db:+.1f} dB) {status}")

    # 5. 生成报告
    # overall_lufs comes from pyloudnorm (numpy.float64); force native types
    # to keep json.dump safe (matches the per-speaker boost_db fix below).
    report = {
        "overall_lufs": float(overall_lufs) if overall_lufs is not None else None,
        "target_lufs": float(args.target_lufs),
        "total_duration": format_duration(total_duration),
        "total_duration_seconds": round(total_duration, 1),
        "speakers": speakers_report
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 响度分析完成 → {args.output}")

    # 打印摘要表格
    print(f"\n{'说话人':<8} {'LUFS':<12} {'时长':<10} {'偏差':<10} {'状态'}")
    print("-" * 55)
    for speaker, info in speakers_report.items():
        status = "需要调整" if info["needs_boost"] else "正常"
        print(f"{speaker:<8} {info['lufs']:<12} {info['total_duration']:<10} {info['boost_db']:+.1f} dB{'':<4} {status}")
    print(f"\n目标: {args.target_lufs} LUFS（播客标准）")


if __name__ == '__main__':
    main()
