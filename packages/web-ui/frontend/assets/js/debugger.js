  /* ==================================================================
   * 页面调试器 (F12 式) -- 零 LLM 直操作会话 Playwright 实例
   * ================================================================== */
  var DBG_OPEN = false;
  var DBG_TAB = localStorage.getItem('dbg.tab') || 'elements';
  var DBG_H = parseInt(localStorage.getItem('dbg.height') || '0', 10) || Math.round(window.innerHeight * 0.45);
  var DBG_MAX = false;
  var DBG_PICKING = false;
  var dbgPickTimer = null;
  var dbgElements = [];      // Elements tab 缓存
  var dbgLastShot = null;    // 最近一次截图(供 pin/download)
  var dbgLocHistory = [];

  function dbgEl(id) { return document.getElementById(id); }

  function refreshDbgEntry() {
    var btn = dbgEl('dbg-toggle-btn');
    if (!btn) return;
    btn.disabled = !sessionId;
    btn.title = sessionId ? '页面调试器（Esc 开关）——直接操作当前会话的浏览器，无需 LLM' : '先发起一次 Agent 执行，建立浏览器会话后可用';
  }

  // ---------- 开关 / 高度 / Esc ----------
  function toggleDebugger(force) {
    var open = (typeof force === 'boolean') ? force : !DBG_OPEN;
    if (open && !sessionId) return;
    DBG_OPEN = open;
    dbgEl('dbg').classList.toggle('open', open);
    if (open) {
      dbgApplyHeight();
      dbgSwitchTab(DBG_TAB);
      dbgRefreshUrl();
      if (!dbgElements.length && DBG_TAB === 'elements') dbgLoadElements();
      dbgLiveStart();
    } else {
      dbgPickStopInternal();
      dbgLiveStop();
    }
  }
  function dbgClose() { toggleDebugger(false); }
  function dbgApplyHeight() {
    var maxH = Math.max(200, window.innerHeight - 160);
    var h = DBG_MAX ? Math.min(maxH, Math.round(window.innerHeight * 0.85)) : Math.min(maxH, DBG_H);
    dbgEl('dbg').style.height = h + 'px';
  }
  function dbgToggleMax() {
    DBG_MAX = !DBG_MAX;
    dbgApplyHeight();
    dbgEl('dbg-max-btn').textContent = DBG_MAX ? '▢' : '▣';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !DBG_OPEN) return;
    if (DBG_PICKING) { dbgPickStop(); e.preventDefault(); return; }
    toggleDebugger(false);
  });
  window.addEventListener('resize', function () { if (DBG_OPEN) dbgApplyHeight(); });
  (function initDbgResizer() {
    var rz = dbgEl('dbg-resizer');
    if (!rz) return;
    rz.addEventListener('mousedown', function (e) {
      var startY = e.clientY, startH = dbgEl('dbg').offsetHeight;
      rz.classList.add('active');
      function onMove(ev) {
        var h = startH + (startY - ev.clientY);
        var maxH = Math.max(200, window.innerHeight - 160);  // 给主内容保留最小高度
        h = Math.max(Math.round(window.innerHeight * 0.25), Math.min(maxH, h));
        DBG_H = h; DBG_MAX = false;
        dbgEl('dbg-max-btn').textContent = '▣';
        dbgEl('dbg').style.height = h + 'px';
      }
      function onUp() {
        rz.classList.remove('active');
        localStorage.setItem('dbg.height', String(DBG_H));
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  })();

  // ---------- Tab 切换 ----------
  function dbgSwitchTab(tab) {
    DBG_TAB = tab;
    localStorage.setItem('dbg.tab', tab);
    ['elements', 'locator', 'snapshot', 'actions', 'console'].forEach(function (t) {
      var b = dbgEl('dbg-tab-' + t), p = dbgEl('dbg-pane-' + t);
      if (b) b.classList.toggle('active', t === tab);
      if (p) p.classList.toggle('active', t === tab);
    });
  }

  // ---------- 通用请求 ----------
  function dbgInspect(action, params) {
    return fetch('/api/agent/session/' + encodeURIComponent(sessionId) + '/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, params || {}))
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.detail || ('HTTP ' + r.status));
        });
      }
      return r.json();
    });
  }
  function dbgRefreshUrl(url) {
    var el = dbgEl('dbg-url');
    if (url) { el.textContent = url; el.title = url; return; }
    if (!sessionId || !DBG_OPEN) return;
    dbgInspect('pageinfo').then(function (r) {
      if (r.ok) { el.textContent = r.url || ''; el.title = r.url || ''; }
    }).catch(function () {});
  }
  // ---------- 会话生命周期 ----------
  function dbgOnSessionGone() {
    dbgPickStopInternal();
    dbgElements = [];
    dbgLastShot = null;
    if (DBG_OPEN) toggleDebugger(false);
    refreshDbgEntry();
  }
  refreshDbgEntry();
