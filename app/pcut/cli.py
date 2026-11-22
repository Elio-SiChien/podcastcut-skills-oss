"""pcut — podcast rough-cut pipeline that actually produces the finished episode.

  python -m pcut doctor                          check ffmpeg / packages / key / models
  python -m pcut new <录音> <本期文件夹>          ① ask intro / target length / editing rules (every episode)
  python -m pcut transcribe <本期文件夹>          ② decode check + word timestamps + speakers
  python -m pcut propose <本期文件夹>             ③ LLM scores blocks, code picks cuts to hit the target
  python -m pcut review <本期文件夹>              ③b review page in the browser (required before assemble)
  python -m pcut assemble <本期文件夹>            ④ cut from the original → compress pauses → intro → loudness → mp3
  python -m pcut verify <本期文件夹>              ⑤ re-transcribe the result → transcript, chapters, QA report
  python -m pcut article <本期文件夹>             ⑥ WeChat article draft (quotes verified against the transcript)
  python -m pcut run <录音> <本期文件夹>          all of the above in order, stopping at the review page
  python -m pcut status <本期文件夹>              what's done, what's next
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from . import config
from .select import block_sec, choose, clean_blocks, delete_segments, keep_ranges, kept_sec

LAST = config.HOME / "last_episode.json"     # previous answers — shown as reference only, never applied silently


# ---------- helpers ----------
def mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def W(ep: Path) -> Path:
    w = ep / "work"; w.mkdir(parents=True, exist_ok=True); return w


def rj(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def wj(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def req_of(ep: Path) -> dict:
    p = ep / "本期要求.json"
    if not p.exists():
        raise SystemExit(f"{ep} 里没有 本期要求.json，先运行 `python -m pcut new <录音> {ep}`")
    return rj(p)


def glossary(ep: Path, req: dict) -> dict:
    for p in [ep / "glossary.json", Path(req.get("glossary") or "")]:
        if p.is_file():
            g = rj(p)
            return g.get("替换") or g.get("replace") or {}
    return {}


def apply_glossary(text: str, g: dict) -> str:
    for a, b in sorted(g.items(), key=lambda kv: -len(kv[0])):
        text = text.replace(a, b)
    return text


def run(cmd: list, cwd=None) -> str:
    r = subprocess.run([str(c) for c in cmd], env=config.subprocess_env(), cwd=cwd, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stdout[-1500:], r.stderr[-1500:])
        raise SystemExit(f"失败：{Path(str(cmd[1] if len(cmd) > 1 else cmd[0])).name}")
    return r.stdout + r.stderr


def probe_sec(path: Path) -> float:
    out = subprocess.run([config.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(path)], capture_output=True, text=True).stdout.strip()
    return float(out or 0)


# ---------- ① new ----------
def ask(q: str, last=None, required=True) -> str:
    hint = f"（上期：{last}；只作参考，请重新回答）" if last not in (None, "") else ""
    while True:
        a = input(f"{q}{hint}\n> ").strip()
        if a or not required:
            return a


def cmd_new(a) -> None:
    ep, src = Path(a.episode), Path(a.audio)
    if not src.exists():
        raise SystemExit(f"找不到录音：{src}")
    ep.mkdir(parents=True, exist_ok=True)
    last = rj(LAST) if LAST.exists() else {}
    given = all(v is not None for v in (a.intro, a.target, a.rules))
    if given:          # scripted use: all three must be given explicitly — never borrowed from last time
        intro, target, rules = a.intro, a.target, a.rules
        show, hosts, guest, enroll = a.show or "", a.hosts or "", a.guest or "", a.enroll or ""
    else:
        intro_dir = Path(a.intro_dir or last.get("intro_dir") or src.parent)
        intros = sorted(p for p in intro_dir.glob("*") if p.suffix.lower() in (".mp3", ".wav", ".m4a", ".aac", ".flac")
                        and ("片头" in p.name or "intro" in p.name.lower()))
        print("本期要求（每期都要回答；上期的答案只作参考，不会自动套用）")
        print(f"可用片头（在 {intro_dir} 里找名字带“片头”或 intro 的音频）：")
        for i, p in enumerate(intros):
            print(f"  [{i}] {p.name}" + ("   ← 上期用过" if str(p) == last.get("intro") else ""))
        k = ask("1. 片头用哪个？输入编号；不加片头输入 n；也可以直接粘贴片头文件路径", last.get("intro_name"))
        intro = "" if k.lower() == "n" else (str(intros[int(k)]) if k.isdigit() and int(k) < len(intros) else k.strip('"'))
        target = ask("2. 这期剪到多少分钟？", last.get("target_min"))
        rules = ask("3. 剪辑原则：哪些一定要留、哪些可以删、有没有特别要求？", last.get("rules"))
        show = ask("4. 节目名", last.get("show"), required=False)
        hosts = ask("5. 主持人，逗号分隔（名字常被识别错可以写别名：张三=章三|张山）", last.get("hosts"))
        guest = ask("6. 嘉宾名字", None)
        enroll = ask("7. 认声音（推荐）：每个人自我介绍里的一句原话，格式 名字=短语|短语; 名字=短语。直接回车跳过，"
                     "跳过就自动聚类，两个声音相近时可能分错", None, required=False)
    if intro and not Path(intro).is_file():
        raise SystemExit(f"找不到片头文件：{intro}")
    req = {"source": str(src.resolve()), "intro": intro, "intro_name": Path(intro).name if intro else "无",
           "target_min": float(target), "rules": rules, "show": show,
           "hosts": [h.strip() for h in str(hosts).split(",") if h.strip()], "guest": guest,
           "enroll": {k.strip(): [x for x in v.split("|") if x] for k, _, v in
                      (x.partition("=") for x in str(enroll).split(";")) if v} if enroll else {},
           "terms": [t for t in re.split(r"[,，、\s]+", a.terms or "") if t], "glossary": a.glossary or ""}
    wj(ep / "本期要求.json", req)
    (ep / "本期要求.md").write_text(
        f"# 本期要求\n\n- 录音：{req['source']}\n- 片头：{req['intro_name']}\n- 目标时长：{req['target_min']} 分钟\n"
        f"- 剪辑原则：{rules}\n- 节目：{show}\n- 主持人：{'、'.join(req['hosts'])}\n- 嘉宾：{guest}\n", encoding="utf-8")
    wj(LAST, {"intro": intro, "intro_name": req["intro_name"], "intro_dir": str(Path(intro).parent) if intro else "",
              "target_min": req["target_min"], "rules": rules, "show": show, "hosts": hosts})
    print(f"已存 {ep / '本期要求.md'}。下一步：python -m pcut transcribe \"{ep}\"")


# ---------- ② transcribe ----------
def cmd_transcribe(a) -> None:
    from . import diarize, transcribe
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    print("② 解码核实时长…"); print("  ", transcribe.decode(r["source"], w))
    print("② 词级转写（1 小时录音在 CPU 上约 50–60 分钟，有 NVIDIA 显卡会快很多）…")
    sents = transcribe.words(w, transcribe.whisper_prompt(r))
    if diarize.available():
        print("② 区分说话人…")
        print("  ", diarize.label(w / "audio16k.wav", sents, r["hosts"], r["guest"], r.get("enroll", {})))
    else:
        print("  ⚠️ 没装说话人模型（funasr + CAM++），跳过区分说话人；文字稿里不标是谁说的。见 doctor。")
    wj(w / "sentences.json", sents)
    print(f"下一步：python -m pcut propose \"{ep}\"")


# ---------- ③ propose ----------
def write_suggestion_md(ep: Path, plan: dict, sents: list[dict], target_min: float, intro_sec: float) -> None:
    est = kept_sec(plan["blocks"], sents) / 60 + (intro_sec + 0.5) / 60
    md = ["# 删减建议（大模型打分 + 程序按目标时长挑，等你审）", "",
          f"预计成品 **{est:.1f} 分钟**（目标 {target_min}）。用 `python -m pcut review` 打开审核页面勾选；"
          "自动建议和人工通读的重合度约 77%（2026-11-22 实测），一定要审。", "",
          "| 原始时间 | 分 | 类型 | 留/删 | 为什么 |", "| --- | --- | --- | --- | --- |"]
    for b in plan["blocks"]:
        md.append(f"| {mmss(sents[b['from']]['start'])}–{mmss(sents[b['to']]['end'])} | {b.get('importance')} | "
                  f"{b.get('type')} | {'留' if b['keep'] else '**删**'} | {b.get('reason', '')} |")
    if plan.get("notes"):
        md += ["", f"**要重点听的**：{plan['notes']}"]
    (ep / "删减建议.md").write_text("\n".join(md) + "\n", encoding="utf-8")


def intro_seconds(r: dict) -> float:
    return probe_sec(Path(r["intro"])) if r.get("intro") else 0.0


def cmd_propose(a) -> None:
    from . import llm
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    sents = rj(w / "sentences.json")
    print("③ 大模型给每一块内容打分…")
    raw = llm.score_blocks(sents, r)
    blocks = clean_blocks(raw.get("blocks", []), len(sents))
    if not blocks:
        raise SystemExit("大模型没有返回可用的分块，重跑一次 propose。")
    intro = intro_seconds(r)
    target = r["target_min"] * 60 * 0.98 - intro - 0.5
    choose(blocks, sents, target)
    plan = {"blocks": blocks, "keep": keep_ranges(blocks), "notes": raw.get("notes", ""), "reviewed": False,
            "target_min": r["target_min"], "llm_chapters": raw.get("chapters", [])}
    wj(w / "plan.json", plan)
    write_suggestion_md(ep, plan, sents, r["target_min"], intro)
    print(f"建议已出：{ep / '删减建议.md'}。下一步：python -m pcut review \"{ep}\"")


# ---------- ③b review ----------
def review_audio(r: dict, w: Path) -> Path:
    src = Path(r["source"])
    return src if src.suffix.lower() in (".mp3", ".m4a", ".wav", ".aac", ".ogg") else w / "audio16k.wav"


def cmd_review(a) -> None:
    from .review import serve
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    sents = rj(w / "sentences.json"); intro = intro_seconds(r)
    serve(ep, review_audio(r, w), w / "plan.json", sents, f"{r.get('show', '')} {r.get('guest', '')}", intro,
          on_save=lambda plan: write_suggestion_md(ep, plan, sents, r["target_min"], intro),
          open_browser=not a.no_browser)
    print(f"审核结束。下一步：python -m pcut assemble \"{ep}\"")


# ---------- ④ assemble ----------
def cmd_assemble(a) -> None:
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    plan, sents = rj(w / "plan.json"), rj(w / "sentences.json")
    if not plan.get("reviewed") and not a.yes:
        raise SystemExit("删减建议还没人审过。先 `python -m pcut review`；确实不审就加 --yes（不推荐）。")
    total = rj(w / "duration.json")["decoded_sec"]
    dels = delete_segments(plan["keep"], sents, total)
    wj(w / "delete_segments.json", dels)
    cut, trimmed = w / "cut.mp3", w / "cut_trimmed.mp3"
    print(f"④ 从原始录音剪掉 {len(dels)} 段…")
    # --no-snap: boundaries are already on word edges; snapping to silence once swallowed a whole short sentence
    run([sys.executable, config.SCRIPTS / "cut_audio.py", cut, r["source"], w / "delete_segments.json", "--no-snap"], cwd=w)
    print("④ 压缩长停顿（>0.8 秒压到 0.6 秒）…")
    trimmed.unlink(missing_ok=True)
    run([sys.executable, config.SCRIPTS / "trim_silences.py", cut, trimmed, "--threshold", "0.8", "--target", "0.6"], cwd=w)
    if not trimmed.exists():          # trim_silences writes nothing when there is no long pause
        trimmed = cut
    out = ep / "成品" / f"{ep.name}.mp3"; out.parent.mkdir(exist_ok=True)
    ln = "loudnorm=I=-16:TP=-1.5:LRA=11"
    if r.get("intro"):
        print("④ 加片头 + 响度标准化（-16 LUFS）…")
        fc = (f"[0:a]aresample=44100,aformat=channel_layouts=stereo,{ln}[i];anullsrc=r=44100:cl=stereo,atrim=0:0.5[g];"
              f"[1:a]aresample=44100,aformat=channel_layouts=stereo,{ln}[m];[i][g][m]concat=n=3:v=0:a=1[a]")
        run([config.ffmpeg(), "-y", "-v", "error", "-i", r["intro"], "-i", trimmed, "-filter_complex", fc,
             "-map", "[a]", "-c:a", "libmp3lame", "-b:a", "192k", out])
    else:
        run([config.ffmpeg(), "-y", "-v", "error", "-i", trimmed, "-af", f"aresample=44100,{ln}",
             "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", out])
    rep = {"intro_sec": round(intro_seconds(r), 2), "cut_sec": round(probe_sec(cut), 2),
           "final_sec": round(probe_sec(out), 2), "deleted_segments": len(dels)}
    rep["final_min"] = round(rep["final_sec"] / 60, 2)
    wj(w / "assemble_report.json", rep)
    # 删减清单：每处删掉的原始时间和理由，删错了改 plan 里那块的 keep 再 assemble 就能放回来
    md = ["# 删减清单", "", f"成品 {rep['final_min']} 分钟；共删 {sum(block_sec(b, sents) for b in plan['blocks'] if not b['keep']) / 60:.1f} 分钟内容。",
          "", "| # | 原始时间 | 类型 | 为什么删 |", "| --- | --- | --- | --- |"]
    n = 0
    for b in plan["blocks"]:
        if not b["keep"]:
            n += 1
            md.append(f"| {n} | {mmss(sents[b['from']]['start'])}–{mmss(sents[b['to']]['end'])} | {b.get('type')} | {b.get('reason', '')} |")
    (out.parent / "删减清单.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"成品：{out}（{rep['final_min']} 分钟）。下一步：python -m pcut verify \"{ep}\"")


# ---------- ⑤ verify ----------
def loudness(path: Path) -> dict:
    out = run([config.ffmpeg(), "-hide_banner", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"])
    tail = out[out.rfind("Summary"):]
    get = lambda pat: float(m.group(1)) if (m := re.search(pat, tail)) else None
    return {"lufs": get(r"I:\s+(-?[\d.]+) LUFS"), "peak_dbfs": get(r"Peak:\s+(-?[\d.]+) dBFS")}


def longest_silence(path: Path) -> float:
    out = run([config.ffmpeg(), "-hide_banner", "-i", path, "-af", "silencedetect=n=-35dB:d=1.5", "-f", "null", "-"])
    durs = [float(x) for x in re.findall(r"silence_duration: ([\d.]+)", out)]
    return max(durs, default=0.0)


def paragraphs(sents: list[dict]) -> list[dict]:
    paras, cur = [], None
    for s in sents:
        if cur and cur["spk"] == s["spk"] and s["start"] - cur["end"] < 3:
            cur["text"] += ("" if cur["text"][-1:] in "。？！，,.?!" else "，") + s["text"]; cur["end"] = s["end"]
        else:
            cur = {"spk": s["spk"], "start": s["start"], "end": s["end"], "text": s["text"]}; paras.append(cur)
    return paras


def cmd_verify(a) -> None:
    from . import diarize, llm, transcribe
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    out = ep / "成品" / f"{ep.name}.mp3"; v = w / "verify"
    rep = rj(w / "assemble_report.json")
    print("⑤ 成品重新转写（核对文字稿和音频对得上）…")
    transcribe.decode(out, v)
    sents = transcribe.words(v, transcribe.whisper_prompt(r))
    if diarize.available():
        diarize.label(v / "audio16k.wav", sents, r["hosts"], r["guest"], r.get("enroll", {}))
    g = glossary(ep, r); intro_end = rep["intro_sec"] + 0.5 if r.get("intro") else 0
    for s in sents:
        s["text"] = apply_glossary(s["text"], g).strip("，,。 ")
        s["spk"] = "片头" if s["start"] < intro_end - 0.3 else s.get("spk", "").replace("（按出场顺序推断）", "")
    sents = [s for s in sents if s["text"]]
    wj(v / "sentences.json", sents)
    paras = paragraphs(sents)
    md = [f"# {r.get('show', '')} · 文字稿（对应成品）", "", "> 由成品重新转写，时间对应成品；个别错字和很短句子的说话人以音频为准。", ""]
    md += [f"**{p['spk'] or '—'}** `{mmss(p['start'])}`  \n{p['text']}。\n" for p in paras]
    (out.parent / "文字稿.md").write_text("\n".join(md), encoding="utf-8")
    ch, ok = llm.chapters(sents)
    lines = ["# 章节时间戳（对应成品）", ""] + ([] if ok else ["> ⚠️ 自动分章没通过“覆盖整期”的检查，请人工看一下", ""])
    lines += [f"- `{mmss(sents[x['from']]['start'])}` **{x['title']}**：{x.get('summary', '')}" for x in ch]
    (out.parent / "章节.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    ld, sil = loudness(out), longest_silence(out)
    hdr, dec = probe_sec(out), rj(v / "duration.json")["decoded_sec"]
    checks = [("时长", rep["final_min"] <= r["target_min"] + 0.01, f"{rep['final_min']} 分钟，目标 ≤ {r['target_min']}"),
              ("响度", ld["lufs"] is not None and abs(ld["lufs"] + 16) <= 1.0, f"{ld['lufs']} LUFS（目标 -16±1）"),
              ("峰值", ld["peak_dbfs"] is not None and ld["peak_dbfs"] <= -1.0, f"{ld['peak_dbfs']} dBFS（≤ -1）"),
              ("最长静音", sil < 2.0, f"{sil:.1f} 秒（< 2）"),
              ("文件完整", abs(hdr - dec) < 1.0, f"文件头 {hdr:.1f}s / 实际解码 {dec:.1f}s"),
              ("章节覆盖整期", ok, "通过" if ok else "未通过，人工看")]
    qa = ["# 核查报告", "", "## 自动检查", "", "| 项 | 结果 | 数值 |", "| --- | --- | --- |"]
    qa += [f"| {n} | {'✅' if p else '⚠️'} | {d} |" for n, p, d in checks]
    qa += ["", "## 要人工听的", "- 每个删减接缝（删减清单里每一处的成品位置前后各 5 秒）",
           "- 自动建议里标了“要重点听”的地方：" + (rj(w / 'plan.json').get('notes') or "无"), ""]
    (out.parent / "核查报告.md").write_text("\n".join(qa), encoding="utf-8")
    for n, p, d in checks:
        print(f"  {'✅' if p else '⚠️'} {n}：{d}")
    print(f"下一步：python -m pcut article \"{ep}\"")


# ---------- ⑥ article ----------
def cmd_article(a) -> None:
    from . import llm
    ep = Path(a.episode); r, w = req_of(ep), W(ep)
    sents = rj(w / "verify" / "sentences.json")
    chapters_md = (ep / "成品" / "章节.md").read_text(encoding="utf-8")
    md, dropped = llm.article(paragraphs(sents), chapters_md, r)
    (ep / "成品" / "公众号图文草稿.md").write_text(md, encoding="utf-8")
    print(f"图文草稿：{ep / '成品' / '公众号图文草稿.md'}" + (f"（丢掉了 {len(dropped)} 句对不上原文的金句）" if dropped else ""))


# ---------- status / run / doctor ----------
STAGES = [("本期要求.json", "new"), ("work/sentences.json", "transcribe"), ("work/plan.json", "propose"),
          ("work/assemble_report.json", "assemble"), ("work/verify/sentences.json", "verify"),
          ("成品/公众号图文草稿.md", "article")]


def cmd_status(a) -> None:
    ep = Path(a.episode)
    for f, name in STAGES:
        print(f"  {'✅' if (ep / f).exists() else '⬜'} {name}")
    p = ep / "work" / "plan.json"
    if p.exists():
        print(f"  审核：{'已审' if rj(p).get('reviewed') else '还没审（assemble 前必须 review）'}")


def cmd_run(a) -> None:
    ep = Path(a.episode)
    if not (ep / "本期要求.json").exists():
        cmd_new(a)
    ns = argparse.Namespace(episode=a.episode, yes=False, no_browser=False)
    if not (ep / "work" / "sentences.json").exists():
        cmd_transcribe(ns)
    if not (ep / "work" / "plan.json").exists():
        cmd_propose(ns)
    if not rj(ep / "work" / "plan.json").get("reviewed"):
        cmd_review(ns)
    cmd_assemble(ns); cmd_verify(ns); cmd_article(ns)


def cmd_doctor(a) -> None:
    from .doctor import main
    sys.exit(main())


def main(argv=None) -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    p = argparse.ArgumentParser(prog="pcut", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("new", "run"):
        s = sub.add_parser(name); s.add_argument("audio"); s.add_argument("episode")
        for f in ("intro", "target", "rules", "show", "hosts", "guest", "enroll", "terms", "glossary", "intro_dir"):
            s.add_argument("--" + f.replace("_", "-"), dest=f)
    for name in ("transcribe", "propose", "review", "assemble", "verify", "article", "status"):
        s = sub.add_parser(name); s.add_argument("episode")
        s.add_argument("--yes", action="store_true"); s.add_argument("--no-browser", action="store_true")
    sub.add_parser("doctor")
    a = p.parse_args(argv)
    for f in ("episode", "audio", "intro", "glossary", "intro_dir"):    # child scripts run in other folders
        if getattr(a, f, None):
            setattr(a, f, str(Path(getattr(a, f)).resolve()))
    {"new": cmd_new, "run": cmd_run, "transcribe": cmd_transcribe, "propose": cmd_propose, "review": cmd_review,
     "assemble": cmd_assemble, "verify": cmd_verify, "article": cmd_article, "status": cmd_status,
     "doctor": cmd_doctor}[a.cmd](a)
