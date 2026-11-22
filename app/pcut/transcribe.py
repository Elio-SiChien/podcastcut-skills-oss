"""Step ②: decode check + word-level transcription (faster-whisper) + optional speaker separation (CAM++).

Why faster-whisper word timestamps for the timeline (2026-11-22): FunASR paraformer sentence timestamps drifted
25–40 s on a 1-hour episode, so cuts landed in the wrong place. Whisper word timestamps stayed accurate.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from . import config


def decode(src: str | Path, work: Path) -> dict:
    """16 kHz mono wav + compare header duration with decoded duration (catches truncated files)."""
    ff, fp = config.ffmpeg(), config.ffprobe()
    if not ff:
        raise SystemExit("找不到 ffmpeg。运行 `python -m pcut doctor` 看怎么装。")
    work.mkdir(parents=True, exist_ok=True)
    wav = work / "audio16k.wav"
    header = 0.0
    if fp:
        out = subprocess.run([fp, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                             capture_output=True, text=True).stdout.strip()
        header = float(out or 0)
    subprocess.run([ff, "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)], check=True)
    import soundfile as sf
    info = sf.info(str(wav))
    rep = {"header_sec": round(header, 2), "decoded_sec": round(info.frames / info.samplerate, 2)}
    rep["diff_sec"] = round(rep["decoded_sec"] - header, 2)
    (work / "duration.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    if header and abs(rep["diff_sec"]) > 2:
        print(f"⚠️ 文件头时长 {header:.1f}s 和实际解码 {rep['decoded_sec']:.1f}s 差 {rep['diff_sec']}s，以解码为准")
    return rep


def whisper_prompt(req: dict) -> str:
    names = [h.partition("=")[0] for h in req.get("hosts", [])] + [req.get("guest", "")]
    terms = req.get("terms", [])
    return ("以下是普通话播客，简体中文。" + (req.get("show") or "") + "，"
            + "、".join(n for n in names if n) + ("，" + "，".join(terms) if terms else "") + "。")


def _run_whisper(audio, device: str, prompt: str, progress=True):
    from faster_whisper import WhisperModel
    compute = "float16" if device == "cuda" else "int8"
    model = WhisperModel(config.WHISPER_MODEL, device=device, compute_type=compute, cpu_threads=os.cpu_count() or 4)
    segs, _info = model.transcribe(audio, language="zh", word_timestamps=True, vad_filter=True,
                                   initial_prompt=prompt, beam_size=5, condition_on_previous_text=False)
    words, sents, last_e, t0 = [], [], 0.0, time.time()
    for s in segs:
        # faster-whisper occasionally decodes the same stretch twice (timestamps jump back) — drop the repeat
        if s.start < last_e - 0.5:
            continue
        last_e = max(last_e, s.end)
        sents.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
        for w in s.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)})
        if progress and len(sents) % 50 == 0:
            print(f"  已转写到 {s.end / 60:.1f} 分钟（{device}，用时 {time.time() - t0:.0f}s）", flush=True)
    return words, sents


def words(work: Path, prompt: str) -> list[dict]:
    """Writes words.json and sentences.json; returns sentences [{start,end,text}]."""
    import soundfile as sf
    # pass a numpy array: faster-whisper's file reader clashes with some PyAV versions (metadata_errors)
    audio, _ = sf.read(str(work / "audio16k.wav"), dtype="float32")
    dev = config.WHISPER_DEVICE
    order = ["cuda", "cpu"] if dev == "auto" else [dev]
    last_err = None
    for d in order:
        try:
            w, s = _run_whisper(audio, d, prompt)
            break
        except Exception as e:  # e.g. cublas64_12.dll missing on a machine without CUDA 12
            last_err = e
            print(f"  {d} 转写失败（{type(e).__name__}: {str(e)[:120]}），换下一个设备")
    else:
        raise SystemExit(f"转写失败：{last_err}")
    (work / "words.json").write_text(json.dumps(w, ensure_ascii=False), encoding="utf-8")
    (work / "sentences.json").write_text(json.dumps(s, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"  转写完成：{len(s)} 句，{len(w)} 个词")
    return s
