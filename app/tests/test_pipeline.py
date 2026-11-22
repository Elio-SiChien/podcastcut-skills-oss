"""Tests that need no API key and no models: selection logic, review server, and a real cut on synthetic audio.

Run:  python -m unittest discover -s app/tests -v      (from the repo root)
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pcut import config  # noqa: E402
from pcut.review import apply_keep, build_data, serve  # noqa: E402
from pcut.select import (chapters_ok, choose, clean_blocks, delete_segments, keep_ranges,  # noqa: E402
                         kept_sec)


def sents_every(n, sec=10.0):
    return [{"start": i * sec, "end": i * sec + sec - 0.5, "text": f"句子{i}", "spk": "A"} for i in range(n)]


class Selection(unittest.TestCase):
    def test_clean_drops_bad_blocks(self):
        b = clean_blocks([{"from": 3, "to": 2}, {"from": 0, "to": 9}, {"from": "x", "to": 1}, {"from": 5, "to": 99}], 10)
        self.assertEqual(b, [{"from": 0, "to": 9}])

    def test_reaches_target_and_never_cuts_5(self):
        s = sents_every(60)                                   # 10 minutes
        blocks = [{"from": i, "to": i + 5, "importance": imp, "type": "主干"}
                  for i, imp in zip(range(0, 60, 6), [5, 2, 4, 3, 5, 2, 3, 4, 5, 3])]
        choose(blocks, s, target_sec=300)
        self.assertLessEqual(kept_sec(blocks, s), 300)
        self.assertTrue(all(b["keep"] for b in blocks if b["importance"] == 5))
        cut = [b["importance"] for b in blocks if not b["keep"]]
        kept = [b["importance"] for b in blocks if b["keep"] and b["importance"] < 5]
        self.assertTrue(not kept or max(cut) <= min(kept))  # lower scores go first

    def test_always_drop_types(self):
        s = sents_every(10)
        blocks = [{"from": 0, "to": 1, "importance": 5, "type": "录前准备"}, {"from": 2, "to": 9, "importance": 4, "type": "主干"}]
        choose(blocks, s, target_sec=1e9)
        self.assertEqual([b["keep"] for b in blocks], [False, True])

    def test_keep_ranges_merge_adjacent(self):
        blocks = [{"from": 0, "to": 2, "keep": True}, {"from": 3, "to": 4, "keep": True},
                  {"from": 5, "to": 6, "keep": False}, {"from": 7, "to": 9, "keep": True}]
        self.assertEqual(keep_ranges(blocks), [[0, 4], [7, 9]])

    def test_delete_segments_cover_gaps_and_tail(self):
        s = sents_every(10)
        d = delete_segments([[1, 3], [6, 7]], s, total_sec=100.0, pad=0)
        self.assertEqual(d, [{"start": 0.0, "end": 10.0}, {"start": 39.5, "end": 60.0}, {"start": 79.5, "end": 100.0}])

    def test_chapters_ok(self):
        self.assertTrue(chapters_ok([0, 600, 1200, 1700, 2100], 2400))
        self.assertFalse(chapters_ok([0, 60, 120, 180, 240], 2400))      # all crammed at the start
        self.assertFalse(chapters_ok([0, 600, 1200], 2400))              # wrong count


class Review(unittest.TestCase):
    def test_save_roundtrip(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            s = sents_every(10)
            blocks = [{"from": 0, "to": 4, "keep": True, "importance": 4}, {"from": 5, "to": 9, "keep": False, "importance": 2}]
            plan = tmp / "plan.json"
            plan.write_text(json.dumps({"blocks": blocks, "keep": [[0, 4]], "target_min": 1}), encoding="utf-8")
            audio = tmp / "a.wav"; audio.write_bytes(b"RIFF" + b"\0" * 5000)
            saved = []
            srv, url = serve(tmp, audio, plan, s, "t", 0, on_save=saved.append, open_browser=False, block=False)
            try:
                d = json.loads(urllib.request.urlopen(url + "data").read())
                self.assertEqual([b["keep"] for b in d["blocks"]], [True, False])
                self.assertIn("句子5", d["blocks"][1]["text"])
                rq = urllib.request.Request(url + "audio", headers={"Range": "bytes=10-19"})
                r = urllib.request.urlopen(rq)
                self.assertEqual((r.status, len(r.read())), (206, 10))
                urllib.request.urlopen(url + "save", data=json.dumps({"keep": [True, True]}).encode())
                p = json.loads(plan.read_text(encoding="utf-8"))
                self.assertEqual((p["keep"], p["reviewed"]), ([[0, 9]], True))
                self.assertEqual(len(saved), 1)
            finally:
                srv.shutdown()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_apply_keep_rejects_wrong_length(self):
        with self.assertRaises(ValueError):
            apply_keep({"blocks": [{"from": 0, "to": 1, "keep": True}]}, [True, False])

    def test_build_data_intro_counted(self):
        d = build_data({"blocks": [{"from": 0, "to": 0, "keep": True}], "target_min": 1}, sents_every(1), "t", 4.5)
        self.assertEqual(d["intro"], 5.0)


@unittest.skipUnless(config.ffmpeg(), "ffmpeg not installed")
class RealCut(unittest.TestCase):
    """Builds a 30 s tone track with 6 'sentences', cuts two of them with the real cut_audio.py + trim_silences.py
    through `pcut assemble`, and checks the result length and that the intro is in front."""

    def test_assemble_end_to_end(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            ff = config.ffmpeg()
            # 6 x (4.5 s tone + 0.5 s silence) = 30 s; each tone a different pitch
            parts = "".join(f"sine=f={300 + 80 * i}:d=4.5,apad=pad_dur=0.5[s{i}];" for i in range(6))
            cat = "".join(f"[s{i}]" for i in range(6))
            src = tmp / "raw.wav"
            subprocess.run([ff, "-y", "-v", "error", "-filter_complex", parts + cat + "concat=n=6:v=0:a=1[a]",
                            "-map", "[a]", "-ar", "44100", str(src)], check=True)
            intro = tmp / "片头.wav"
            subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=1000:d=2", str(intro)], check=True)
            ep = tmp / "ep"; w = ep / "work"; w.mkdir(parents=True)
            sents = [{"start": i * 5.0, "end": i * 5.0 + 4.5, "text": f"s{i}", "spk": "A"} for i in range(6)]
            (w / "sentences.json").write_text(json.dumps(sents), encoding="utf-8")
            (w / "duration.json").write_text(json.dumps({"decoded_sec": 30.0}), encoding="utf-8")
            blocks = [{"from": i, "to": i, "keep": i not in (1, 4), "importance": 3, "type": "主干"} for i in range(6)]
            (w / "plan.json").write_text(json.dumps({"blocks": blocks, "keep": keep_ranges(blocks), "reviewed": True}),
                                         encoding="utf-8")
            (ep / "本期要求.json").write_text(json.dumps({"source": str(src), "intro": str(intro), "target_min": 1,
                                                       "hosts": [], "guest": ""}), encoding="utf-8")
            from pcut.cli import main
            main(["assemble", str(ep)])
            rep = json.loads((w / "assemble_report.json").read_text())
            # kept 4 sentences ≈ 4 x 4.5 s + short gaps, plus 2 s intro + 0.5 s gap
            self.assertTrue(19 < rep["final_sec"] < 25, rep)
            self.assertEqual(rep["deleted_segments"], 3)          # 2 cut sentences + the trailing 0.5 s of silence
            self.assertTrue((ep / "成品" / "删减清单.md").exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
