/**
 * inspect-ws.js — WebSocket 统一性能通道(B 优化)
 * 一条连接承载: act 请求-响应(correlation id) + 帧流 + url 推送 + dialog 事件。
 * 后端不可用时自动降级: INSAPP.act 回退 HTTP(fetch), 帧流回退 EventSource。
 */
(function (global) {
  'use strict';

  var ws = null;
  var reqSeq = 0;
  var pending = {};      // id -> {resolve, reject}
  var callbacks = { frame: null, url: null, dialog: null };
  var reconnectTimer = null;
  var aliveCheck = null; // 由 app.js 注入的存活判断

  function setAliveCheck(fn) { aliveCheck = fn; }
  function isOpen() { return !!(ws && ws.readyState === 1); }

  function connect(sid) {
    disconnect();
    if (!sid) return;
    try {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/api/inspect/ws/' + sid);
    } catch (e) { ws = null; return; }
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 'frame') {
        if (callbacks.frame) callbacks.frame(d);
      } else if (d.type === 'url') {
        if (callbacks.url) callbacks.url(d.url);
      } else if (d.type === 'dialog') {
        if (callbacks.dialog) callbacks.dialog(d.event);
      } else if (d.id !== undefined && d.id !== null) {
        var p = pending[d.id];
        if (p) {
          delete pending[d.id];
          d.ok ? p.resolve(d) : p.reject(new Error(d.error || 'WS 请求失败'));
        }
      }
    };
    ws.onclose = function () {
      rejectAll('连接关闭');
      ws = null;
      if (aliveCheck && aliveCheck()) {
        reconnectTimer = setTimeout(function () {
          var sid2 = global.INSAPP ? global.INSAPP.sid : null;
          if (sid2) connect(sid2);
        }, 3000);
      }
    };
    ws.onerror = function () { /* onclose 会触发重连 */ };
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) { /* ignore */ }
      ws = null;
    }
    rejectAll('主动断开');
  }

  function rejectAll(reason) {
    Object.keys(pending).forEach(function (id) {
      pending[id].reject(new Error(reason));
      delete pending[id];
    });
  }

  /** 请求-响应(与 HTTP act 同构: resolve 带 {ok, ...result}) */
  function request(action, payload) {
    return new Promise(function (resolve, reject) {
      if (!isOpen()) { reject(new Error('WS 未连接')); return; }
      var id = ++reqSeq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        ws.send(JSON.stringify({ id: id, action: action, payload: payload || {} }));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  /** 发送任意协议消息(quality 等非请求-响应消息) */
  function sendRaw(obj) {
    if (!isOpen()) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  global.InsWS = {
    connect: connect,
    disconnect: disconnect,
    isOpen: isOpen,
    request: request,
    sendRaw: sendRaw,
    setAliveCheck: setAliveCheck,
    onFrame: function (cb) { callbacks.frame = cb; },
    onUrl: function (cb) { callbacks.url = cb; },
    onDialog: function (cb) { callbacks.dialog = cb; }
  };
})(window);
