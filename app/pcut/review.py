"""Step ③b: local review page. Lists every scored block; tick/untick to keep or cut, listen to a block or to the
seam a cut would create, watch the projected length, then save. Binds to 127.0.0.1 only — nothing leaves the machine.
"""
from __future__ import annotations

import json
import mimetypes
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .select import SILENCE_FACTOR, keep_ranges

PAGE = r"""<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>播客删减审核</title><style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b66;--line:#e3e2dc;--keep:#e8f3ea;--cut:#f8e6e3;--acc:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#171716;--fg:#ecebe6;--mut:#a3a29b;--line:#34332f;--keep:#1f3326;--cut:#3a2320;--acc:#7cc79b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,"Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;z-index:2}
h1{font-size:18px;margin:0 0 4px}.mut{color:var(--mut);font-size:13px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}
button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
button.pri{background:var(--acc);color:var(--bg);border-color:var(--acc)}
#len{font-weight:600;font-variant-numeric:tabular-nums}
main{padding:8px 16px 80px;max-width:980px;margin:auto}
.b{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:10px 12px}
.b.keep{background:var(--keep)}.b.cut{background:var(--cut)}
.h{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.h label{font-weight:600}
.t{font-variant-numeric:tabular-nums;color:var(--mut);font-size:13px}
.txt{margin-top:6px;font-size:14px;white-space:pre-wrap}.txt.fold{max-height:4.6em;overflow:hidden}
.why{font-size:13px;color:var(--mut);margin-top:4px}
</style></head><body>
<header><h1>播客删减审核</h1><div class="mut" id="sub"></div>
<div class="bar"><span>预计成品 <span id="len"></span></span><button id="save" class="pri">保存</button><button id="done">保存并结束审核</button><span class="mut" id="msg"></span></div>
<audio id="au" preload="metadata" src="/audio"></audio></header><main id="list"></main>
<script>
const $=s=>document.querySelector(s);let D,au=$("#au"),stopAt=null,jump=null;
const mm=t=>String(Math.floor(t/60)).padStart(2,"0")+":"+String(Math.floor(t%60)).padStart(2,"0");
au.addEventListener("timeupdate",()=>{if(jump&&au.currentTime>=jump[0]){au.currentTime=jump[1];jump=null}
 if(stopAt!==null&&au.currentTime>=stopAt){au.pause();stopAt=null}});
function play(a,b,j){au.currentTime=a;stopAt=b;jump=j||null;au.play()}
function total(){let s=0;D.blocks.forEach(b=>{if(b.keep)s+=b.sec});return s*D.factor/60+D.intro/60}
function upd(){$("#len").textContent=total().toFixed(1)+" 分钟（目标 "+D.target+"）";$("#len").style.color=total()>D.target?"#c0392b":""}
function render(){const L=$("#list");L.innerHTML="";D.blocks.forEach((b,i)=>{const d=document.createElement("div");
 d.className="b "+(b.keep?"keep":"cut");d.innerHTML=`<div class="h"><label><input type="checkbox" ${b.keep?"checked":""}> ${b.keep?"留":"删"}</label>
 <span class="t">${mm(b.start)}–${mm(b.end)} · ${Math.round(b.sec)} 秒 · ${b.importance} 分 · ${b.type||""}</span>
 <button data-a="p">听这段</button><button data-a="s">听删掉后的接缝</button><button data-a="f">展开</button></div>
 <div class="why">${b.reason||""}</div><div class="txt fold"></div>`;d.querySelector(".txt").textContent=b.text;
 d.querySelector("input").onchange=e=>{b.keep=e.target.checked;d.className="b "+(b.keep?"keep":"cut");d.querySelector("label").lastChild.textContent=" "+(b.keep?"留":"删");upd()};
 d.querySelector('[data-a="p"]').onclick=()=>play(b.start,b.end);
 d.querySelector('[data-a="s"]').onclick=()=>play(Math.max(0,b.start-4),b.end+4,[b.start,b.end]);
 d.querySelector('[data-a="f"]').onclick=e=>{d.querySelector(".txt").classList.toggle("fold")};L.appendChild(d)});upd()}
async function save(done){const r=await fetch(done?"/done":"/save",{method:"POST",body:JSON.stringify({keep:D.blocks.map(b=>b.keep)})});
 $("#msg").textContent=r.ok?(done?"已保存，审核结束，可以关掉这个页面":"已保存 "+new Date().toLocaleTimeString()):"保存失败"}
$("#save").onclick=()=>save(false);$("#done").onclick=()=>save(true);
fetch("/data").then(r=>r.json()).then(d=>{D=d;$("#sub").textContent=d.title+" · 共 "+d.blocks.length+" 块；红色是建议删掉的，勾上就留下";render()});
</script></body></html>"""


