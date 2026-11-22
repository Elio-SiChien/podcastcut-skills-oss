#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const STAGES = ['transcribe', 'roughcut', 'fine', 'execute', 'qa', 'audio_quality', 'post'];
const STAGE_LABELS = {
  transcribe: '转录',
  roughcut: '粗剪',
  fine: '精剪',
  execute: '出片',
  qa: '质检',
  audio_quality: '音质',
  post: '后期',
};
const MANDATORY_STAGES = ['transcribe', 'roughcut', 'fine', 'execute'];
const OPTIONAL_STAGES = ['qa', 'audio_quality', 'post'];

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') return usage(0);

  try {
    if (cmd === 'doctor') return doctor(args);
    if (cmd === 'footer') return footer(args);
    if (cmd === 'fresh-agent') return freshAgent(args);
    if (cmd === 'episode') return episode(args);
    if (cmd === 'status') return status(args);
    if (cmd === 'validate') return validate(args);
    usage(1, `unknown command: ${cmd}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

function usage(code, msg = '') {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.log(`Usage:
  npm run doctor
  npm run footer -- [BASE_DIR] [COMPLETED_STAGE]
  npm run fresh-agent -- [--role podcast|dispatcher]
  npm run episode -- <start|review|execute|learn> [BASE_DIR] [options]
  npm run status -- [BASE_DIR]
  npm run validate -- [BASE_DIR] [STAGE]

Commands:
  doctor       Check local machine prerequisites.
  footer       Render the standard checkpoint progress footer.
  fresh-agent  Check installed snapshot/profile/tunnel readiness for a new agent.
  episode      KISS episode workflow: preferences, review gates, execution gate, learning candidates.
  status       Show project.json pipeline state.
  validate     Check required files for one stage or the current stage.
`);
  process.exit(code);
}

function doctor(args) {
  const opts = parseOpts(args);
  if (opts.freshAgent) return freshAgent(args.filter((arg) => arg !== '--fresh-agent'));

  const outputDir = resolveOutputDir(opts);
  const python = pythonCommand();
  const checks = [];

  checks.push(checkCommand('node', ['--version'], { required: true }));
  checks.push(checkCommand('bash', ['--version'], { required: true }));
  checks.push(checkCommand('ffmpeg', ['-version'], { required: true }));
  checks.push(checkCommand('ffprobe', ['-version'], { required: true }));
  checks.push(checkCommand(python, ['--version'], { name: `python (${python})`, required: true }));
  checks.push(checkCommand('cloudflared', ['--version'], { required: false }));

  checks.push(checkPath('repo shared scripts', path.join(REPO_ROOT, 'shared', 'scripts'), 'dir', true));
  checks.push(checkPath('repo cloud-bridge', path.join(REPO_ROOT, 'cloud-bridge'), 'dir', true));
  checks.push(checkWritableDir('output dir', outputDir, false));

  const envFile = path.join(REPO_ROOT, '.env');
  const hasDashScope = Boolean(process.env.DASHSCOPE_API_KEY) || fileContains(envFile, /^DASHSCOPE_API_KEY=.+/m);
  checks.push({
    name: 'DASHSCOPE_API_KEY',
    ok: hasDashScope,
    required: false,
    detail: hasDashScope ? 'configured' : 'missing; required for real ASR',
  });

  const tunnelFile = path.join(REPO_ROOT, 'cloud-bridge', 'current_tunnel_url.txt');
  checks.push({
    name: 'cloud-bridge tunnel URL',
    ok: fs.existsSync(tunnelFile),
    required: false,
    detail: fs.existsSync(tunnelFile) ? fs.readFileSync(tunnelFile, 'utf8').trim() : 'missing; review pages need a tunnel or fallback',
  });

  const pyRequired = ['numpy', 'soundfile', 'pyloudnorm'];
  const pyOptional = ['librosa', 'df', 'torch', 'torchaudio'];
  checks.push(checkPythonImports('python audio deps', pyRequired, true, python));
  checks.push(checkPythonImports('python optional deps', pyOptional, false, python));

  printChecks('podcastcut doctor', checks);
  exitForRequiredChecks(checks);
}

function footer(args) {
  const opts = parseOpts(args);
  const positional = opts._;
  let baseDir;
  let completedStage;

  if (positional[0] && STAGES.includes(positional[0])) {
    completedStage = positional[0];
    baseDir = resolveCurrentBaseDir(opts);
  } else {
    baseDir = positional[0] ? path.resolve(positional[0]) : resolveCurrentBaseDir(opts);
    completedStage = positional[1];
  }

  if (!baseDir) throw new Error('BASE_DIR not provided and no output/.current_project found');
  const manifest = loadManifest(baseDir);
  completedStage ||= inferCompletedStage(manifest);
  if (!STAGES.includes(completedStage)) throw new Error(`unknown completed stage: ${completedStage}`);

  console.log(renderFooter(manifest, completedStage));
}

function freshAgent(args) {
  const opts = parseOpts(args);
  const role = normalizeFreshAgentRole(opts.role || opts._[0] || 'podcast');
  const installRoot = opts.installRoot ? path.resolve(opts.installRoot) : defaultInstallRoot();
  const outputDir = resolveOutputDir(opts);
  const sharedDir = path.join(installRoot, 'podcastcut-shared');
  const cloudBridgeDir = path.join(installRoot, 'cloud-bridge');
  const profilesDir = path.join(installRoot, 'profiles');
  const skillName = role === 'dispatcher' ? 'podcastcut-dispatcher' : 'podcastcut-edit-chat';
  const checks = [];

  checks.push(checkPath('installed skills root', installRoot, 'dir', true));
  checks.push(checkPath('snapshot manifest', path.join(sharedDir, 'install_manifest.json'), 'file', true));
  checks.push(checkManifest('snapshot manifest details', path.join(sharedDir, 'install_manifest.json'), false));
  checks.push(checkPath('snapshot shared scripts', path.join(sharedDir, 'scripts'), 'dir', true));
  checks.push(checkPath(`${skillName} SKILL.md`, path.join(installRoot, skillName, 'SKILL.md'), 'file', true));
  checks.push(checkPath(`${skillName} shared scripts`, path.join(installRoot, skillName, 'shared', 'scripts'), 'dir', true));
  checks.push(checkWritableDir('output dir', outputDir, true));
  checks.push(checkPath('cloud-bridge scripts', path.join(cloudBridgeDir, 'scripts'), 'dir', role === 'podcast'));
  checks.push(checkTunnelUrl(path.join(cloudBridgeDir, 'current_tunnel_url.txt'), false));

  if (role === 'podcast') {
    checks.push(checkPath('profiles dir', profilesDir, 'dir', true));
    checks.push(checkProfileJson(profilesDir, true));
    checks.push(checkProfileAmbiguity(profilesDir));
  } else {
    checks.push(checkPath('profiles dir', profilesDir, 'dir', false));
  }

  printChecks(`podcastcut fresh-agent (${role})`, checks);
  exitForRequiredChecks(checks);
}

function inferCompletedStage(manifest) {
  const current = manifest.current_stage;
  if (current && MANDATORY_STAGES.includes(current)) {
    const currentIndex = MANDATORY_STAGES.indexOf(current);
    if (currentIndex > 0) return MANDATORY_STAGES[currentIndex - 1];
  }

  const pipeline = Array.isArray(manifest.pipeline) ? manifest.pipeline : [];
  const completed = pipeline
    .filter((stage) => isDoneLike(stage.status))
    .map((stage) => stage.id)
    .filter((id) => STAGES.includes(id));

  for (const id of [...STAGES].reverse()) {
    if (completed.includes(id)) return id;
  }

  return 'transcribe';
}

function renderFooter(manifest, completedStage) {
  const completedSet = completedStageSet(manifest, completedStage);
  const nextStage = nextMandatoryStage(completedSet);
  const completedLabel = STAGE_LABELS[completedStage] || completedStage;
  const nextLine = nextStage ? nextMandatoryText(nextStage) : optionalNextText(completedSet);

  return [
    '—————',
    `📍 当前已完成：${completedLabel}`,
    `🎯 下一步：${nextLine}`,
    `📋 剩余流程：${remainingFlowText(completedSet, nextStage)}`,
  ].join('\n');
}

function completedStageSet(manifest, completedStage) {
  const done = new Set();
  const completedIndex = STAGES.indexOf(completedStage);
  for (const id of MANDATORY_STAGES) {
    if (STAGES.indexOf(id) <= completedIndex) done.add(id);
  }

  const pipeline = Array.isArray(manifest.pipeline) ? manifest.pipeline : [];
  for (const stage of pipeline) {
    if (OPTIONAL_STAGES.includes(stage.id) && isDoneLike(stage.status)) {
      done.add(stage.id);
    }
  }
  return done;
}

function nextMandatoryStage(completedSet) {
  return MANDATORY_STAGES.find((id) => !completedSet.has(id)) || null;
}

function nextMandatoryText(stage) {
  const text = {
    roughcut: '粗剪（段落级删减，自动）',
    fine: '精剪（词级口癖删减，自动）',
    execute: '出片（按你的决定切音频）',
  };
  return text[stage] || STAGE_LABELS[stage] || stage;
}

function optionalNextText(completedSet) {
  const options = OPTIONAL_STAGES.filter((id) => !completedSet.has(id));
  if (!options.length) return '完成';
  const labels = options.map((id, index) => `${String.fromCharCode(65 + index)}) ${optionalLabel(id)}`);
  return `${labels.join(' / ')} / ${String.fromCharCode(65 + options.length)}) 完成`;
}

function remainingFlowText(completedSet, nextStage) {
  if (!nextStage) {
    const remainingOptional = OPTIONAL_STAGES.filter((id) => !completedSet.has(id)).map(optionalShortLabel);
    if (!remainingOptional.length) return '✅ 全部流程已做';
    return `✅ 全部必走阶段已做 · 可选：${remainingOptional.join(' / ')}`;
  }

  const mandatory = MANDATORY_STAGES.map((id) => {
    if (completedSet.has(id)) return `✅ ${STAGE_LABELS[id]}`;
    if (id === nextStage) return `**${STAGE_LABELS[id]}**`;
    return STAGE_LABELS[id];
  }).join(' → ');
  const optional = OPTIONAL_STAGES.map(optionalShortLabel).join(' · ');
  return `${mandatory} · ${optional}`;
}

function optionalLabel(id) {
  const text = {
    qa: '质检',
    audio_quality: '音质处理',
    post: '后期（片头/章节/简介/金句）',
  };
  return text[id] || STAGE_LABELS[id] || id;
}

function optionalShortLabel(id) {
  return STAGE_LABELS[id] || id;
}

function isDoneLike(status) {
  return ['done', 'approved', 'complete', 'completed', 'skipped'].includes(String(status || '').toLowerCase());
}

function status(args) {
  const opts = parseOpts(args);
  const positional = opts._;
  const baseDir = positional[0] ? path.resolve(positional[0]) : resolveCurrentBaseDir(opts);
  if (!baseDir) {
    console.log('No project selected. Pass BASE_DIR or set output/.current_project.');
    return;
  }

  const manifest = loadManifest(baseDir);
  console.log(`Project: ${manifest.project?.id || path.basename(path.resolve(baseDir, '..'))}`);
  console.log(`Base dir: ${baseDir}`);
  console.log(`Title: ${manifest.project?.title || '(none)'}`);
  console.log(`Current stage: ${manifest.current_stage || 'complete'}`);
  console.log('');
  console.log('Pipeline:');
  for (const stage of manifest.pipeline || []) {
    const marker = stage.id === manifest.current_stage ? '>' : ' ';
    console.log(`${marker} ${stage.id.padEnd(13)} ${String(stage.status || 'unknown').padEnd(16)} ${stage.label || ''}`);
  }
}

function validate(args) {
  const opts = parseOpts(args);
  const positional = opts._;
  let baseDir;
  let stage;

  if (positional[0] && STAGES.includes(positional[0])) {
    stage = positional[0];
    baseDir = resolveCurrentBaseDir(opts);
  } else {
    baseDir = positional[0] ? path.resolve(positional[0]) : resolveCurrentBaseDir(opts);
    stage = positional[1];
  }

  if (!baseDir) throw new Error('BASE_DIR not provided and no output/.current_project found');
  const manifest = fs.existsSync(path.join(baseDir, 'project.json')) ? loadManifest(baseDir) : null;
  stage ||= manifest?.current_stage || 'transcribe';
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);

  const checks = stageChecks(baseDir, stage);
  printChecks(`validate ${stage}`, checks);
  exitForRequiredChecks(checks);
}

function stageChecks(baseDir, stage) {
  const checks = [
    checkPath('base dir', baseDir, 'dir', true),
    checkPath('project.json', path.join(baseDir, 'project.json'), 'file', stage !== 'transcribe'),
  ];

  if (stage === 'transcribe') {
    checks.push(checkAny('audio_original.*', path.join(baseDir, '1_转录'), /^audio_original\./, true));
    checks.push(checkPath('ASR audio.mp3', path.join(baseDir, '1_转录', 'audio.mp3'), 'file', false));
    checks.push(checkPath('seekable audio', path.join(baseDir, '1_转录', 'audio_seekable.mp3'), 'file', false));
    return checks;
  }

  checks.push(...transcribeOutputs(baseDir));
  if (stage === 'roughcut') {
    checks.push(checkPath('episode_preferences.json', path.join(baseDir, 'episode_preferences.json'), 'file', true));
    checks.push(checkPath('profile.json', path.join(baseDir, 'profile.json'), 'file', false));
    checks.push(checkPath('_debrief.json', path.join(baseDir, '_debrief.json'), 'file', false));
    return checks;
  }

  checks.push(checkPath('semantic_deep_analysis.json', path.join(baseDir, '2_分析', 'semantic_deep_analysis.json'), 'file', true));
  if (stage === 'fine') {
    checks.push(checkPath('delete_segments_roughcut.json', path.join(baseDir, '2_分析', 'delete_segments_roughcut.json'), 'file', false));
    return checks;
  }

  checks.push(checkPath('episode_preferences.json', path.join(baseDir, 'episode_preferences.json'), 'file', true));
  checks.push(checkPath('fine_analysis.json', path.join(baseDir, '2_分析', 'fine_analysis.json'), 'file', stage !== 'execute')); 
  checks.push(checkPath('delete_segments_edited.json', path.join(baseDir, '2_分析', 'delete_segments_edited.json'), 'file', true));
  checks.push(checkAny('audio_original.*', path.join(baseDir, '1_转录'), /^audio_original\./, true));

  if (stage === 'execute') {
    checks.push(checkReviewGate(baseDir, 'roughcut', '2_分析/delete_segments_roughcut.json'));
    checks.push(checkReviewGate(baseDir, 'fine', '2_分析/delete_segments_edited.json'));
    return checks;
  }

  checks.push(checkAny('3_成品 audio', path.join(baseDir, '3_成品'), /\.(m4a|mp3|wav)$/i, true));
  if (stage === 'audio_quality') return checks;

  if (stage === 'post') {
    checks.push(checkPath('sentences.txt', path.join(baseDir, '2_分析', 'sentences.txt'), 'file', true));
    checks.push(checkPath('delete_segments_edited.json', path.join(baseDir, '2_分析', 'delete_segments_edited.json'), 'file', true));
  }
  return checks;
}

function transcribeOutputs(baseDir) {
  return [
    checkPath('subtitles_words.json', path.join(baseDir, '1_转录', 'subtitles_words.json'), 'file', true),
    checkPath('speaker_mapping.json', path.join(baseDir, '1_转录', 'speaker_mapping.json'), 'file', true),
    checkPath('sentences.txt', path.join(baseDir, '2_分析', 'sentences.txt'), 'file', true),
    checkPath('audio_seekable.mp3', path.join(baseDir, '1_转录', 'audio_seekable.mp3'), 'file', true),
  ];
}

const AGGRESSIVENESS_VALUES = new Set(['conservative', 'moderate', 'aggressive']);
const AGGRESSIVENESS_ALIASES = new Map([
  ['保守', 'conservative'], ['conservative', 'conservative'],
  ['适中', 'moderate'], ['中等', 'moderate'], ['moderate', 'moderate'],
  ['激进', 'aggressive'], ['aggressive', 'aggressive'],
]);

function episode(args) {
  const [subcmd, ...rest] = args;
  if (!subcmd || subcmd === '-h' || subcmd === '--help') return episodeUsage(0);
  if (subcmd === 'start') return episodeStart(rest);
  if (subcmd === 'review') return episodeReview(rest);
  if (subcmd === 'execute') return episodeExecute(rest);
  if (subcmd === 'learn') return episodeLearn(rest);
  return episodeUsage(1, 'unknown episode command: ' + subcmd);
}

function episodeUsage(code, msg = '') {
  if (msg) console.error('ERROR: ' + msg + '\n');
  console.log(`Usage:
  npm run episode -- start BASE_DIR --speaker-count N --speaker "姓名:角色" --editing-style 风格 --aggressiveness conservative|moderate|aggressive --target-minutes N [--must-keep 文本] [--must-delete 文本] [--privacy 文本] [--glossary 词,词]
  npm run episode -- review BASE_DIR roughcut|fine --ok [--source chat|review_page]
  npm run episode -- execute BASE_DIR
  npm run episode -- learn BASE_DIR roughcut|fine

