#!/usr/bin/env python3
"""
Extract one clean ~10s audio sample per speaker for the speaker-mapping
checkpoint (edit-chat 阶段 3).

The naive approach — take the first 10s the diarizer labels as speaker N —
breaks down whenever the first run is a noisy intro, contains music, or
straddles a diarization mis-segment where another speaker briefly cuts in.
Both failure modes showed up live on EP20 (2026-06-03): speaker 0's sample
was an intro music bed; speaker 1's sample had a second voice mixed in.

This script picks the longest consecutive single-speaker run from the
diarization output and samples from the middle of it (skipping a small
guard on each side so a mis-aligned sentence boundary doesn't bleed in).
Longer runs ≈ higher confidence the diarizer is right ≈ cleaner sample.

usage:
  python3 extract_speaker_samples.py <transcription.json> <audio.mp3> <out_dir>
                                     [--duration 10] [--guard 0.3]
                                     [--mapping speaker_mapping.json]

inputs:
  transcription.json    Aliyun FunASR output (has transcripts[0].sentences[])
  audio.mp3             ORIGINAL audio (not the 16kHz downsampled audio.mp3
                        used for ASR — that one sounds muddy in samples).
                        Convention in the project: 1_转录/audio_original.mp3.
  out_dir               where to write spk<id>_sample.mp3 files (typically
                        1_转录/).

outputs:
  <out_dir>/spk<id>_sample.mp3  per distinct speaker_id in the transcription.

The mapping file is purely informational — when provided, we print a line
per speaker listing the human name we'll show the user. The sample
filenames stay name-free so the agent can re-run after the user fixes the
mapping without needing to rename files.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict


def load_runs(transcription_path):
    """
    Return per-speaker list of (run_start_s, run_end_s, num_sentences).

    A "run" is a maximal stretch of consecutive sentences (in chronological
    order) labeled with the same speaker_id. We rank runs by duration and
    use the longest one as our sample source.
    """
    with open(transcription_path, 'r') as f:
        data = json.load(f)

    sentences = data['transcripts'][0]['sentences']
    if not sentences:
        return {}

    # Sort defensively — the API returns chronological order but we depend on it.
    sentences = sorted(sentences, key=lambda s: s['begin_time'])

    runs = defaultdict(list)
    cur_speaker = sentences[0]['speaker_id']
    cur_start = sentences[0]['begin_time']
    cur_end = sentences[0]['end_time']
    cur_count = 1

    for s in sentences[1:]:
        if s['speaker_id'] == cur_speaker:
            cur_end = s['end_time']
            cur_count += 1
        else:
            runs[cur_speaker].append((cur_start / 1000.0, cur_end / 1000.0, cur_count))
            cur_speaker = s['speaker_id']
            cur_start = s['begin_time']
            cur_end = s['end_time']
            cur_count = 1
    runs[cur_speaker].append((cur_start / 1000.0, cur_end / 1000.0, cur_count))

    return runs


def pick_sample_window(runs_for_speaker, duration, guard):
    """
    Choose [start, end] in seconds for the cleanest sample.

    Strategy:
      1. Prefer the longest run that comfortably fits `duration + 2*guard`.
         Sample from its middle so the first/last sentence in the run
         (where diarization mis-cuts tend to happen) is excluded.
      2. If no run is long enough, take the longest run as-is. The sample
         may be shorter than `duration`, but at least it's the best single
         stretch we have. The agent's chat copy still says "~10s sample".
    """
    if not runs_for_speaker:
        return None
    runs = sorted(runs_for_speaker, key=lambda r: r[1] - r[0], reverse=True)
    min_needed = duration + 2 * guard
    for start, end, _ in runs:
        if end - start >= min_needed:
            mid = (start + end) / 2.0
            return (max(start + guard, mid - duration / 2.0),
                    min(end - guard, mid + duration / 2.0))
    # Fall back to longest available
    start, end, _ = runs[0]
    return (start, end)


def extract_clip(audio_path, start, end, out_path):
    cmd = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-ss', f'{start:.3f}',
        '-to', f'{end:.3f}',
        '-i', audio_path,
        '-c:a', 'libmp3lame', '-b:a', '128k',
        '-ar', '44100', '-ac', '2',
        out_path,
    ]
    subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser(description='Extract clean speaker samples from diarized transcription.')
    p.add_argument('transcription', help='aliyun_funasr_transcription.json')
    p.add_argument('audio', help='original audio file (mp3/wav)')
    p.add_argument('out_dir', help='where to write spk<id>_sample.mp3')
    p.add_argument('--duration', type=float, default=10.0, help='target sample duration in seconds (default 10)')
    p.add_argument('--guard', type=float, default=0.3, help='trim N seconds from each end of the chosen run (default 0.3)')
    p.add_argument('--mapping', default=None, help='optional speaker_mapping.json to print human-readable names')
    args = p.parse_args()

    if not os.path.exists(args.transcription):
        print(f'error: {args.transcription} not found', file=sys.stderr)
        return 2
    if not os.path.exists(args.audio):
        print(f'error: {args.audio} not found', file=sys.stderr)
        return 2
    os.makedirs(args.out_dir, exist_ok=True)

    mapping = {}
    if args.mapping and os.path.exists(args.mapping):
        with open(args.mapping) as f:
            mapping = json.load(f)

    runs = load_runs(args.transcription)
    if not runs:
        print('error: no sentences in transcription', file=sys.stderr)
        return 1

    written = []
    for speaker_id in sorted(runs.keys()):
        window = pick_sample_window(runs[speaker_id], args.duration, args.guard)
        if window is None:
            print(f'⚠️  speaker {speaker_id}: no usable run, skipping', file=sys.stderr)
            continue
        start, end = window
        out_path = os.path.join(args.out_dir, f'spk{speaker_id}_sample.mp3')
        extract_clip(args.audio, start, end, out_path)
        name = mapping.get(str(speaker_id), f'Speaker {speaker_id}')
        # Best-run stats for diagnostics
        longest = max(runs[speaker_id], key=lambda r: r[1] - r[0])
        longest_dur = longest[1] - longest[0]
        print(f'spk{speaker_id} ({name}): {end-start:.1f}s @ {start:.1f}s  '
              f'(picked from {longest_dur:.0f}s solo run, {longest[2]} sentences) → {out_path}')
        written.append(out_path)

    print(f'\n✅ wrote {len(written)} sample(s) to {args.out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
