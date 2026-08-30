/**
 * inspect-timeline.js — 时间线卡片 / 徽标 / 代码累积 / 导出
 * 卡片视觉与 index.html 时间线一致; 数据仅存本页(inspect_data/), 与主站零交集。
 */
(function (global) {
  'use strict';

  var steps = [];        // 时间线事件 {step, method, desc, locator, value, url, screenshot, warning, ts}
  var readOnly = false;  // 历史只读回放模式
  var curViewerIdx = -1; // 大图查看器当前索引
  window.steps = steps;  // 与 index.html 共享同一全局: code-panel.js 直接消费此引用

  function el(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** DSL 芯片文本: method [locator] = value */
  function dslText(s) {
    var loc = s.locator ? ' [' + s.locator + ']' : '';
    var hasVal = s.value !== undefined && s.value !== null && String(s.value) !== '';
    var val = hasVal ? ' = ' + s.value : '';
    return s.method + loc + val;
  }

  function updateBadge() {
    var tab = el('ins-tab-timeline');
    if (tab) tab.textContent = steps.length ? '时间线 (' + steps.length + ')' : '时间线';
    var cnt = el('ins-tl-count');
    if (cnt) cnt.textContent = steps.length + ' 步';
  }

  function renderCard(s) {
    var box = el('ins-steps');
    var hint = box.querySelector('.ins-hint');
    if (hint) hint.remove();
    var card = document.createElement('div');
    card.className = 'step-card' + (s.warning ? ' warn' : '');
    var st = s.warning ? '<span class="st warn">⚠</span>' : '<span class="st ok">✓</span>';
    card.innerHTML =
      '<div class="step-head"><span class="idx">' + s.step + '</span>' + st +
      '<span class="desc" title="' + esc(s.desc) + '">' + esc(s.desc) + '</span>' +
      '<button class="copy" title="复制该步的 Playwright JS 代码">📋</button></div>' +
      (s.warning ? '<div class="warnline" title="' + esc(s.warning) + '">⚠ 页面无变化：可能未点中目标元素</div>' : '') +
      '<div class="cmd">' + esc(dslText(s)) + '</div>' +
      (s.screenshot ? '<img class="shot" src="' + s.screenshot + '" alt="步骤截图"/>' : '') +
      '<div class="url">' + esc(s.url || '') + '</div>';
    var shot = card.querySelector('.shot');
    if (shot) shot.addEventListener('click', function () { viewerShow(s); });
    card.querySelector('.copy').addEventListener('click', function () {
      copyText(global.CodeGenerator.generate([s], 'js'));
      toast('已复制该步 Playwright JS 代码', 'ok');
    });
    box.appendChild(card);
    box.scrollTop = box.scrollHeight;
  }

  function render() {
    var box = el('ins-steps');
    box.innerHTML = '';
    if (!steps.length) {
      box.innerHTML = '<div class="ins-hint">' +
        (readOnly ? '该历史会话暂无步骤记录' : '执行的每一步会记录在这里') + '</div>';
    }
    steps.forEach(renderCard);
    updateBadge();
  }

  function addEvent(evt) {
    steps.push(evt);
    renderCard(evt);
    updateBadge();
    refreshCode();
  }

  function load(list, ro) {
    steps = (list || []).slice();
    window.steps = steps;  // 保持同一引用(code-panel.js 消费)
    readOnly = !!ro;
    render();
    refreshCode();
  }

  function reset() {
    steps = [];
    window.steps = steps;
    readOnly = false;
    render();
    refreshCode();
  }

  function setReadOnly(ro) {
    readOnly = !!ro;
    render();
    refreshCode();
  }

  /** 代码 tab: 从时间线 steps 实时累积生成完整脚本 */
  function refreshCode() {
    var pre = el('ins-code');
    if (!pre) return;
    var lang = el('ins-code-lang') ? el('ins-code-lang').value : 'js';
    if (!steps.length) {
      pre.textContent = '// 暂无步骤';
      return;
    }
    pre.textContent = global.CodeGenerator.generate(steps, lang);
  }

  /** 与 index.html openViewerAt 完全同语义: 越界/目标无截图 → 停在当前 */
  function viewerOpenAt(i) {
    if (i < 0 || i >= steps.length) return;
    var s = steps[i];
    if (!s.screenshot) return;
    curViewerIdx = i;
    el('ins-viewer-img').src = s.screenshot;
    el('ins-viewer-cap').textContent = '第 ' + s.step + ' 步 · ' + (s.desc || s.method || '');
    el('ins-viewer').classList.add('show');
  }
  function viewerClose() { el('ins-viewer').classList.remove('show'); }
  function prevShot() { viewerOpenAt(curViewerIdx - 1); }
  function nextShot() { viewerOpenAt(curViewerIdx + 1); }

  function viewerShow(s) {
    var i = steps.indexOf(s);
    viewerOpenAt(i < 0 ? 0 : i);
  }

  /** 附加: 滚轮 / 方向键翻页(复用与 index.html 相同的 prev/next 语义) */
  function viewerNav(d) { (d < 0 ? prevShot : nextShot)(); }

  var viewerWheelT = 0;
  function onViewerWheel(e) {
    if (!el('ins-viewer').classList.contains('show')) return;
    e.preventDefault();
    var now = Date.now();
    if (now - viewerWheelT < 220) return;  // 快速翻页节流
    viewerWheelT = now;
    viewerNav(e.deltaY > 0 ? 1 : -1);
  }

  function download(name, content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function toast(msg, type) {
    var t = el('ins-toast');
    t.textContent = msg;
    t.className = 'ins-toast show ' + (type || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'ins-toast'; }, 1800);
  }

  /** 导出 JSON / JS / PY */
  function exportAs(kind) {
    if (!steps.length) { toast('暂无步骤可导出', 'warn'); return; }
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (kind === 'json') {
      download('inspect-' + stamp + '.json', JSON.stringify(steps, null, 2));
    } else {
      download('inspect-' + stamp + '.' + kind, global.CodeGenerator.generate(steps, kind));
    }
    toast('已导出 ' + kind.toUpperCase(), 'ok');
  }

  // ---------- 绑定 ----------
  document.addEventListener('DOMContentLoaded', function () {
    var prev = el('ins-viewer-prev'), next = el('ins-viewer-next'), vw = el('ins-viewer');
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); prevShot(); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); nextShot(); });
    if (el('ins-viewer-close')) {
      el('ins-viewer-close').addEventListener('click', function (e) { e.stopPropagation(); viewerClose(); });
    }
    if (vw) vw.addEventListener('wheel', onViewerWheel, { passive: false });
  });

  global.InsTimeline = {
    addEvent: addEvent,
    load: load,
    reset: reset,
    all: function () { return steps; },
    isReadOnly: function () { return readOnly; },
    setReadOnly: setReadOnly,
    dslText: dslText,
    refreshCode: refreshCode,
    exportAs: exportAs,
    viewerNav: viewerNav,
    viewerOpen: function () { return el('ins-viewer').classList.contains('show'); },
    toast: toast,
    copyText: copyText
  };
})(window);