The episode command is the KISS workflow guard. It never cuts audio itself; it validates state and writes small handoff files for the existing skills.`);
  process.exit(code);
}

function parseEpisodeOpts(args) {
  const out = { _: [], speakers: [], must_keep: [], must_delete: [], privacy: [], glossary: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(a + ' requires a value');
      return args[++i];
    };
    if (a === '--speaker-count') out.speaker_count = Number(val());
    else if (a === '--speaker') out.speakers.push(parseSpeaker(val()));
    else if (a === '--speakers-json') out.speakers = JSON.parse(val());
    else if (a === '--editing-style' || a === '--style') out.editing_style = val();
    else if (a === '--aggressiveness') out.aggressiveness = normalizeAggressiveness(val());
    else if (a === '--target-minutes') out.target_minutes = Number(val());
    else if (a === '--must-keep') out.must_keep.push(val());
    else if (a === '--must-delete') out.must_delete.push(val());
    else if (a === '--privacy') out.privacy.push(val());
    else if (a === '--glossary') out.glossary.push(...splitList(val()));
    else if (a === '--ok') out.ok = true;
    else if (a === '--source') out.source = val();
    else if (a === '--by') out.by = val();
    else if (a.startsWith('--')) throw new Error('unknown episode option: ' + a);
    else out._.push(a);
  }
  return out;
}

function parseSpeaker(raw) {
  const [name, ...roleParts] = String(raw).split(':');
  return { name: (name || '').trim(), role: roleParts.join(':').trim() || '说话人' };
}

function splitList(raw) {
  return String(raw).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

function normalizeAggressiveness(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return AGGRESSIVENESS_ALIASES.get(key) || raw;
}

function episodeStart(args) {
  const opts = parseEpisodeOpts(args);
  const baseDir = opts._[0] ? path.resolve(opts._[0]) : resolveCurrentBaseDir(opts);
  if (!baseDir) throw new Error('BASE_DIR is required for episode start');
  fs.mkdirSync(baseDir, { recursive: true });

  const existing = readJsonIfExists(path.join(baseDir, 'episode_preferences.json')) || {};
  const prefs = {
    version: 'episode_preferences_v1',
    speaker_count: opts.speaker_count ?? existing.speaker_count ?? (opts.speakers.length || undefined),
    speakers: opts.speakers.length ? opts.speakers : safeArray(existing.speakers),
    editing_style: opts.editing_style ?? existing.editing_style,
    aggressiveness: opts.aggressiveness ?? existing.aggressiveness,
    target_minutes: opts.target_minutes ?? existing.target_minutes,
    must_keep: mergeUnique(safeArray(existing.must_keep), opts.must_keep),
    must_delete: mergeUnique(safeArray(existing.must_delete), opts.must_delete),
    privacy: mergeUnique(safeArray(existing.privacy), opts.privacy),
    glossary: mergeUnique(safeArray(existing.glossary), opts.glossary),
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const missing = missingPreferenceFields(prefs);
  if (missing.length) {
    printPreferenceQuestions(missing, prefs);
    process.exit(1);
  }

  fs.writeFileSync(path.join(baseDir, 'episode_preferences.json'), JSON.stringify(prefs, null, 2));
  writeProfileFromPreferences(baseDir, prefs);
  writeDebriefFromPreferences(baseDir, prefs);
  syncManifestPreferences(baseDir, prefs);
  console.log('OK episode preferences written: ' + path.join(baseDir, 'episode_preferences.json'));
  console.log('Speakers: ' + prefs.speakers.map((s) => `${s.name}(${s.role})`).join(', '));
  console.log(`Style: ${prefs.editing_style}; aggressiveness: ${prefs.aggressiveness}; target: ${prefs.target_minutes} min`);
}

function missingPreferenceFields(prefs) {
  const missing = [];
  if (!Number.isFinite(Number(prefs.speaker_count)) || Number(prefs.speaker_count) <= 0) missing.push('speaker_count');
  if (!Array.isArray(prefs.speakers) || prefs.speakers.length !== Number(prefs.speaker_count) || prefs.speakers.some((s) => !s?.name || !s?.role)) missing.push('speakers');
  if (!prefs.editing_style || !String(prefs.editing_style).trim()) missing.push('editing_style');
  if (!AGGRESSIVENESS_VALUES.has(prefs.aggressiveness)) missing.push('aggressiveness');
  if (!Number.isFinite(Number(prefs.target_minutes)) || Number(prefs.target_minutes) <= 0) missing.push('target_minutes');
  return [...new Set(missing)];
}

function printPreferenceQuestions(missing, prefs) {
  console.log('PREFERENCE_REQUIRED');
  console.log('开始剪辑前必须先补齐这些信息；补齐前不要进入转录/粗剪/精剪。');
  for (const field of missing) {
    if (field === 'speaker_count') console.log('- speaker_count: 本期有几位说话人？');
    if (field === 'speakers') console.log(`- speakers: 请给出 ${prefs.speaker_count || 'N'} 位说话人的姓名+角色，例如 --speaker "裘思谦:主持"。`);
    if (field === 'editing_style') console.log('- editing_style: 本期剪辑风格是什么？例如 科研访谈 / 闲聊 / 叙事 / 教学。');
    if (field === 'aggressiveness') console.log('- aggressiveness: 请选择 conservative / moderate / aggressive（保守 / 适中 / 激进）。');
    if (field === 'target_minutes') console.log('- target_minutes: 目标时长是多少分钟？');
  }
}

function writeProfileFromPreferences(baseDir, prefs) {
  const profilePath = path.join(baseDir, 'profile.json');
  const existing = readJsonIfExists(profilePath) || {};
  const profile = {
    ...existing,
    version: existing.version || 'profile_v1',
    name: existing.name || path.basename(path.resolve(baseDir, '..')),
    tone: prefs.editing_style,
    hosts: prefs.speakers,
    default_target_min: Number(prefs.target_minutes),
    default_aggressiveness: prefs.aggressiveness,
    glossary: mergeUnique(safeArray(existing.glossary), prefs.glossary, prefs.speakers.map((s) => s.name)),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
}

function writeDebriefFromPreferences(baseDir, prefs) {
  const debriefPath = path.join(baseDir, '_debrief.json');
  const existing = readJsonIfExists(debriefPath) || {};
  const debrief = {
    smoothness: existing.smoothness || '未说明',
    incidents: existing.incidents || [],
    privacy: mergeUnique(safeArray(existing.privacy), prefs.privacy),
    must_keep: mergeUnique(safeArray(existing.must_keep), prefs.must_keep),
    must_delete: mergeUnique(safeArray(existing.must_delete), prefs.must_delete),
    editing_style: prefs.editing_style,
    aggressiveness: prefs.aggressiveness,
    target_minutes: Number(prefs.target_minutes),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(debriefPath, JSON.stringify(debrief, null, 2));
}

function syncManifestPreferences(baseDir, prefs) {
  const p = path.join(baseDir, 'project.json');
  if (!fs.existsSync(p)) return;
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  manifest.preferences = {
    speaker_count: prefs.speaker_count,
    speakers: prefs.speakers,
    editing_style: prefs.editing_style,
    aggressiveness: prefs.aggressiveness,
    target_minutes: prefs.target_minutes,
  };
  manifest.speakers ||= { count: null, mapping: {}, verified: false };
  manifest.speakers.count = prefs.speaker_count;
  manifest.speakers.mapping = Object.fromEntries(prefs.speakers.map((s, i) => [String(i), s.name]));
  manifest.project ||= {};
  manifest.project.updated_at = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

function episodeReview(args) {
  const opts = parseEpisodeOpts(args);
  const baseDir = opts._[0] ? path.resolve(opts._[0]) : resolveCurrentBaseDir(opts);
  const stage = opts._[1];
  if (!baseDir) throw new Error('BASE_DIR is required for episode review');
  if (!['roughcut', 'fine'].includes(stage)) throw new Error('episode review stage must be roughcut or fine');
  const exportRel = stage === 'roughcut' ? '2_分析/delete_segments_roughcut.json' : '2_分析/delete_segments_edited.json';
  const exportPath = path.join(baseDir, exportRel);
  const approvedByOk = Boolean(opts.ok);
  const approvedByExport = fs.existsSync(exportPath);
  if (!approvedByOk && !approvedByExport) {
    throw new Error(`${stage} is awaiting review: open the review page and commit/export ${exportRel}, or pass --ok for an explicit chat approval`);
  }
  const source = opts.source || (approvedByExport ? 'review_page' : 'explicit_ok');
  setStageApproved(baseDir, stage, source, exportRel, opts.by || 'user');
  writeReviewGate(baseDir, stage, { approved: true, source, export: approvedByExport ? exportRel : null, by: opts.by || 'user' });
  console.log(`OK ${stage} review approved (${source}).`);
}

function episodeExecute(args) {
  const opts = parseEpisodeOpts(args);
  const baseDir = opts._[0] ? path.resolve(opts._[0]) : resolveCurrentBaseDir(opts);
  if (!baseDir) throw new Error('BASE_DIR is required for episode execute');
  const failures = [];
  if (!fs.existsSync(path.join(baseDir, 'episode_preferences.json'))) failures.push('preferences: episode_preferences.json 不存在，必须先跑 episode start');
  for (const [stage, exportRel] of [['roughcut', '2_分析/delete_segments_roughcut.json'], ['fine', '2_分析/delete_segments_edited.json']]) {
    const gate = reviewGateStatus(baseDir, stage, exportRel);
    if (!gate.ok) failures.push(`${stage}: ${gate.detail}`);
  }
  if (failures.length) {
    throw new Error(`需要审查或明确 OK 后才能出片：\n- ${failures.join('\n- ')}`);
  }
  console.log('OK execution gate passed. You may now run podcastcut:执行 / cut_audio.py.');
}

function episodeLearn(args) {
  const opts = parseEpisodeOpts(args);
  const baseDir = opts._[0] ? path.resolve(opts._[0]) : resolveCurrentBaseDir(opts);
  const stage = opts._[1];
  if (!baseDir) throw new Error('BASE_DIR is required for episode learn');
  if (!['roughcut', 'fine'].includes(stage)) throw new Error('episode learn stage must be roughcut or fine');
  const candidates = stage === 'roughcut' ? roughcutLearningCandidates(baseDir) : fineLearningCandidates(baseDir);
  const out = {
    version: 'learning_candidates_v1',
    stage,
    generated_at: new Date().toISOString(),
    requires_user_confirmation: true,
    note: 'Only append accepted candidates to profile lessons; do not silently write long-term preferences.',
    candidates: candidates.slice(0, 3),
  };
  const outPath = path.join(baseDir, '2_分析', 'learning_candidates.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('OK learning candidates written: ' + outPath);
  console.log(JSON.stringify(out.candidates, null, 2));
}

function setStageApproved(baseDir, stage, source, exportRel, by) {
  const p = path.join(baseDir, 'project.json');
  if (!fs.existsSync(p)) return;
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  const st = safeArray(manifest.pipeline).find((x) => x.id === stage);
  if (!st) return;
  st.status = 'approved';
  st.completed_at = new Date().toISOString();
  st.review ||= {};
  st.review.approved_at = new Date().toISOString();
  st.review.by = by;
  st.review.notes = `approved via ${source}`;
  st.outputs ||= {};
  if (exportRel) st.outputs.export = exportRel;
  const next = safeArray(manifest.pipeline).find((x) => !['approved', 'done', 'skipped'].includes(x.status));
  manifest.current_stage = next ? next.id : null;
  manifest.project ||= {};
  manifest.project.updated_at = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

function writeReviewGate(baseDir, stage, data) {
  const p = path.join(baseDir, 'episode_review_gate.json');
  const gate = readJsonIfExists(p) || {};
  gate[stage] = { ...data, approved_at: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(gate, null, 2));
}

function reviewGateStatus(baseDir, stage, exportRel) {
  const exportExists = fs.existsSync(path.join(baseDir, exportRel));
  const manifest = readJsonIfExists(path.join(baseDir, 'project.json'));
  const st = safeArray(manifest?.pipeline).find((x) => x.id === stage);
  const manifestApproved = st && ['approved', 'done'].includes(st.status);
  const gate = readJsonIfExists(path.join(baseDir, 'episode_review_gate.json')) || {};
  const gateApproved = Boolean(gate[stage]?.approved);
  if (!manifestApproved && !gateApproved) return { ok: false, detail: '没有审查页提交，也没有明确 OK approval' };
  if (!exportExists) return { ok: false, detail: `${exportRel} 不存在，无法执行实际剪辑` };
  return { ok: true, detail: `approved; ${exportRel}` };
}

function checkReviewGate(baseDir, stage, exportRel) {
  const r = reviewGateStatus(baseDir, stage, exportRel);
  return { name: `${stage} review gate`, ok: r.ok, required: true, detail: r.detail };
}

function fineLearningCandidates(baseDir) {
  const ai = readJsonIfExists(path.join(baseDir, '2_分析', 'fine_analysis.json')) || {};
  const user = readJsonIfExists(path.join(baseDir, '2_分析', 'delete_segments_edited.json')) || {};
  const aiIndex = new Map();
  const bySent = new Map();
  for (const e of safeArray(ai.edits)) {
    if (e?.sentenceIdx == null || !e.type) continue;
    if (!bySent.has(e.sentenceIdx)) bySent.set(e.sentenceIdx, []);
    bySent.get(e.sentenceIdx).push(e);
  }
  for (const [sentIdx, edits] of bySent) {
    edits.sort((a, b) => (a.deleteStart ?? 0) - (b.deleteStart ?? 0));
    edits.forEach((e, i) => aiIndex.set(`${sentIdx}|${e.type}|${i + 1}`, e));
  }
  const kept = new Set(safeArray(user.fine_edits).filter((e) => e?.idx != null && e.type && e.ord != null).map((e) => `${e.idx}|${e.type}|${e.ord}`));
  const perType = {};
  for (const [key, e] of aiIndex) {
    perType[e.type] ||= { total: 0, kept: 0, restored: [] };
    perType[e.type].total++;
    if (kept.has(key)) perType[e.type].kept++;
    else if (perType[e.type].restored.length < 5) perType[e.type].restored.push({ sentenceIdx: e.sentenceIdx, text: e.deleteText || '', reason: e.reason || '' });
  }
  const candidates = Object.entries(perType)
    .map(([type, s]) => ({ type, retention: s.total ? s.kept / s.total : 1, ...s }))
    .filter((s) => s.total >= 5 && s.retention < 0.8)
    .sort((a, b) => a.retention - b.retention || b.total - a.total)
    .map((s) => ({ scope: 'fine', kind: 'detector_tuning', rule: `这档播客里 ${s.type} 的自动删减需要更保守；同类删点先降权，除非语义上明显是口癖/卡顿。`, evidence: s.restored, stats: { type: s.type, total: s.total, kept: s.kept, retention: Number(s.retention.toFixed(3)) } }));
  const userAdded = safeArray(user.sentence_deletes).length + Object.keys(user.partial_deletes || {}).length;
  if (userAdded > 0) candidates.push({ scope: 'fine', kind: 'coverage_gap', rule: `用户额外增加了 ${userAdded} 处删减；下期精剪后请优先询问这些新增删点是否应沉淀为长期规则。`, evidence: [], stats: { user_added: userAdded } });
  return candidates;
}

function roughcutLearningCandidates(baseDir) {
  const ai = readJsonIfExists(path.join(baseDir, '2_分析', 'semantic_deep_analysis.json')) || {};
  const user = readJsonIfExists(path.join(baseDir, '2_分析', 'delete_segments_roughcut.json')) || {};
  const userSet = new Set(safeArray(user.sentence_deletes).map(Number));
  const perType = {};
  const aiDeleteSet = new Set();
  for (const s of safeArray(ai.sentences)) {
    if (s?.action !== 'delete') continue;
    aiDeleteSet.add(s.sentenceIdx);
    const type = s.type || 'unknown';
    perType[type] ||= { total: 0, kept: 0, restored: [] };
    perType[type].total++;
    if (userSet.has(s.sentenceIdx)) perType[type].kept++;
    else if (perType[type].restored.length < 5) perType[type].restored.push({ sentenceIdx: s.sentenceIdx, reason: s.reason || '' });
  }
  const candidates = Object.entries(perType)
    .map(([type, s]) => ({ type, retention: s.total ? s.kept / s.total : 1, ...s }))
    .filter((s) => s.total >= 3 && s.retention < 0.8)
    .sort((a, b) => a.retention - b.retention || b.total - a.total)
    .map((s) => ({ scope: 'roughcut', kind: 'type_threshold', rule: `这档播客里 ${s.type} 粗剪判断要更谨慎；除非明确偏离本期主题或属于制作流程，否则先保留。`, evidence: s.restored, stats: { type: s.type, total: s.total, kept: s.kept, retention: Number(s.retention.toFixed(3)) } }));
  let userOnly = 0;
  for (const idx of userSet) if (!aiDeleteSet.has(idx)) userOnly++;
  if (userOnly > 0) candidates.push({ scope: 'roughcut', kind: 'coverage_gap', rule: `用户额外删除了 ${userOnly} 句粗剪内容；下期粗剪总结时主动询问这类新增删除是否应成为长期规则。`, evidence: [], stats: { user_added_sentences: userOnly } });
  return candidates;
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function readJsonIfExists(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
  catch { return null; }
}

function mergeUnique(...lists) {
  return [...new Set(lists.flat().filter((x) => x != null && String(x).trim()).map((x) => String(x).trim()))];
}

function parseOpts(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--output-dir') out.outputDir = args[++i];
    else if (a.startsWith('--output-dir=')) out.outputDir = a.slice('--output-dir='.length);
    else if (a === '--install-root') out.installRoot = args[++i];
    else if (a.startsWith('--install-root=')) out.installRoot = a.slice('--install-root='.length);
    else if (a === '--role') out.role = args[++i];
    else if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a === '--fresh-agent') out.freshAgent = true;
    else out._.push(a);
  }
  return out;
}

function defaultInstallRoot() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function resolveOutputDir(opts = {}) {
  if (opts.outputDir) return path.resolve(opts.outputDir);
  if (process.env.OUTPUT_DIR) return path.resolve(process.env.OUTPUT_DIR);

  const installed = path.join(os.homedir(), '.claude', 'skills', 'podcastcut-edit-chat', 'output');
  if (fs.existsSync(installed)) return installed;

  const defaultExternal = '/Volumes/T9/claude_skill/podcastcut/output';
  if (fs.existsSync(defaultExternal)) return defaultExternal;

  return path.join(REPO_ROOT, 'output');
}

function resolveCurrentBaseDir(opts = {}) {
  const outputDir = resolveOutputDir(opts);
  const currentPath = path.join(outputDir, '.current_project');
  if (!fs.existsSync(currentPath)) return null;
  const project = fs.readFileSync(currentPath, 'utf8').trim();
  if (!project) return null;
  return path.join(outputDir, project, '剪播客');
}

function loadManifest(baseDir) {
  const p = path.join(baseDir, 'project.json');
  if (!fs.existsSync(p)) throw new Error(`project.json not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pythonCommand() {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function normalizeFreshAgentRole(role) {
  if (['podcast', 'per-podcast', 'editing'].includes(role)) return 'podcast';
  if (['dispatcher', 'shared', 'infra'].includes(role)) return 'dispatcher';
  throw new Error(`unknown fresh-agent role: ${role}`);
}

function checkCommand(cmd, args, { name = cmd, required }) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  const ok = !res.error && res.status === 0;
  const firstLine = `${res.stdout || res.stderr || ''}`.split('\n').find(Boolean) || '';
  return { name, ok, required, detail: ok ? firstLine : (res.error?.message || `exit ${res.status}`) };
}

