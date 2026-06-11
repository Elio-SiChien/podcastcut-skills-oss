#!/usr/bin/env node
/**
 * cloud-bridge server
 *
 * 把本地 review HTML 通过 cloudflared tunnel 暴露给浏览器，让用户在
 * 公网上编辑剪辑决策、保存（draft）或提交（commit）。提交后 edit-chat
 * skill 监听到 commit 文件出现，自动继续 pipeline。
 *
 * 路由：
 *   GET  /r/:session            — 渲染 review HTML（kind="review"）
 *   GET  /u/:session            — 渲染 upload HTML（kind="upload"），用户拖音频上来
 *   GET  /m/:session            — 渲染 mastering HTML（kind="mastering"），后期 UI
 *   GET  /api/:session/state    — 返回当前 draft / committed / upload 状态
 *   POST /api/:session/save     — 写 draft（review / mastering session 通用）
 *   POST /api/:session/commit   — 写 final + 触发 commit 文件
 *   GET  /api/:session/audio    — proxy 已存在音频，支持 Range
 *   POST /api/:session/upload   — 流式接收用户上传的音频（upload session，单 POST 旧版）
 *   POST /api/:session/upload-chunk — chunked / resumable 上传（推荐，~5MB 分块，per-chunk 重试）
 *   POST /api/:session/mastering-upload?slot=intro|outro
 *                               — mastering session 内的音乐切片上传
 *                                 落到 base_dir/3_后期/theme_<slot>.<ext>
 *
 * Session 文件布局：
 *   $SESSIONS_DIR/<session>/
 *     meta.json
 *       review:  {kind?:"review", base_dir, review_html_path, audio_path,
 *                 status: "viewing"|"draft"|"committed"|"expired"}
 *       upload:  {kind:"upload", base_dir, audio_dest, max_bytes?,
 *                 status: "viewing"|"uploading"|"uploaded"|"error",
 *                 bytes_received?, error?}
 *     review.html            — symlink 到 BASE_DIR/review_{roughcut,enhanced}.html
 *     state.draft.json       — overwrite 每次 /save
 *     state.committed.json   — 一次性，commit 后 edit-chat fs.watch 拾起
 *     upload.received.json   — 一次性，upload 完成后 watch_upload.sh 拾起
 *
 * 用法：
 *   PORT=8765 SESSIONS_DIR=/path/to/sessions node server.js
 *   (推荐起在 mac mini 的 launchd 或者 pm2，跟 cloudflared tunnel 一起常驻)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const SLOCK_TRIGGER_CHANNEL = process.env.SLOCK_TRIGGER_CHANNEL || '#podcastcut';
const SLOCK_TRIGGER_AGENT = process.env.SLOCK_TRIGGER_AGENT || '@podcast-editor-agent';

// Fire-and-forget: ask the editor agent to pick up a freshly uploaded episode
// via the user's slock daemon. Failures only log — the pending/ file still
// lets a human ping the agent manually.
function triggerEditorAgent(hint, sid) {
  const title =
    `${SLOCK_TRIGGER_AGENT} 剪 "${hint.episode_name}" — base_dir=${hint.base_dir} ` +
    `session_id=${sid} speaker_count=${hint.speaker_count}`;
  const child = spawn('slock', ['task', 'create',
    '--channel', SLOCK_TRIGGER_CHANNEL,
    '--titles', title,
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let err = '';
  child.stderr.on('data', d => { err += d.toString(); });
  child.on('error', e => console.error('[trigger] spawn failed:', e.message));
  child.on('exit', code => {
    if (code === 0) console.log(`[trigger] task created in ${SLOCK_TRIGGER_CHANNEL} for sid=${sid}`);
    else console.error(`[trigger] slock task create exit=${code} stderr=${err.trim()}`);
  });
}

const PORT = parseInt(process.env.PORT || '8765', 10);
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─────────────────────────── helpers ──────────────────────────────────
function sessionDir(s) { return path.join(SESSIONS_DIR, s); }
function readMeta(s) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(s), 'meta.json'), 'utf8')); }
  catch { return null; }
}
function writeMeta(s, meta) {
  fs.writeFileSync(path.join(sessionDir(s), 'meta.json'), JSON.stringify(meta, null, 2));
}
function isValidSession(s) {
  return /^[a-z0-9]{8,32}$/.test(s) && fs.existsSync(sessionDir(s));
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendErr(res, code, msg) { send(res, code, { error: msg }); }

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ─────────────────────────── handlers ──────────────────────────────────
function handleReviewPage(s, res) {
  const meta = readMeta(s);
  if (!meta || !meta.review_html_path) return sendErr(res, 404, 'session not found');
  fs.readFile(meta.review_html_path, 'utf8', (err, html) => {
    if (err) return sendErr(res, 500, 'review html read error');
    // Inject SESSION constant + cloud-bridge JS hooks at end of <head>
    const inject = `<script>window.__CLOUD_BRIDGE__={session:"${s}"};</script>`;
    const out = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(out);
  });
}

function handleGetState(s, res) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const cFile = path.join(sessionDir(s), 'state.committed.json');
  const dFile = path.join(sessionDir(s), 'state.draft.json');
  const isCommitted = fs.existsSync(cFile);
  const file = isCommitted ? cFile : (fs.existsSync(dFile) ? dFile : null);
  if (!file) return send(res, 200, { initial: true });
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return sendErr(res, 500, 'state read error');
    let payload;
    try { payload = JSON.parse(data); } catch (e) { return sendErr(res, 500, 'state parse error'); }
    payload.committed = isCommitted; // client locks the page read-only when true
    send(res, 200, payload);
  });
}

async function handleSave(s, req, res, commit) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const meta = readMeta(s);
  if (meta.status === 'committed' && !commit) {
    return sendErr(res, 409, 'session already committed');
  }
  if (meta.status === 'expired') return sendErr(res, 410, 'session expired');
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendErr(res, 400, 'bad json'); }
  body.received_at = Date.now();
  const fname = commit ? 'state.committed.json' : 'state.draft.json';
  fs.writeFileSync(path.join(sessionDir(s), fname), JSON.stringify(body, null, 2));
  meta.status = commit ? 'committed' : 'draft';
  meta[commit ? 'last_commit' : 'last_save'] = body.received_at;
  writeMeta(s, meta);
  console.log(`[${s}] ${commit ? 'COMMIT' : 'save'} at ${new Date(body.received_at).toISOString()}`);
  // If this is a review session tied to a project (kind=review with base_dir),
  // bump the project.json stage on commit so /app's iframe watcher can advance
  // and the editor agent knows to pick up 精剪.
  if (commit && (meta.kind === 'review' || meta.kind === 'mastering') && meta.base_dir) {
    try {
      const projectPath = path.join(meta.base_dir, 'project.json');
      let project = {};
      if (fs.existsSync(projectPath)) {
        try { project = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch {}
      }
      if (meta.kind === 'mastering') {
        project.stage = 'mastering_committed';
        project.mastering_committed_at = new Date(body.received_at).toISOString();
        project.mastering_session = s;
      } else {
        const isFine = meta.review_stage === 'fine';
        project.stage = isFine ? 'finecut_committed' : 'roughcut_committed';
        project[isFine ? 'finecut_committed_at' : 'roughcut_committed_at'] = new Date(body.received_at).toISOString();
        project[isFine ? 'finecut_review_session' : 'review_session'] = s;
      }
      fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    } catch (e) { console.error('[commit] project.json bump failed:', e.message); }
  }
  send(res, 200, { ok: true, status: meta.status });
}

function handleMasteringPage(s, res) {
  const meta = readMeta(s);
  if (!meta || meta.kind !== 'mastering') return sendErr(res, 404, 'session not found');
  if (!meta.mastering_html_path) return sendErr(res, 500, 'meta.mastering_html_path missing');
  fs.readFile(meta.mastering_html_path, 'utf8', (err, html) => {
    if (err) return sendErr(res, 500, 'mastering html read error');
    const inject = `<script>window.__CLOUD_BRIDGE__={session:"${s}",kind:"mastering"};</script>`;
    const out = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(out);
  });
}

function handleMasteringUpload(s, req, res, slot) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const meta = readMeta(s);
  if (!meta || meta.kind !== 'mastering') return sendErr(res, 400, 'not a mastering session');
  if (meta.status === 'committed') return sendErr(res, 409, 'session already committed');
  if (slot !== 'intro' && slot !== 'outro') return sendErr(res, 400, 'slot must be intro or outro');
  if (!meta.base_dir) return sendErr(res, 500, 'meta.base_dir missing');

  const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
  const cap = Number(meta.upload_cap_bytes) || (200 * 1024 * 1024); // 200 MB default for music files
  if (!declaredLen) return sendErr(res, 411, 'content-length required');
  if (declaredLen > cap) return sendErr(res, 413, `payload > ${cap} bytes`);

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!(ct.startsWith('audio/') || ct === 'application/octet-stream' || ct === '')) {
    return sendErr(res, 415, `unsupported content-type: ${ct}`);
  }

  // Infer extension from content-type so the agent's downstream ffmpeg call
  // doesn't have to sniff. Falls back to .mp3 (most common).
  const ext = ct.includes('mp4') || ct.includes('m4a') ? '.m4a'
            : ct.includes('wav') ? '.wav'
            : ct.includes('ogg') ? '.ogg'
            : '.mp3';
  const destDir = path.join(meta.base_dir, '3_后期');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `theme_${slot}${ext}`);
  const partial = dest + '.partial';

  const out = fs.createWriteStream(partial);
  let received = 0;
  let failed = false;
  const finish = (ok, errMsg) => {
    if (failed) return;
    failed = !ok;
    out.end(() => {
      const currentMeta = readMeta(s) || meta;
      if (ok) {
        try { fs.renameSync(partial, dest); }
        catch (e) { ok = false; errMsg = 'rename failed: ' + e.message; }
      }
      if (!ok) { try { fs.unlinkSync(partial); } catch {} }
      currentMeta.slots = currentMeta.slots || {};
      currentMeta.slots[slot] = ok
        ? { path: dest, bytes: received, uploaded_at: Date.now() }
        : { error: errMsg, failed_at: Date.now() };
      writeMeta(s, currentMeta);
      console.log(`[${s}] mastering-upload[${slot}] ${ok ? 'DONE' : 'FAIL'} (${received} bytes)`);
      if (!res.headersSent) {
        send(res, ok ? 200 : 500, ok ? { ok: true, bytes: received, path: dest } : { ok: false, error: errMsg });
      }
    });
  };

  req.on('data', chunk => {
    received += chunk.length;
    if (received > cap) { finish(false, `exceeded cap ${cap}`); req.destroy(); }
  });
  req.on('aborted', () => finish(false, 'client aborted'));
  req.on('error', e => finish(false, 'req error: ' + e.message));
  out.on('error', e => finish(false, 'disk error: ' + e.message));
  req.pipe(out);
  req.on('end', () => {
    if (received !== declaredLen) return finish(false, `truncated: declared ${declaredLen}, got ${received}`);
    finish(true);
  });
}

function handleUploadPage(s, res) {
  const meta = readMeta(s);
  if (!meta || meta.kind !== 'upload') return sendErr(res, 404, 'session not found');
  const tmplPath = path.join(__dirname, 'upload.html');
  fs.readFile(tmplPath, 'utf8', (err, html) => {
    if (err) return sendErr(res, 500, 'upload template read error');
    // Inject session token + a hint at expected size cap for the UI to display
    const cfg = JSON.stringify({ session: s, max_bytes: meta.max_bytes || null });
    const inject = `<script>window.__UPLOAD__=${cfg};</script>`;
    const out = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(out);
  });
}

function handleUploadPost(s, req, res) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const meta = readMeta(s);
  if (!meta || meta.kind !== 'upload') return sendErr(res, 400, 'not an upload session');
  if (meta.status === 'uploaded') return sendErr(res, 409, 'already uploaded');
  if (meta.status === 'expired') return sendErr(res, 410, 'session expired');
  if (!meta.audio_dest) return sendErr(res, 500, 'meta.audio_dest missing');

  // Content-Length gate — refuse oversize before we open the file. Default 2 GB.
  const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
  const cap = Number(meta.max_bytes) || (2 * 1024 * 1024 * 1024);
  if (!declaredLen) return sendErr(res, 411, 'content-length required');
  if (declaredLen > cap) return sendErr(res, 413, `payload > ${cap} bytes`);

  // Content-Type whitelist — accept any audio/* plus generic octet-stream.
  // Browsers sometimes guess wrong on .m4a/.mp3 from extensionless files;
  // keep this lenient since the agent will sniff the file before processing.
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!(ct.startsWith('audio/') || ct === 'application/octet-stream' || ct === '')) {
    return sendErr(res, 415, `unsupported content-type: ${ct}`);
  }

  fs.mkdirSync(path.dirname(meta.audio_dest), { recursive: true });
  // Stream to a .partial sibling first, then rename on success so a partial
  // upload never gets picked up by watch_upload.sh as a finished file.
  const partial = meta.audio_dest + '.partial';
  const out = fs.createWriteStream(partial);
  let received = 0;
  let failed = false;

  const finish = (ok, errMsg) => {
    if (failed) return;
    failed = !ok;
    out.end(() => {
      const finalMeta = readMeta(s) || meta;
      if (ok) {
        try { fs.renameSync(partial, meta.audio_dest); }
        catch (e) { ok = false; errMsg = `rename failed: ${e.message}`; }
      }
      if (!ok) {
        try { fs.unlinkSync(partial); } catch {}
      }
      finalMeta.status = ok ? 'uploaded' : 'error';
      finalMeta.bytes_received = received;
      if (!ok) finalMeta.error = errMsg || 'unknown';
      finalMeta[ok ? 'last_upload' : 'last_error_at'] = Date.now();
      writeMeta(s, finalMeta);
      if (ok) {
        fs.writeFileSync(path.join(sessionDir(s), 'upload.received.json'),
          JSON.stringify({ bytes: received, received_at: Date.now() }, null, 2));
      }
      console.log(`[${s}] upload ${ok ? 'DONE' : 'FAIL'} (${received} bytes${ok ? '' : ': ' + errMsg})`);
      if (!res.headersSent) {
        send(res, ok ? 200 : 500, ok ? { ok: true, bytes: received } : { ok: false, error: errMsg });
      }
    });
  };

  // Mark status mid-upload so /state can report progress.
  meta.status = 'uploading';
  meta.bytes_received = 0;
  writeMeta(s, meta);

  req.on('data', chunk => {
    received += chunk.length;
    if (received > cap) {
      finish(false, `exceeded cap ${cap}`);
      req.destroy();
    }
  });
  req.on('aborted', () => finish(false, 'client aborted'));
  req.on('error', e => finish(false, `req error: ${e.message}`));
  out.on('error', e => finish(false, `disk error: ${e.message}`));
  req.pipe(out);
  req.on('end', () => {
    // Verify we got the bytes the client said it would send. Truncated
    // uploads (mobile flapped, browser tab closed) would otherwise look
    // successful and trigger the pipeline on a half-file.
    if (received !== declaredLen) {
      return finish(false, `truncated: declared ${declaredLen}, got ${received}`);
    }
    finish(true);
  });
}

// ──────────── /api/:session/upload-chunk — resumable chunked upload ────
//
// Why this exists (2026-06-11): trycloudflare quick tunnels cancel large
// long-lived requests mid-transfer (ivy's 330MB EP1 upload died at 72%).
// One monolithic POST has no recovery. Chunked POST lets the client retry
// only the failed chunk and keep the survivor chunks already written to
// the .partial file.
//
// Protocol (sequential, server-state, no reordering):
//   POST /api/:session/upload-chunk
//   Headers:
//     content-type:        audio/* | application/octet-stream
//     content-length:      <chunk byte count>
//     x-upload-part:       <0-based chunk index>
//     x-upload-total-parts:<total number of chunks>
//     x-upload-total-bytes:<full file byte count, identical across chunks>
//   Body: raw chunk bytes
//
// Server state: <session_dir>/upload.progress.json
//   { total_bytes, total_parts, next_part, last_chunk_at, partial_path }
//   - "next_part" is the only chunk the server will accept (sequential).
//     A retry of the same chunk gets 409 with X-Next-Part header so the
//     client can re-align.
//   - Out-of-order chunks → 409 + X-Next-Part. Client either retries the
//     correct chunk or starts over.
//   - On the last chunk (next_part === total_parts after append), rename
//     .partial → final, set meta.status="uploaded", write upload.received.json.
//
// Status query: GET /api/:session/state already returns bytes_received and
// the new fields (next_part, total_parts) appended below.
function handleUploadChunkPost(s, req, res) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const meta = readMeta(s);
  if (!meta || meta.kind !== 'upload') return sendErr(res, 400, 'not an upload session');
  if (meta.status === 'uploaded') return sendErr(res, 409, 'already uploaded');
  if (meta.status === 'expired') return sendErr(res, 410, 'session expired');
  if (!meta.audio_dest) return sendErr(res, 500, 'meta.audio_dest missing');

  const part = parseInt(req.headers['x-upload-part'] || '', 10);
  const totalParts = parseInt(req.headers['x-upload-total-parts'] || '', 10);
  const totalBytes = parseInt(req.headers['x-upload-total-bytes'] || '', 10);
  const chunkLen = parseInt(req.headers['content-length'] || '0', 10);

  if (!Number.isInteger(part) || part < 0)
    return sendErr(res, 400, 'invalid x-upload-part');
  if (!Number.isInteger(totalParts) || totalParts <= 0)
    return sendErr(res, 400, 'invalid x-upload-total-parts');
  if (!Number.isInteger(totalBytes) || totalBytes <= 0)
    return sendErr(res, 400, 'invalid x-upload-total-bytes');
  if (!chunkLen) return sendErr(res, 411, 'content-length required');

  const cap = Number(meta.max_bytes) || (2 * 1024 * 1024 * 1024);
  if (totalBytes > cap) return sendErr(res, 413, `payload > ${cap} bytes`);

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!(ct.startsWith('audio/') || ct === 'application/octet-stream' || ct === '')) {
    return sendErr(res, 415, `unsupported content-type: ${ct}`);
  }

  fs.mkdirSync(path.dirname(meta.audio_dest), { recursive: true });
  const partial = meta.audio_dest + '.partial';
  const progressPath = path.join(sessionDir(s), 'upload.progress.json');

  let progress;
  try {
    progress = fs.existsSync(progressPath)
      ? JSON.parse(fs.readFileSync(progressPath, 'utf8'))
      : null;
  } catch (e) { progress = null; }
  if (!progress) {
    progress = { total_bytes: totalBytes, total_parts: totalParts, next_part: 0,
                 partial_path: partial, started_at: Date.now() };
  } else if (progress.total_bytes !== totalBytes || progress.total_parts !== totalParts) {
    // Client renegotiated chunking on us — most likely a fresh upload after a
    // previous failed/abandoned one. Reset to the new spec.
    progress = { total_bytes: totalBytes, total_parts: totalParts, next_part: 0,
                 partial_path: partial, started_at: Date.now() };
    try { fs.unlinkSync(partial); } catch {}
  }

  // Sequential check. If wrong chunk, tell the client the next expected one
  // via a header so retries don't need a separate round-trip to /state.
  if (part !== progress.next_part) {
    res.setHeader('x-next-part', String(progress.next_part));
    return sendErr(res, 409,
      `chunk out of order: got part=${part}, expected ${progress.next_part}`);
  }

  // Append. Use a write stream in append mode for backpressure handling.
  const out = fs.createWriteStream(partial, { flags: 'a' });
  let received = 0;
  let failed = false;

  const finish = (ok, errMsg) => {
    if (failed) return;
    failed = !ok;
    out.end(() => {
      // Whether ok or not, persist whatever progress we have so a retry can
      // pick up. Truncation is detected by the next-part chunk's expected size.
      if (ok) {
        progress.next_part = part + 1;
        progress.last_chunk_at = Date.now();
        progress.bytes_received = (progress.bytes_received || 0) + received;
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));

        const isLast = progress.next_part >= progress.total_parts;
        if (isLast) {
          // Verify final size before rename. A chunk that lied about its
          // content-length could leave the .partial smaller than total_bytes.
          let actualSize = 0;
          try { actualSize = fs.statSync(partial).size; } catch {}
          if (actualSize !== totalBytes) {
            // Don't rename — let the client retry by starting over.
            return send(res, 500, { ok: false,
              error: `final size mismatch: expected ${totalBytes}, got ${actualSize}` });
          }
          try {
            fs.renameSync(partial, meta.audio_dest);
            const finalMeta = readMeta(s) || meta;
            finalMeta.status = 'uploaded';
            finalMeta.bytes_received = totalBytes;
            finalMeta.last_upload = Date.now();
            writeMeta(s, finalMeta);
            fs.writeFileSync(path.join(sessionDir(s), 'upload.received.json'),
              JSON.stringify({ bytes: totalBytes, received_at: Date.now() }, null, 2));
            // upload.progress.json kept until cleanup so debugging the last
            // upload doesn't require digging out an archived rename.
            console.log(`[${s}] chunked upload DONE (${totalBytes} bytes, ${totalParts} parts)`);
            return send(res, 200, { ok: true, bytes: totalBytes, done: true });
          } catch (e) {
            return send(res, 500, { ok: false, error: `rename failed: ${e.message}` });
          }
        }

        // Mid-upload progress reporting via meta status (so /state shows it).
        const finalMeta = readMeta(s) || meta;
        finalMeta.status = 'uploading';
        finalMeta.bytes_received = progress.bytes_received;
        writeMeta(s, finalMeta);
        return send(res, 200, { ok: true,
          next_part: progress.next_part,
          bytes_received: progress.bytes_received,
          total_bytes: totalBytes });
      }

      // ok === false → don't advance next_part; client will retry SAME part.
      console.log(`[${s}] chunked upload FAIL part=${part}: ${errMsg}`);
      return send(res, 500, { ok: false, error: errMsg });
    });
  };

  req.on('data', chunk => { received += chunk.length; });
  req.on('aborted', () => finish(false, 'client aborted'));
  req.on('error', e => finish(false, `req error: ${e.message}`));
  out.on('error', e => finish(false, `disk error: ${e.message}`));
  req.pipe(out);
  req.on('end', () => {
    if (received !== chunkLen) {
      return finish(false, `chunk truncated: declared ${chunkLen}, got ${received}`);
    }
    finish(true);
  });
}

// ──────────────────── /app — public web UI ────────────────────
// Serves the podcastcut-web prototype at /app. Same tunnel that already
// hosts the per-session review pages now hosts the marketing/onboarding
// experience too — no separate frontend deploy, no separate URL.
const WEB_PROTOTYPE_PATH = path.resolve(__dirname, '..', '..',
  'podcastcut-web', 'design', 'prototype_主流程_当前最新.html');
const PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');

function handleAppPage(res) {
  fs.readFile(WEB_PROTOTYPE_PATH, 'utf8', (err, html) => {
    if (err) return sendErr(res, 500, 'prototype html read error: ' + err.message);
    // Cache-bust glue.js via mtime so iterating the frontend doesn't
    // require the user to hard-reload after every deploy. The HTML
    // itself is served no-store so the latest ?v= always lands.
    let ver = Date.now();
    try { ver = Math.floor(fs.statSync(path.join(__dirname, 'web-glue.js')).mtimeMs); } catch {}
    const inject = `\n<script src="/app/glue.js?v=${ver}" defer></script>\n`;
    const out = html.replace('</body>', inject + '</body>');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(out);
  });
}

function handleAppGlue(res) {
  const gluePath = path.join(__dirname, 'web-glue.js');
  fs.readFile(gluePath, 'utf8', (err, js) => {
    if (err) return sendErr(res, 500, 'glue read error: ' + err.message);
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      // glue.js is fingerprinted via ?v= so it's safe to cache long-lived.
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(js);
  });
}

async function handleProfileSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendErr(res, 400, 'bad json'); }
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return sendErr(res, 400, 'name required');
  }
  // Slash / nul in the name would let the request escape PROFILES_DIR.
  // Strip anything not alphanumeric / Chinese / hyphen / underscore.
  const safeName = body.name.trim();
  if (/[\/\\\0]/.test(safeName)) return sendErr(res, 400, 'invalid name');
  const now = new Date().toISOString();
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, safeName + '.json'), 'utf8')); }
    catch { return null; }
  })();
  const profile = {
    version: 'profile_v1',
    name: safeName,
    xiaoyuzhou_url: body.xiaoyuzhou_url || null,
    xiaoyuzhou_desc: body.xiaoyuzhou_desc || null,
    xiaoyuzhou_past_episodes: body.xiaoyuzhou_past_episodes || null,
    tone: body.tone || '',
    hosts: Array.isArray(body.hosts) ? body.hosts.filter(h => h && h.name).map(h => ({
      name: String(h.name).trim(),
      role: h.role === '嘉宾' ? '嘉宾' : '主持',
    })) : [],
    default_target_min: Number.isFinite(+body.default_target_min) ? +body.default_target_min : 50,
    default_aggressiveness: ['conservative', 'moderate', 'aggressive'].includes(body.default_aggressiveness)
      ? body.default_aggressiveness : 'moderate',
    glossary: Array.isArray(body.glossary) ? body.glossary.map(g => String(g).trim()).filter(Boolean) : [],
    created_at: existing && existing.created_at ? existing.created_at : now,
    updated_at: now,
  };
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const dest = path.join(PROFILES_DIR, safeName + '.json');
  fs.writeFileSync(dest, JSON.stringify(profile, null, 2));
  console.log(`[profile] saved ${safeName} → ${dest}`);
  send(res, 200, { ok: true, name: safeName, path: dest, created: !existing });
}

function handleProfileList(res) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => f.slice(0, -5));
  } catch (e) {
    return sendErr(res, 500, 'list error: ' + e.message);
  }
  send(res, 200, { profiles: names });
}

function handleProfileGet(name, res) {
  if (!name || /[\/\\\0]/.test(name)) return sendErr(res, 400, 'bad name');
  const p = path.join(PROFILES_DIR, name + '.json');
  fs.readFile(p, 'utf8', (err, data) => {
    if (err) return sendErr(res, 404, 'profile not found');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(data);
  });
}

// Per-episode session state — vibe pick, upload meta, debrief answers.
// Each session gets a uuid; the prototype's localStorage carries it as
// `current_session_id`. Persistent on disk so reload-resume works.
const WEB_STATE_DIR = path.join(SESSIONS_DIR, '_web_sessions');
async function handleWebSessionSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendErr(res, 400, 'bad json'); }
  if (!body || typeof body.session_id !== 'string' || !/^[a-z0-9-]{8,40}$/i.test(body.session_id)) {
    return sendErr(res, 400, 'session_id required (8-40 alphanumeric/hyphen)');
  }
  fs.mkdirSync(WEB_STATE_DIR, { recursive: true });
  const dest = path.join(WEB_STATE_DIR, body.session_id + '.json');
  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { return {}; }
  })();
  const merged = { ...prev, ...body, last_save: Date.now() };
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
  send(res, 200, { ok: true, session_id: body.session_id });
}

function handleWebSessionGet(sid, res) {
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'bad session_id');
  const p = path.join(WEB_STATE_DIR, sid + '.json');
  fs.readFile(p, 'utf8', (err, data) => {
    if (err) return send(res, 200, { initial: true, session_id: sid });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(data);
  });
}

// ── Phase 2: audio upload + edit pipeline trigger ──

const OUTPUT_ROOT = path.resolve(__dirname, '..', 'output');
const PENDING_DIR = path.join(__dirname, 'pending');

// Turn an arbitrary episode title into a filesystem-friendly slug. Keeps
// CJK characters (they're fine in dir names on macOS) but strips path
// separators and most punctuation.
function slugify(s) {
  return String(s || 'untitled')
    .replace(/[\/\\?<>|"*:]/g, '')   // hard-illegal on common filesystems
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'untitled';
}

function isoDateLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// Compose the base_dir for an episode based on the web session. Reuses
// the existing episode layout (`output/<YYYY-MM-DD>_<slug>/剪播客/...`)
// so the chat-mode edit-chat skill recognises it without changes.
function buildBaseDir(sessionData) {
  const title = (sessionData.upload_meta && sessionData.upload_meta.title) || 'untitled';
  const slug = slugify(title);
  const date = isoDateLocal();
  return path.join(OUTPUT_ROOT, `${date}_${slug}`, '剪播客');
}

// Read the profile saved earlier. The web flow doesn't carry an explicit
// `profile_name` field (yet); fall back to the only profile or to "辟客"
// as a sensible default for the demo. Future: have the prototype track
// the active profile and POST it as part of the session.
function pickProfile(sessionData) {
  const hinted = sessionData.profile_name
    || (sessionData.upload_meta && sessionData.upload_meta.profile_name);
  if (hinted) {
    const p = path.join(PROFILES_DIR, hinted + '.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const profiles = fs.existsSync(PROFILES_DIR)
    ? fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    : [];
  if (profiles.length === 1) {
    return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, profiles[0]), 'utf8'));
  }
  // Multi-profile, no hint — fall back to most-recently-edited.
  const sorted = profiles
    .map(f => ({ name: f, mtime: fs.statSync(path.join(PROFILES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (sorted.length) {
    return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, sorted[0].name), 'utf8'));
  }
  return null;
}

function debriefFromSession(session) {
  const d = session.debrief || {};
  return {
    smoothness: d.smoothness || '',
    incidents: '',
    privacy: d.privacy || '',
    must_keep: d.must_keep || '',
    safe_delete: d.safe_delete || '',
    excluded_segments: d.excluded || [],
    target_min: d.target_min || null,
    aggressiveness: d.aggressiveness || null,
    captured_at: Date.now(),
  };
}

function speakerCountFromSession(session, profile) {
  const hosts = (profile && Array.isArray(profile.hosts)) ? profile.hosts.length : 2;
  const cast = (session.upload_meta && Array.isArray(session.upload_meta.cast))
    ? session.upload_meta.cast.length : 0;
  return Math.max(2, hosts + cast);
}

// Stream an audio file from the browser into BASE_DIR/1_转录/audio_original.<ext>.
// Synchronously prepares the rest of the BASE_DIR scaffolding (profile,
// debrief, vibe, hint files) so the agent can wake up to a ready
// workspace.
function handleEditUpload(req, res, query) {
  const sid = query.session_id;
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'session_id required');

  const sessionPath = path.join(WEB_STATE_DIR, sid + '.json');
  if (!fs.existsSync(sessionPath)) {
    return sendErr(res, 404, 'web session not found — POST /api/session/save first');
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

  const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
  const cap = 2 * 1024 * 1024 * 1024; // 2 GB
  if (!declaredLen) return sendErr(res, 411, 'content-length required');
  if (declaredLen > cap) return sendErr(res, 413, `payload > ${cap} bytes`);

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!(ct.startsWith('audio/') || ct === 'application/octet-stream' || ct === '')) {
    return sendErr(res, 415, `unsupported content-type: ${ct}`);
  }
  const ext = ct.includes('mp4') || ct.includes('m4a') ? '.m4a'
            : ct.includes('wav') ? '.wav'
            : ct.includes('ogg') ? '.ogg'
            : '.mp3';

  const baseDir = buildBaseDir(session);
  const transcribeDir = path.join(baseDir, '1_转录');
  fs.mkdirSync(transcribeDir, { recursive: true });
  const audioDest = path.join(transcribeDir, 'audio_original' + ext);
  const partial = audioDest + '.partial';

  const out = fs.createWriteStream(partial);
  let received = 0;
  let failed = false;

  const finish = (ok, errMsg) => {
    if (failed) return;
    failed = !ok;
    out.end(() => {
      if (ok) {
        try { fs.renameSync(partial, audioDest); }
        catch (e) { ok = false; errMsg = 'rename failed: ' + e.message; }
      }
      if (!ok) {
        try { fs.unlinkSync(partial); } catch {}
        return sendErr(res, 500, errMsg || 'upload failed');
      }

      // Audio is on disk. Now stamp the rest of the project scaffolding.
      const profile = pickProfile(session);
      if (profile) {
        try { fs.writeFileSync(path.join(baseDir, 'profile.json'), JSON.stringify(profile, null, 2)); }
        catch (e) { console.error('[edit-upload] profile write failed:', e.message); }
      }
      try {
        fs.writeFileSync(path.join(baseDir, '_debrief.json'),
          JSON.stringify(debriefFromSession(session), null, 2));
      } catch (e) { console.error('[edit-upload] debrief write failed:', e.message); }

      // Hint file the agent reads to know SPEAKER_COUNT + episode metadata.
      const hint = {
        source: 'web-app',
        session_id: sid,
        episode_name: (session.upload_meta && session.upload_meta.title) || 'untitled',
        speaker_count: speakerCountFromSession(session, profile),
        cast: (session.upload_meta && session.upload_meta.cast) || [],
        profile_name: profile ? profile.name : null,
        vibe: session.vibe || null,
        audio_path: audioDest,
        base_dir: baseDir,
        created_at: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(path.join(baseDir, 'web_session_hint.json'),
          JSON.stringify(hint, null, 2));
      } catch (e) { console.error('[edit-upload] hint write failed:', e.message); }

      // Drop a pending request the agent can pick up. cloud-bridge under
      // launchd doesn't have a writable slock CLI session, so the agent
      // either polls this dir or the operator pings them manually with
      // the trigger text we return below.
      fs.mkdirSync(PENDING_DIR, { recursive: true });
      try {
        fs.writeFileSync(path.join(PENDING_DIR, sid + '.json'),
          JSON.stringify({ hint, status: 'pending' }, null, 2));
      } catch (e) { console.error('[edit-upload] pending write failed:', e.message); }

      // Direct agent trigger via the user's slock daemon (fire-and-forget).
      // Falls back to trigger_text in the response if slock is unavailable.
      triggerEditorAgent(hint, sid);

      const triggerText =
        `${SLOCK_TRIGGER_AGENT} 新的剪辑请求 — base_dir=${baseDir} session_id=${sid} ` +
        `episode="${hint.episode_name}" speaker_count=${hint.speaker_count}`;

      console.log(`[edit-upload] sid=${sid} bytes=${received} base_dir=${baseDir}`);
      send(res, 200, {
        ok: true,
        session_id: sid,
        base_dir: baseDir,
        speaker_count: hint.speaker_count,
        episode_name: hint.episode_name,
        trigger_text: triggerText,
      });
    });
  };

  req.on('data', chunk => {
    received += chunk.length;
    if (received > cap) { finish(false, `exceeded cap ${cap}`); req.destroy(); }
  });
  req.on('aborted', () => finish(false, 'client aborted'));
  req.on('error', e => finish(false, 'req error: ' + e.message));
  out.on('error', e => finish(false, 'disk error: ' + e.message));
  req.pipe(out);
  req.on('end', () => {
    if (received !== declaredLen) {
      return finish(false, `truncated: declared ${declaredLen}, got ${received}`);
    }
    finish(true);
  });
}

// Status polling — the agent updates BASE_DIR/project.json as it goes;
// the front-end polls this every few seconds to keep the "正在转录…"
// progress card live.
function handleEditStatus(query, res) {
  const sid = query.session_id;
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'session_id required');

  // We look up base_dir via the pending file we wrote on upload.
  const pendingPath = path.join(PENDING_DIR, sid + '.json');
  if (!fs.existsSync(pendingPath)) {
    return send(res, 200, { stage: 'waiting_for_upload', session_id: sid });
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const baseDir = pending.hint && pending.hint.base_dir;
  if (!baseDir) return send(res, 200, { stage: 'unknown', session_id: sid });

  const projectPath = path.join(baseDir, 'project.json');
  let project = null;
  if (fs.existsSync(projectPath)) {
    try { project = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch {}
  }
  const transcriptPath = path.join(baseDir, '1_转录', 'aliyun_funasr_transcription.json');
  const speakerSamplesDir = path.join(baseDir, '1_转录');
  const speakerSamples = fs.existsSync(speakerSamplesDir)
    ? fs.readdirSync(speakerSamplesDir).filter(f => /^spk\d+_sample\.mp3$/.test(f))
    : [];

  const stage = project && project.stage ? project.stage
    : (fs.existsSync(transcriptPath) ? 'transcribed' : 'pending_agent_pickup');

  // If transcription is done, surface speaker count + samples + best-guess
  // name mapping for the UI to render the speakers screen.
  let speakers = null;
  let mapping = null;
  const mappingPath = path.join(baseDir, '1_转录', 'speaker_mapping.json');
  if (fs.existsSync(mappingPath)) {
    try { mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')); } catch {}
  }
  if (fs.existsSync(transcriptPath)) {
    try {
      const t = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      const counts = {};
      (t.transcripts || []).forEach(tr => (tr.sentences || []).forEach(s => {
        counts[s.speaker_id] = (counts[s.speaker_id] || 0) + 1;
      }));
      const sids = Object.keys(counts).sort();
      const total = sids.reduce((a, k) => a + counts[k], 0) || 1;
      speakers = sids.map(id => ({
        id,
        sentence_count: counts[id],
        share: +(counts[id] / total * 100).toFixed(1),
        suggested_name: (mapping && mapping[id]) || null,
        sample_url: `/api/edit/speaker-sample?sid=${sid}&speaker_id=${id}`,
      }));
    } catch {}
  }

  send(res, 200, {
    session_id: sid,
    base_dir: baseDir,
    stage,
    speakers,
    speaker_mapping: mapping,
    project,
    speaker_samples: speakerSamples,
    speaker_count_expected: pending.hint && pending.hint.speaker_count,
    episode_name: pending.hint && pending.hint.episode_name,
    profile_hosts: (function(){ try { return JSON.parse(fs.readFileSync(path.join(baseDir, 'profile.json'),'utf8')).hosts || null; } catch { return null; } })(),
    cast: (pending.hint && pending.hint.cast) || null,
  });
}

// User clicked "进入后期" on the done card. Flip project.stage to
// `mastering_review` so the iframe watcher's expectedStage check resolves
// (without this, watchReviewCommit thinks the user already committed
// because backend stage is still `cutting_done` and bounces back).
async function handleEnterMastering(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendErr(res, 400, 'bad json'); }
  const sid = body.session_id;
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'bad session_id');
  const pendingPath = path.join(PENDING_DIR, sid + '.json');
  if (!fs.existsSync(pendingPath)) return sendErr(res, 404, 'no pending request');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const baseDir = pending.hint && pending.hint.base_dir;
  if (!baseDir) return sendErr(res, 404, 'no base_dir');
  const projectPath = path.join(baseDir, 'project.json');
  let project = {};
  if (fs.existsSync(projectPath)) {
    try { project = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch {}
  }
  if (!project.mastering_review_url) {
    return sendErr(res, 409, 'mastering_review_url not set — agent has not prepared mastering session yet');
  }
  project.stage = 'mastering_review';
  project.mastering_entered_at = new Date().toISOString();
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
  send(res, 200, { ok: true, stage: project.stage, mastering_review_url: project.mastering_review_url });
}

// User confirmed (possibly corrected) the speaker mapping on screen 4.
// Persist it back to BASE_DIR/1_转录/speaker_mapping.json and flip the stage
// so the agent's polling watcher knows to resume into 粗剪.
async function handleSpeakersConfirm(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendErr(res, 400, 'bad json'); }
  const sid = body.session_id;
  const mapping = body.speaker_mapping;
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'bad session_id');
  if (!mapping || typeof mapping !== 'object') return sendErr(res, 400, 'bad mapping');
  const pendingPath = path.join(PENDING_DIR, sid + '.json');
  if (!fs.existsSync(pendingPath)) return sendErr(res, 404, 'no pending request');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const baseDir = pending.hint && pending.hint.base_dir;
  if (!baseDir) return sendErr(res, 404, 'no base_dir');
  const mappingPath = path.join(baseDir, '1_转录', 'speaker_mapping.json');
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  // Flip stage so the agent picks this up.
  let project = {};
  const projectPath = path.join(baseDir, 'project.json');
  if (fs.existsSync(projectPath)) {
    try { project = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch {}
  }
  project.stage = 'speakers_confirmed';
  project.speaker_mapping = mapping;
  project.speakers_confirmed_at = new Date().toISOString();
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
  console.log(`[speakers-confirm] sid=${sid} mapping=${JSON.stringify(mapping)}`);
  send(res, 200, { ok: true, mapping });
}

// Serve a speaker sample MP3 so the prototype's <audio> tag can play it.
function handleEditSpeakerSample(query, res) {
  const sid = query.sid;
  const spk = query.speaker_id;
  if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return sendErr(res, 400, 'bad sid');
  if (!/^\d+$/.test(String(spk))) return sendErr(res, 400, 'bad speaker_id');
  const pendingPath = path.join(PENDING_DIR, sid + '.json');
  if (!fs.existsSync(pendingPath)) return sendErr(res, 404, 'no pending request');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const baseDir = pending.hint && pending.hint.base_dir;
  if (!baseDir) return sendErr(res, 404, 'no base_dir');
  const samplePath = path.join(baseDir, '1_转录', `spk${spk}_sample.mp3`);
  if (!fs.existsSync(samplePath)) return sendErr(res, 404, 'sample not generated yet');
  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': fs.statSync(samplePath).size,
  });
  fs.createReadStream(samplePath).pipe(res);
}

function handleAudio(s, req, res) {
  if (!isValidSession(s)) return sendErr(res, 404, 'bad session');
  const meta = readMeta(s);
  if (!meta.audio_path || !fs.existsSync(meta.audio_path)) return sendErr(res, 404, 'audio not found');
  fs.stat(meta.audio_path, (err, stat) => {
    if (err) return sendErr(res, 500, 'stat error');
    const range = req.headers.range;
    if (!range) {
      // full file
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': stat.size,
        'accept-ranges': 'bytes',
      });
      fs.createReadStream(meta.audio_path).pipe(res);
      return;
    }
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) return sendErr(res, 416, 'bad range');
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) return sendErr(res, 416, 'range out of bounds');
    res.writeHead(206, {
      'content-type': 'audio/mpeg',
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
    });
    fs.createReadStream(meta.audio_path, { start, end }).pipe(res);
  });
}

// ─────────────────────────── router ──────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // Web UI routes (token-less — public app surface)
  if (parsed.pathname === '/app' || parsed.pathname === '/app/') {
    return handleAppPage(res);
  }
  if (parsed.pathname === '/app/glue.js') {
    return handleAppGlue(res);
  }
  if (parsed.pathname === '/api/profiles' && req.method === 'GET') {
    return handleProfileList(res);
  }
  if (parsed.pathname === '/api/profile/save' && req.method === 'POST') {
    return handleProfileSave(req, res);
  }
  const profGetMatch = parsed.pathname.match(/^\/api\/profile\/(.+)$/);
  if (profGetMatch && req.method === 'GET') {
    return handleProfileGet(decodeURIComponent(profGetMatch[1]), res);
  }
  if (parsed.pathname === '/api/session/save' && req.method === 'POST') {
    return handleWebSessionSave(req, res);
  }
  const sessGetMatch = parsed.pathname.match(/^\/api\/session\/([a-z0-9-]{8,40})$/i);
  if (sessGetMatch && req.method === 'GET') {
    return handleWebSessionGet(sessGetMatch[1], res);
  }
  if (parsed.pathname === '/api/edit/upload' && req.method === 'POST') {
    return handleEditUpload(req, res, parsed.query || {});
  }
  if (parsed.pathname === '/api/edit/status' && req.method === 'GET') {
    return handleEditStatus(parsed.query || {}, res);
  }
  if (parsed.pathname === '/api/edit/speaker-sample' && req.method === 'GET') {
    return handleEditSpeakerSample(parsed.query || {}, res);
  }
  if (parsed.pathname === '/api/edit/speakers-confirm' && req.method === 'POST') {
    return handleSpeakersConfirm(req, res);
  }
  if (parsed.pathname === '/api/edit/enter-mastering' && req.method === 'POST') {
    return handleEnterMastering(req, res);
  }

  const m = parsed.pathname.match(
    /^\/(?:r\/([a-z0-9]+)|u\/([a-z0-9]+)|m\/([a-z0-9]+)|api\/([a-z0-9]+)\/(state|save|commit|audio|upload|upload-chunk|mastering-save|mastering-commit|mastering-upload))$/
  );
  if (!m) {
    if (parsed.pathname === '/health') return send(res, 200, { ok: true, sessions_dir: SESSIONS_DIR });
    return sendErr(res, 404, 'not found');
  }
  const reviewSess = m[1];
  const uploadSess = m[2];
  const masteringSess = m[3];
  const apiSess = m[4];
  const action = m[5] || (reviewSess ? 'review_page' : (uploadSess ? 'upload_page' : 'mastering_page'));
  if (action === 'review_page') return handleReviewPage(reviewSess, res);
  if (action === 'upload_page') return handleUploadPage(uploadSess, res);
  if (action === 'mastering_page') return handleMasteringPage(masteringSess, res);
  if (action === 'state' && req.method === 'GET') return handleGetState(apiSess, res);
  if (action === 'save' && req.method === 'POST') return handleSave(apiSess, req, res, false);
  if (action === 'commit' && req.method === 'POST') return handleSave(apiSess, req, res, true);
  if (action === 'audio' && (req.method === 'GET' || req.method === 'HEAD')) return handleAudio(apiSess, req, res);
  if (action === 'upload' && req.method === 'POST') return handleUploadPost(apiSess, req, res);
  if (action === 'upload-chunk' && req.method === 'POST') return handleUploadChunkPost(apiSess, req, res);
  if (action === 'mastering-save' && req.method === 'POST') return handleSave(apiSess, req, res, false);
  if (action === 'mastering-commit' && req.method === 'POST') return handleSave(apiSess, req, res, true);
  if (action === 'mastering-upload' && req.method === 'POST') {
    const slot = (parsed.query && parsed.query.slot) || '';
    return handleMasteringUpload(apiSess, req, res, slot);
  }
  return sendErr(res, 405, 'method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cloud-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`sessions dir: ${SESSIONS_DIR}`);
  console.log(`expose via: cloudflared tunnel --url http://localhost:${PORT}`);
});
