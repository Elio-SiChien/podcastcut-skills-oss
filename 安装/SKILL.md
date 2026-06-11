---
name: podcastcut:安装
description: 环境准备。注册 Skills、安装依赖、配置 API Key、验证环境。触发词：安装、环境准备、初始化
---

<!--
input: 无
output: 环境就绪
pos: 前置 skill，首次使用前运行

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 安装

> 首次使用前的环境准备

## 快速使用

```
用户: 安装环境
用户: 初始化
用户: 准备播客剪辑环境
```

## 步骤 0: 注册 Skills（snapshot 模式）

Claude Code 从 `~/.claude/skills/` 目录发现 skills。本项目改用 **snapshot 模式安装**：每次安装从 dev 仓库**复制** SKILL.md 和 shared/ 到 `~/.claude/skills/`，install 完之后 dev 仓库换 branch / checkout 别的 PR 都**不会**影响线上 agent 行为。

```bash
# 设置项目路径（根据你 clone 的位置修改）
PODCASTCUT_DIR="/path/to/podcastcut"

# 一键安装
bash "$PODCASTCUT_DIR/安装/install.sh"
```

脚本会：
1. 把 `shared/` 复制到 `~/.claude/skills/podcastcut-shared/`（canonical snapshot）
2. 给每个技能创建 `~/.claude/skills/podcastcut-<名>/` 实目录（不是 symlink），里面：
   - SKILL.md（复制自 dev 仓库）
   - `shared/` → `../podcastcut-shared/`（symlink，dedup 指向 canonical snapshot）
   - `output/` → 项目 output 路径（symlink，default `/Volumes/T9/claude_skill/podcastcut/output`）
3. 写 `install_manifest.json` 记录 install-time 的 git commit + branch + 时间
4. 跑 pre-flight 自检：所有 `$SKILL_DIR/SKILL.md` / `$SKILL_DIR/shared/scripts` / `$SKILL_DIR/shared/templates` 都存在 → 没问题就报 ✅；否则 fail-fast 提示哪条 path 没装上

验证：

```bash
ls ~/.claude/skills/ | grep podcastcut
cat ~/.claude/skills/podcastcut-shared/install_manifest.json   # 查看当前 install 版本
```

> **注意**：如果 `~/.claude/skills/` 目录不存在，install.sh 会自动创建。
>
> **环境变量可覆盖**：`OUTPUT_DIR` 改 output 路径；`INSTALL_ROOT` 改安装目标（默认 `~/.claude/skills/`）。

### 更新 / 同步

每次 dev 仓库 `git pull` 之后想把新代码推到线上 agent，**必须重跑 install.sh**：

```bash
bash "$PODCASTCUT_DIR/安装/install.sh"
```

不再像以前那样"dev 仓库一改就立刻生效"。这是这个 snapshot 模式的设计取舍：
- 优：dev 仓库换 branch / 做 worktree / checkout PR 测试，**不影响**线上 agent 行为
- 缺：必须显式 sync 才能 update 线上行为

### 历史背景：为什么不再用 symlink

旧版本（PR #75 之前）安装是 `ln -s "$PODCASTCUT_DIR/粗剪" ~/.claude/skills/podcastcut-粗剪`。
表面看是隔离，实际上 `$SKILL_DIR/shared/scripts/<x>` 会路径解析回 dev 仓库的 mutable 文件。
2026-06-10 上午 wdyk 那次 incident 就是这么炸的：dev 仓库 stuck 在
`fix/finecut-dui-overdeletion` 分支没切回 main，wdyk 跑 `generate_review.js` 拿到的是
那个分支上的**旧模板**（缺 PR #66/#68/#71/#72/#73/#74/#75/#77 修复），导致 review 里
已经修过的 bug "复发"——其实只是路径解析吃了 stale 代码。

PR #83 改成 snapshot 模式根治这个问题。

## 步骤 1: 安装依赖

| 依赖 | 用途 | 安装命令 |
|------|------|----------|
| Node.js | 运行脚本 | `brew install node` |
| FFmpeg | 音频处理、CBR 重编码 | `brew install ffmpeg` |
| Python 3 | 音频剪辑 (`cut_audio.py`) | macOS 自带，或 `brew install python3` |
| DeepFilterNet | 音频降噪/去回声（音质处理） | `pip install deepfilternet` |
| pyloudnorm | 响度分析和标准化（音质处理） | `pip install pyloudnorm` |
| librosa | 音频信号分析（质检+音质处理） | `pip install librosa soundfile` |
| curl | API 调用 | 系统自带 |

```bash
# macOS
brew install node ffmpeg

# Python 依赖
pip install deepfilternet    # 音频降噪/去回声（音质处理 skill）
pip install pyloudnorm       # 响度分析和标准化（音质处理 skill）
pip install librosa soundfile numpy  # 音频信号分析（质检+音质处理）

# 验证
node -v
ffmpeg -version
python3 --version
deepFilter --version
```

## 步骤 2: 配置 API Key

### 阿里云 DashScope（语音识别）

控制台：https://dashscope.console.aliyun.com/

1. 注册阿里云账号
2. 开通"模型服务灵积"
3. 创建 API Key

```bash
cd "$PODCASTCUT_DIR"
cp .env.example .env
# 编辑 .env，填入 API Key
```

`.env` 文件内容：

```
DASHSCOPE_API_KEY=sk-your-api-key-here
```

## 步骤 3: 验证

```bash
node -v                              # Node.js
ffmpeg -version                      # FFmpeg
python3 --version                    # Python 3
deepFilter --version                 # DeepFilterNet（可选）
cat "$PODCASTCUT_DIR/.env" | grep DASHSCOPE  # API Key
ls -la ~/.claude/skills/ | grep podcastcut   # Skills 注册
```

全部通过后即可使用：

```
/podcastcut-edit-chat (或者发音频附件触发 chat-mode)
```

## 常见问题

### Q1: API Key 在哪获取？

阿里云控制台 → https://dashscope.console.aliyun.com/ → 创建 API Key

### Q2: ffmpeg 命令找不到

```bash
which ffmpeg  # 应该输出路径
# 如果没有：brew install ffmpeg
```

### Q3: 支持多长的播客？

- 已验证：2.5 小时（147 分钟）正常处理
- 阿里云 FunASR API 转录约 3 分钟完成（与音频时长无关）
- 无硬性上限，超长播客无需分段

### Q4: 多人对话能识别说话人吗？

支持。阿里云 FunASR API 提供说话人分离功能，实测 98.8% 准确度。需要在转录时指定正确的说话人数量。

### Q5: Skills 注册后看不到？

1. 确认 symlink 有效：`ls -la ~/.claude/skills/ | grep podcastcut`
2. 确认目标存在：`ls "$PODCASTCUT_DIR/安装/SKILL.md"`
3. 重启 Claude Code 会话（新会话会重新扫描 skills 目录）

### Q6: 如何处理音乐和音效？

使用后期 skill（`/podcastcut-后期`）：片头预览、主题曲片头片尾、时间戳章节、标题建议、播客简介。
