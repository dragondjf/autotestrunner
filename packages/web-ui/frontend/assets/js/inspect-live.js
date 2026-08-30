/**
 * inspect-live.js — CDP 帧流预览 / hover 命中框 / 点击选中 / 滚轮映射
 * 坐标换算: 帧即页面视口 CSS 像素, x_page = offsetX × naturalWidth/clientWidth
 */
(function (global) {
  'use strict';

  var es = null;
  var retryTimer = null;
  var wsFallbackTimer = null;  // WS 未按时连通 → SSE 降级
  var hoverTimer = 0;
  var executing = false;   // 执行中暂停 hover 请求(防抖)
  var lastMeta = {};       // 帧元数据(deviceWidth/deviceHeight): 帧可能被 maxWidth 缩放
  var lastClickXY = null;  // 最近一次点击的页面坐标(坐标点击兜底用)
  var zoomScale = 1;       // 预览缩放(1=适配基准), 0 = 铺满(cover 自动)

  function el(id) { return document.getElementById(id); }
  function sid() { return global.INSAPP ? global.INSAPP.sid : null; }
  function alive() { return !!(global.INSAPP && global.INSAPP.alive); }

  // ---------- 预览缩放(transform scale: rect 自动反映, 坐标换算公式不变) ----------
  // 帧源固定 1920×1080(后端默认高清), 无需动态 quality 切换

  function zoomApply() {
    var img = el('ins-live-img');
    if (!img) return;
    var pv = el('ins-preview');
    if (zoomScale === 0) {
      // 铺满: cover 比例 = max(容器/适配), 居中裁切
      var baseW = img.offsetWidth, baseH = img.offsetHeight;
      if (baseW > 0 && baseH > 0) {
        var s = Math.max(pv.clientWidth / baseW, pv.clientHeight / baseH);
        img.style.transform = 'scale(' + s + ')';
        el('ins-zoom-val').textContent = Math.round(s * 100) + '%';
      }
    } else {
      img.style.transform = 'scale(' + zoomScale + ')';
      el('ins-zoom-val').textContent = Math.round(zoomScale * 100) + '%';
    }
  }
  function zoomSet(s) {
    zoomScale = Math.max(0.5, Math.min(4, s));
    localStorage.setItem('ins.zoom', String(zoomScale));
    zoomApply();
  }
  function zoomIn() { zoomSet(zoomScale === 0 ? 1 : zoomScale + 0.25); }
  function zoomOut() { zoomSet(zoomScale === 0 ? 1 : zoomScale - 0.25); }
  function zoomFit() { zoomScale = 1; localStorage.setItem('ins.zoom', '1'); zoomApply(); }
  function zoomCover() { zoomScale = 0; localStorage.setItem('ins.zoom', '0'); zoomApply(); }
  function zoomInit() {
    var v = parseFloat(localStorage.getItem('ins.zoom') || '1');
    zoomScale = isNaN(v) ? 1 : v;
    zoomApply();
  }

  /** B 优化: 帧来源 WS 优先, 3s 未连通自动降级 SSE */
  function start() {
    stop();
    if (!sid()) return;
    global.InsWS.connect(sid());
    wsFallbackTimer = setTimeout(function () {
      if (!global.InsWS.isOpen()) startEs();  // WS 不可用 → SSE 兜底
    }, 3000);
  }

  function startEs() {
    if (es) return;
    es = new EventSource('/api/inspect/session/' + sid() + '/live');
    es.addEventListener('frame', function (ev) {
      try { onFrame(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    });
    es.addEventListener('pageswitch', function () {
      // B2: 后端已切换到弹窗新页面, 立即重连帧流(不等 3s 重试)
      stopEs();
      if (alive()) start();
    });
    es.onerror = function () {
      stopEs();
      retryTimer = setTimeout(function () {
        if (alive()) start();  // 断线 3s 自动重连(会话被回收时 alive=false 不再连)
      }, 3000);
    };
  }

  function stopEs() {
    if (es) { es.close(); es = null; }
  }
  function stop() {
    stopEs();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (wsFallbackTimer) { clearTimeout(wsFallbackTimer); wsFallbackTimer = null; }
    global.InsWS.disconnect();
    hideBox('ins-hover-box');
  }

  // WS 帧/url 事件接线(一次性注册; 连接由 start/stop 管理)
  global.InsWS.onFrame(function (d) {
    if (es) stopEs();  // WS 有帧 → 停掉 SSE 兜底
    if (d.url && global.INSAPP) global.INSAPP.updateUrl(d.url);  // URL 栏零轮询跟随
    onFrame(d);
  });
  global.InsWS.onUrl(function (u) {
    if (u && global.INSAPP) global.INSAPP.updateUrl(u);
  });
  global.InsWS.onDialog(function (evt) {
    if (evt && global.InsTimeline) global.InsTimeline.addEvent(evt);  // 即时补录时间线
  });

  function onFrame(d) {
    if (!d || !d.img) return;
    var img = el('ins-live-img');
    img.src = d.img;
    lastMeta = d.meta || {};
    el('ins-stage').style.display = 'flex';
    el('ins-empty').style.display = 'none';
    el('ins-error').style.display = 'none';
    el('ins-zoom-bar').style.display = 'flex';
    if (zoomScale === 0) zoomApply();  // 铺满模式: 帧尺寸变化后重算
    // A3: 滚动指示直接取帧流元数据 scrollOffsetY(不再 5s HTTP 轮询)
    if (typeof lastMeta.scrollOffsetY === 'number' && global.INSAPP) {
      global.INSAPP.updateScroll(lastMeta.scrollOffsetY);
    }
  }

  /**
   * 屏幕事件 → 页面坐标(视口 CSS 像素) + 显示缩放因子。
   * 关键: 帧源固定 1920×1080, deviceWidth/deviceHeight 是帧的真实尺寸,
   * 须用元数据还原(帧被缩放时), 否则命中点会偏。
   */
  function pageXY(e) {
    var img = el('ins-live-img');
    var r = img.getBoundingClientRect();
    var frameW = img.naturalWidth || 1;
    var frameH = img.naturalHeight || 1;
    var devW = lastMeta.deviceWidth || frameW;
    var devH = lastMeta.deviceHeight || frameH;
    return {
      x: (e.clientX - r.left) * (devW / r.width),
      y: (e.clientY - r.top) * (devH / r.height),
      sx: devW / r.width,   // 显示px → 页面CSS px(滚轮增量换算用)
      sy: devH / r.height,
      kx: r.width / devW,   // 页面CSS px → 显示px(overlay 定位用)
      ky: r.height / devH
    };
  }

  function showBox(id, box, kx, ky, label) {
    var b = el(id);
    if (!box) { hideBox(id); return; }
    // img 缩放/铺满后相对 stage 有偏移: box 定位 = img偏移 + 元素框×缩放比例
    var stage = el('ins-stage'), img = el('ins-live-img');
    var sRect = stage.getBoundingClientRect(), iRect = img.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = (iRect.left - sRect.left) + box.x * kx + 'px';
    b.style.top = (iRect.top - sRect.top) + box.y * ky + 'px';
    b.style.width = Math.max(box.w * kx, 4) + 'px';
    b.style.height = Math.max(box.h * ky, 4) + 'px';
    if (label !== undefined) b.setAttribute('data-label', label);
  }
  function hideBox(id) {
    var b = el(id);
    b.style.display = 'none';
  }

  function onMouseMove(e) {
    if (!alive() || executing) return;
    if (dragStart) return;  // 拖拽中不发送 hover
    var now = Date.now();
    if (now - hoverTimer < 150) return;  // 150ms 节流(A4)
    hoverTimer = now;
    var p = pageXY(e);
    global.INSAPP.act('hover', { x: p.x, y: p.y }).then(function (r) {
      var elInfo = r && r.ok && r.element;
      if (elInfo && elInfo.box) {
        showBox('ins-hover-box', elInfo.box, p.kx, p.ky, elInfo.tag || '');
      } else {
        hideBox('ins-hover-box');
      }
      // 检视 tab 可见时才刷新元素信息(未锁定状态下)
      if (global.InsLocator) global.InsLocator.onHover(elInfo);
      // A3: URL 栏跟随(不再轮询)
      if (r && r.url && global.INSAPP) global.INSAPP.updateUrl(r.url);
    }).catch(function () { /* 会话消失等, 静默 */ });
  }

  /**
   * 拖拽中继: 预览上 mousedown+移动+up = 真实页面的 mouse down/move/up。
   * 纯坐标中继, 不依赖 elementFromPoint —— iframe 内滑块验证码也能操作。
   * 移动阈值 6px: 原地 = 点击选中(走 onClick), 移动 = 拖拽。
   */
  var dragStart = null;
  var dragLastMove = 0;
  var suppressClick = false;

  function onMouseDown(e) {
    if (!alive() || global.InsTimeline.isReadOnly()) return;
    e.preventDefault();  // 阻止 img 原生拖拽(ghost 图)
    var p = pageXY(e);
    dragStart = { sx: p.x, sy: p.y, moved: false };
    window.addEventListener('mousemove', onDragWindowMove);
    window.addEventListener('mouseup', onDragWindowUp);
  }
  function onDragWindowMove(e) {
    if (!dragStart) return;
    var now = Date.now();
    if (now - dragLastMove < 40) return;  // 40ms 节流
    dragLastMove = now;
    var p = pageXY(e);
    if (Math.abs(p.x - dragStart.sx) + Math.abs(p.y - dragStart.sy) > 6) {
      if (!dragStart.moved) {
        // 首次越过阈值: 先在按下的原点 mouse.down(与真实抓取一致), 再移动
        dragStart.moved = true;
        dragStart.startP = global.INSAPP.act('drag_start', { x: dragStart.sx, y: dragStart.sy })
          .catch(function () { /* ignore */ });
      }
      // 后续移动等 drag_start 完成再发, 避免后端锁内乱序
      var moveP = (dragStart.startP || Promise.resolve())
        .then(function () { return global.INSAPP.act('drag_move', { x: p.x, y: p.y }); });
      if (!dragStart.lastMoveP) dragStart.lastMoveP = moveP;
      moveP.catch(function () { /* ignore */ });
    }
  }
  function onDragWindowUp(e) {
    if (!dragStart) return;
    var st = dragStart;
    dragStart = null;
    window.removeEventListener('mousemove', onDragWindowMove);
    window.removeEventListener('mouseup', onDragWindowUp);
    if (!st.moved) return;  // 原地: 交给 click 事件走选中逻辑
    suppressClick = true;
    var p = pageXY(e);
    (st.lastMoveP || st.startP || Promise.resolve()).then(function () {
      return global.INSAPP.act('drag_end', { x: p.x, y: p.y, sx: st.sx, sy: st.sy });
    }).then(function (r) {
      if (r && r.event) global.InsTimeline.addEvent(r.event);
      global.InsTimeline.toast('拖拽完成' + (r && r.event ? ' → 时间线第 ' + r.event.step + ' 步' : ''), 'ok');
    }).catch(function (err) {
      global.InsTimeline.toast('拖拽失败: ' + (err.message || err), 'err');
    });
  }

  function onClick(e) {
    if (!alive()) return;
    if (global.InsTimeline.isReadOnly()) return;
    if (suppressClick) { suppressClick = false; return; }  // 刚完成的是拖拽, 忽略 click
    var p = pageXY(e);
    lastClickXY = { x: p.x, y: p.y };  // 坐标点击兜底用
    global.INSAPP.act('select', { x: p.x, y: p.y }).then(function (r) {
      var elInfo = r && r.ok ? r.element : null;
      if (!global.InsLocator) return;
      // A3: URL 栏跟随
      if (r && r.url && global.INSAPP) global.INSAPP.updateUrl(r.url);
      if (elInfo && elInfo.box) {
        showBox('ins-select-box', elInfo.box, p.kx, p.ky, '已选中 ' + (elInfo.tag || ''));
        global.InsLocator.onSelect(elInfo);
        global.INSAPP.switchTab('inspect');  // 点击选中 → 自动切到检视 tab
      } else {
        global.InsLocator.clearSelection();
      }
    }).catch(function (err) {
      global.InsTimeline.toast('选中失败: ' + (err.message || err), 'err');
    });
  }

  /** 滚轮: 增量累计 + 单飞请求去重。
   *  真实滚轮是高频事件流, 若每个事件都发一次 act, 后端串行化排队,
   *  会出现滚动滞后/松手后还继续滚的错觉。改为: 请求在途时只累计 delta,
   *  返回后把累计量一次发出 —— 手势结束即停, 方向自然跟随。 */
  var wheelAccumDx = 0, wheelAccumDy = 0, wheelBusy = false, wheelX = 0, wheelY = 0;
  function pumpWheel() {
    if (wheelBusy || (!wheelAccumDx && !wheelAccumDy)) return;
    wheelBusy = true;
    var dx = wheelAccumDx, dy = wheelAccumDy;
    wheelAccumDx = 0; wheelAccumDy = 0;
    global.INSAPP.act('wheel', { dx: dx, dy: dy, x: wheelX, y: wheelY })
      .catch(function () { /* ignore */ })
      .then(function () { wheelBusy = false; pumpWheel(); });
  }
  function onWheel(e) {
    if (!alive()) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+滚轮 = 预览缩放(不映射页面滚动)
      if (e.deltaY < 0) zoomIn(); else zoomOut();
      return;
    }
    var p = pageXY(e);
    wheelX = p.x; wheelY = p.y;
    wheelAccumDx += e.deltaX * (p.sx || 1);
    wheelAccumDy += e.deltaY * (p.sy || 1);
    pumpWheel();
  }

  function setExecuting(v) { executing = !!v; }

  /**
   * 执行完成后用响应截图即时刷新预览(消除"执行中0帧→完成后突变"的闪烁):
   * 后端 act 响应已带执行后截图, 直接设为预览帧; 帧流后续帧内容一致, 无缝衔接。
   * 双缓冲: 先离屏解码, 完成后再换 src —— 直接换 src 时旧图先被清空、
   * 新图解码需要时间, 中间会出现空白间隙(视觉上即"闪一下")。
   */
  function applyShot(dataUri) {
    if (!dataUri) return;
    var img = el('ins-live-img');
    el('ins-stage').style.display = 'flex';
    el('ins-empty').style.display = 'none';
    var pre = new Image();
    pre.onload = function () {
      img.src = dataUri;
      if (zoomScale === 0) zoomApply();  // 铺满模式: 尺寸变化后重算
    };
    pre.src = dataUri;
  }

  global.InsLive = {
    start: start,
    stop: stop,
    setExecuting: setExecuting,
    applyShot: applyShot,
    hideSelect: function () { hideBox('ins-select-box'); },
    lastClickXY: function () { return lastClickXY; },
    _onMouseMove: onMouseMove,
    _onClick: onClick,
    _onWheel: onWheel
  };

  // 事件绑定(图片存在即绑, 内部再判会话状态)
  document.addEventListener('DOMContentLoaded', function () {
    var img = el('ins-live-img');
    img.addEventListener('mousemove', onMouseMove);
    img.addEventListener('mousedown', onMouseDown);
    img.addEventListener('click', function (e) { e.preventDefault(); onClick(e); });
    el('ins-stage').addEventListener('wheel', onWheel, { passive: false });
    el('ins-viewer').addEventListener('click', function (e) {
      if (e.target.closest('.nav') || e.target.closest('.close')) return;  // 翻页/关闭按钮不触发背景关闭
      el('ins-viewer').classList.remove('show');
    });
    // 预览缩放控制条
    el('ins-zoom-in').addEventListener('click', zoomIn);
    el('ins-zoom-out').addEventListener('click', zoomOut);
    el('ins-zoom-fit').addEventListener('click', zoomFit);
    el('ins-zoom-cover').addEventListener('click', zoomCover);
    window.addEventListener('resize', function () { if (zoomScale === 0) zoomApply(); });
    zoomInit();
  });
})(window);
