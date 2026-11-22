# Windows installer for the pcut pipeline (app/).
# Usage (PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File 安装\install_windows.ps1            # core only
#   powershell -ExecutionPolicy Bypass -File 安装\install_windows.ps1 -Speakers  # + speaker separation (~2 GB)
#
# What it does: creates app\.venv, installs app\requirements.txt, checks ffmpeg, runs doctor (pcut.bat ships with the repo).
# It never asks for or stores API keys: put PCUT_LLM_API_KEY=... in the repo-root .env yourself.
param([switch]$Speakers)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Repo "app"
$Venv = Join-Path $App ".venv"

function Find-Python {
    foreach ($c in @("py -3.12", "py -3.11", "py -3.10", "python")) {
        $exe, $arg = $c.Split(" ", 2)
        try {
            $v = & $exe $arg -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
            if ($v -and [version]$v -ge [version]"3.10" -and [version]$v -lt [version]"3.13") { return $c }
        } catch {}
    }
    return $null
}

Write-Host "1/4 找 Python 3.10–3.12 ..."
$py = Find-Python
if (-not $py) { Write-Host "没找到。请先装 Python 3.12：https://www.python.org/downloads/ （安装时勾选 Add to PATH），再重新运行。"; exit 1 }
Write-Host "    用 $py"

Write-Host "2/4 建虚拟环境并装依赖（第一次约 5 分钟）..."
if (-not (Test-Path $Venv)) { $exe, $arg = $py.Split(" ", 2); & $exe $arg -m venv $Venv }
$vpy = Join-Path $Venv "Scripts\python.exe"
& $vpy -m pip install --upgrade pip -q
& $vpy -m pip install -r (Join-Path $App "requirements.txt") -q
if ($Speakers) { & $vpy -m pip install funasr torch torchaudio scikit-learn -q }

Write-Host "3/4 检查 ffmpeg ..."
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "    没找到 ffmpeg。推荐运行：winget install Gyan.FFmpeg   （装完重开 PowerShell）"
}

Write-Host "4/4 自检 ..."
& (Join-Path $Repo "pcut.bat") doctor
Write-Host ""
Write-Host "装好了。以后在仓库目录运行：  .\pcut.bat run <录音文件> <本期文件夹>"