function checkPath(name, p, kind, required) {
  let ok = false;
  try {
    const st = fs.statSync(p);
    ok = kind === 'dir' ? st.isDirectory() : st.isFile();
  } catch {
    ok = false;
  }
  return { name, ok, required, detail: p };
}

function checkAny(name, dir, regex, required) {
  let hit = '';
  try {
    hit = fs.readdirSync(dir).find((x) => regex.test(x)) || '';
  } catch {
    hit = '';
  }
  return { name, ok: Boolean(hit), required, detail: hit ? path.join(dir, hit) : dir };
}

function checkManifest(name, manifestPath, required) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const commit = manifest.git_commit || 'unknown';
    const branch = manifest.git_branch || 'unknown';
    const dirty = manifest.git_dirty ? ' DIRTY' : '';
    const installedAt = manifest.installed_at || 'unknown-time';
    return {
      name,
      ok: true,
      required,
      detail: `${commit} on ${branch}${dirty}, installed ${installedAt}`,
    };
  } catch (err) {
    return { name, ok: false, required, detail: `${manifestPath} (${err.message})` };
  }
}

function checkProfileJson(dir, required) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    files = [];
  }
  return {
    name: 'podcast profile json',
    ok: files.length > 0,
    required,
    detail: files.length ? files.join(', ') : dir,
  };
}

