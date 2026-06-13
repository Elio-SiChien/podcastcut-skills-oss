# Podcastcut

用 Claude Code Skills 构建的播客剪辑工具。
丢进原始录音，AI 自动转录、分析内容、标记删减，在浏览器里审一遍，导出，剪辑完成。

## 粗剪审查页面

设定目标时长和用户偏好，AI 预删减内容，让你更快进入精剪和高光筛选。

### 编辑模式

![编辑模式](docs/review-edit.png)

完整逐字稿按章节导航呈现，AI 建议删除的段落标记理由，一键恢复或追加删除。

### 粗剪预览

![粗剪预览](docs/review-preview.png)

直接试听成品效果。粗剪完成后右上角导出json丢进Claude Code继续执行精剪。

## 安装

```bash
git clone https://github.com/luoyuweidu1/podcastcut-skills.git
cd podcastcut-skills

# 注册 Claude Code Skills
bash 安装/install.sh

# 依赖
brew install node ffmpeg

# API Key
cp .env.example .env
# 编辑 .env，填入阿里云 DashScope API Key

# 自检
npm install
npm run doctor
npm run fresh-agent -- --role podcast
npm test
```

如果 Python 依赖装在虚拟环境里，`doctor` 支持显式指定解释器：

```bash
PYTHON=.venv/bin/python npm run doctor
```

在 Slock / Claude Code chat 里直接发音频附件 + "剪一下"，触发 `podcastcut-edit-chat` 走完整流程；
或在 CLI 里按需调用各 stage skill（`/podcastcut-转录` / `/podcastcut-粗剪` / 等）。

## 自检命令

Fresh agent onboarding: see `AGENT_ONBOARDING.md`.

| 命令 | 用途 |
|------|------|
| `npm run doctor` | 检查本机 Node / Python / ffmpeg / 输出目录 / API key / cloud-bridge 状态 |
| `npm run footer -- [BASE_DIR] [COMPLETED_STAGE]` | 生成 checkpoint chat 的“当前已完成 / 下一步 / 剩余流程”三行 footer |
| `npm run fresh-agent -- --role podcast` | 检查新专属剪辑 agent 的 snapshot / profile / output / cloud-bridge 是否就绪 |
| `npm run fresh-agent -- --role dispatcher` | 检查通用 dispatcher agent 的 snapshot / output / cloud-bridge 是否就绪 |
| `npm test` | 跑本地 regression tests，不需要网络或 API key |
| `npm run status -- [BASE_DIR]` | 查看当前或指定项目的 `project.json` pipeline 状态 |
| `npm run validate -- [BASE_DIR] [STAGE]` | 检查某个阶段所需输入文件是否齐全 |

## 流程

```
阶段 1  转录 + AI 分析
阶段 2  人工审核（粗剪审查页面）
阶段 3  剪辑执行 + 质检
阶段 4  音质处理（按说话人降噪、响度标准化）
阶段 5  后期（高光片段、片头片尾、时间戳）
```

## Skill 清单

| 命令 | 功能 |
|------|------|
| `/podcastcut-安装` | 环境准备 |
| `/podcastcut-edit-chat` | chat-mode 编排器（音频附件触发，串起各 stage，每步暂停） |
| `/podcastcut-onboarding-chat` | 新播客首次接入（建 profile） |
| `/podcastcut-转录` | 转录单元：音频 → DashScope paraformer-v2 + alignment → 字级转录 + 分句 |
| `/podcastcut-粗剪` | 粗剪单元：段落级分析 + 句子级审查页 → `delete_segments_roughcut.json` |
| `/podcastcut-精剪` | 精剪单元：词级口癖删减 + AI 自审查 + 词级审查页 → `delete_segments_edited.json` |
| `/podcastcut-执行` | 执行单元：按删除清单从 `audio_original` 切成品（≥192k） |
| `/podcastcut-质检` | 数据层 + 信号层 + 语义层质检 |
| `/podcastcut-音质处理` | 按说话人降噪、LUFS 标准化 |
| `/podcastcut-后期` | 高光、音乐、时间戳、标题 |

## 致谢

Fork 自 [@luoyuweidu1](https://github.com/luoyuweidu1) 的 [podcastcut-skills](https://github.com/luoyuweidu1/podcastcut-skills)。核心转录、分析、质检架构来自原项目，本版本在此基础上做了审查体验重设计和功能扩展。

## OSS Freeze

商业化开发转 private 前的开源冻结流程见 `docs/oss-freeze/runbook.md`。冻结版 README 模板见 `docs/oss-freeze/README.snapshot.md`。

## License

MIT. See `LICENSE`.
