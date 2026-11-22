"""Pure functions: choose which scored blocks to keep so the episode reaches the target length.

Why blocks + program selection (tested 2026-11-22 on a 62-minute episode): asking the LLM to return keep-ranges
directly only cut to 51–53 min for a 40-min target, even after 3 follow-ups. Asking it only to *score* contiguous
blocks 1–5 and letting code delete from the lowest score up reaches the target deterministically.
"""
from __future__ import annotations

ALWAYS_DROP = {"录前准备", "录后闲聊", "制作讨论", "口误重录"}
# Among equal scores, cut these types first; then longer blocks first.
TYPE_PRIORITY = {"主持人铺垫过长": 0, "点名": 0, "细节展开": 1, "重复内容": 2}
SILENCE_FACTOR = 0.985            # pause compression shortens kept speech by ~1.5%


def clean_blocks(blocks: list[dict], n_sent: int) -> list[dict]:
    """Drop malformed blocks and sort by start."""
    ok = [b for b in blocks if isinstance(b.get("from"), int) and isinstance(b.get("to"), int)
          and 0 <= b["from"] <= b["to"] < n_sent]
    return sorted(ok, key=lambda b: b["from"])


def block_sec(b: dict, sents: list[dict]) -> float:
    return sents[b["to"]]["end"] - sents[b["from"]]["start"]


def kept_sec(blocks: list[dict], sents: list[dict]) -> float:
    return sum(block_sec(b, sents) for b in blocks if b["keep"]) * SILENCE_FACTOR


def choose(blocks: list[dict], sents: list[dict], target_sec: float) -> list[dict]:
    """Set b['keep'] on every block. Score-5 blocks are never cut. Returns the same list."""
    for b in blocks:
        b["keep"] = not (b.get("type") in ALWAYS_DROP or b.get("importance", 3) <= 1)
    order = sorted((b for b in blocks if b["keep"] and b.get("importance", 3) < 5),
                   key=lambda b: (b.get("importance", 3), TYPE_PRIORITY.get(b.get("type"), 3), -block_sec(b, sents)))
    for b in order:
        if kept_sec(blocks, sents) <= target_sec:
            break
        b["keep"] = False
    return blocks


def keep_ranges(blocks: list[dict]) -> list[list[int]]:
    """Merge adjacent kept blocks into [first_sentence, last_sentence] ranges."""
    out: list[list[int]] = []
    for b in blocks:
        if not b["keep"]:
            continue
        if out and b["from"] <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b["to"])
        else:
            out.append([b["from"], b["to"]])
    return out


def delete_segments(ranges: list[list[int]], sents: list[dict], total_sec: float, pad: float = 0.04) -> list[dict]:
    """Turn kept sentence ranges into the delete list cut_audio.py expects ({start,end} seconds)."""
    keeps = [(max(0.0, sents[a]["start"] - pad), min(total_sec, sents[b]["end"] + pad)) for a, b in ranges]
    dels, prev = [], 0.0
    for a, b in keeps:
        if a > prev + 0.01:
            dels.append({"start": round(prev, 2), "end": round(a, 2)})
        prev = max(prev, b)
    if total_sec > prev + 0.01:
        dels.append({"start": round(prev, 2), "end": round(total_sec, 2)})
    return dels


def chapters_ok(starts: list[float], total: float, n: int = 5) -> bool:
    """Chapters must cover the whole episode: last one starts after 60%, none longer than 45%."""
    if len(starts) != n:
        return False
    gaps = [b - a for a, b in zip(starts, starts[1:] + [total])]
    return starts[-1] > 0.6 * total and max(gaps) < 0.45 * total
