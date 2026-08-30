/**
 * inspect-locator.js — 检视面板状态机
 * IDLE → PREVIEWING(hover刷新元素信息) → SELECTED(锁定: 候选定位器+动作配置+执行)
 * 不需要定位器的动作(open_url/refresh/go_back/wait_for_time/wait_for_load/execute_script/
 * scroll_to_height/wait_for_url_contains)可在无选中状态下直接执行。
 */
(function (global) {
  'use strict';

  var selected = null;       // 锁定的元素信息(含 candidates)
  var chosenLocator = '';    // 当前选中的候选定位器
  var actionGroups = [];     // /api/inspect/actions 分组配置
  var NEED_VALUE = {};       // method -> value placeholder
  var NO_LOCATOR = new Set([
    'open_url', 'refresh', 'go_back', 'wait_for_time', 'wait_for_load',
    'execute_script', 'scroll_to_height', 'wait_for_url_contains'
  ]);

  function el(id) { return document.getElementById(id); }
  function alive() { return !!(global.INSAPP && global.INSAPP.alive); }
  function readOnly() { return global.InsTimeline.isReadOnly(); }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- 动作下拉 ----------
  function loadActions() {
    return global.INSAPP.actGet('/api/inspect/actions').then(function (groups) {
      actionGroups = groups || [];
      var sel = el('ins-action');
      sel.innerHTML = '';
      actionGroups.forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g.group;
        g.actions.forEach(function (a) {
          var opt = document.createElement('option');
          opt.value = a.method;
          opt.textContent = a.label + ' · ' + a.method;
          og.appendChild(opt);
          NEED_VALUE[a.method] = a.value;  // null 表示无需值
        });
        sel.appendChild(og);
      });
      sel.value = 'click_ele';
      onActionChange();
    }).catch(function () { /* ignore */ });
  }

  function onActionChange() {
    var m = el('ins-action').value;
    var ph = NEED_VALUE[m];
    var v = el('ins-value');
    if (ph === null || ph === undefined) {
      v.style.display = 'none';
      v.value = '';
    } else {
      v.style.display = 'block';
      v.placeholder = ph;
    }
    refreshButtons();
  }

  // ---------- 元素信息 ----------
  function elInfoHtml(e) {
    var tag = e.tag || '?';
    var head = '<b>' + esc(tag) + '</b>' +
      (e.id ? '<b>#' + esc(e.id) + '</b>' : '') +
      (e['class'] ? '<span class="meta">.' + esc(String(e['class']).split(/\s+/).filter(Boolean).slice(0, 3).join('.')) + '</span>' : '');
    var rows = [];
    if (e.text) rows.push('文本: ' + esc(String(e.text).slice(0, 60)));
    if (e.checked !== undefined && e.checked !== null) {
      rows.push('状态: ' + (e.checked ? '<b style="color:var(--ok)">✓ 已选中</b>' : '✗ 未选中'));
    }
    if (e.role) rows.push('role: ' + esc(e.role));
    if (e.placeholder) rows.push('placeholder: ' + esc(e.placeholder));
    if (e.type) rows.push('type: ' + esc(e.type));
    if (e.title) rows.push('title: ' + esc(e.title));
    if (e.box) rows.push('<span class="meta">位置 ' + Math.round(e.box.x) + ',' + Math.round(e.box.y) +
      ' · ' + Math.round(e.box.w) + '×' + Math.round(e.box.h) + '</span>');
    return '<div class="tagline">' + head + '</div>' +
      (rows.length ? '<div class="meta">' + rows.join('<br/>') + '</div>' : '');
  }

  function setElInfo(html) { el('ins-el-info').innerHTML = html; }
  function setHint(html) {
    setElInfo('<div class="ins-hint">' + html + '</div>');
  }

  // ---------- hover(A4: 指纹去重——同一元素不重复重渲染) ----------
  var lastHoverFp = '';
  function onHover(elInfo) {
    if (selected) return;  // 锁定中不跟随
    if (!elInfo) return;
    var fp = (elInfo.tag || '') + '|' + (elInfo.id || '') + '|' + (elInfo.text || '') +
      '|' + Math.round(elInfo.box ? elInfo.box.x : 0) + 'x' + Math.round(elInfo.box ? elInfo.box.y : 0);
    if (fp === lastHoverFp) return;  // 同一元素, 跳过渲染
    lastHoverFp = fp;
    setElInfo(elInfoHtml(elInfo));
  }

  // ---------- 选中(C3: iframe 内元素提示不支持) ----------
  function onSelect(elInfo) {
    if (!elInfo) return;
    if (elInfo.tag === 'iframe' || elInfo.tag === 'frame') {
      setHint('⚠ iframe 内元素暂不支持选中，请在顶层文档上操作');
      return;
    }
    selected = elInfo;
    chosenLocator = '';           // 新元素: 重置上一次的定位器选择, 避免残留串位
    setElInfo(elInfoHtml(elInfo));
    renderCandidates(elInfo.candidates || [], elInfo);
    setStatus('', '');            // 先清状态
    smartDefaultAction(elInfo);   // 输入类元素自动切换推荐动作(可能写入提示)
    refreshButtons();
    // 批次②: select 下拉 → 枚举选项可视化点选
    if ((elInfo.tag || '').toLowerCase() === 'select' && chosenLocator) {
      loadSelectOptions(chosenLocator);
    } else {
      el('ins-select-options').innerHTML = '';
    }
  }

  /** 智能默认动作: file→upload_file, input/textarea→fill_value, select→select_option, 其余→click_ele */
  function smartDefaultAction(elInfo) {
    var tag = (elInfo.tag || '').toLowerCase();
    var type = (elInfo.type || '').toLowerCase();
    var clickTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'image'];
    var sel = el('ins-action');
    var prev = sel.value;
    if (tag === 'input' && type === 'file') {
      sel.value = 'upload_file';
    } else if ((tag === 'textarea') || (tag === 'input' && clickTypes.indexOf(type) < 0)) {
      sel.value = 'fill_value';
    } else if (tag === 'select') {
      sel.value = 'select_option';
    } else {
      sel.value = 'click_ele';
    }
    onActionChange();
    if ((sel.value === 'fill_value' || sel.value === 'upload_file') && prev !== sel.value) {
      el('ins-value').focus();
      setStatus('已为你选择 ' + sel.value + '，填入后执行（Ctrl+Enter）', '');
    }
  }

  function clearSelection() {
    selected = null;
    chosenLocator = '';
    global.InsLive.hideSelect();
    setHint('hover 预览画面查看元素，点击选中后配置动作');
    el('ins-cands').innerHTML = '<div class="ins-hint">点击预览选中元素后，这里列出候选定位器（按稳定性排序）</div>';
    el('ins-cand-hint').textContent = '';
    el('ins-select-options').innerHTML = '';
    refreshButtons();
  }

  /** 批次②: select 下拉选项可视化——点选选项即配置 select_option 动作 */
  function loadSelectOptions(locator) {
    var box = el('ins-select-options');
    box.innerHTML = '<div class="ins-hint">枚举选项中…</div>';
    global.INSAPP.act('options', { locator: locator }).then(function (r) {
      if (!r.ok || !(r.options || []).length) {
        box.innerHTML = r.ok ? '' : '<div class="ins-hint">选项枚举失败: ' + esc(r.error || '') + '</div>';
        return;
      }
      var wrap = document.createElement('div');
      wrap.className = 'ins-opt-list';
      r.options.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'ins-opt' + (o.selected ? ' cur' : '');
        row.textContent = o.text + (o.selected ? ' ✓当前' : '');
        row.title = 'value: ' + o.value;
        row.addEventListener('click', function () {
          el('ins-action').value = 'select_option';
          onActionChange();
          el('ins-value').value = o.value;
          setStatus('已选择选项「' + o.text.slice(0, 20) + '」，点击执行生效', '');
        });
        wrap.appendChild(row);
      });
      box.innerHTML = '<div class="ins-sec-title" style="margin-top:8px">下拉选项（点选即配置）</div>';
      box.appendChild(wrap);
    }).catch(function () { box.innerHTML = ''; });
  }

  // ---------- 候选定位器列表(A1: 渐进填充——先渲染, 后台并行 probe 逐条更新) ----------
  function stars(c) {
    var n = 0;
    if (c.count === 1 && c.visible) n = 3;          // 唯一且可见 → 最稳
    else if (c.visible > 0 && c.count > 1) n = 2;   // 可见但有多个
    else if (c.count > 0) n = 1;                    // 匹配但不可见
    return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);
  }

  function renderCandidates(cands, elInfo) {
    var box = el('ins-cands');
    box.innerHTML = '';
    el('ins-cand-hint').textContent = cands.length ? '(' + cands.length + ' 条, 按稳定性排序)' : '';
    if (!cands.length) {
      box.innerHTML = '<div class="ins-hint">未能为该元素生成候选定位器（元素无 id/文本/属性特征）</div>';
      return;
    }
    var needProbe = cands.some(function (c) { return typeof c.count !== 'number'; });
    cands.forEach(function (c, i) {
      var row = document.createElement('label');
      row.className = 'ins-cand' + ((i === 0 && !chosenLocator) || c.locator === chosenLocator ? ' sel' : '');
      row.dataset.locator = c.locator;
      var cntTxt = typeof c.count === 'number'
        ? c.count + '匹配/' + (c.visible || 0) + '可见'
        : '…';
      var cntCls = typeof c.count === 'number'
        ? 'cnt ' + (c.count === 1 && c.visible ? 'ok' : (c.count ? '' : 'bad'))
        : 'cnt';
      row.innerHTML =
        '<input type="radio" name="ins-cand" ' + ((i === 0 && !chosenLocator) || c.locator === chosenLocator ? 'checked' : '') + '/>' +
        '<span class="loc">' + esc(c.locator) + '</span>' +
        '<span class="stars">' + (typeof c.count === 'number' ? stars(c) : '☆☆☆') + '</span>' +
        '<span class="' + cntCls + '">' + cntTxt + '</span>';
      row.querySelector('input').addEventListener('change', function () {
        chosenLocator = c.locator;
        box.querySelectorAll('.ins-cand').forEach(function (r) { r.classList.remove('sel'); });
        row.classList.add('sel');
        refreshButtons();
      });
      if ((i === 0 && !chosenLocator) || c.locator === chosenLocator) chosenLocator = c.locator;
      box.appendChild(row);
    });
    refreshButtons();
    // 兜底: 旧后端/降级路径的候选无 count 字段 → 并行 probe, 全部完成后一次性渲染(绝不逐个显示)
    if (needProbe) {
      Promise.all(cands.map(function (c) {
        return global.INSAPP.act('probe', { locator: c.locator }).catch(function () { return null; });
      })).then(function (results) {
        results.forEach(function (r, i) {
          var row = box.querySelectorAll('.ins-cand')[i];
          if (!row || !row.isConnected) return;
          var cnt = row.querySelector('.cnt');
          var st = row.querySelector('.stars');
          if (!r || !r.ok) {
            cnt.textContent = '—';
            cnt.className = 'cnt bad';
            return;
          }
          cnt.textContent = r.count + '匹配/' + (r.visible || 0) + '可见';
          cnt.className = 'cnt ' + (r.count === 1 && r.visible ? 'ok' : (r.count ? '' : 'bad'));
          st.textContent = stars(r);
          if (r.count === 1 && r.visible && chosenLocator !== cands[i].locator &&
              !row.querySelector('input').checked) {
            chosenLocator = cands[i].locator;
            box.querySelectorAll('.ins-cand').forEach(function (rr) { rr.classList.remove('sel'); });
            row.classList.add('sel');
            row.querySelector('input').checked = true;
            refreshButtons();
          }
        });
      });
    }
  }

  // ---------- 按钮/状态 ----------
  function currentMethod() { return el('ins-action').value; }
  function needLocator() { return !NO_LOCATOR.has(currentMethod()); }

  function refreshButtons() {
    var can = alive() && !readOnly();
    var hasLoc = !!chosenLocator;
    var m = currentMethod();
    var clickAt = can && isClickAtMode();
    el('ins-probe-btn').disabled = !(can && hasLoc);
    el('ins-highlight-btn').disabled = !(can && hasLoc);
    el('ins-exec-btn').disabled = !(can && m && (clickAt || hasLoc || !needLocator()));
    el('ins-exec-btn').textContent = clickAt ? '▶ 坐标点击' : '▶ 执行一步';
    el('ins-action').disabled = !can;
  }

  /** 批次②: 无候选定位器的无语义元素(canvas/验证码/自绘控件) → 坐标点击兜底 */
  function isClickAtMode() {
    return !!(selected && (selected.candidates || []).length === 0 && needLocator());
  }

  function setStatus(text, cls) {
    var s = el('ins-exec-status');
    s.textContent = text || '';
    s.className = 'ins-exec-status ' + (cls || '');
  }

  // ---------- 执行一步 / 坐标点击 ----------
  function execute() {
    if (el('ins-exec-btn').disabled) return;
    var m = currentMethod();
    var clickAt = isClickAtMode() && !chosenLocator;
    var locator = needLocator() ? chosenLocator : '';
    var value = el('ins-value').style.display !== 'none' ? el('ins-value').value : '';
    var elText = selected ? (selected.text || selected.placeholder || selected.aria_label ||
                  (selected.id ? '#' + selected.id : '') || '') : '';

    function afterExec(r) {
      setExecuting(false);
      if (!r.ok) {
        setStatus('✗ 执行失败: ' + (r.error || '未知错误'), 'err');
        return;
      }
      // C: 执行期间产生的事件(dialog 等)补录——WS 通道已由推送即时补录, 仅在 HTTP 路径处理
      if (!(global.InsWS && global.InsWS.isOpen())) {
        (r.extra_events || []).forEach(function (e) { global.InsTimeline.addEvent(e); });
      }
      global.InsTimeline.addEvent(r.event);
      // 防闪烁: 用执行后截图即时刷新预览(不等帧流, 画面无缝切换)
      if (r.event && r.event.screenshot && global.InsLive) {
        global.InsLive.applyShot(r.event.screenshot);
      }
      if (r.warning) {
        setStatus('⚠ 已执行但页面无变化（详见时间线 ⚠ 卡片）', 'warn');
        global.InsTimeline.toast('第 ' + r.event.step + ' 步已执行，但页面无变化', 'warn');
      } else {
        setStatus('✓ 第 ' + r.event.step + ' 步执行成功', 'ok');
        global.InsTimeline.toast('第 ' + r.event.step + ' 步已执行 ✓', 'ok');
      }
      // 成功后自动解除锁定, 回到 PREVIEWING 继续下一步
      clearSelection();
    }
    function onErr(err) {
      setExecuting(false);
      setStatus('✗ ' + (err.message || String(err)), 'err');
    }

    // 批次②: 坐标点击兜底(canvas 等无语义元素)
    if (clickAt) {
      var xy = global.InsLive.lastClickXY();
      if (!xy) { setStatus('✗ 无可用点击坐标，请重新点击预览选中', 'err'); return; }
      setExecuting(true);
      setStatus('坐标点击中…', '');
      global.INSAPP.act('click_at', { x: xy.x, y: xy.y }).then(afterExec).catch(onErr);
      return;
    }

    // 前端轻校验: 需要值的动作必须填
    if (NEED_VALUE[m] !== null && NEED_VALUE[m] !== undefined && String(value).trim() === '') {
      setStatus('⚠ 该动作需要填写「值」', 'warn');
      el('ins-value').focus();
      return;
    }
    setExecuting(true);
    setStatus('执行中…', '');
    global.INSAPP.act('step', {
      method: m, locator: locator, value: value, el_text: elText
    }).then(afterExec).catch(onErr);
  }

  function setExecuting(v) {
    global.InsLive.setExecuting(v);
    el('ins-exec-btn').disabled = v;
    el('ins-probe-btn').disabled = v;
    el('ins-highlight-btn').disabled = v;
    // 执行中隐藏 overlay(避免页面变化后红框/hover框错位闪烁), 完成后由 clearSelection 统一恢复
    document.getElementById('ins-hover-box').style.display = 'none';
    document.getElementById('ins-select-box').style.display = 'none';
  }

  // ---------- 探测 / 高亮 ----------
  function probe() {
    if (!chosenLocator) return;
    setStatus('探测中…', '');
    global.INSAPP.act('probe', { locator: chosenLocator }).then(function (r) {
      var f = r.first || {};
      setStatus('🔍 ' + r.count + ' 匹配 / ' + (r.visible || 0) + ' 可见' +
        (f.text ? ' · 首个: "' + String(f.text).slice(0, 30) + '"' : '') +
        (f.tag ? ' · <' + f.tag + '>' : ''), r.count ? 'ok' : 'err');
    }).catch(function (err) { setStatus('✗ 探测失败: ' + (err.message || err), 'err'); });
  }

  function highlight() {
    if (!chosenLocator) return;
    setStatus('高亮中…', '');
    global.INSAPP.act('highlight', { locator: chosenLocator }).then(function (r) {
      if (r.screenshot) {
        var v = document.getElementById('ins-viewer');
        document.getElementById('ins-viewer-img').src = r.screenshot;
        document.getElementById('ins-viewer-cap').textContent = '高亮标注截图 · ' + chosenLocator;
        v.classList.add('show');
      }
      setStatus(r.ok ? '✓ 已在真实页面描边(8秒自动消除)' : '✗ 高亮失败', r.ok ? 'ok' : 'err');
    }).catch(function (err) { setStatus('✗ ' + (err.message || err), 'err'); });
  }

  /** 只读回放模式: 禁用全部操作 */
  function applyReadOnly() {
    clearSelection();
    refreshButtons();
    if (readOnly()) setHint('📖 只读回放模式（该历史会话浏览器已关闭）');
  }

  /** 会话就绪 */
  function sessionReady() {
    applyReadOnly();
    refreshButtons();
  }

  // ---------- 绑定 ----------
  document.addEventListener('DOMContentLoaded', function () {
    loadActions();
    el('ins-action').addEventListener('change', onActionChange);
    el('ins-probe-btn').addEventListener('click', probe);
    el('ins-highlight-btn').addEventListener('click', highlight);
    el('ins-exec-btn').addEventListener('click', execute);
    // 代码 tab 已由 code-panel.js 全权接管(与 index.html 同一实现)
  });

  global.InsLocator = {
    onHover: onHover,
    onSelect: onSelect,
    clearSelection: clearSelection,
    execute: execute,
    applyReadOnly: applyReadOnly,
    sessionReady: sessionReady,
    refreshButtons: refreshButtons
  };
})(window);
