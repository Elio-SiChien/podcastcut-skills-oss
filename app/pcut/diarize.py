"""Speaker separation with CAM++ embeddings (optional: needs funasr + the CAM++ model).

Two modes:
- enrollment (recommended): each person's self-introduction phrase builds a voiceprint; every sentence goes to the
  nearest voiceprint, refined 3 times. Blind clustering merged two similar female voices on 2026-11-22.
- clustering: agglomerative clustering into N speakers; the one who talks most is the guest.
"""
from __future__ import annotations

import os

import numpy as np

from . import config


def available() -> bool:
    try:
        import funasr  # noqa: F401
    except ImportError:
        return False
    return os.path.isdir(config.CAMPP)


def label(wav_path, sents: list[dict], hosts: list[str], guest: str, enroll: dict[str, list[str]]) -> dict:
    """Adds s['spk'] to every sentence in place. Returns a small report."""
    import soundfile as sf
    from funasr import AutoModel
    wav, sr = sf.read(str(wav_path), dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    m = AutoModel(model=config.CAMPP, disable_update=True)
    embs, idx = [], []
    for i, s in enumerate(sents):
        a, b = int(s["start"] * sr), int(s["end"] * sr)
        if b - a < int(1.2 * sr):
            continue
        e = np.asarray(m.generate(input=wav[a:b][: 15 * sr])[0]["spk_embedding"]).reshape(-1)
        embs.append(e / (np.linalg.norm(e) + 1e-9)); idx.append(i)
    if not embs:
        return {"error": "no sentence long enough"}
    X = np.stack(embs)
    host_names = [h.partition("=")[0] for h in hosts]
    if enroll:
        pos = {i: j for j, i in enumerate(idx)}
        names = list(enroll)
        cents = []
        for name in names:
            rows = [pos[k] for i, s in enumerate(sents) if any(p in s["text"] for p in enroll[name])
                    for k in range(i, min(i + 4, len(sents))) if k in pos]
            if not rows:
                raise SystemExit(f"认声音失败：转写里没找到 {name} 的短语 {enroll[name]}。换一句他/她原话里确实出现的词。")
            c = X[sorted(set(rows))].mean(0); cents.append(c / np.linalg.norm(c))
        cent = np.stack(cents)
        for _ in range(3):
            lab = (X @ cent.T).argmax(1)
            cent = np.stack([X[lab == k].mean(0) if (lab == k).any() else cent[k] for k in range(len(cent))])
            cent /= np.linalg.norm(cent, axis=1, keepdims=True)
        lab = (X @ cent.T).argmax(1)
        name_of = dict(enumerate(names))
    else:
        from sklearn.cluster import AgglomerativeClustering
        n = len(host_names) + 1
        lab = AgglomerativeClustering(n_clusters=n, metric="cosine", linkage="average").fit_predict(X)
        dur = {k: 0.0 for k in range(n)}
        for i, k in zip(idx, lab):
            dur[int(k)] += sents[i]["end"] - sents[i]["start"]
        order = sorted(dur, key=lambda k: -dur[k])
        first = {}
        for i, k in zip(idx, lab):
            first.setdefault(int(k), i)
        name_of = {order[0]: guest}
        rest = sorted(order[1:], key=lambda k: first.get(k, 1e9))
        for k, h in zip(rest, host_names):
            name_of[k] = h + "（按出场顺序推断）"
    spk = [None] * len(sents)
    for i, k in zip(idx, lab):
        spk[i] = int(k)
    for i in range(len(sents)):            # short sentences: nearest long sentence in time
        if spk[i] is None:
            spk[i] = spk[min(idx, key=lambda j: abs(sents[j]["start"] - sents[i]["start"]))]
    minutes = {}
    for s, k in zip(sents, spk):
        s["spk"] = name_of.get(k, f"说话人{k}")
        minutes[s["spk"]] = minutes.get(s["spk"], 0) + (s["end"] - s["start"]) / 60
    return {"mode": "enroll" if enroll else "cluster", "minutes": {k: round(v, 1) for k, v in minutes.items()}}
