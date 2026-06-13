#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const PATH_BLOCKLIST = [
  /^\.env$/i,
  /^profiles\/.*\.json$/i,
  /^cloud-bridge\/(sessions|pending)\//i,
  /^cloud-bridge\/current_tunnel_url\.txt$/i,
  /^output\//i,
  /credential/i,
  /token/i,
  /secret/i,
];

const CONTENT_BLOCKLIST = [
  { name: 'agent token', regex: /sk_agent_[A-Za-z0-9_-]+/ },
  { name: 'machine token', regex: /sk_machine_[A-Za-z0-9_-]+/ },
  { name: 'OpenAI-style secret key', regex: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'DashScope secret value', regex: /DASHSCOPE_API_KEY=(sk-(?!your-api-key-here)[A-Za-z0-9_-]{12,})/ },
  { name: 'private key block', regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
];

const HISTORY_GREP = [
  'sk_agent_',
  'sk_machine_',
  'DASHSCOPE_API_KEY=',
  'trycloudflare.com',
  'current_tunnel_url',
  'credential',
  'token',
  'secret',
  'profiles/',
];

function main() {
  const tracked = gitLines(['ls-files']);
  const failures = [];
  const warnings = [];

  for (const file of tracked) {
    if (PATH_BLOCKLIST.some((pattern) => pattern.test(file))) {
      failures.push(`tracked sensitive path: ${file}`);
    }
  }

  for (const file of tracked) {
    if (!isTextFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const check of CONTENT_BLOCKLIST) {
      if (check.regex.test(text)) {
        failures.push(`${check.name} in tracked file: ${file}`);
      }
    }
  }

  for (const term of HISTORY_GREP) {
    const res = git(['log', '--all', '--regexp-ignore-case', '--fixed-strings', '--grep', term, '--pretty=format:%h %s']);
    if (res.status === 0 && res.stdout.trim()) {
      warnings.push(`history mentions "${term}":\n${indent(res.stdout.trim())}`);
    }
  }

  printSection('OSS hygiene check');
  if (failures.length) {
    printSection('FAIL');
    for (const failure of failures) console.log(`- ${failure}`);
  } else {
    printSection('No tracked-file failures');
  }

  if (warnings.length) {
    printSection('History review warnings');
    for (const warning of warnings) console.log(`- ${warning}`);
  } else {
    printSection('No history grep warnings');
  }

  console.log('');
  console.log('Decision rule: failures block the OSS push. Warnings require human review before preserving full history.');
  if (failures.length) process.exit(1);
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function gitLines(args) {
  const res = git(args);
  if (res.status !== 0) {
    throw new Error(res.stderr || `git ${args.join(' ')} failed`);
  }
  return res.stdout.split('\n').filter(Boolean);
}

function isTextFile(file) {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) return false;
    const sample = bytes.subarray(0, 8192).toString('utf8');
    return !sample.includes('\uFFFD');
  } catch {
    return false;
  }
}

function printSection(title) {
  console.log('');
  console.log(`== ${title} ==`);
}

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

main();
