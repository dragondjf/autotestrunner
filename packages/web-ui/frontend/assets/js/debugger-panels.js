  // ---------- Elements ----------
  function dbgLoadElements() {
    var tbody = dbgEl('dbg-el-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="dbg-td-empty">加载中…</td></tr>';
    dbgInspect('clickable').then(function (r) {
      if (!r.ok) { dbgRenderElError(r.error || '加载失败'); return; }
      dbgElements = r.elements || [];
      dbgEl('dbg-el-count').textContent = '共 ' + (r.count || 0) + ' 个';
      dbgRefreshUrl(r.url);
      dbgRenderElements();
    }).catch(function (e) { dbgRenderElError(e.message); });
  }
  function dbgRenderElError(msg) {
    dbgElements = [];
    dbgEl('dbg-el-tbody').innerHTML = '<tr><td colspan="5" class="dbg-td-empty">⚠ ' + escapeHtml(msg || '') + '</td></tr>';
  }
  function dbgRenderElements() {
    var filter = (dbgEl('dbg-el-filter').value || '').toLowerCase().trim();
    var list = dbgElements.filter(function (el) {
      if (!filter) return true;
      return ((el.tag || '') + ' ' + (el.text || '') + ' ' + (el.best_locator || '') + ' ' +
        (el.id || '') + ' ' + (el.class || '')).toLowerCase().indexOf(filter) >= 0;
    });
    var tbody = dbgEl('dbg-el-tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="dbg-td-empty">' +
        (dbgElements.length ? '无匹配元素' : '点击「刷新」加载当前页面的可交互元素') + '</td></tr>';
      return;
    }
    tbody.innerHTML = list.slice(0, 500).map(function (el, i) {
      var loc = el.best_locator || '';
      return '<tr>' +
        '<td class="dbg-hint">' + (i + 1) + '</td>' +
        '<td><code>' + escapeHtml(el.tag || '') + '</code></td>' +
        '<td class="dbg-el-text" title="' + escapeHtml(el.text || '') + '">' + escapeHtml(el.text || '') + '</td>' +
        '<td><span class="dbg-loc-code" title="点击填入 Locator 输入框" data-loc="' + escapeHtml(loc) + '" data-act="use">' + escapeHtml(loc) + '</span></td>' +
        '<td style="white-space:nowrap">' +
          '<button class="dbg-mini" title="在页面上高亮" data-loc="' + escapeHtml(loc) + '" data-act="highlight">👁</button>' +
          '<button class="dbg-mini" title="复制定位器" data-loc="' + escapeHtml(loc) + '" data-act="copy">📋</button>' +
        '</td></tr>';
    }).join('');
  }
  // 表格事件委托(避免内联 onclick 的引号转义问题)
  (function initElTable() {
    var tbody = dbgEl('dbg-el-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', function (e) {
      var t = e.target.closest('[data-loc]');
      if (!t) return;
      var loc = t.getAttribute('data-loc') || '';
      var act = t.getAttribute('data-act');
      if (act === 'highlight') dbgHighlightRow(loc);
      else if (act === 'copy') dbgCopy(loc);
      else dbgUseLocator(loc);
    });
  })();
  function dbgCopy(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) {}
      document.body.removeChild(ta);
    }
  }

  // ---------- Locator ----------
  function dbgUseLocator(loc) {
    if (!loc) return;
    dbgSwitchTab('locator');
    dbgEl('dbg-loc-input').value = loc;
    dbgEl('dbg-loc-input').focus();
    dbgPushLocHistory(loc);
  }
  function dbgHighlightRow(loc) {
    if (!loc) return;
    dbgUseLocator(loc);
    setTimeout(dbgHighlight, 80);
  }
  function dbgPushLocHistory(loc) {
    if (!loc) return;
    dbgLocHistory = [loc].concat(dbgLocHistory.filter(function (x) { return x !== loc; })).slice(0, 10);
    var sel = dbgEl('dbg-loc-history');
    sel.innerHTML = '<option value="">最近…</option>' + dbgLocHistory.map(function (l) {
      return '<option value="' + escapeHtml(l) + '">' + escapeHtml(l) + '</option>';
    }).join('');
  }
  function dbgProbe() {
    var loc = dbgEl('dbg-loc-input').value.trim();
    if (!loc) return;
    dbgPushLocHistory(loc);
    var out = dbgEl('dbg-loc-result');
    out.innerHTML = '<div class="dbg-empty">探测中…</div>';
    dbgInspect('probe', { locator: loc }).then(function (r) {
      if (!r.ok) {
        out.innerHTML = '<div class="dbg-card"><div class="dbg-kv"><span class="err">⚠ ' + escapeHtml(r.error || '探测失败') + '</span></div></div>';
        return;
      }
      var html = '<div class="dbg-card"><div class="dbg-kv">' +
        '<span><b>locator</b> <code>' + escapeHtml(r.locator) + '</code></span>' +
        '<span><b>匹配</b> ' + r.count + ' 个</span>' +
        '<span><b>首个可见</b> ' + (r.visible ? '是' : '否') + '</span>';
      if (r.first && r.first.tag) {
        html += '<span><b>元素</b> <code>&lt;' + escapeHtml(r.first.tag) +
          (r.first.id ? '#' + escapeHtml(r.first.id) : '') + '&gt;</code></span>';
        if (r.first.text) html += '<span><b>文本</b> ' + escapeHtml(r.first.text) + '</span>';
        if (r.first.box) html += '<span><b>位置</b> (' + Math.round(r.first.box.x) + ', ' + Math.round(r.first.box.y) + ') ' +
          Math.round(r.first.box.width) + '×' + Math.round(r.first.box.height) + '</span>';
      }
      if (!r.count) html += '<span class="err">未匹配到任何元素，请检查定位器语法</span>';
      html += '</div></div>';
      out.innerHTML = html;
    }).catch(function (e) {
      out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(e.message) + '</div>';
    });
  }
  function dbgHighlight() {
    var loc = dbgEl('dbg-loc-input').value.trim();
    if (!loc) return;
    dbgPushLocHistory(loc);
    var out = dbgEl('dbg-loc-result');
    out.innerHTML = '<div class="dbg-empty">高亮中…（页面已描红框，8 秒后自动消除）</div>';
    dbgInspect('highlight', { locator: loc }).then(function (r) {
      if (!r.ok || !r.count) {
        out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml((r && (r.error || '未匹配到元素')) || '高亮失败') + '</div>';
        return;
      }
      var html = '<div class="dbg-card"><div class="dbg-kv">' +
        '<span><b>locator</b> <code>' + escapeHtml(r.locator) + '</code></span>' +
        '<span><b>匹配</b> ' + r.count + ' 个</span></div>';
      if (r.screenshot) {
        html += '<div class="dbg-shot-wrap"><img src="' + r.screenshot + '" data-cap="高亮: ' + escapeHtml(loc) + '"' +
          ' onclick="openViewerAt(-1, this.src, this.getAttribute(\'data-cap\'))"/></div>';
      }
      html += '</div>';
      out.innerHTML = html;
    }).catch(function (e) {
      out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(e.message) + '</div>';
    });
  }

  // ---------- Snapshot ----------
  function dbgScreenshot(full) {
    var out = dbgEl('dbg-snap-result');
    out.innerHTML = '<div class="dbg-empty">截图中…</div>';
    dbgInspect('screenshot', { full_page: !!full }).then(function (r) {
      if (!r.ok || !r.screenshot) {
        out.innerHTML = '<div class="dbg-card">⚠ 截图失败: ' + escapeHtml((r && r.error) || '未知错误') + '</div>';
        return;
      }
      dbgRefreshUrl(r.url);
      var cap = (full ? '全页' : '视口') + '截图 ' + new Date().toLocaleTimeString();
      dbgLastShot = { screenshot: r.screenshot, cap: cap };
      out.innerHTML = '<div class="dbg-card"><div class="dbg-kv">' +
        '<span><b>类型</b> ' + (full ? '全页' : '视口') + '</span>' +
        '<span><b>URL</b> ' + escapeHtml(r.url || '') + '</span></div>' +
        '<div class="dbg-shot-wrap"><img src="' + r.screenshot + '" data-cap="' + escapeHtml(cap) + '"' +
        ' onclick="openViewerAt(-1, this.src, this.getAttribute(\'data-cap\'))"/></div>' +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<button class="dbg-btn" onclick="dbgPinShot()">📌 插入时间线</button>' +
          '<button class="dbg-btn" onclick="dbgDownloadShot()">⬇ 下载 PNG</button>' +
        '</div></div>';
    }).catch(function (e) {
      out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(e.message) + '</div>';
    });
  }
  function dbgPinShot() {
    if (!dbgLastShot || !sessionId) return;
    dbgInspect('pin', {
      subtype: 'screenshot',
      screenshot: dbgLastShot.screenshot,
      desc: dbgLastShot.cap
    }).then(function (r) {
      if (r.ok && r.event) {
        addStepEvent(r.event);
        dbgActionsLog('📌 已插入时间线: ' + dbgLastShot.cap, 'sys');
      }
    }).catch(function (e) { dbgActionsLog('⚠ 插入失败: ' + e.message, 'err'); });
  }
  function dbgDownloadShot() {
    if (!dbgLastShot) return;
    var a = document.createElement('a');
    a.href = dbgLastShot.screenshot;
    a.download = 'debug-' + Date.now() + '.png';
    a.click();
  }
  function dbgAria() {
    var out = dbgEl('dbg-snap-result');
    out.innerHTML = '<div class="dbg-empty">Aria 树生成中…</div>';
    dbgInspect('aria').then(function (r) {
      if (!r.ok) {
        out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(r.error || '生成失败') + '</div>';
        return;
      }
      dbgRefreshUrl(r.url);
      out.innerHTML = '<div class="dbg-card"><div class="dbg-kv">' +
        '<span><b>快照类型</b> ' + escapeHtml(r.snapshot_type || '') + '</span>' +
        '<span><b>说明</b> 这就是 LLM 看到的页面语义结构</span></div>' +
        '<pre class="dbg-pre">' + escapeHtml(r.snapshot || '') + '</pre></div>';
    }).catch(function (e) {
      out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(e.message) + '</div>';
    });
  }
  function dbgPageInfo() {
    var out = dbgEl('dbg-snap-result');
    out.innerHTML = '<div class="dbg-empty">读取中…</div>';
    dbgInspect('pageinfo').then(function (r) {
      if (!r.ok) {
        out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(r.error || '读取失败') + '</div>';
        return;
      }
      dbgRefreshUrl(r.url);
      out.innerHTML = '<div class="dbg-card"><div class="dbg-kv">' +
        '<span><b>URL</b> <code>' + escapeHtml(r.url || '') + '</code></span>' +
        '<span><b>标题</b> ' + escapeHtml(r.title || '') + '</span>' +
        '<span><b>视口</b> ' + (r.viewport ? (r.viewport.width + '×' + r.viewport.height) : '-') + '</span>' +
        '<span><b>frames</b> ' + (r.frames || 1) + '</span></div></div>';
    }).catch(function (e) {
      out.innerHTML = '<div class="dbg-card">⚠ ' + escapeHtml(e.message) + '</div>';
    });
  }

  // ---------- Actions ----------
  function dbgNav(nav) {
    dbgActionsLog('导航: ' + nav + ' …');
    dbgInspect('navigate', { nav: nav }).then(function (r) {
      if (r.ok) { dbgActionsLog('✓ 已导航 -> ' + (r.url || '')); dbgRefreshUrl(r.url); dbgElements = []; }
      else dbgActionsLog('✗ ' + (r.error || '失败'), 'err');
    }).catch(function (e) { dbgActionsLog('✗ ' + e.message, 'err'); });
  }
  function dbgGoto() {
    var u = dbgEl('dbg-goto-url').value.trim();
    if (!u) return;
    dbgActionsLog('前往: ' + u + ' …');
    dbgInspect('goto', { url: u }).then(function (r) {
      if (r.ok) { dbgActionsLog('✓ 已打开 -> ' + (r.url || '')); dbgRefreshUrl(r.url); dbgElements = []; }
      else dbgActionsLog('✗ ' + (r.error || '失败'), 'err');
    }).catch(function (e) { dbgActionsLog('✗ ' + e.message, 'err'); });
  }
  function dbgScroll(dir) {
    dbgInspect('scroll', { direction: dir }).then(function (r) {
      if (r.ok) dbgActionsLog('✓ 滚动 ' + dir);
      else dbgActionsLog('✗ ' + (r.error || '失败'), 'err');
    }).catch(function (e) { dbgActionsLog('✗ ' + e.message, 'err'); });
  }
  function dbgRunStep() {
    var method = dbgEl('dbg-step-method').value;
    var locator = dbgEl('dbg-step-locator').value.trim();
    var value = dbgEl('dbg-step-value').value;
    if (!locator && !value && ['click_ele', 'double_click_ele', 'fill_value', 'type_value',
        'hover', 'select_option', 'scroll_to_element', 'wait_for_element'].indexOf(method) >= 0) {
      dbgActionsLog('✗ 该方法需要 locator', 'err');
      return;
    }
    dbgActionsLog('▶ ' + method + (locator ? ' [' + locator + ']' : '') + (value ? ' = ' + value : '') + ' …');
    dbgInspect('step', { method: method, locator: locator, value: value }).then(function (r) {
      if (r.ok) {
        dbgActionsLog('✓ 执行成功');
        if (r.warning) dbgActionsLog('⚠ ' + r.warning, 'err');
      }
      else dbgActionsLog('✗ ' + (r.error || '执行失败'), 'err');
    }).catch(function (e) { dbgActionsLog('✗ ' + e.message, 'err'); });
  }
  function dbgActionsLog(msg, cls) {
    var log = dbgEl('dbg-actions-log');
    if (!log) return;
    var empty = log.querySelector('.dbg-empty');
    if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'dbg-log-line ' + (cls || 'sys');
    div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- Console ----------
  function dbgConsoleKeydown(e) {
    var input = dbgEl('dbg-js-input');
    if (e.key === 'Enter') { dbgEval(); return; }
    if (e.key === 'ArrowUp') {
      if (!dbgJsHistory.length) return;
      dbgJsHistIdx = Math.min(dbgJsHistIdx + 1, dbgJsHistory.length - 1);
      input.value = dbgJsHistory[dbgJsHistIdx];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (dbgJsHistIdx <= 0) { dbgJsHistIdx = -1; input.value = ''; return; }
      dbgJsHistIdx -= 1;
      input.value = dbgJsHistory[dbgJsHistIdx];
      e.preventDefault();
    }
  }
  function dbgEval() {
    var input = dbgEl('dbg-js-input');
    var js = input.value.trim();
    if (!js) return;
    dbgJsHistory.unshift(js);
    dbgJsHistIdx = -1;
    input.value = '';
    dbgConsoleAppend('> ' + js, 'in');
    dbgInspect('evaluate', { js: js }).then(function (r) {
      if (r.ok) {
        var val = r.result;
        var text = (val === undefined) ? 'undefined'
          : (val === null) ? 'null'
          : (typeof val === 'object') ? JSON.stringify(val, null, 2)
          : String(val);
        dbgConsoleAppend(text, 'out');
      } else {
        dbgConsoleAppend('⚠ ' + (r.error || '执行失败'), 'err');
      }
    }).catch(function (e) { dbgConsoleAppend('⚠ ' + e.message, 'err'); });
  }
  function dbgConsoleAppend(msg, cls) {
    var log = dbgEl('dbg-console-out');
    var empty = log.querySelector('.dbg-empty');
    if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'dbg-log-line ' + (cls || 'out');
    div.textContent = msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  var dbgJsHistory = [];
  var dbgJsHistIdx = -1;

  // ---------- 元素点选模式 ----------
  function dbgPickToggle() {
    if (DBG_PICKING) { dbgPickStop(); return; }
    dbgInspect('pick_start').then(function (r) {
      if (!r.ok) { alert(r.error || '进入点选模式失败'); return; }
      DBG_PICKING = true;
      dbgEl('dbg-pick-banner').hidden = false;
      dbgEl('dbg-pick-btn').textContent = '⏹ 退出点选';
      if (dbgPickTimer) clearInterval(dbgPickTimer);
      dbgPickTimer = setInterval(dbgPickPoll, 1000);
      dbgSwitchTab('elements');
    }).catch(function (e) { alert(e.message); });
  }
  function dbgPickPoll() {
    if (!DBG_PICKING || !sessionId) return;
    dbgInspect('pick_poll').then(function (r) {
      if (!r.active) { dbgPickStopInternal(); return; }
      var picked = r.picked || [];
      for (var i = 0; i < picked.length; i++) dbgOnPicked(picked[i]);
    }).catch(function () { /* 会话忙或页面跳转,下轮重试 */ });
  }
  function dbgOnPicked(el) {
    if (!el || !el.tag) return;
    var locs = [];
    if (el.selector) locs.push('css=' + el.selector);
    if (el.id) locs.push('css=#' + el.id);
    if (el.role && el.text) locs.push('get_by_role=' + el.role + ', ' + el.text);
    if (el.text) locs.push('text=' + el.text);
    dbgElements.unshift({
      tag: el.tag, id: el.id, class: el.class, text: el.text, role: el.role,
      name: el.name, type: el.type, placeholder: el.placeholder,
      aria_label: el.aria_label, title: el.title,
      selector: el.selector ? ('css=' + el.selector) : '',
      best_locator: locs[0] || '',
      candidates: locs.slice(0, 5)
    });
    dbgEl('dbg-el-count').textContent = '共 ' + dbgElements.length + ' 个（含点选）';
    dbgRenderElements();
    dbgActionsLog('🎯 点选: <' + el.tag + (el.id ? '#' + el.id : '') + '> ' + (el.text || ''), 'sys');
  }
  function dbgPickStop() {
    if (!DBG_PICKING) return;
    var p = sessionId ? dbgInspect('pick_stop').catch(function () {}) : Promise.resolve();
    p.then(dbgPickStopInternal);
  }
  function dbgPickStopInternal() {
    DBG_PICKING = false;
    if (dbgPickTimer) { clearInterval(dbgPickTimer); dbgPickTimer = null; }
    var b = dbgEl('dbg-pick-banner'); if (b) b.hidden = true;
    var btn = dbgEl('dbg-pick-btn'); if (btn) btn.textContent = '🎯 点选元素';
  }
