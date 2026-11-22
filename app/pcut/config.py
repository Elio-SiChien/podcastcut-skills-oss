"""Where tools, keys and models live. Everything can be overridden by environment variables or a .env file.

Lookup order for each setting: environment variable → <repo>/.env → ~/.pcut/.env → default.
"""
from __future__ import annotations

import glob
import os
import shutil
from pathlib import Path

APP = Path(__file__).resolve().parent.parent          # <repo>/app
REPO = APP.parent
SCRIPTS = REPO / "shared" / "scripts"                  # cut_audio.py / trim_silences.py live here
HOME = Path(os.getenv("PCUT_HOME", Path.home() / ".pcut"))


def _load_env_files() -> dict:
    vals = {}
    extra = os.environ.get("PCUT_ENV_FILE")          # point at an existing .env instead of copying keys around
    for f in [HOME / ".env", REPO / ".env"] + ([Path(extra)] if extra else []):   # later wins
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                k, sep, v = line.strip().partition("=")
                if sep and not k.startswith("#"):
                    vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


_ENV = _load_env_files()


def get(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name) or _ENV.get(name) or default


def ffmpeg() -> str | None:
    """ffmpeg path: PCUT_FFMPEG, PATH, or the usual winget install folder."""
    p = get("PCUT_FFMPEG") or shutil.which("ffmpeg")
    if p:
        return p
    hits = sorted(glob.glob(os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\ffmpeg.exe")))
    return hits[-1] if hits else None


def ffprobe() -> str | None:
    f = ffmpeg()
    if not f:
        return None
    p = Path(f).with_name("ffprobe.exe" if f.endswith(".exe") else "ffprobe")
    return str(p) if p.exists() else shutil.which("ffprobe")


# LLM: any OpenAI-compatible endpoint. Default DeepSeek (cheap; a 1-hour episode costs well under 1 RMB).
def llm():
    key = get("PCUT_LLM_API_KEY") or get("DEEPSEEK_API_KEY")
    base = get("PCUT_LLM_BASE_URL") or get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
    model = get("PCUT_LLM_MODEL") or get("DEEPSEEK_MODEL") or "deepseek-chat"
    return key, base, model


WHISPER_MODEL = get("PCUT_WHISPER_MODEL", "mobiuslabsgmbh/faster-whisper-large-v3-turbo")
WHISPER_DEVICE = get("PCUT_WHISPER_DEVICE", "auto")     # auto | cpu | cuda

# CAM++ speaker-embedding model (optional; without it, speakers are not separated)
CAMPP = get("PCUT_CAMPP_DIR", str(Path.home() / ".cache" / "modelscope" / "models"
                                  / "iic--speech_campplus_sv_zh-cn_16k-common" / "snapshots" / "master"))


def subprocess_env() -> dict:
    """Env for child scripts: UTF-8 everywhere (Windows cp1252 breaks on Chinese paths) and ffmpeg on PATH."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    f = ffmpeg()
    if f:
        env["PATH"] = str(Path(f).parent) + os.pathsep + env.get("PATH", "")
    return env