def build_data(plan: dict, sents: list[dict], title: str, intro_sec: float) -> dict:
    blocks = []
    for b in plan["blocks"]:
        s, e = sents[b["from"]]["start"], sents[b["to"]]["end"]
        text = "\n".join(f"{x.get('spk', '')}：{x['text']}" for x in sents[b["from"]: b["to"] + 1])
        blocks.append({"start": s, "end": e, "sec": e - s, "keep": bool(b["keep"]), "importance": b.get("importance"),
                       "type": b.get("type"), "reason": b.get("reason", ""), "text": text})
    return {"title": title, "target": plan.get("target_min"), "factor": SILENCE_FACTOR, "intro": intro_sec + 0.5,
            "blocks": blocks}


def apply_keep(plan: dict, keep: list[bool]) -> dict:
    if len(keep) != len(plan["blocks"]):
        raise ValueError("block count mismatch")
    for b, k in zip(plan["blocks"], keep):
        b["keep"] = bool(k)
    plan["keep"] = keep_ranges(plan["blocks"])
    return plan


def serve(ep: Path, audio: Path, plan_path: Path, sents: list[dict], title: str, intro_sec: float,
          on_save, port: int = 0, open_browser: bool = True, block: bool = True):
    """Start the review server. on_save(plan) is called after every save. Returns (server, url)."""
    done = threading.Event()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body: bytes, ctype="application/json; charset=utf-8", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            if self.path == "/":
                return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            if self.path == "/data":
                plan = json.loads(plan_path.read_text(encoding="utf-8"))
                return self._send(200, json.dumps(build_data(plan, sents, title, intro_sec), ensure_ascii=False).encode())
            if self.path == "/audio":
                return self._audio()
            self._send(404, b"{}")

        def _audio(self):
            size = os.path.getsize(audio)
            ctype = mimetypes.guess_type(str(audio))[0] or "application/octet-stream"
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                start = int(a) if a else max(0, size - int(b))
                end = int(b) if a and b else size - 1
            end = min(end, size - 1, start + 4 * 1024 * 1024 - 1)       # 4 MB per response
            with open(audio, "rb") as f:
                f.seek(start)
                body = f.read(end - start + 1)
            self._send(206 if rng else 200, body, ctype,
                       {"Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{size}"})

        def do_POST(self):
            if self.path not in ("/save", "/done"):
                return self._send(404, b"{}")
            n = int(self.headers.get("Content-Length", 0))
            try:
                keep = json.loads(self.rfile.read(n))["keep"]
                plan = apply_keep(json.loads(plan_path.read_text(encoding="utf-8")), keep)
                plan["reviewed"] = True
                plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
                on_save(plan)
            except Exception as e:  # report, don't crash the server
                return self._send(400, json.dumps({"error": str(e)}).encode())
            self._send(200, b'{"ok":true}')
            if self.path == "/done":
                done.set()

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    if open_browser:
        webbrowser.open(url)
    if block:
        print(f"审核页面：{url}\n在页面上改完点“保存并结束审核”（或在这里按 Ctrl+C 结束）。", flush=True)
        try:
            done.wait()
        except KeyboardInterrupt:
            pass
        srv.shutdown()
    return srv, url
