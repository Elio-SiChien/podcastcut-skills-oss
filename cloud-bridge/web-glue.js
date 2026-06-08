/*
 * web-glue.js — runtime bridge between the podcastcut-web prototype and
 * the cloud-bridge backend.
 *
 * Loaded as a <script defer> tag from /app. Monkey-patches the prototype's
 * existing handlers so the designer's HTML in podcastcut-web/design/ stays
 * pristine and they can iterate without touching this file.
 *
 * Phase 1 wires:
 *   - Profile save (newuser screen) → POST /api/profile/save
 *   - Debrief submit (debrief screen) → POST /api/session/save (debrief)
 *   - Vibe pick (vibe screen)         → POST /api/session/save (vibe)
 *   - Upload "next" click             → POST /api/session/save (upload meta)
 *
 * Phase 2 will add:
 *   - audio file POST + Slock trigger to wake @podcast-editor-agent
 */

(function () {
  'use strict';

  const log = (...a) => console.log('[web-glue]', ...a);
  const toastEl = ensureToast();

  // ── persistent session id (per browser, per podcast cut session) ──
  function sessionId() {
    let sid = localStorage.getItem('cut_session_id');
    if (!sid) {
      sid = 'sess-' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('cut_session_id', sid);
    }
    return sid;
  }

  // ── HTTP helpers ──
  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err += ' — ' + (await r.json()).error; } catch {}
      throw new Error(err);
    }
    return r.json();
  }

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── tiny toast (the prototype has its own toast machinery in some
  // places, but we don't want to depend on it). Fade-out, top-right. ──
  function ensureToast() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:60px;right:24px;z-index:99999;'
      + 'background:#1A1A1A;color:#EFECE6;font-size:13px;font-weight:600;'
      + 'padding:10px 16px;border-radius:6px;letter-spacing:.5px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:0;'
      + 'transition:opacity .2s ease-out;pointer-events:none;'
      + 'font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    document.body.appendChild(el);
    return el;
  }
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.style.background = kind === 'err' ? '#8a3a30' : (kind === 'ok' ? '#3a6a4a' : '#1A1A1A');
    toastEl.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.style.opacity = '0'; }, 2500);
  }

  // ── PROFILE form readers ──
  // The newuser screen has the 6 sections. None of them have IDs in the
  // prototype, so we read by position within the screen. This is fragile
  // and the right long-term fix is for the designer to add id="" — but
  // for Phase 1 we cope.
  function collectProfile() {
    const root = document.getElementById('newuser');
    if (!root) throw new Error('newuser screen not found');

    // form-sec blocks in order: import → 01 name → 02 tone → 03 hosts
    // → 04 target → 05 aggressiveness → 06 glossary
    const secs = root.querySelectorAll('.form-sec');
    // pick by content rather than index — small extra safety
    const findSecByLabel = (text) =>
      Array.from(secs).find(s => (s.querySelector('.fs-label')?.textContent || '').includes(text));

    const importSec = findSecByLabel('小宇宙') || secs[0];
    const xiaoyuzhouUrl = importSec?.querySelector('input[type=url]')?.value.trim() || null;

    const nameInput = (findSecByLabel('播客名') || secs[1])?.querySelector('input[type=text]');
    const name = (nameInput?.value || '').trim();

    const toneSec = findSecByLabel('调性') || secs[2];
    const tone = (toneSec?.querySelector('textarea')?.value || '').trim();

    const hostsSec = findSecByLabel('主播') || secs[3];
    const hosts = Array.from(hostsSec?.querySelectorAll('.host-row') || []).map(row => {
      const name = (row.querySelector('input[type=text]')?.value || '').trim();
      const activePill = row.querySelector('.role-pill.on');
      const role = (activePill?.textContent || '主持').trim();
      return name ? { name, role } : null;
    }).filter(Boolean);

    const durSec = findSecByLabel('时长') || secs[4];
    const default_target_min = +(durSec?.querySelector('#sv')?.textContent || '50');

    const aggSec = findSecByLabel('力度') || secs[5];
    const activeAgg = aggSec?.querySelector('.pill.on');
    const aggText = (activeAgg?.firstChild?.textContent || '适中').trim();
    const aggMap = { '保守': 'conservative', '适中': 'moderate', '激进': 'aggressive' };
    const default_aggressiveness = aggMap[aggText] || 'moderate';

    const glossSec = findSecByLabel('Glossary') || findSecByLabel('词库') || secs[6];
    const glossary = Array.from(glossSec?.querySelectorAll('.tag') || [])
      .map(t => (t.firstChild?.textContent || '').trim())
      .filter(Boolean);

    return {
      name,
      tone,
      hosts,
      default_target_min,
      default_aggressiveness,
      glossary,
      xiaoyuzhou_url: xiaoyuzhouUrl,
    };
  }

  // ── DEBRIEF form reader ──
  function collectDebrief() {
    const root = document.getElementById('debrief');
    if (!root) throw new Error('debrief screen not found');

    const smoothPill = root.querySelector('.pills[data-group="smoothness"] .pill.on');
    const smoothness = (smoothPill?.textContent || '').trim();

    const excluded = Array.from(root.querySelectorAll('.check.on .ck-text'))
      .map(el => (el.textContent || '').trim());

    const fields = root.querySelectorAll('.field');
    // 03 = privacy, 04 = must_keep, 05 = safe_delete
    const privacy = (fields[2]?.querySelector('textarea')?.value || '').trim();
    const must_keep = (fields[3]?.querySelector('textarea')?.value || '').trim();
    const safe_delete = (fields[4]?.querySelector('textarea')?.value || '').trim();

    const durEl = root.querySelector('#durVal');
    const target_min = +(durEl?.textContent || '50');

    const aggPill = root.querySelector('.pills[data-group="aggressiveness"] .pill.on');
    const aggText = (aggPill?.firstChild?.textContent || '适中').trim();
    const aggMap = { '保守': 'conservative', '适中': 'moderate', '激进': 'aggressive' };
    const aggressiveness = aggMap[aggText] || 'moderate';

    return { smoothness, excluded, privacy, must_keep, safe_delete, target_min, aggressiveness };
  }

  // ── UPLOAD-screen meta reader ──
  // Per-episode upload meta = episode title + this-episode cast (the
  // 嘉宾 / 临时主持 the user added under "本期加入"). The "档案常驻" block
  // reads its names from the profile, so we don't re-save those.
  function collectUploadMeta() {
    const titleInput = document.getElementById('upTitle');
    const castList = document.getElementById('castList');
    const cast = Array.from(castList?.querySelectorAll('.cast-row') || []).map(row => {
      const name = (row.querySelector('input[type=text]')?.value || '').trim();
      const activePill = row.querySelector('.role-pill.on');
      const role = (activePill?.textContent || '嘉宾').trim();
      return name ? { name, role } : null;
    }).filter(Boolean);
    return {
      title: (titleInput?.value || '').trim(),
      cast,
    };
  }

  // ── HOOK 1: profile save ──
  // The prototype defines saveProfileAnim(btn) globally. We replace it
  // with a version that POSTs first and only proceeds with the floppy
  // animation on success.
  function hookProfileSave() {
    const orig = window.saveProfileAnim;
    if (typeof orig !== 'function') {
      log('saveProfileAnim not found, skipping profile hook');
      return;
    }
    window.saveProfileAnim = function (btn) {
      let profile;
      try { profile = collectProfile(); }
      catch (e) { toast('表单读取出错：' + e.message, 'err'); return; }
      if (!profile.name) { toast('请填播客名', 'err'); return; }

      postJson('/api/profile/save', profile)
        .then(r => {
          toast(r.created === false ? '档案已更新' : '档案已建', 'ok');
          orig.call(this, btn);
        })
        .catch(e => {
          toast('保存失败：' + e.message, 'err');
        });
    };
  }

  // ── HOOK 2: debrief submit ──
  // After saving the debrief, upload the audio file (if any was picked
  // on screen 2) and hand off to the agent. Show a "正在转录" overlay
  // and poll /api/edit/status until the agent has produced speaker
  // samples, then advance to the (now real) speakers screen.
  function hookDebriefSubmit() {
    const root = document.getElementById('debrief');
    if (!root) return;
    const btn = root.querySelector('.cta-row .btn-primary');
    if (!btn) return;
    btn.onclick = async function (e) {
      let data;
      try { data = collectDebrief(); }
      catch (err) { toast('表单读取出错：' + err.message, 'err'); return; }
      try {
        await postJson('/api/session/save', { session_id: sessionId(), debrief: data });
      } catch (err) {
        toast('保存复盘失败：' + err.message, 'err');
        return;
      }
      const file = window.__uploadFile;
      if (!file) {
        // No audio picked — proceed to mock speakers screen anyway.
        toast('未上传音频，继续到 mock 屏', 'warn');
        window.show && window.show('speakers');
        return;
      }
      showTranscribingOverlay('上传音频…');
      try {
        const meta = await uploadAudio(file, p => updateProgress('上传中', p));
        updateProgress('上传完成', 100);
        setOverlayMessage(`已上传 ${file.name}。等 agent 接活儿（请去 Slock 让 @podcast-editor-agent 处理 ${meta.episode_name}）。`);
        // Begin polling. The agent will eventually update project.json.
        startStatusPoll(meta);
      } catch (err) {
        hideOverlay();
        toast('上传失败：' + err.message, 'err');
      }
    };
  }

  // ── HOOK 3: upload-screen "上传并继续" ──
  // The prototype's file picker only stashes a blob URL locally. Capture
  // the File object here so the debrief-submit hook can stream it to the
  // backend. The "下一步" still navigates to debrief — actual upload is
  // deferred until the user commits the debrief (so we don't burn
  // bandwidth if they bail).
  function hookUploadNext() {
    const root = document.getElementById('upload');
    if (!root) return;
    // 1) capture the file the moment user picks one
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        window.__uploadFile = fileInput.files && fileInput.files[0];
        if (window.__uploadFile) toast('已选 ' + window.__uploadFile.name + '，会在复盘提交时上传', 'ok');
      });
    }
    // 2) wrap the "上传并继续" button to save meta then navigate
    const btn = root.querySelector('.btn-primary');
    if (!btn) return;
    btn.onclick = function () {
      const meta = collectUploadMeta();
      postJson('/api/session/save', { session_id: sessionId(), upload_meta: meta })
        .then(() => { window.show && window.show('debrief'); })
        .catch(err => {
          toast('保存失败：' + err.message, 'err');
          window.show && window.show('debrief');
        });
    };
  }

  // ── upload streaming + progress UI ──
  function uploadAudio(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/edit/upload?session_id=' + encodeURIComponent(sessionId()), true);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('bad response: ' + e.message)); }
        } else {
          let msg = 'HTTP ' + xhr.status;
          try { msg += ' — ' + (JSON.parse(xhr.responseText).error || ''); } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    });
  }

  // ── overlay: "正在处理" full-screen card with spinning cassette + timer ──
  let overlay = null;
  let overlayBar = null;
  let overlayMsg = null;
  let overlayTimer = null;
  let pollHandle = null;
  let overlayStartedAt = null;
  let overlayTickHandle = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    // Inject spin keyframes once (using cb-spin to avoid clashes with the prototype's own spin).
    if (!document.getElementById('cb-overlay-style')) {
      const st = document.createElement('style');
      st.id = 'cb-overlay-style';
      st.textContent =
        '@keyframes cb-spin { to { transform: rotate(360deg); } }\n' +
        '.cb-reel { animation: cb-spin 1.4s linear infinite; }';
      document.head.appendChild(st);
    }
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(239,237,230,.96);'
      + 'display:flex;align-items:center;justify-content:center;'
      + 'font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    // Cassette: 240×144 body with two spinning reels, mirrors prototype screen 5.
    const reelSvg = (delay) =>
      `<svg class="cb-reel" width="36" height="36" viewBox="0 0 36 36" style="animation-delay:${delay}">
         <circle cx="18" cy="18" r="16" fill="none" stroke="#6E6E6E" stroke-width="2"/>
         <circle cx="18" cy="18" r="5" fill="#EFECE6" stroke="#6E6E6E" stroke-width="1.5"/>
         <line x1="18" y1="4" x2="18" y2="13" stroke="#6E6E6E" stroke-width="2"/>
         <line x1="4" y1="18" x2="13" y2="18" stroke="#6E6E6E" stroke-width="2"/>
       </svg>`;
    overlay.innerHTML = `
      <div style="text-align:center;max-width:540px;padding:32px;">
        <div style="width:240px;height:144px;border:2.5px solid #6E6E6E;border-radius:10px;background:#EFECE6;
                    box-shadow:0 6px 24px rgba(0,0,0,.08);margin:0 auto 28px;position:relative;">
          <div style="position:absolute;top:24px;left:32px;right:32px;height:56px;border:2px solid #6E6E6E;
                      border-radius:5px;background:#E2DED4;display:flex;align-items:center;justify-content:space-between;padding:0 18px;">
            ${reelSvg('0s')}
            ${reelSvg('-.4s')}
          </div>
          <div style="position:absolute;bottom:14px;left:50%;transform:translateX(-50%);
                      font-family:'SF Mono',monospace;font-size:9.5px;letter-spacing:3px;color:#9A958C;text-transform:uppercase;">
            PROCESSING
          </div>
        </div>
        <div style="font-family:'Noto Serif SC',serif;font-size:30px;font-weight:700;color:#1A1A1A;margin-bottom:8px;">
          正在处理
        </div>
        <div id="cb-overlay-stage" style="font-size:14px;color:#6E6E6E;letter-spacing:1.5px;margin-bottom:8px;">
          准备中…
        </div>
        <div id="cb-overlay-timer" style="font-family:'SF Mono',monospace;font-size:12px;color:#9A958C;
                                          letter-spacing:1.5px;margin-bottom:20px;">
          00:00
        </div>
        <div style="width:320px;height:6px;margin:0 auto 24px;background:#DDD8D0;border-radius:99px;overflow:hidden;">
          <div id="cb-overlay-bar" style="height:100%;width:0;background:#1A1A1A;transition:width .3s ease-out;"></div>
        </div>
        <div id="cb-overlay-msg" style="font-size:13px;color:#4A4A4A;line-height:1.6;">
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlayBar = overlay.querySelector('#cb-overlay-bar');
    overlayMsg = overlay.querySelector('#cb-overlay-msg');
    overlayTimer = overlay.querySelector('#cb-overlay-timer');
    return overlay;
  }
  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }
  function tickTimer() {
    if (!overlay || !overlayTimer) return;
    if (overlayStartedAt == null) return;
    overlayTimer.textContent = formatElapsed(Date.now() - overlayStartedAt);
  }
  function showTranscribingOverlay(initialMsg) {
    ensureOverlay();
    overlay.style.display = 'flex';
    setOverlayMessage(initialMsg || '');
    if (overlayStartedAt == null) overlayStartedAt = Date.now();
    if (overlayTickHandle == null) overlayTickHandle = setInterval(tickTimer, 1000);
    tickTimer();
    updateProgress('上传中', 0);
  }
  function updateProgress(stageLabel, pct) {
    ensureOverlay();
    overlay.querySelector('#cb-overlay-stage').textContent = stageLabel;
    overlayBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function setOverlayMessage(msg) {
    ensureOverlay();
    overlayMsg.textContent = msg;
  }
  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (overlayTickHandle != null) { clearInterval(overlayTickHandle); overlayTickHandle = null; }
    overlayStartedAt = null;
  }

  // Stage label progression — kept in sync with what the agent writes
  // into BASE_DIR/project.json as it walks the pipeline.
  const STAGE_LABELS = {
    waiting_for_upload: '上传等待',
    pending_agent_pickup: '等 agent 接活儿',
    transcribing: '转录中',
    transcribed: '转录完成 — 准备说话人确认',
    await_speaker_confirm: '请确认说话人',
    speakers_confirmed: '说话人已确认',
    rough_cut: '粗剪中（语义分析 483 句）',
    roughcut_review: '粗剪完成 — 你来审查',
    roughcut_committed: '粗剪已提交，准备精剪',
    fine_cut: '精剪中（词级口癖 / 卡顿）',
    finecut_review: '精剪完成 — 词级审查',
    finecut_committed: '精剪已提交，切音频中',
    cutting_audio: '切音频中',
    cutting_done: '成品就绪',
    mastering_review: '后期 — 选金句、配片头片尾',
    mastering_committed: '后期已提交，混音中',
    mastering_mixing: '混音中（DFN 降噪 + 片头片尾）',
    done: '完成',
  };
  const STAGE_PCT = {
    pending_agent_pickup: 15,
    transcribing: 35,
    transcribed: 60,
    await_speaker_confirm: 60,
    speakers_confirmed: 65,
    rough_cut: 75,
    roughcut_review: 80,
    roughcut_committed: 82,
    fine_cut: 88,
    finecut_review: 92,
    finecut_committed: 96,
    cutting_audio: 98,
    cutting_done: 100,
    mastering_review: 100,
    mastering_committed: 100,
    mastering_mixing: 100,
    done: 100,
  };
  const DONE_STAGES = new Set(['cutting_done', 'done']);
  // Stage -> (project field that holds the review URL) mapping for the
  // generic iframe transition.
  const REVIEW_STAGE_URL_FIELD = {
    roughcut_review: 'roughcut_review_url',
    finecut_review: 'finecut_review_url',
    mastering_review: 'mastering_review_url',
  };
  const SPEAKERS_READY_STAGES = new Set(['transcribed', 'await_speaker_confirm']);

  function startStatusPoll(meta) {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      let s;
      try { s = await getJson('/api/edit/status?session_id=' + encodeURIComponent(sessionId())); }
      catch { return; }
      updateProgress(STAGE_LABELS[s.stage] || s.stage, STAGE_PCT[s.stage] || 20);
      if (SPEAKERS_READY_STAGES.has(s.stage) && s.speakers && s.speakers.length) {
        clearInterval(pollHandle);
        pollHandle = null;
        hideOverlay();
        renderRealSpeakers(s, meta);
        window.show && window.show('speakers');
        return;
      }
      const urlField = REVIEW_STAGE_URL_FIELD[s.stage];
      const reviewUrl = urlField && s.project && s.project[urlField];
      if (reviewUrl) {
        clearInterval(pollHandle);
        pollHandle = null;
        hideOverlay();
        renderReviewIframe(reviewUrl, meta, s);
        return;
      }
      if (DONE_STAGES.has(s.stage)) {
        clearInterval(pollHandle);
        pollHandle = null;
        hideOverlay();
        renderDoneCard(s, meta);
        return;
      }
    }, 3000);
  }

  // After 粗剪 completes, embed the review HTML inline so the user never
  // leaves /app. The review HTML's own cloud-bridge integration handles
  // 保存进度 / 完成开始剪 — we just host it in an iframe and wait for the
  // next stage flip (fine_cut) before showing the overlay again.
  function renderReviewIframe(reviewUrl, meta, status) {
    let host = document.getElementById('cb-review-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cb-review-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:9000;background:#EFECE6;'
        + 'display:flex;flex-direction:column;';
      const bar = document.createElement('div');
      bar.style.cssText = 'flex:0 0 44px;padding:0 18px;display:flex;align-items:center;gap:14px;'
        + 'border-bottom:1.5px solid #DDD8D0;background:#EFECE6;'
        + 'font-family:-apple-system,sans-serif;font-size:12px;color:#4A4A4A;letter-spacing:1px;';
      bar.innerHTML =
        '<span id="cb-review-title" style="font-family:\'Noto Serif SC\',serif;font-weight:700;font-size:14px;color:#1A1A1A;">粗剪审查</span>' +
        '<span style="color:#9A958C;">|</span>' +
        '<span id="cb-review-epname">' + (meta && meta.episode_name || '本期') + '</span>' +
        '<span style="margin-left:auto;color:#9A958C;font-size:11px;letter-spacing:1.5px;font-family:\'SF Mono\',monospace;">' +
        '在审查页内勾选/取消勾选，完成后点右上"完成，开始剪"</span>';
      host.appendChild(bar);
      const iframe = document.createElement('iframe');
      iframe.id = 'cb-review-iframe';
      iframe.style.cssText = 'flex:1;width:100%;border:0;background:#EFECE6;';
      host.appendChild(iframe);
      document.body.appendChild(host);
    }
    const titleEl = host.querySelector('#cb-review-title');
    if (titleEl) {
      const map = { roughcut_review: '粗剪审查', finecut_review: '精剪审查（词级）', mastering_review: '后期 — 选金句、片头片尾' };
      titleEl.textContent = (status && map[status.stage]) || '审查';
    }
    const iframe = host.querySelector('#cb-review-iframe');
    if (iframe.src !== reviewUrl) iframe.src = reviewUrl;
    host.style.display = 'flex';
    // After embedding, watch for the commit transition (review session
    // status flips to committed) and advance the user to the next overlay.
    watchReviewCommit(reviewUrl, meta, host, status && status.stage);
  }

  // Pipeline finished: show a done card with inline audio player + stats +
  // a "进入后期" CTA. Replaces both overlay and review iframe.
  function renderDoneCard(status, meta) {
    let host = document.getElementById('cb-done-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cb-done-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:9500;background:#EFECE6;'
        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
        + 'font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;';
      document.body.appendChild(host);
    }
    const project = status.project || {};
    const cut = project.cut_summary || {};
    const finalUrl = project.final_audio_url || '';
    const epName = (meta && meta.episode_name) || status.episode_name || '本期';
    host.innerHTML = '';
    host.style.display = 'flex';

    const card = document.createElement('div');
    card.style.cssText = 'max-width:640px;width:100%;background:#FFFCF6;border:1.5px solid #DDD8D0;'
      + 'border-radius:14px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.07);';
    card.innerHTML =
      '<div style="font-family:\'SF Mono\',monospace;font-size:11px;letter-spacing:3px;color:#9A958C;margin-bottom:10px;">EPISODE READY</div>'
      + '<h1 style="font-family:\'Noto Serif SC\',serif;font-weight:700;font-size:28px;color:#1A1A1A;margin:0 0 6px;">' + epName + '</h1>'
      + '<div style="font-family:\'Noto Serif SC\',serif;font-style:italic;color:#6E6E6E;font-size:14px;margin-bottom:24px;">精剪完成 · 准备进后期</div>'
      + '<div id="cb-done-player" style="margin-bottom:24px;"></div>'
      + '<div id="cb-done-stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px;"></div>'
      + '<div id="cb-done-actions" style="display:flex;gap:12px;flex-wrap:wrap;"></div>';
    host.appendChild(card);

    // Player
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'metadata';
    player.style.cssText = 'width:100%;';
    player.src = finalUrl;
    card.querySelector('#cb-done-player').appendChild(player);

    // Stats tiles
    const stats = [
      ['原时长', (cut.original_min != null ? cut.original_min + ' min' : '—')],
      ['精剪后', (cut.after_trim_min != null ? cut.after_trim_min + ' min' : '—')],
      ['净省', (cut.saved_min != null ? cut.saved_min + ' min (' + (cut.saved_pct || 0) + '%)' : '—')],
    ];
    const statsBox = card.querySelector('#cb-done-stats');
    stats.forEach(([k, v]) => {
      const t = document.createElement('div');
      t.style.cssText = 'background:#EFECE6;border-radius:8px;padding:14px;text-align:center;';
      t.innerHTML =
        '<div style="font-family:\'SF Mono\',monospace;font-size:10px;letter-spacing:2px;color:#9A958C;margin-bottom:6px;">' + k + '</div>'
        + '<div style="font-family:\'Noto Serif SC\',serif;font-weight:700;font-size:18px;color:#1A1A1A;">' + v + '</div>';
      statsBox.appendChild(t);
    });

    // Actions
    const actionsBox = card.querySelector('#cb-done-actions');
    const dl = document.createElement('a');
    dl.href = finalUrl;
    dl.download = epName + '_精剪版.m4a';
    dl.textContent = '⬇ 下载 m4a';
    dl.style.cssText = 'flex:1;padding:14px 18px;background:#FFFCF6;border:1.5px solid #1A1A1A;'
      + 'border-radius:8px;color:#1A1A1A;text-decoration:none;text-align:center;font-weight:600;letter-spacing:.5px;font-size:14px;';
    actionsBox.appendChild(dl);

    const masteringBtn = document.createElement('button');
    masteringBtn.textContent = '进入后期 →';
    const masteringUrl = project.mastering_review_url;
    masteringBtn.style.cssText = 'flex:1;padding:14px 18px;background:#1A1A1A;border:1.5px solid #1A1A1A;'
      + 'border-radius:8px;color:#EFECE6;text-align:center;font-weight:600;letter-spacing:.5px;font-size:14px;'
      + (masteringUrl ? 'cursor:pointer;' : 'cursor:not-allowed;opacity:.6;');
    if (!masteringUrl) {
      masteringBtn.disabled = true;
      masteringBtn.title = '后期 session 还没建好 — 等 agent 跑过 generate_mastering';
    } else {
      masteringBtn.onclick = async () => {
        masteringBtn.disabled = true;
        masteringBtn.textContent = '进入后期…';
        try {
          await postJson('/api/edit/enter-mastering', { session_id: sessionId() });
        } catch (e) {
          masteringBtn.disabled = false;
          masteringBtn.textContent = '进入后期 →';
          toast('进入后期失败：' + e.message);
          return;
        }
        host.style.display = 'none';
        renderReviewIframe(masteringUrl, meta, { stage: 'mastering_review' });
      };
    }
    actionsBox.appendChild(masteringBtn);

    const newCutBtn = document.createElement('button');
    newCutBtn.textContent = '剪新一期';
    newCutBtn.style.cssText = 'padding:14px 18px;background:transparent;border:1.5px solid #DDD8D0;'
      + 'border-radius:8px;color:#6E6E6E;font-weight:600;letter-spacing:.5px;font-size:14px;cursor:pointer;';
    newCutBtn.onclick = () => {
      try { localStorage.removeItem('cut_session_id'); } catch {}
      location.href = '/app';
    };
    actionsBox.appendChild(newCutBtn);
  }

  let reviewWatchHandle = null;
  function watchReviewCommit(reviewUrl, meta, host, expectedStage) {
    if (reviewWatchHandle) clearInterval(reviewWatchHandle);
    reviewWatchHandle = setInterval(async () => {
      let edit;
      try { edit = await getJson('/api/edit/status?session_id=' + encodeURIComponent(sessionId())); } catch { return; }
      if (edit && edit.stage && edit.stage !== expectedStage) {
        clearInterval(reviewWatchHandle);
        reviewWatchHandle = null;
        host.style.display = 'none';
        showTranscribingOverlay(meta);
        updateProgress(STAGE_LABELS[edit.stage] || edit.stage, STAGE_PCT[edit.stage] || 80);
        setOverlayMessage((expectedStage === 'finecut_review' ? '精剪' : '粗剪') + '已提交，继续后面阶段…');
        startStatusPoll(meta);
      }
    }, 3000);
  }

  // When transcription is done, replace the prototype's static SPEAKER
  // cards on the speakers screen with real ones from the agent: one card
  // per detected speaker_id, with playable sample, suggested name, and a
  // chip menu of valid names (profile.hosts + cast).
  function renderRealSpeakers(status, meta) {
    const root = document.getElementById('speakers');
    if (!root) return;
    if (meta && meta.episode_name) {
      const header = root.querySelector('.ep-name');
      if (header) header.textContent = meta.episode_name;
    }
    const epMeta = root.querySelector('.ep-meta');
    if (epMeta) epMeta.textContent = `AI 在录音里听到 ${status.speakers.length} 个声音`;

    // Build the chip name pool: profile hosts + cast members.
    const namePool = [];
    (status.profile_hosts || []).forEach(h => { if (h && h.name) namePool.push(h.name); });
    (status.cast || []).forEach(c => { if (c && c.name && !namePool.includes(c.name)) namePool.push(c.name); });

    const list = root.querySelector('#speakerList');
    if (!list) return;
    list.innerHTML = '';
    status.speakers.forEach(spk => {
      const row = document.createElement('div');
      row.className = 'speaker-row assigned';
      row.dataset.spkId = spk.id;
      row.dataset.suggest = spk.suggested_name || '';
      row.dataset.assigned = spk.suggested_name || '';

      const playBtn = document.createElement('button');
      playBtn.className = 'spk-play';
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', '播放样本');
      const audio = new Audio(spk.sample_url);
      playBtn.onclick = () => {
        if (audio.paused) { audio.play(); playBtn.textContent = '⏸'; }
        else { audio.pause(); playBtn.textContent = '▶'; }
      };
      audio.onended = () => { playBtn.textContent = '▶'; };
      row.appendChild(playBtn);

      const wave = document.createElement('div');
      wave.className = 'spk-wave';
      wave.dataset.name = spk.suggested_name || ('Speaker ' + spk.id);
      // simple seeded heights so the visual doesn't look broken
      for (let i = 0; i < 18; i++) {
        const s = document.createElement('span');
        s.style.height = (28 + ((i * 37 + +spk.id * 11) % 60)) + '%';
        wave.appendChild(s);
      }
      row.appendChild(wave);

      const metaCol = document.createElement('div');
      metaCol.className = 'spk-meta';
      metaCol.innerHTML =
        `<div class="spk-cluster">SPEAKER 0${+spk.id + 1} · ${spk.sentence_count} 句 · ${spk.share}%</div>` +
        `<div class="spk-suggest"><span class="spk-suggest-prefix">建议</span> · ` +
          `<span class="spk-suggest-name">${spk.suggested_name || '未匹配'}</span></div>`;
      row.appendChild(metaCol);

      const pills = document.createElement('div');
      pills.className = 'spk-pills';
      namePool.forEach(name => {
        const b = document.createElement('button');
        b.className = 'role-pill' + (name === spk.suggested_name ? ' on' : '');
        b.textContent = name;
        b.onclick = () => {
          pills.querySelectorAll('.role-pill').forEach(p => p.classList.remove('on'));
          b.classList.add('on');
          row.dataset.assigned = name;
          metaCol.querySelector('.spk-suggest-name').textContent = name;
        };
        pills.appendChild(b);
      });
      row.appendChild(pills);

      list.appendChild(row);
    });

    // Wire the "确认 · 开始处理" CTA to POST the user's final mapping back.
    const cta = root.querySelector('.cta-row .btn-primary');
    if (cta && !cta.dataset.cbWired) {
      cta.dataset.cbWired = '1';
      cta.onclick = async () => {
        const finalMap = {};
        list.querySelectorAll('.speaker-row').forEach(row => {
          finalMap[row.dataset.spkId] = row.dataset.assigned || row.dataset.suggest;
        });
        try {
          await postJson('/api/edit/speakers-confirm', {
            session_id: sessionId(),
            speaker_mapping: finalMap,
          });
          toast('已确认，开始粗剪');
        } catch (e) {
          toast('确认失败：' + e.message);
          return;
        }
        showTranscribingOverlay(meta);
        setOverlayMessage('已确认说话人，agent 开始粗剪...');
        startStatusPoll(meta);
      };
    }
  }

  // ── HOOK 4: vibe pick ──
  // The prototype's pickVibe(card, vibe) is the entry point. Wrap it so
  // every selection persists.
  function hookVibePick() {
    const orig = window.pickVibe;
    if (typeof orig !== 'function') return;
    window.pickVibe = function (card, vibe) {
      try {
        if (vibe) {
          postJson('/api/session/save', {
            session_id: sessionId(),
            vibe: { name: vibe.name, hex: vibe.hex, quote: vibe.quote, author: vibe.author },
          }).catch(() => { /* non-blocking */ });
        }
      } catch {}
      return orig.apply(this, arguments);
    };
  }

  // ── resume an in-flight pipeline on page reload ──
  // If the user closed the tab mid-pipeline, localStorage still has the
  // session_id. Hit /api/edit/status — if the agent is mid-flight (anything
  // past waiting_for_upload) jump back to the overlay and re-attach polling.
  async function resumeIfInFlight() {
    let s;
    try { s = await getJson('/api/edit/status?session_id=' + encodeURIComponent(sessionId())); }
    catch { return; }
    if (!s || !s.stage || s.stage === 'waiting_for_upload') return;
    const meta = { episode_name: s.episode_name || '本期' };
    showTranscribingOverlay(meta);
    setOverlayMessage('恢复中：已检测到正在处理的剪辑（' + (s.episode_name || '本期') + '）。');
    updateProgress(STAGE_LABELS[s.stage] || s.stage, STAGE_PCT[s.stage] || 20);
    if (SPEAKERS_READY_STAGES.has(s.stage) && s.speakers && s.speakers.length) {
      hideOverlay();
      renderRealSpeakers(s, meta);
      window.show && window.show('speakers');
      return;
    }
    const urlField = REVIEW_STAGE_URL_FIELD[s.stage];
    const reviewUrl = urlField && s.project && s.project[urlField];
    if (reviewUrl) {
      hideOverlay();
      renderReviewIframe(reviewUrl, meta, s);
      return;
    }
    if (DONE_STAGES.has(s.stage)) {
      hideOverlay();
      renderDoneCard(s, meta);
      return;
    }
    startStatusPoll(meta);
  }

  // ── boot ──
  function boot() {
    hookProfileSave();
    hookDebriefSubmit();
    hookUploadNext();
    hookVibePick();
    resumeIfInFlight();
    log('boot complete, session_id =', sessionId());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
