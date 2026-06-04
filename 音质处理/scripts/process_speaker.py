#!/usr/bin/env python3
"""
按说话人段落运行 DeepFilterNet 降噪/去回声。

只处理指定说话人的段落，其他段落原样保留；处理段和原始段衔接处做 crossfade。

2026-06-04 重写要点（fix batch for bugs #2/#3/#4/#7/#8/#10/#11）:
  - 用 deepfilternet 的 Python API（`from df.enhance import enhance, init_df`）
    一次性 init 模型，循环 enhance per segment。绕过原来的 subprocess CLI
    每段重载模型的瓶颈（172 段从 ~30 min 降到 ~5 min）。
  - 同时也避免 subprocess 跑多次后失败、stderr 被截断、tmp_dir 状态累积
    几个连带 bug。
  - 解码保留原始声道（stereo 保 stereo），输出格式按输入扩展名匹配
    （.m4a in → .m4a out via AAC，.mp3 in → .mp3 out via libmp3lame）。
  - 备份**输入**文件而不是看输出是否存在。
  - crossfade 从备份的 ORIGINAL 段读，不是从 result_audio 读，避免相邻
    处理段在衔接处双重 mix。
  - 删了 dead arg --speaker-mapping（脚本根本没用，subtitles_words.json
    已经带真名 speaker 字段）。

用法:
  python3 process_speaker.py \
    --audio podcast.m4a \
    --words subtitles_words.json \
    --speakers "清扬,响歌歌" \
    --output audio_denoised.m4a \
    [--bitrate 192k] [--preview-only --preview-dir ./previews]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections import defaultdict

import numpy as np
import soundfile as sf

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

CROSSFADE_MS = 50      # 衔接处 crossfade 毫秒数
MERGE_GAP_S = 0.5      # 间隔 < 此值的段落合并处理
MIN_SEG_S = 0.3        # 小于此值的段落跳过（短到不值得跑模型）
DF_SR = 48000          # DeepFilterNet 模型采样率（固定 48k）


def load_speaker_segments(words_path):
    """从 subtitles_words.json 提取每个说话人的连续时间段。"""
    with open(words_path) as f:
        words = json.load(f)

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

        if speaker == current_speaker and seg_end is not None and start - seg_end < MERGE_GAP_S:
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


def decode_audio(audio_path, target_sr=DF_SR):
    """
    解码音频为 numpy float32 array (samples × channels)，保留原始声道。

    DeepFilterNet 要求 48 kHz；上游通常是 32 kHz/44.1 kHz/48 kHz，ffmpeg 会
    把任何源升采到 DF_SR。声道保留：mono 还是 mono，stereo 还是 stereo —
    模型对每个声道独立处理。
    """
    # ffprobe → 拿原始声道数（保留 stereo 必要的信息）
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
         '-show_entries', 'stream=channels', '-of', 'csv=p=0', audio_path],
        capture_output=True, text=True, check=True,
    )
    orig_channels = max(1, int(probe.stdout.strip() or '1'))

    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    try:
        cmd = ['ffmpeg', '-i', audio_path, '-vn', '-acodec', 'pcm_s16le',
               '-ar', str(target_sr), '-ac', str(orig_channels), '-y', tmp.name]
        subprocess.run(cmd, capture_output=True, check=True)
        data, sr = sf.read(tmp.name, dtype='float32', always_2d=True)
        return data, sr, orig_channels
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass


def init_deepfilter():
    """
    Init DF model once. Returns (model, df_state, suggested_sr).

    deepfilternet 的 Python API 把模型加载（最贵的一步，1-2 秒）从循环里拎
    出来 — 之前 CLI 是 per-call init，172 段累积 5-10 min 纯浪费。
    """
    from df.enhance import init_df  # late import — heavy module
    model, df_state, _ = init_df()
    return model, df_state


def enhance_segment(audio_mono_48k, model, df_state):
    """
    在已初始化的模型上跑一次 enhance。

    audio_mono_48k: 1-D float32 array @ 48 kHz, mono
    return: 1-D float32 array, same length (DF may shave a few samples;
            we pad/trim to match)
    """
    import torch  # late
    from df.enhance import enhance as df_enhance
    t = torch.from_numpy(audio_mono_48k).unsqueeze(0)  # (1, N)
    enhanced = df_enhance(model, df_state, t).squeeze(0).cpu().numpy()
    # Length match — DF can output ±1-2 samples off
    L = len(audio_mono_48k)
    if len(enhanced) >= L:
        enhanced = enhanced[:L]
    else:
        enhanced = np.concatenate([enhanced, np.zeros(L - len(enhanced), dtype=enhanced.dtype)])
    return enhanced


def enhance_multichannel(segment_2d, model, df_state):
    """Run DF on each channel independently, recombine."""
    out = np.empty_like(segment_2d)
    for c in range(segment_2d.shape[1]):
        out[:, c] = enhance_segment(segment_2d[:, c], model, df_state)
    return out


def apply_crossfade(result, original, processed, s_idx, e_idx, fade_samples):
    """
    Write `processed` into result[s_idx:e_idx] with `fade_samples` crossfade
    at each edge. Crossfade ALWAYS reads from `original`, never from
    `result` — otherwise adjacent processed segments compound at the seam
    (bug #8 in 2026-06-03 review).

    All arrays are (samples × channels). Lengths checked, processed
    pad/trimmed to seg_len.
    """
    seg_len = e_idx - s_idx
    if processed.shape[0] != seg_len:
        if processed.shape[0] > seg_len:
            processed = processed[:seg_len]
        else:
            pad = np.zeros((seg_len - processed.shape[0],) + processed.shape[1:], dtype=processed.dtype)
            processed = np.concatenate([processed, pad], axis=0)

    # Centre body — full processed
    result[s_idx:e_idx] = processed

    # Leading fade: original_fade_out + processed_fade_in
    lead = min(fade_samples, seg_len)
    if lead > 0:
        ramp = np.linspace(0.0, 1.0, lead, dtype=processed.dtype)
        if result.ndim == 2:
            ramp = ramp[:, None]
        orig_lead = original[s_idx:s_idx + lead]
        proc_lead = processed[:lead]
        result[s_idx:s_idx + lead] = orig_lead * (1.0 - ramp) + proc_lead * ramp

    # Trailing fade: processed_fade_out + original_fade_in
    trail_start = max(s_idx, e_idx - fade_samples)
    trail_len = e_idx - trail_start
    if trail_len > 0:
        ramp = np.linspace(1.0, 0.0, trail_len, dtype=processed.dtype)
        if result.ndim == 2:
            ramp = ramp[:, None]
        offset = trail_start - s_idx
        proc_trail = processed[offset:offset + trail_len]
        orig_trail = original[trail_start:e_idx]
        result[trail_start:e_idx] = proc_trail * ramp + orig_trail * (1.0 - ramp)


def encode_output(wav_data, sr, output_path, bitrate='192k'):
    """
    Encode numpy → output, picking codec by extension. Supports mono and
    stereo identically since soundfile/ffmpeg both handle 2-D arrays.

    .mp3 → libmp3lame
    .m4a / .aac → aac  (+ MP4Box-style elst stripping handled in the caller
                        if needed; cut_audio.py owns that pattern)
    .wav → pcm passthrough
    """
    ext = os.path.splitext(output_path)[1].lower()
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    try:
        sf.write(tmp.name, wav_data, sr)
        if ext == '.wav':
            shutil.copy2(tmp.name, output_path)
            return
        if ext in ('.m4a', '.aac', '.mp4'):
            codec_args = ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart']
        else:  # default mp3
            codec_args = ['-c:a', 'libmp3lame', '-b:a', bitrate]
        cmd = ['ffmpeg', '-i', tmp.name, *codec_args, '-y', output_path]
        subprocess.run(cmd, capture_output=True, check=True)
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass


def format_time(seconds):
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def backup_input(audio_path):
    """
    Make `<name>_pre_audio_fix.<ext>` next to the input. Match the name
    promised by SKILL.md 红线 #2. Idempotent — won't overwrite if backup
    already exists (typical re-run case).
    """
    base, ext = os.path.splitext(audio_path)
    backup = f"{base}_pre_audio_fix{ext}"
    if not os.path.exists(backup):
        shutil.copy2(audio_path, backup)
        print(f"   📁 输入已备份 → {backup}")
    else:
        print(f"   📁 已有备份，跳过 → {backup}")
    return backup


def main():
    parser = argparse.ArgumentParser(description='按说话人降噪/去回声')
    parser.add_argument('--audio', required=True, help='音频文件路径')
    parser.add_argument('--words', required=True, help='subtitles_words.json 路径')
    parser.add_argument('--speakers', required=True, help='要处理的说话人（逗号分隔）')
    parser.add_argument('--music-segments', help='music_segments.json 路径（跳过音乐段）')
    parser.add_argument('--output', help='输出音频路径（按 ext 自动选 codec）')
    parser.add_argument('--bitrate', default='192k', help='输出码率（默认 192k）')
    parser.add_argument('--no-backup', action='store_true', help='跳过输入备份')
    parser.add_argument('--preview-only', action='store_true', help='只生成试听对比片段')
    parser.add_argument('--preview-dir', default='./previews', help='试听片段输出目录')
    parser.add_argument('--preview-count', type=int, default=3, help='试听片段数量')
    parser.add_argument('--preview-duration', type=float, default=15.0, help='每段试听时长（秒）')
    args = parser.parse_args()

    target_speakers = [s.strip() for s in args.speakers.split(',')]
    print(f"🎙️ 开始按说话人音质处理")
    print(f"   音频: {args.audio}")
    print(f"   目标说话人: {', '.join(target_speakers)}")

    # 1. 备份输入（红线 #2）
    if not args.preview_only and not args.no_backup:
        backup_input(args.audio)

    # 2. 解码音频（保留声道）
    print("   解码音频...")
    audio_data, sr, n_chan = decode_audio(args.audio)
    total_samples = audio_data.shape[0]
    fade_samples = int(CROSSFADE_MS / 1000.0 * sr)
    print(f"   采样率: {sr}Hz, 声道: {n_chan}, 时长: {format_time(total_samples / sr)}")

    # 3. 段落
    all_segments = load_speaker_segments(args.words)

    # 4. 音乐段（如有）
    music_ranges = []
    if args.music_segments and os.path.exists(args.music_segments):
        with open(args.music_segments) as f:
            music_data = json.load(f)
        music_ranges = [(s['start'], s['end']) for s in music_data.get('music_segments', [])]
        if music_ranges:
            print(f"   已加载 {len(music_ranges)} 个音乐段，处理时将跳过")
    def in_music_range(start, end):
        return any(start < me and end > ms for ms, me in music_ranges)

    # 5. 收集要处理的段落
    segments_to_process = []
    for speaker in target_speakers:
        if speaker not in all_segments:
            print(f"   ⚠️ 说话人 '{speaker}' 未找到，跳过")
            continue
        for seg_start, seg_end in all_segments[speaker]:
            if in_music_range(seg_start, seg_end):
                continue
            if seg_end - seg_start < MIN_SEG_S:
                continue
            segments_to_process.append((seg_start, seg_end, speaker))
    segments_to_process.sort(key=lambda x: x[0])
    total_process_dur = sum(e - s for s, e, _ in segments_to_process)
    print(f"   共 {len(segments_to_process)} 段需要处理，总计 {format_time(total_process_dur)}")
    if not segments_to_process:
        print("   没有需要处理的段落，退出")
        return

    # 6. Init DF model ONCE
    print("   初始化 DeepFilterNet 模型...")
    t0 = time.monotonic()
    model, df_state = init_deepfilter()
    print(f"   ✓ 模型 ready ({time.monotonic() - t0:.1f}s)")

    # 7. Preview mode
    if args.preview_only:
        print(f"\n📢 生成试听对比片段...")
        os.makedirs(args.preview_dir, exist_ok=True)
        step = max(1, len(segments_to_process) // (args.preview_count + 1))
        preview_indices = [step * (i + 1) for i in range(args.preview_count)]
        preview_indices = [i for i in preview_indices if i < len(segments_to_process)]
        for idx, pi in enumerate(preview_indices):
            seg_start, seg_end, speaker = segments_to_process[pi]
            center = (seg_start + seg_end) / 2
            half_dur = args.preview_duration / 2
            clip_start = max(0, center - half_dur)
            clip_end = min(total_samples / sr, center + half_dur)
            s_idx = int(clip_start * sr)
            e_idx = int(clip_end * sr)
            clip_data = audio_data[s_idx:e_idx]
            before_path = os.path.join(args.preview_dir, f'preview_before_{idx+1}.mp3')
            after_path = os.path.join(args.preview_dir, f'preview_after_{idx+1}.mp3')
            encode_output(clip_data, sr, before_path, args.bitrate)
            processed = enhance_multichannel(clip_data, model, df_state)
            encode_output(processed, sr, after_path, args.bitrate)
            print(f"   片段 {idx+1}: {format_time(clip_start)}-{format_time(clip_end)} ({speaker})")
            print(f"      处理前: {before_path}")
            print(f"      处理后: {after_path}")
        print(f"\n✅ 试听对比片段已生成 → {args.preview_dir}")
        return

    # 8. 完整处理
    if not args.output:
        print("❌ 完整处理模式需要 --output 参数")
        sys.exit(1)

    print(f"\n🔧 开始 DeepFilterNet 处理（声道={n_chan}, batch via Python API）...")
    original = audio_data        # 不动，crossfade 读这里
    result = audio_data.copy()   # 写到这里
    fail_count = 0
    fail_details = []

    t_proc_start = time.monotonic()
    for i, (seg_start, seg_end, speaker) in enumerate(segments_to_process):
        s_idx = max(0, min(int(seg_start * sr), total_samples))
        e_idx = max(0, min(int(seg_end * sr), total_samples))
        segment = original[s_idx:e_idx]
        progress = f"[{i+1}/{len(segments_to_process)}]"
        print(f"   {progress} {speaker} {format_time(seg_start)}-{format_time(seg_end)} "
              f"({(seg_end-seg_start):.1f}s)")
        try:
            processed = enhance_multichannel(segment, model, df_state)
        except Exception as e:
            # 完整错误进 log，不再 [:200] 截断
            fail_count += 1
            fail_details.append((i + 1, str(e)))
            print(f"   ⚠️ enhance 失败（保留原段）: {e}")
            continue
        apply_crossfade(result, original, processed, s_idx, e_idx, fade_samples)

    proc_dur = time.monotonic() - t_proc_start
    print(f"\n   ⏱ DeepFilterNet 总耗时 {proc_dur/60:.1f} min "
          f"(per-segment avg {proc_dur/len(segments_to_process):.2f}s)")
    if fail_count:
        print(f"   ⚠️ 共 {fail_count} 段失败:")
        for n, err in fail_details[:10]:
            print(f"      seg {n}: {err}")
        if len(fail_details) > 10:
            print(f"      …还有 {len(fail_details) - 10} 段类似失败")

    # 9. Output
    print(f"   编码输出 ({args.bitrate}, ext={os.path.splitext(args.output)[1] or '.mp3'})...")
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    encode_output(result, sr, args.output, args.bitrate)
    print(f"\n✅ 音质处理完成 → {args.output}")
    print(f"   成功处理 {len(segments_to_process) - fail_count} / {len(segments_to_process)} 段")
    if fail_count == 0:
        print(f"   所有段都已降噪 ✓")


if __name__ == '__main__':
    main()
