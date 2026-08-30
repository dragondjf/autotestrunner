  const stepsEl = document.getElementById('steps');
  const msgsEl = document.getElementById('msgs');
  const statsEl = document.getElementById('stats');
  const badge = document.getElementById('status-badge');
  const execBody = document.getElementById('exec-body');
  const viewer = document.getElementById('viewer');
  const viewerImg = document.getElementById('viewer-img');
  const viewerCap = document.getElementById('viewer-cap');
  const sessList = document.getElementById('sess-list');

  let mode = 'timeline';   // timeline | board
  let steps = [];          // 收集每一步事件
  let curViewerIdx = -1;   // 大图浏览定位
  let controller = null;   // AbortController
  let sessionId = null;    // 多轮会话 id：复用一个 Playwright 实例

  function sseDecode(payload) { try { return JSON.parse(payload); } catch (_) { return null; } }

  function appendAgentMsg(meta, text, isErr) {
    const div = document.createElement('div');
    div.className = 'msg agent' + (isErr ? ' err' : '');
    const m = document.createElement('div'); m.className = 'm'; m.textContent = meta;
    const t = document.createElement('span'); t.textContent = text;
    div.appendChild(m); div.appendChild(t);
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return t;
  }
  function typewriter(el, text, speed) {
    let i = 0;
    return new Promise((res) => {
      const timer = setInterval(() => {
        el.textContent = text.slice(0, ++i);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        if (i >= text.length) { clearInterval(timer); res(); }
      }, speed || 12);
    });
  }
  function appendUserMsg(text) {
    const div = document.createElement('div');
    div.className = 'msg user'; div.textContent = text;
    msgsEl.appendChild(div); msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function setStatus(label, cls) {
    badge.textContent = label;
    badge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  function clearSteps() {
    steps = [];
    curViewerIdx = -1;
    stepsEl.innerHTML = '';
    statsEl.innerHTML = '已执行 <b>0</b> 步';
    renderEmpty();
  }
  function renderEmpty() {
    if (!steps.length) {
      stepsEl.innerHTML = '<div class="empty">尚无执行记录。<br/>发起一次 Agent 执行后，这里会实时出现每一步。</div>';
    }
  }

  function cardFromStep(evt, active) {
    const card = document.createElement('div');
    card.className = 'step ' + (evt.success === false ? 'fail' : 'done');
    if (active) card.classList.add('active');
    card.dataset.idx = evt.step;
    const method = evt.method || '—';
    const ok = evt.success !== false;
    card.innerHTML = `
      <div class="step-top">
        <span class="idx">${evt.step}</span>
        ${ok ? '<span class="icon">✓</span>' : '<span class="icon">✗</span>'}
        <span class="method-tag">${escapeHtml(method)}</span>
      </div>
      <div class="desc">${escapeHtml(evt.desc || '')}</div>
      <div class="cmd">
        <span><span class="k">指令</span> ${escapeHtml(evt.locator || '')}</span>
        ${evt.value ? `<span><span class="k">值</span> ${escapeHtml(evt.value)}</span>` : ''}
      </div>
      ${evt.screenshot ? `<div class="shot-wrap"><img class="shot" src="${evt.screenshot}" data-url="${evt.screenshot}" data-cap="${evt.desc || method}"/></div>` : ''}
      ${evt.url ? `<div class="url">🔗 ${escapeHtml(evt.url)}</div>` : ''}`;
    const img = card.querySelector('.shot');
    if (img) img.onclick = () => openViewerAt(steps.findIndex(s => s === evt));
    return card;
  }

  let currentAgentEl = null;   // 当前流式输出的 agent 段落
  function startAgentStream(meta, text, isErr) {
    const el = appendAgentMsg(meta, '', isErr);
    return typewriter(el, text);
  }
  function finishCurrentCursor() { /* 段落即为当前,无额外光标 */ }

  function addStepEvent(evt) {
    // 移除占位空标记
    const empty = stepsEl.querySelector('.empty');
    if (empty) empty.remove();
    steps.push(evt);
    // 取消旧的 active 高亮
    const prevActive = stepsEl.querySelector('.step.active');
    if (prevActive) prevActive.classList.remove('active');

    if (mode === 'timeline') {
      const card = cardFromStep(evt, true);
      stepsEl.appendChild(card);
    } else {
      renderBoard();
    }
    statsEl.innerHTML = `已执行 <b>${steps.length}</b> 步`;
    execBody.scrollTop = execBody.scrollHeight;
  }

  function renderBoard() {
    stepsEl.innerHTML = '';
    const board = document.createElement('div');
    board.className = 'board';
    steps.forEach((s, i) => {
      const card = cardFromStep(s, i === steps.length - 1);
      board.appendChild(card);
    });
    stepsEl.appendChild(board);
  }

  function setMode(m) {
    mode = m;
    document.getElementById('mode-timeline').classList.toggle('active', m === 'timeline');
    document.getElementById('mode-board').classList.toggle('active', m === 'board');
    document.getElementById('mode-code').classList.toggle('active', m === 'code');
    const cp = document.getElementById('code-panel');
    const dbgEntry = document.querySelector('.dbg-entry');
    if (dbgEntry) dbgEntry.style.display = (m === 'code') ? 'none' : '';
    if (m === 'code') {
      execBody.style.display = 'none';
      cp.style.display = 'flex';
    } else {
      execBody.style.display = '';  // 恢复 CSS 默认 block：调试器入口 sticky 底部依赖块级布局，flex(row) 会把它挤成右侧竖条
      cp.style.display = 'none';
      if (steps.length) {
        if (m === 'board') renderBoard();
        else {
          stepsEl.innerHTML = '';
          stepsEl.className = 'steps';
          steps.forEach((s) => stepsEl.appendChild(cardFromStep(s, false)));
        }
      }
    }
  }

  // ---- 大图查看/回放 ----
  function openViewerAt(i) {
    if (i < 0 || i >= steps.length) return;
    const s = steps[i];
    if (!s.screenshot) return;
    curViewerIdx = i;
    viewerImg.src = s.screenshot;
    viewerCap.textContent = `第 ${s.step} 步 · ${s.desc || s.method || ''}`;
    viewer.classList.add('show');
  }
  function closeViewer() { viewer.classList.remove('show'); }
  function prevShot() { openViewerAt(curViewerIdx - 1); }
  function nextShot() { openViewerAt(curViewerIdx + 1); }

  // ---- 运行时 ----
  async function run() {
    const userReq = document.getElementById('user-req').value.trim();
    const startUrl = document.getElementById('start-url').value.trim();
    if (!userReq) { appendAgentMsg('Assist', '请先输入你的需求。', true); return; }

    // 时间线属于整个会话：跨轮次持续累积，不在 run 时清空。
    // 需要全新会话时请点"新会话"按钮（newSession 内部负责 clearSteps）。
    appendUserMsg(userReq);
    document.getElementById('user-req').value = '';
    setStatus('执行中', 'running');
    document.getElementById('btn-run').disabled = true;
    setRunBtnMode('stop');
    currentAgentEl = null;

    controller = new AbortController();
    try {
      const resp = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_req: userReq, start_url: startUrl, max_steps: 15,
          session_id: sessionId || undefined,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const evt = sseDecode(line.slice(5).trim());
          if (!evt) continue;
          handleEvent(evt);
        }
      }
      if (!steps.length) renderEmpty();
    } catch (err) {
      if (err.name === 'AbortError') {
        appendAgentMsg('Assist', '已中止执行。', true);
        setStatus('已中止', '');
      } else {
        appendAgentMsg('Assist', '执行出错: ' + err.message, true);
        setStatus('出错', '');
      }
    } finally {
      document.getElementById('btn-run').disabled = false;
      setRunBtnMode('send');
      if (badge.textContent === '执行中') setStatus('待命', '');
      loadSessions();
    }
  }

  function stop() { if (controller) controller.abort(); }

  /** 切换发送按钮为「发送」或「停止」模式（DeepSeek 风格：运行中按钮变停止） */
  function setRunBtnMode(mode) {
    const btn = document.getElementById('btn-run');
    if (mode === 'stop') {
      btn.classList.add('stop');
      btn.title = '停止';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      btn.onclick = stop;
    } else {
      btn.classList.remove('stop');
      btn.title = '发送 (Enter)';
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
      btn.onclick = run;
    }
  }

  async function newSession() {
    if (!sessionId) { clearSteps(); setStatus('待命', ''); msgsEl.innerHTML = WELCOME_HTML; clearSessionUrl(); loadSessions(); return; }
    try {
      await fetch('/api/agent/session/' + encodeURIComponent(sessionId), { method: 'DELETE' });
    } catch (_) { /* 会话可能已回收 */ }
    sessionId = null;
    refreshDbgEntry();
    dbgOnSessionGone();
    clearSteps();
    setStatus('待命', '');
    msgsEl.innerHTML = WELCOME_HTML;
    appendAgentMsg('Assist', '已开启新会话，浏览器实例已释放。可重新输入需求开始。', false);
    clearSessionUrl();
    loadSessions();
  }

  // ---- 会话历史(磁盘持久化) ----
  const WELCOME_HTML = '<div class="msg agent"><div class="m">Assist</div>在下方输入需求，我将通过浏览器 Agent 逐步执行，并在右侧实时展示每一步的“步骤描述 + 执行指令 + 截图”。</div>';
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // ---- URL 深链：会话 id 体现在地址栏（/session/<id>） ----
  function sidFromUrl() {
    const m = location.pathname.match(/^\/session\/([^\/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setUrlForSid(sid) {
    const target = '/session/' + encodeURIComponent(sid);
    if (location.pathname !== target) history.pushState({ sid }, '', target);
  }
  function clearSessionUrl() {
    if (location.pathname !== '/') history.pushState({}, '', '/');
  }
  async function loadSessions() {
    try {
      const list = await fetch('/api/sessions').then(r => r.json());
      renderSessList(list || []);
    } catch (_) { /* 历史栏独立，出错静默 */ }
  }
  function renderSessList(list) {
    if (!list.length) { sessList.innerHTML = '<div class="empty">暂无历史会话</div>'; return; }
    sessList.innerHTML = list.map(s => {
      const active = s.session_id === sessionId ? ' active' : '';
      const title = escapeHtml(s.title || '未命名会话');
      return `<div class="sess-item${active}" data-sid="${s.session_id}" onclick="openSession('${s.session_id}')">
        <div class="t" title="${title}">${title}</div>
        <div class="meta">${fmtTime(s.updated_at)} · ${s.step_count || 0}步${s.msg_count ? `<span class="cnt">· ${s.msg_count}条</span>` : ''}</div>
        <button class="del" onclick="event.stopPropagation();delSession('${s.session_id}')">×</button>
      </div>`;
    }).join('');
  }
  async function delSession(sid) {
    if (!confirm('确认删除该会话历史？')) return;
    try {
      await fetch('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' });
      if (sid === sessionId) { sessionId = null; clearSteps(); msgsEl.innerHTML = WELCOME_HTML; clearSessionUrl(); }
      loadSessions();
    } catch (e) { appendAgentMsg('Assist', '删除失败: ' + e.message, true); }
  }
  // 依据已持久化的 steps 重建时间线/工作台
  function renderStepsHistory() {
    statsEl.innerHTML = `已执行 <b>${steps.length}</b> 步`;
    if (!steps.length) { renderEmpty(); return; }
    if (mode === 'board') renderBoard();
    else {
      stepsEl.innerHTML = '';
      stepsEl.className = 'steps';
      steps.forEach(s => stepsEl.appendChild(cardFromStep(s, false)));
    }
    execBody.scrollTop = execBody.scrollHeight;
  }
  async function openSession(sid) {
    let data;
    try {
      const resp = await fetch('/api/sessions/' + encodeURIComponent(sid));
      if (!resp.ok) throw new Error('加载失败(' + resp.status + ')');
      data = await resp.json();
    } catch (e) { appendAgentMsg('Assist', '加载会话失败: ' + e.message, true); return; }

    // 重建聊天区：重置为欢迎语后，按事件流逐条重建
    msgsEl.innerHTML = WELCOME_HTML;
    (data.events || []).forEach(evt => {
      if (evt.type === 'user') {
        appendUserMsg(evt.text || '');
      } else if (evt.type === 'status') {
        if (evt.message && evt.message !== 'Agent 启动中…') appendAgentMsg('Agent', evt.message, false);
      } else if (evt.type === 'qa') {
        appendAgentMsg('Agent·问', evt.answer || evt.message || '', false);
      } else if (evt.type === 'step') {
        appendAgentMsg(`Agent·第${evt.step}步`, evt.desc || evt.value || evt.message || '', false);
      } else if (evt.type === 'final') {
        const r = evt.result || {};
        if (r.urls_visited && r.urls_visited.length) appendAgentMsg('完成', `已访问页面: ${r.urls_visited.join(' → ')}`, false);
      } else if (evt.type === 'error') {
        appendAgentMsg('Assist', '错误: ' + evt.error, true);
      }
    });

    // 重建步骤(时间线/工作台)
    steps = (data.steps || []).slice();
    curViewerIdx = -1;
    renderStepsHistory();

    // 填充目标 URL 与 sessionId，供"继续对话"复用同一 sid/浏览器
    document.getElementById('start-url').value = data.start_url || data.last_url || '';
    sessionId = data.session_id;
    refreshDbgEntry();
    setUrlForSid(data.session_id);
    setStatus('待命', '');
    loadSessions();
    execBody.scrollTop = 0;
  }

  async function handleEvent(evt) {
    if (evt.session_id) { sessionId = evt.session_id; setUrlForSid(evt.session_id); refreshDbgEntry(); }
    if (evt.type === 'status') {
      if (evt.message && evt.message !== 'Agent 启动中…') {
        await startAgentStream('Agent', evt.message);
      }
      if (evt.done) { setStatus('已完成', 'done'); }
    } else if (evt.type === 'qa') {
      // 问答式交流：基于当前页面的可操作性说明
      await startAgentStream('Agent·问', evt.answer || evt.message || '');
    } else if (evt.type === 'step') {
      await startAgentStream(`Agent·第${evt.step}步`, evt.desc || evt.value || evt.message || '');
      addStepEvent(evt);
    } else if (evt.type === 'final') {
      const r = evt.result || {};
      if (r.urls_visited && r.urls_visited.length) {
        await startAgentStream('完成', `已访问页面: ${r.urls_visited.join(' → ')}`);
      }
      setStatus('待命', '');
    } else if (evt.type === 'error') {
      await startAgentStream('Assist', '错误: ' + evt.error, true);
      setStatus('出错', '');
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 回车发送（Shift+Enter 换行）
  document.getElementById('user-req').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  });

  // 输入框自动增高（DeepSeek 风格）
  const reqEl = document.getElementById('user-req');
  function autoGrow() {
    reqEl.style.height = 'auto';
    reqEl.style.height = Math.min(reqEl.scrollHeight, 200) + 'px';
  }
  reqEl.addEventListener('input', autoGrow);

  // 发送按钮初始化为「发送」模式
  setRunBtnMode('send');
