"""`python -m pcut doctor`: check everything the pipeline needs and say how to fix what's missing."""
from __future__ import annotations

import importlib.util
import sys

from . import config


def main() -> int:
    rows, bad = [], 0

    def check(name, ok, fix, required=True):
        nonlocal bad
        rows.append(("✅" if ok else ("❌" if required else "⚠️"), name, "" if ok else fix))
        bad += (not ok) and required

    check("Python ≥ 3.10", sys.version_info >= (3, 10), "装 Python 3.10–3.12：https://www.python.org/downloads/")
    check("ffmpeg", bool(config.ffmpeg()), "运行 winget install Gyan.FFmpeg，或设置 PCUT_FFMPEG=ffmpeg.exe 路径")
    for mod, pip in (("faster_whisper", "faster-whisper"), ("soundfile", "soundfile"), ("numpy", "numpy"),
                     ("openai", "openai")):
        check(f"Python 包 {pip}", importlib.util.find_spec(mod) is not None, f"pip install {pip}")
    key, base, model = config.llm()
    check(f"大模型 Key（{model} @ {base}）", bool(key), "仓库根目录 .env 写 PCUT_LLM_API_KEY=你的Key（或设置 PCUT_ENV_FILE 指向已有的 .env）")
    has_funasr = importlib.util.find_spec("funasr") is not None
    import os
    check("说话人区分（可选）：funasr + CAM++ 模型", has_funasr and os.path.isdir(config.CAMPP),
          "pip install funasr torch torchaudio scikit-learn；模型放到 " + config.CAMPP +
          "（或设置 PCUT_CAMPP_DIR）。不装也能剪，只是文字稿不标说话人", required=False)
    cuda = False
    try:
        import ctranslate2
        cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        pass
    check("NVIDIA 显卡（可选；转写先试显卡，缺 CUDA 库会自动退回 CPU）", cuda, "没有也能跑，CPU 转写 1 小时录音约 50–60 分钟", required=False)
    for mark, name, fix in rows:
        print(f"{mark} {name}" + (f"\n     → {fix}" if fix else ""))
    print("\n可以开始剪了。" if not bad else f"\n还有 {bad} 项必须先解决。")
    return 1 if bad else 0
