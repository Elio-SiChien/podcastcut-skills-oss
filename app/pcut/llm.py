"""LLM calls (any OpenAI-compatible endpoint; default DeepSeek): score blocks, split chapters, draft the article."""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import config
from .select import chapters_ok

RULES = Path(__file__).with_name("editing_rules.md")


def client():
    key, base, model = config.llm()
    if not key:
        raise SystemExit("没有大模型 Key。在仓库根目录 .env 里写一行 PCUT_LLM_API_KEY=你的Key（默认用 DeepSeek）。")
    from openai import OpenAI
    return OpenAI(api_key=key, base_url=base), model


def ask_json(prompt: str, temperature: float = 0.2) -> dict:
    c, model = client()
    r = c.chat.completions.create(model=model, response_format={"type": "json_object"}, temperature=temperature,
                                  messages=[{"role": "user", "content": prompt}])
    return json.loads(r.choices[0].message.content)


def mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def score_blocks(sents: list[dict], req: dict) -> dict:
    lines = "\n".join(f"[{i}] {s['start']:.1f}s {s.get('spk', '')}：{s['text']}" for i, s in enumerate(sents))
    total = sents[-1]["end"] / 60
    hosts = "、".join(h.partition("=")[0] for h in req.get("hosts", []))
    prompt = (f"{RULES.read_text(encoding='utf-8')}\n\n## 本期要求\n- 目标时长：{req['target_min']} 分钟"
              f"（原始 {total:.1f} 分钟，片头另算）\n- 剪辑原则：{req.get('rules', '')}\n"
              f"- 主持人：{hosts}；嘉宾：{req.get('guest', '')}\n\n## 逐句稿（[编号] 开始秒 说话人：内容）\n{lines}")
    return ask_json(prompt)


def chapters(sents: list[dict], n: int = 5) -> tuple[list[dict], bool]:
    total = sents[-1]["end"]
    numbered = "\n".join(f"[{i}] {mmss(s['start'])} {s['text']}" for i, s in enumerate(sents))
    prompt = (f"下面是一期播客成品的逐句稿（共 {int(total // 60)} 分钟）。按话题分成正好 {n} 章，覆盖整期："
              "第 1 章从 [0] 开始，最后一章要从后 30% 的内容里开始，各章长度大致均衡。"
              "每章标题 12 字以内、大白话、不用比喻，再写一句话概括。只返回 JSON："
              '{"chapters":[{"from":编号,"title":"...","summary":"..."}]}\n\n' + numbered)
    ch: list[dict] = []
    for _ in range(3):
        ch = [x for x in ask_json(prompt).get("chapters", []) if 0 <= x.get("from", -1) < len(sents)]
        if chapters_ok([sents[x["from"]]["start"] for x in ch], total, n):
            return ch, True
        prompt += "\n\n上一次的分章不合格（没有覆盖整期，或者长度很不均衡），请重新分。"
    return ch, False


def _norm(s: str) -> str:
    return re.sub(r"[\s，。,.!?！？、：:；;“”\"'‘’（）()]", "", s)


def article(paras: list[dict], chapters_md: str, req: dict) -> tuple[str, list[str]]:
    """WeChat-style article draft. Every quote must appear verbatim in the transcript; unverified quotes are dropped."""
    text = "\n".join(f"{p['spk']}（{mmss(p['start'])}）：{p['text']}" for p in paras)
    prompt = ("根据下面这期播客的文字稿和章节，写一篇公众号图文草稿。只返回 JSON：\n"
              '{"titles":["标题1","标题2","标题3"],"recommended":0,"intro":"导语 100 字以内",'
              '"body":"正文 markdown，800–1200 字，按章节组织，用大白话，不编造文字稿里没有的事实",'
              '"quotes":[{"text":"嘉宾原话，必须一字不差摘自文字稿","time":"mm:ss"}]}\n'
              f"节目：{req.get('show', '')}；嘉宾：{req.get('guest', '')}。金句 5 句，只摘嘉宾说的话。\n\n"
              f"## 章节\n{chapters_md}\n\n## 文字稿\n{text}")
    a = ask_json(prompt, temperature=0.5)
    full = _norm("".join(p["text"] for p in paras))
    good, dropped = [], []
    for q in a.get("quotes", []):
        (good if _norm(q.get("text", "")) and _norm(q["text"]) in full else dropped).append(q)
    titles = a.get("titles", [])
    rec = a.get("recommended", 0) if isinstance(a.get("recommended"), int) else 0
    md = [f"# 公众号图文草稿 · {req.get('show', '')} × {req.get('guest', '')}", "",
          "> 草稿，发布前请人工通读；【】里的内容要你补。", "", "## 标题候选"]
    md += [f"{i + 1}. {t}{'（推荐）' if i == rec else ''}" for i, t in enumerate(titles)]
    md += ["", "【嘉宾照片】", "", "## 导语", a.get("intro", ""), "", "## 正文", a.get("body", ""), "",
           "## 金句（都已核对过文字稿原文）"]
    md += [f"> {q['text']}（{q.get('time', '')}）" for q in good]
    md += ["", "## 本期时间轴", chapters_md, "", "## 嘉宾", "【嘉宾链接】", ""]
    return "\n".join(md), [q.get("text", "") for q in dropped]
