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
 *   GET  /api/:session/state    — 返回当前 draft / committed / upload 状态
 *   POST /api/:session/save     — 写 draft（review session）
 *   POST /api/:session/commit   — 写 final + 触发 commit 文件（review session）
 *   GET  /api/:session/audio    — proxy 已存在音频，支持 Range（review session）
 *   POST /api/:session/upload   — 流式接收用户上传的音频（upload session）
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
  const file = fs.existsSync(cFile) ? cFile : (fs.existsSync(dFile) ? dFile : null);
  if (!file) return send(res, 200, { initial: true });
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return sendErr(res, 500, 'state read error');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(data);
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
  send(res, 200, { ok: true, status: meta.status });
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
  const m = parsed.pathname.match(
    /^\/(?:r\/([a-z0-9]+)|u\/([a-z0-9]+)|api\/([a-z0-9]+)\/(state|save|commit|audio|upload))$/
  );
  if (!m) {
    if (parsed.pathname === '/health') return send(res, 200, { ok: true, sessions_dir: SESSIONS_DIR });
    return sendErr(res, 404, 'not found');
  }
  const reviewSess = m[1];
  const uploadSess = m[2];
  const apiSess = m[3];
  const action = m[4] || (reviewSess ? 'review_page' : 'upload_page');
  if (action === 'review_page') return handleReviewPage(reviewSess, res);
  if (action === 'upload_page') return handleUploadPage(uploadSess, res);
  if (action === 'state' && req.method === 'GET') return handleGetState(apiSess, res);
  if (action === 'save' && req.method === 'POST') return handleSave(apiSess, req, res, false);
  if (action === 'commit' && req.method === 'POST') return handleSave(apiSess, req, res, true);
  if (action === 'audio' && (req.method === 'GET' || req.method === 'HEAD')) return handleAudio(apiSess, req, res);
  if (action === 'upload' && req.method === 'POST') return handleUploadPost(apiSess, req, res);
  return sendErr(res, 405, 'method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cloud-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`sessions dir: ${SESSIONS_DIR}`);
  console.log(`expose via: cloudflared tunnel --url http://localhost:${PORT}`);
});
