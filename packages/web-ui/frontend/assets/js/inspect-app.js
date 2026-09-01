/**
 * inspect-app.js — 会话生命周期 / 顶栏 / 历史列表 / tab 切换 / 分隔条 / 快捷键
 * 全局共享状态: window.INSAPP = {sid, alive, currentUrl}
 */
(function (global) {
  'use strict';

  var state = {
    sid: null,
    alive: false,
    currentUrl: '',
    projectId: null   // 所属录制项目（录制项目页「启动录制」带入，随会话绑定落盘）
  };

  function el(id) { return document.getElementById(id); }

  // ---------- API ----------
  /** B 优化: WS 优先(统一性能通道), 失败自动回退 HTTP */
  function act(action, payload) {
    if (global.InsWS && global.InsWS.isOpen()) {
      return global.InsWS.request(action, payload).catch(function (err) {
        return actHttp(action, payload);
      });
    }
    return actHttp(action, payload);
  }
  function actHttp(action, payload) {
    return fetch('/api/inspect/session/' + state.sid + '/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.detail || ('HTTP ' + r.status)); });
      return r.json();
    });
  }
  function actGet(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---------- 状态栏 ----------
  function setStatus(text, cls) {
    var s = el('ins-status');
    s.textContent = text;
    s.className = 'ins-status ' + (cls || '');
  }
  function setBusy(b) {
    ['ins-open', 'ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) {
      el(id).disabled = b;
    });
    el('ins-end').disabled = b || !state.alive;
  }

  // ---------- 会话生命周期 ----------
  function openSession() {
    var url = el('ins-url').value.trim();
    if (!url) { InsTimeline.toast('请输入网站地址', 'warn'); return; }
    setBusy(true);
    setStatus('连接中…', '');
    fetch('/api/inspect/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_url: url, project_id: state.projectId || undefined })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.detail || ('HTTP ' + r.status)); });
      return r.json();
    }).then(function (d) {
      state.sid = d.sid;
      state.alive = true;
      state.currentUrl = d.url;
      el('ins-url').value = d.url;
      setBusy(false);
      setStatus('● 已连接', 'on');
      ['ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) { el(id).disabled = false; });
      el('ins-end').disabled = false;
      el('ins-debug-btn').disabled = false;
      InsTimeline.reset();
      InsLocator.sessionReady();
      InsLive.start();
      startTimelinePoll();   // 用户手动操作实时刷新时间线
      InsTimeline.toast('会话已建立: ' + (d.title || d.url), 'ok');
      setUrlForSid(d.sid);   // URL 深链: /inspect/{sid}
      refreshHistory();
    }).catch(function (err) {
      setBusy(false);
      setStatus('未连接', '');
      el('ins-error').style.display = 'flex';
      el('ins-error-text').textContent = '页面打开失败: ' + (err.message || err);
      el('ins-empty').style.display = 'none';
    });
  }

  // ---------- 用户手动操作实时时间线轮询（采集脚本 → timeline API） ----------
  var insPollTimer = null;
  var insPollCount = 0;  // 已同步条数（增量追加，避免全量重绘刷新闪烁）
  function startTimelinePoll() {
    stopTimelinePoll();
    insPollCount = 0;
    insPollTimer = setInterval(function () {
      if (!state.sid || !state.alive) return;
      actGet('/api/inspect/session/' + state.sid + '/timeline').then(function (d) {
        var list = d.steps || [];
        var cur = InsTimeline.count();
        if (list.length === cur) return;                       // 无变化不重绘
        if (list.length > cur && cur >= insPollCount) {        // 增量追加新步骤
          for (var i = cur; i < list.length; i++) InsTimeline.addEvent(list[i]);
        } else {                                               // 重置/变短 → 全量
          InsTimeline.load(list, false);
        }
        insPollCount = list.length;
      }).catch(function () { });
    }, 2000);
  }
  function stopTimelinePoll() {
    if (insPollTimer) { clearInterval(insPollTimer); insPollTimer = null; }
  }

  function endSession() {
    if (!state.sid) return;
    act('close').then(function (d) {
      afterClose(closeToast(d));
      refreshHistory();
    }).catch(function (err) {
      // 会话可能已被 GC/替换
      afterClose('会话已结束');
      refreshHistory();
      InsTimeline.toast('结束会话: ' + (err.message || err), 'warn');
    });
    function afterClose(msg) {
      state.alive = false;
      stopTimelinePoll();
      InsLive.stop();
      setStatus('未连接', '');
      el('ins-end').disabled = true;
      ['ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) { id && (el(id).disabled = true); });
      InsLocator.sessionReady();
      InsTimeline.toast(msg, 'ok');
      clearSessionUrl();   // 会话结束 → 回 /inspect 根路径
      refreshHistory();
    }
  }

  /** 结束保存文案：绑定项目的会话已生成脚本/快照（后端 syncRecordingToProject），否则仅时间线 */
  function closeToast(d) {
    var s = d && d.sync;
    if (s && s.projectName) {
      var t = '已保存并生成脚本（' + (s.steps || 0) + ' 步）→ 项目「' + s.projectName + '」';
      if (s.tasksRefreshed > 0) t += '，补齐 ' + s.tasksRefreshed + ' 个任务快照';
      return t;
    }
    return '已结束并保存时间线';
  }

  function adoptAliveSession(sid, steps) {
    // 存活续操: 历史会话浏览器仍在
    state.sid = sid;
    state.alive = true;
    InsTimeline.load(steps, false);
    InsLocator.sessionReady();
    InsLive.start();
    setStatus('● 已连接（续操）', 'on');
    el('ins-end').disabled = false;
    ['ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) { el(id).disabled = false; });
    setUrlForSid(sid);
  }

  function openReadOnly(sid, steps, startUrl) {
    // 只读回放
    state.sid = sid;
    state.alive = false;
    InsTimeline.load(steps, true);
    InsLocator.applyReadOnly();
    InsLive.stop();
    setStatus('📖 只读回放', 'ro');
    el('ins-end').disabled = true;
    ['ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) { el(id).disabled = true; });
    if (startUrl) el('ins-url').value = startUrl;
    InsTimeline.toast('只读回放: ' + steps.length + ' 步', '');
    setUrlForSid(sid);
  }

  // ---------- 状态指示(A3 性能优化: 无轮询) ----------
  // 滚动位置 ← 帧流元数据 scrollOffsetY(InsLive.onFrame 驱动)
  // URL 栏 ← act 响应带回 url(InsLive 调用 updateUrl)
  function updateUrl(url) {
    if (url && url !== state.currentUrl) {
      state.currentUrl = url;
      el('ins-url').value = url;
    }
  }
  function updateScroll(scrollY) {
    if (typeof scrollY !== 'number') return;
    setStatus('● 已连接' + (scrollY > 0 ? ' · 滚动 ' + Math.round(scrollY) + 'px' : ''), 'on');
  }

  // ---------- 左侧历史会话(交互与 index.html 会话列表一致) ----------
  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t * 1000);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function refreshHistory() {
    actGet('/api/inspect/sessions').then(function (items) {
      renderSessList(items || []);
    }).catch(function () { /* ignore */ });
  }

  function renderSessList(list) {
    var box = el('ins-sess-list');
    if (!list.length) {
      box.innerHTML = '<div class="ins-h-empty">暂无历史会话，打开一个网页开始调试</div>';
      el('ins-sess-cnt').textContent = '';
      return;
    }
    el('ins-sess-cnt').textContent = list.length + ' 个';
    box.innerHTML = '';
    list.forEach(function (it) {
      var row = document.createElement('div');
      var active = it.sid === state.sid ? ' active' : '';
      row.className = 'ins-sess-item' + active;
      row.dataset.sid = it.sid;
      var title = it.start_url || '(未知 URL)';
      var esc = function (t) { return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
      row.innerHTML =
        '<div class="t" title="' + esc(title) + '">' + esc(title) + '</div>' +
        '<div class="meta">' + fmtTime(it.updated_at) + ' · ' + (it.step_count || 0) + '步' +
          (it.alive ? '<span class="cnt live">● 存活</span>' : '') + '</div>' +
        '<button class="del" title="删除历史">×</button>';
      row.addEventListener('click', function () { openHistory(it); });
      row.querySelector('.del').addEventListener('click', function (ev) {
        ev.stopPropagation();
        delSession(it);
      });
      box.appendChild(row);
    });
  }

  function delSession(it) {
    if (!confirm('确认删除该会话历史？')) return;
    fetch('/api/inspect/sessions/' + it.sid, { method: 'DELETE' }).then(function () {
      if (it.sid === state.sid) {
        // 删除的是当前会话: 清空状态并回根 URL(与 index.html delSession 语义一致)
        state.alive = false;
        InsLive.stop();
          InsTimeline.reset();
        InsLocator.applyReadOnly();
        setStatus('未连接', '');
        el('ins-end').disabled = true;
        ['ins-back', 'ins-fwd', 'ins-reload'].forEach(function (id) { el(id).disabled = true; });
        clearSessionUrl();
      }
      refreshHistory();
      InsTimeline.toast('已删除历史会话', 'ok');
    }).catch(function (err) {
      InsTimeline.toast('删除失败: ' + (err.message || err), 'err');
    });
  }

  function openHistory(item) {
    actGet('/api/inspect/session/' + item.sid + '/timeline').then(function (d) {
      state.projectId = d.project_id || null;  // 会话归属项目（调试跳转带上下文）
      el('ins-debug-btn').disabled = false;    // 有会话即可进脚本调试（含只读回放）
      if (d.alive) {
        adoptAliveSession(item.sid, d.steps || []);
        InsTimeline.toast('已接续存活会话', 'ok');
      } else {
        openReadOnly(item.sid, d.steps || [], d.start_url);
      }
      refreshHistory();  // 更新 active 高亮
    }).catch(function (err) {
      InsTimeline.toast('打开历史失败: ' + (err.message || err), 'err');
    });
  }

  /** 脚本调试：把当前会话生成的脚本装入调试工作台（嵌入=通知父页 SPA 跳转；独立=新开管理台） */
  function goSessionDebug() {
    if (!state.sid) return;
    var payload = { type: 'autotest.sessionDebug', sid: state.sid, projectId: state.projectId || '' };
    try {
      if (window.self !== window.top && window.parent) {
        window.parent.postMessage(payload, '*');
        InsTimeline.toast('已进入脚本调试工作台', 'ok');
        return;
      }
    } catch (e) { /* 跨域受限走新开 */ }
    window.open('/app#/debug?sessionId=' + encodeURIComponent(state.sid) +
      (state.projectId ? '&projectId=' + encodeURIComponent(state.projectId) : ''));
  }

  // ---------- URL 深链同步(与 index.html /session/{sid} 同机制) ----------
  function sidFromUrl() {
    var m = location.pathname.match(/^\/inspect\/([^\/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function projectIdFromUrl() {
    try { return new URLSearchParams(location.search).get('projectId') || null; } catch (e) { return null; }
  }
  function setUrlForSid(sid) {
    // URL 带会话 id + 工程 id（工程上下文随深链恢复，脚本调试跳转不丢归属）
    var target = '/inspect/' + encodeURIComponent(sid) +
      (state.projectId ? '?projectId=' + encodeURIComponent(state.projectId) : '');
    if (location.pathname + location.search !== target) history.pushState({ sid: sid }, '', target);
  }
  function clearSessionUrl() {
    if (location.pathname !== '/inspect') history.pushState({}, '', '/inspect');
  }
  function initFromUrl() {
    var sid = sidFromUrl();
    var pid = projectIdFromUrl();
    if (pid && !state.projectId) state.projectId = pid;  // 深链工程上下文（新建会话亦绑定该工程）
    if (sid) openHistory({ sid: sid });
    refreshHistory();
  }

  // ---------- Tab 切换 ----------
  function switchTab(name) {
    document.querySelectorAll('.ins-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.ins-pane').forEach(function (p) {
      p.classList.toggle('active', p.id === 'ins-pane-' + name);
    });
  }

  // ---------- 分隔条拖拽(A3) ----------
  function initDivider() {
    var dv = el('ins-divider'), side = el('ins-side');
    dv.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startX = e.clientX, startW = side.getBoundingClientRect().width;
      document.body.classList.add('ins-resizing');
      dv.classList.add('active');
      function onMove(ev) {
        var w = startW - (ev.clientX - startX);
        w = Math.max(320, Math.min(760, w));
        side.style.flexBasis = w + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('ins-resizing');
        dv.classList.remove('active');
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // 左侧历史会话栏折叠(默认收起, localStorage 持久化)
  function applySessionsCollapsed() {
    var c = localStorage.getItem('ins.sessionsCollapsed');
    var collapsed = (c === null) ? true : (c === '1');  // 默认收起
    el('ins-sessions').classList.toggle('collapsed', collapsed);
  }
  function toggleSessionsCollapsed() {
    var s = el('ins-sessions');
    var collapsed = !s.classList.contains('collapsed');
    s.classList.toggle('collapsed', collapsed);
    localStorage.setItem('ins.sessionsCollapsed', collapsed ? '1' : '0');
    if (!collapsed) refreshHistory();
  }

  // 左侧历史会话栏宽度拖拽
  function initSessDivider() {
    var dv = el('ins-sess-divider'), pane = el('ins-sessions');
    if (!dv || !pane) return;
    dv.addEventListener('mousedown', function (e) {
      e.preventDefault();
      // 收起态下拖拽 = 先展开
      if (pane.classList.contains('collapsed')) {
        pane.classList.remove('collapsed');
        localStorage.setItem('ins.sessionsCollapsed', '0');
      }
      var startX = e.clientX, startW = pane.getBoundingClientRect().width;
      document.body.classList.add('ins-resizing');
      dv.classList.add('active');
      function onMove(ev) {
        var w = startW + (ev.clientX - startX);
        w = Math.max(190, Math.min(380, w));
        pane.style.flexBasis = w + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('ins-resizing');
        dv.classList.remove('active');
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 快捷键(A1: Ctrl+Enter 执行; Esc 解除选中; ←→ 翻看大图) ----------
  function initKeys() {
    document.addEventListener('keydown', function (e) {
      if (global.InsTimeline.viewerOpen()) {
        if (e.key === 'ArrowLeft') { global.InsTimeline.viewerNav(-1); return; }
        if (e.key === 'ArrowRight') { global.InsTimeline.viewerNav(1); return; }
      }
      if (e.key === 'Escape') {
        if (el('ins-viewer').classList.contains('show')) {
          el('ins-viewer').classList.remove('show');
          return;
        }
        global.InsLocator.clearSelection();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        global.InsLocator.execute();
      }
    });
  }

  // ---------- 导航按钮 ----------
  function nav(to) {
    if (!state.alive) return;
    act('navigate', { to: to }).then(function (r) {
      state.currentUrl = r.url;
      el('ins-url').value = r.url;
    }).catch(function (err) { InsTimeline.toast('导航失败: ' + (err.message || err), 'err'); });
  }

  // ---------- bootstrap ----------
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    el('ins-open').addEventListener('click', openSession);
    el('ins-debug-btn').addEventListener('click', goSessionDebug);
    el('ins-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') openSession();
    });
    el('ins-back').addEventListener('click', function () { nav('back'); });
    el('ins-fwd').addEventListener('click', function () { nav('forward'); });
    el('ins-reload').addEventListener('click', function () { nav('reload'); });
    el('ins-end').addEventListener('click', endSession);
    el('ins-retry').addEventListener('click', openSession);
    el('ins-sess-collapse').addEventListener('click', toggleSessionsCollapsed);
    el('ins-sess-expand').addEventListener('click', toggleSessionsCollapsed);
    applySessionsCollapsed();
    if (global.InsWS) global.InsWS.setAliveCheck(function () { return state.alive; });
    document.querySelectorAll('.ins-tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    el('ins-export-json').addEventListener('click', function () { InsTimeline.exportAs('json'); });
    el('ins-export-js').addEventListener('click', function () { InsTimeline.exportAs('js'); });
    el('ins-export-py').addEventListener('click', function () { InsTimeline.exportAs('py'); });
    initDivider();
    initSessDivider();
    initKeys();
    setStatus('未连接', '');
    // URL 深链 + 历史列表 + popstate(前进后退)
    initFromUrl();
    window.addEventListener('popstate', function () {
      var sid = sidFromUrl();
      if (sid && sid !== state.sid) openHistory({ sid: sid });
      else if (!sid && state.sid) { /* 根路径: 保持当前会话, 仅 URL 变化 */ }
    });
    setInterval(refreshHistory, 30000);  // 30s 轻量刷新(反映存活状态变化)
  }

  global.INSAPP = {
    get sid() { return state.sid; },
    get alive() { return state.alive; },
    act: act,
    actGet: actGet,
    switchTab: switchTab,
    updateUrl: updateUrl,
    updateScroll: updateScroll,
    toast: function (m, t) { InsTimeline.toast(m, t); }
  };

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();

  // ---------- 管理台嵌入预填（/app 卡片「启动录制」跳转时接收 URL + 项目绑定） ----------
  // 注意：必须在主闭包内（state 不可外部访问）
  (function () {
    try {
      // 嵌入场景：读取 sessionStorage 预填
      if (window.self !== window.top) {
        var raw = sessionStorage.getItem('autotest.prefill');
        if (raw) {
          var pf = JSON.parse(raw);
          var u = document.getElementById('ins-url');
          if (u && pf.url) { u.value = pf.url; }
          if (pf.projectId) { state.projectId = pf.projectId; }  // 录制会话与项目绑定
          sessionStorage.removeItem('autotest.prefill');
        }
      }
    } catch (e) { /* 访问受限忽略 */ }
    // postMessage 预填（管理台跳转后延迟送达）
    window.addEventListener('message', function (ev) {
      if (!ev.data || ev.data.type !== 'autotest.prefill') return;
      try {
        var u = document.getElementById('ins-url');
        if (u && ev.data.url) u.value = ev.data.url;
        if (ev.data.projectId) state.projectId = ev.data.projectId;
      } catch (e) { /* pass */ }
    });
  })();
})(window);
