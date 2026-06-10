#!/usr/bin/env node
/**
 * 从阿里云FunASR转录结果生成subtitles_words.json
 *
 * 用法: node generate_subtitles_from_aliyun.js <aliyun_transcription.json> <speaker_mapping.json>
 *
 * speaker_mapping.json 格式: {"0": "麦雅", "1": "响歌歌", "2": "安安"}
 */

const fs = require('fs');

// 检查参数
if (process.argv.length < 3) {
    console.error('❌ 错误：缺少参数');
    console.error('');
    console.error('用法: node generate_subtitles_from_aliyun.js <aliyun_transcription.json> [speaker_mapping.json]');
    console.error('示例: node generate_subtitles_from_aliyun.js aliyun_funasr_transcription.json speaker_mapping.json');
    console.error('');
    console.error('如果不提供speaker_mapping.json，将使用默认映射: Speaker 0, Speaker 1, ...');
    process.exit(1);
}

const aliyunFile = process.argv[2];
const mappingFile = process.argv[3];

// 读取阿里云转录结果
let aliyunData;
try {
    aliyunData = JSON.parse(fs.readFileSync(aliyunFile, 'utf8'));
} catch (error) {
    console.error(`❌ 读取文件失败: ${aliyunFile}`);
    console.error(error.message);
    process.exit(1);
}

// 读取说话人映射（可选）
let speakerMapping = {};
if (mappingFile) {
    try {
        speakerMapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        console.log('✅ 已加载说话人映射:', speakerMapping);
    } catch (error) {
        console.warn(`⚠️  无法读取映射文件: ${mappingFile}，使用默认映射`);
    }
}

// 提取句子
const sentences = aliyunData.transcripts[0].sentences;

console.log(`📝 处理 ${sentences.length} 句话...`);

// 转换为subtitles_words格式
const words = [];

sentences.forEach((sentence, idx) => {
    const speakerId = sentence.speaker_id;
    const speakerName = speakerMapping[speakerId] || `Speaker ${speakerId}`;

    // 添加说话人标记（作为特殊"词"）
    if (idx === 0 || sentences[idx - 1].speaker_id !== speakerId) {
        words.push({
            text: `[${speakerName}]`,
            start: sentence.begin_time / 1000,
            end: sentence.begin_time / 1000,
            isGap: false,
            isSpeakerLabel: true,
            speaker: speakerName
        });
    }

    // 添加句子中的每个词
    sentence.words.forEach(word => {
        const text = word.text + (word.punctuation || '');
        words.push({
            text: text,
            start: word.begin_time / 1000,
            end: word.end_time / 1000,
            isGap: false,
            speaker: speakerName
        });
    });

    // 检查与下一句之间的间隔
    if (idx < sentences.length - 1) {
        const currentEnd = sentence.end_time / 1000;
        const nextStart = sentences[idx + 1].begin_time / 1000;
        const gap = nextStart - currentEnd;

        if (gap >= 0.5) {  // 间隔大于0.5秒
            words.push({
                text: '',
                start: currentEnd,
                end: nextStart,
                isGap: true
            });
        }
    }
});

// 保存结果
const outputFile = 'subtitles_words.json';
fs.writeFileSync(outputFile, JSON.stringify(words, null, 2));

// 推断字级时间戳是不是真声学对齐，写到 transcription_meta.json 让下游（generate_review.js）读。
// 信号：句内相邻词时间戳之间有 >1ms 间隙的比例。真声学对齐的 ASR（paraformer-v2 + alignment）
// 因为真停顿/呼吸/字间隙保留下来，比例 >2%（实测 EP1=5.4% / EP21=14.5%）。后处理均分的 ASR
// （fun-asr 触发到 16kHz 均分模式时）所有相邻词首尾相连，比例 <1%（实测 EP1=0.2%）。
// 阈值 2% 是中间值，能把两种模式干净分开。
//
// 没有这个 meta 文件的旧项目，review.html 默认 timestamps_acoustic=false（向后兼容 = 保留
// 原有 fun-asr 时代的边界 nudge 行为）。
let gapPairs = 0;
let gapPositive = 0;
const sentences2 = aliyunData.transcripts[0].sentences;
for (const s of sentences2) {
    const ws = s.words || [];
    for (let i = 0; i < ws.length - 1; i++) {
        const gap = (ws[i + 1].begin_time - ws[i].end_time) / 1000;
        gapPairs++;
        if (gap > 0.001) gapPositive++;
    }
}
const gapRate = gapPairs > 0 ? gapPositive / gapPairs : 0;
const ACOUSTIC_THRESHOLD = 0.02;
const meta = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    timestamps_acoustic: gapRate >= ACOUSTIC_THRESHOLD,
    signal: {
        within_sentence_gap_rate: Math.round(gapRate * 10000) / 10000,
        gap_threshold: ACOUSTIC_THRESHOLD,
        gap_pairs: gapPairs,
        gap_positive: gapPositive,
    },
};
fs.writeFileSync('transcription_meta.json', JSON.stringify(meta, null, 2));
console.log(`📊 transcription_meta: timestamps_acoustic=${meta.timestamps_acoustic} (within-sent gap rate=${(gapRate*100).toFixed(1)}%, threshold ${ACOUSTIC_THRESHOLD*100}%)`);

console.log('✅ 已生成:', outputFile);
console.log(`   总词数: ${words.filter(w => !w.isGap && !w.isSpeakerLabel).length}`);
console.log(`   说话人标记: ${words.filter(w => w.isSpeakerLabel).length}`);
console.log(`   静音段: ${words.filter(w => w.isGap).length}`);

// 统计说话人分布
const speakerCounts = {};
words.forEach(w => {
    if (w.speaker && !w.isSpeakerLabel && !w.isGap) {
        speakerCounts[w.speaker] = (speakerCounts[w.speaker] || 0) + 1;
    }
});

console.log('\n📊 说话人词数分布:');
Object.keys(speakerCounts).sort().forEach(speaker => {
    const count = speakerCounts[speaker];
    const pct = (count / words.filter(w => !w.isGap && !w.isSpeakerLabel).length * 100).toFixed(1);
    console.log(`   ${speaker}: ${count}词 (${pct}%)`);
});
