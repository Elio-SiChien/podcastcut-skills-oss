# Regression Tests

防止以后换模型 / 改 pipeline 时静默引入 regression 的快测试。**不需要网络/API key**——所有测试都基于 fixture 或 source code 静态检查。

## 用法

```bash
bash shared/scripts/tests/run_all.sh
```

或单跑：

```bash
python3 shared/scripts/tests/test_silence_snap.py
bash    shared/scripts/tests/test_asr_model.sh
python3 shared/scripts/tests/test_punctuation_density.py
```

## 测试

### `test_asr_model.sh`
**守住**：当前 ASR 默认必须是 `paraformer-v2 + timestamp_alignment_enabled=true`。
这套组合在 PR #80 复测里把 EP21 同段长 utterance 漂移降到约 180ms，并恢复热词支持。

**测试**：静态检查 `aliyun_funasr_transcribe.sh`：
- `model:` 字段 == `paraformer-v2`
- `timestamp_alignment_enabled: true`

任何人换模型或关掉 alignment 而没改本测试，这条会立刻挂。

**修改流程**：如果故意要换 ASR 模型或 alignment 策略，**先**：
1. 取一段已知音频，新 ASR + Whisper 跑一遍
2. 对比各词时间戳偏差 ≤ 0.3s
3. 验证标点密度通过 `test_punctuation_density.py`
4. 验证 partial-delete / highlight 跟读的实际切点
5. 通过后 PR 同步改本测试的 contract，附 validation 报告

### `test_punctuation_density.py`
**守住**：fun-asr 在长 utterance 上 suppress 句中标点 → 长 blob 句子，
下游分句/审查页/LLM 都受影响。`enhance_punctuation.js`（PR #29）专门补标点。

**测试**：对 fixture sentences.txt（已知 enhance 处理过）做断言：
- 长度 > 50 字的句子必须有 ≥ 2 个标点
- 允许 ≤ 10% 的句子违规（accommodation for edge cases）

**回归排查**：
- enhance_punctuation.js 还 wired 着吗？（转录/SKILL.md step 6.5）
- LLM 调用挂了？
- 路径搬迁后 wiring 断了？

### `test_silence_snap.py`
**守住**：cut_audio.py 的 silence-snap 行为不被无意中改坏。

**测试**：
1. 长 delete（≥1.5s）末尾吸到最远静音
2. 长 delete 头部吸到最早静音
3. 短 delete（filler）不动 — 避免吃假静音里的真语音
4. 超长 delete（≥60s，pre-show/wrap-up）不动 — 避免吃主内容开头/结尾
5. 邻近 delete 重叠后正确 merge
6. 超窗口的静音不吸
7. 没有静音时不动

## 加新 test 的原则

- **No network / no API key**：所有测试本地跑完
- **快**：单测整套 < 5 秒
- **针对具体 regression**：每条测试对应一个真实发现过的 bug 或 risk
- **错误消息可执行**：测试挂时告诉 reader 怎么排查 / 修
- **Fixture 标注来源**：fixture 数据来自哪里、为什么是 "good" baseline

## CI 集成

待 follow-up PR：把 `bash run_all.sh` 接到 GitHub Actions，每个 PR 自动跑。