function checkProfileAmbiguity(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    files = [];
  }
  return {
    name: 'single default profile',
    ok: files.length <= 1,
    required: false,
    detail: files.length <= 1 ? (files[0] || 'none') : `multiple profiles: ${files.join(', ')}; agent must ask which podcast`,
  };
}

function checkTunnelUrl(file, required) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    const ok = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.test(value) || /^https?:\/\//.test(value);
    return {
      name: 'cloud-bridge tunnel URL',
      ok,
      required,
      detail: ok ? value : `${file} is not a URL`,
    };
  } catch {
    return {
      name: 'cloud-bridge tunnel URL',
      ok: false,
      required,
      detail: `${file} missing; ask operator for current URL or install launchd`,
    };
  }
}

function checkWritableDir(name, dir, required) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { name, ok: true, required, detail: dir };
  } catch (err) {
    return { name, ok: false, required, detail: `${dir} (${err.message})` };
  }
}

function checkPythonImports(name, modules, required, python = pythonCommand()) {
  const code = modules.map((m) => `import ${m}`).join('\n');
  const res = spawnSync(python, ['-c', code], { encoding: 'utf8' });
  const err = res.error?.message || (res.stderr || res.stdout || '').trim().split('\n').at(-1);
  return {
    name,
    ok: res.status === 0,
    required,
    detail: res.status === 0 ? `${modules.join(', ')} via ${python}` : `${modules.join(', ')} via ${python} (${err})`,
  };
}

function fileContains(p, regex) {
  try {
    return regex.test(fs.readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
}

function printChecks(title, checks) {
  console.log(title);
  console.log('');
  for (const c of checks) {
    const marker = c.ok ? 'OK ' : (c.required ? 'ERR' : 'WARN');
    console.log(`[${marker}] ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  }
}

function exitForRequiredChecks(checks) {
  const failed = checks.filter((c) => c.required && !c.ok);
  if (failed.length) process.exit(1);
}

main();
