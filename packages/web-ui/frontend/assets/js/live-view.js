  // ---------- 实时视图（右侧） ----------
  var dbgLivePaused = false;

  var dbgLiveEs = null;
  var dbgLiveRetryTimer = null;

  function dbgLiveStart() {
    if (dbgLiveEs) return;
    if (!sessionId) return;
    dbgLivePaused = false;
    var es = new EventSource('/api/agent/session/' + encodeURIComponent(sessionId) + '/live');
    dbgLiveEs = es;
    es.addEventListener('frame', function (ev) {
      if (dbgLivePaused) return;
      try { dbgLiveOnFrame(JSON.parse(ev.data)); } catch (e) {}
    });
    es.onerror = function () {
      dbgLiveStop();
      // 自动重连：3 秒后若调试器仍打开且未暂停则重新连接
      var retryTimer = setTimeout(function () {
        if (DBG_OPEN && !dbgLivePaused && sessionId) dbgLiveStart();
      }, 3000);
      dbgLiveRetryTimer = retryTimer;
    };
  }
  function dbgLiveStop() {
    if (dbgLiveRetryTimer) { clearTimeout(dbgLiveRetryTimer); dbgLiveRetryTimer = null; }
    if (dbgLiveEs) { dbgLiveEs.close(); dbgLiveEs = null; }
  }
  function dbgLiveOnFrame(d) {
    if (!d || !d.img) return;
    var img = dbgEl('dbg-live-img');
    img.src = d.img;
    img.style.display = 'block';
    dbgEl('dbg-live-empty').style.display = 'none';
    dbgEl('dbg-live-dot').classList.remove('paused');
    // 同步更新全屏视图（如果已打开）
    var fs = dbgEl('dbg-live-fs');
    if (fs && fs.classList.contains('show')) {
      dbgEl('dbg-live-fs-img').src = d.img;
    }
  }
  var dbgLiveHoverT = 0;
  var dbgLiveHoverEl = null;

  function dbgLiveClick(e) {
    dbgInspect('click_at', dbgLiveXY(e)).then(function (r) {
      var el = (r && r.ok && r.element) || {};
      dbgActionsLog(r && r.ok
        ? '✓ Live 点击 <' + el.tag + (el.id ? '#' + el.id : '') + '>' +
          (el.best_locator ? ' [' + el.best_locator + ']' : '')
        : '✗ Live 点击失败: ' + ((r && r.error) || '无元素'), r && r.ok ? 'sys' : 'err');
    }).catch(function (err) { dbgActionsLog('✗ ' + err.message, 'err'); });
  }
  (function initLiveImgEvents() {
    var img = document.getElementById('dbg-live-img');
    if (!img) return;
    img.addEventListener('mousemove', dbgLiveHover);
    img.addEventListener('click', function (e) { e.preventDefault(); dbgLiveClick(e); });
    // 全屏图片也绑定相同事件（坐标自动换算，因 naturalWidth 独立于显示尺寸）
    var fsImg = document.getElementById('dbg-live-fs-img');
    if (fsImg) {
      fsImg.addEventListener('mousemove', dbgLiveHover);
      fsImg.addEventListener('click', function (e) { e.preventDefault(); dbgLiveClick(e); });
    }
  })();

  function dbgLiveHover(e) {
    var now = Date.now();
    if (now - dbgLiveHoverT < 120) return;
    dbgLiveHoverT = now;
    dbgInspect('hit_test', dbgLiveXY(e)).then(function (r) {
      var el = r && r.ok && r.element;
      dbgLiveHoverEl = el || null;
      var text = el
        ? el.tag + (el.id ? '#' + el.id : '') +
          (el.text ? ' "' + el.text.slice(0, 24) + '"' : '') +
          (el.best_locator ? ' | ' + el.best_locator : '')
        : '';
      dbgEl('dbg-live-info').textContent = text;
      dbgEl('dbg-live-fs-bar').textContent = text;
    }).catch(function () {});
  }
  function dbgLiveXY(e) {
    var img = e.target;
    var r = img.getBoundingClientRect();
    var sx = img.naturalWidth / r.width, sy = img.naturalHeight / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }
  function dbgLiveToggle() {
    dbgLivePaused = !dbgLivePaused;
    var btn = dbgEl('dbg-live-toggle-btn');
    var dot = dbgEl('dbg-live-dot');
    if (dbgLivePaused) {
      btn.textContent = '▶ 继续';
      dot.classList.add('paused');
    } else {
      btn.textContent = '⏸ 暂停';
      dot.classList.remove('paused');
      dbgLiveStart();
    }
  }
  function dbgLiveFullscreen() {
    var img = dbgEl('dbg-live-img');
    if (!img.src || img.style.display === 'none') return;
    dbgEl('dbg-live-fs-img').src = img.src;
    dbgEl('dbg-live-fs-bar').textContent = dbgEl('dbg-live-info').textContent || '';
    dbgEl('dbg-live-fs').classList.add('show');
  }
  function dbgLiveCloseFs() {
    dbgEl('dbg-live-fs').classList.remove('show');
  }
