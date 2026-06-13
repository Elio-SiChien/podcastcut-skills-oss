#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const STAGES = ['transcribe', 'roughcut', 'fine', 'execute', 'qa', 'audio_quality', 'post'];

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') return usage(0);

  try {
    if (cmd === 'doctor') return doctor(args);
    if (cmd === 'fresh-agent') return freshAgent(args);
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
  npm run fresh-agent -- [--role podcast|dispatcher]
  npm run status -- [BASE_DIR]
  npm run validate -- [BASE_DIR] [STAGE]

Commands:
  doctor       Check local machine prerequisites.
  fresh-agent  Check installed snapshot/profile/tunnel readiness for a new agent.
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
    checks.push(checkPath('profile.json', path.join(baseDir, 'profile.json'), 'file', false));
    checks.push(checkPath('_debrief.json', path.join(baseDir, '_debrief.json'), 'file', false));
    return checks;
  }

  checks.push(checkPath('semantic_deep_analysis.json', path.join(baseDir, '2_分析', 'semantic_deep_analysis.json'), 'file', true));
  if (stage === 'fine') {
    checks.push(checkPath('delete_segments_roughcut.json', path.join(baseDir, '2_分析', 'delete_segments_roughcut.json'), 'file', false));
    return checks;
  }

  checks.push(checkPath('fine_analysis.json', path.join(baseDir, '2_分析', 'fine_analysis.json'), 'file', stage !== 'execute'));
  checks.push(checkPath('delete_segments_edited.json', path.join(baseDir, '2_分析', 'delete_segments_edited.json'), 'file', true));
  checks.push(checkAny('audio_original.*', path.join(baseDir, '1_转录'), /^audio_original\./, true));

  if (stage === 'execute') return checks;

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
  return process.env.PYTHON || 'python3';
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
