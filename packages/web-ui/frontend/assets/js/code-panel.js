  // ===================== 代码面板 (Code Playground) =====================

  let codeRunning = false;
  let codeAbort = false;

  /** 获取当前选中的语言 */
  function getCodeLang() {
    return document.getElementById('code-lang').value;
  }

  /** 获取 CodeMirror 编辑器内容 */
  function getEditorValue() {
    return codeMirrorEditor ? codeMirrorEditor.getValue() : '';
  }

  /** 设置 CodeMirror 编辑器内容 */
  function setEditorValue(val) {
    if (codeMirrorEditor) {
      codeMirrorEditor.setValue(val || '');
      codeMirrorEditor.clearHistory();
    }
  }

  /** 获取 CodeMirror mode 名称 */
  function getCodeMirrorMode() {
    var lang = getCodeLang();
    if (lang === 'py') return 'python';
    if (lang === 'json') return { name: 'javascript', json: true };
    return 'javascript';
  }

  /** 根据当前语言生成代码（核心逻辑在 code-generator.js） */
  function generateCode() {
    return CodeGenerator.generate(steps, getCodeLang());
  }

  /** 语言切换时刷新 */
  function onCodeLangChange() {
    var lang = getCodeLang();
    var label = lang === 'js' ? 'JavaScript' : (lang === 'py' ? 'Python' : 'JSON');
    if (codeMirrorEditor && steps.length > 0) {
      setEditorValue(generateCode());
    }
    // 切换 CodeMirror 语法高亮模式
    if (codeMirrorEditor) {
      codeMirrorEditor.setOption('mode', getCodeMirrorMode());
    }
    addDebugLog('ok', '🔤 已切换到 ' + label);
  }

  /** 切换导出菜单 */
  function toggleExportMenu() {
    document.getElementById('code-export-menu').classList.toggle('show');
  }

  /** 点击外部关闭导出菜单 */
  document.addEventListener('click', function(e) {
    var wrap = document.querySelector('.code-export-wrap');
    if (wrap && !wrap.contains(e.target)) {
      var menu = document.getElementById('code-export-menu');
      if (menu) menu.classList.remove('show');
    }
  });

  /** 导出功能 */
  function codeExport(type) {
    document.getElementById('code-export-menu').classList.remove('show');
    var text = getEditorValue();
    if (!text.trim()) { addDebugLog('warn', '⚠ 无代码可导出'); return; }
    var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    var filename, mime, content;
    if (type === 'json') {
      filename = 'steps_export_' + ts + '.json';
      mime = 'application/json';
      content = JSON.stringify(steps, null, 2);
      addDebugLog('ok', '📤 已导出 JSON（' + steps.length + ' 步）');
    } else if (type === 'py') {
      filename = 'playwright_script_' + ts + '.py';
      mime = 'text/x-python';
      content = CodeGenerator.generatePythonCode(steps);
      addDebugLog('ok', '📤 已导出 Python 脚本');
    } else {
      filename = 'playwright_script_' + ts + '.js';
      mime = 'text/javascript';
      content = text;
      addDebugLog('ok', '📤 已导出 JavaScript 脚本');
    }
    var blob = new Blob([content], { type: mime });
    var a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 刷新：从 steps 重新生成代码并替换编辑器内容 */
  function codeRefresh() {
    const code = generateCode();
    setEditorValue(code);
    const status = document.getElementById('code-status');
    status.textContent = '✓ 已从 ' + steps.length + ' 步生成脚本';
    status.style.color = 'var(--ok)';
    setTimeout(function() { status.style.color = ''; }, 3000);
    addDebugLog('ok', '🔄 已刷新代码（' + steps.length + ' 步 → ' + code.split('\n').length + ' 行）');
  }

  /** 运行脚本 */
  function codeRun() {
    const btn = document.getElementById('code-run-btn');
    if (codeRunning) {
      codeAbort = true;
      codeRunning = false;
      if (window._codeAbortController) {
        window._codeAbortController.abort();
      }
      btn.textContent = '▶ 运行';
      btn.classList.remove('running');
      addDebugLog('warn', '⏹ 执行已取消');
      return;
    }

    const lang = getCodeLang();
    const code = getEditorValue().trim();
    if (!code) {
      addDebugLog('error', '! 编辑器为空，请先输入代码或点击「刷新」生成');
      return;
    }
    // JSON 不支持直接执行
    if (lang === 'json') {
      addDebugLog('warn', '⚠ JSON 模式不支持运行，请切换到 JavaScript 或 Python');
      return;
    }

    codeRunning = true;
    codeAbort = false;
    btn.classList.add('running');
    btn.textContent = '⏹ 停止';

    clearDebugLog();
    addDebugLog('info', '▶ 发送 ' + (lang === 'js' ? 'JavaScript' : 'Python') + ' 代码到后端执行…');

    const endpoint = lang === 'js' ? '/api/agent/run-script' : '/api/agent/run-python';
    const controller = new AbortController();
    window._codeAbortController = controller;

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      signal: controller.signal,
    })
      .then(async function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === 'log') {
                  addDebugLog(evt.level, evt.text);
                } else if (evt.type === 'screenshot') {
                  const body = document.getElementById('code-debug-body');
                  const empty = body.querySelector('.code-debug-empty');
                  if (empty) empty.remove();
                  body.insertAdjacentHTML(
                    'beforeend',
                    '<div class="debug-line"><span class="t">[' + new Date().toLocaleTimeString() + ']</span><img src="data:image/png;base64,' + evt.data + '" style="max-width:100%;border:1px solid var(--border);border-radius:4px;margin:4px 0"></div>'
                  );
                  body.scrollTop = body.scrollHeight;
                }
              } catch (e) {
                /* ignore parse errors */
              }
            }
          }
        }
        addDebugLog('ok', '✅ 执行完成');
      })
      .catch(function(err) {
        if (err.name === 'AbortError') return;
        addDebugLog('error', '! 请求失败: ' + err.message);
      })
      .finally(function() {
        if (codeRunning) finishRun();
      });
  }

  function finishRun() {
    codeRunning = false;
    codeAbort = false;
    const btn = document.getElementById('code-run-btn');
    btn.classList.remove('running');
    btn.textContent = '▶ 运行';
  }

  /** 复制代码到剪贴板 */
  function codeCopy() {
    var text = getEditorValue();
    if (!text.trim()) { addDebugLog('warn', '⚠ 无代码可复制'); return; }
    navigator.clipboard.writeText(text).then(function() {
      var status = document.getElementById('code-status');
      status.textContent = '✓ 已复制到剪贴板';
      setTimeout(function() { status.textContent = ''; }, 2000);
      addDebugLog('ok', '📋 代码已复制到剪贴板');
    }).catch(function() {
      // fallback: 选中全部并复制
      if (codeMirrorEditor) {
        codeMirrorEditor.execCommand('selectAll');
        codeMirrorEditor.execCommand('copy');
      }
      addDebugLog('ok', '📋 代码已复制');
    });
  }

  /** 保存脚本文件 */
  function codeSave() {
    var text = getEditorValue();
    if (!text.trim()) { addDebugLog('warn', '⚠ 无代码可保存'); return; }
    var lang = getCodeLang();
    var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    var extMap = { js: 'js', py: 'py', json: 'json' };
    var mimeMap = { js: 'text/javascript', py: 'text/x-python', json: 'application/json' };
    var ext = extMap[lang] || 'js';
    var mime = mimeMap[lang] || 'text/javascript';
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.download = 'playwright_script_' + ts + '.' + ext;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    addDebugLog('ok', '💾 已保存为 ' + a.download);
  }

  /** 打开运行设置对话框 */
  function openCodeSettings() {
    // 弹出一个简易设置浮层
    let dlg = document.getElementById('code-settings-dlg');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'code-settings-dlg';
      dlg.innerHTML = '' +
        '<div class="cfg-mask" id="code-settings-mask" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:flex;align-items:center;justify-content:center;">' +
          '<div style="background:#fff;border-radius:12px;padding:24px 28px;min-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.25);">' +
            '<h3 style="margin:0 0 16px;font-size:16px;">⚙ 运行设置</h3>' +
            '<label style="display:block;margin-bottom:12px;font-size:13px;">' +
              '<span style="display:block;margin-bottom:4px;color:#555;">浏览器</span>' +
              '<select id="code-cfg-browser" style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
                '<option value="chromium">Chromium</option>' +
                '<option value="firefox">Firefox</option>' +
                '<option value="webkit">WebKit (Safari)</option>' +
              '</select>' +
            '</label>' +
            '<label style="display:block;margin-bottom:12px;font-size:13px;">' +
              '<span style="display:block;margin-bottom:4px;color:#555;">启动模式</span>' +
              '<select id="code-cfg-headless" style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
                '<option value="false">有界面 (headless: false)</option>' +
                '<option value="true">无界面 (headless: true)</option>' +
              '</select>' +
            '</label>' +
            '<label style="display:block;margin-bottom:16px;font-size:13px;">' +
              '<span style="display:block;margin-bottom:4px;color:#555;">超时 (ms)</span>' +
              '<input type="number" id="code-cfg-timeout" value="30000" style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;" />' +
            '</label>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
              '<button onclick="document.getElementById(\'code-settings-dlg\').remove()" style="padding:6px 16px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:13px;">取消</button>' +
              '<button onclick="saveCodeSettings()" style="padding:6px 16px;border:none;background:var(--primary);color:#fff;border-radius:6px;cursor:pointer;font-size:13px;">保存</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(dlg);
    }
  }

  function saveCodeSettings() {
    var browser = document.getElementById('code-cfg-browser').value;
    var headless = document.getElementById('code-cfg-headless').value;
    var timeout = document.getElementById('code-cfg-timeout').value;
    var text = getEditorValue();
    var lines = text.split('\n');
    var inject = '// Browser: ' + browser + ' | headless: ' + headless + ' | timeout: ' + timeout + 'ms\n';
    if (lines[0] && lines[0].startsWith('// Browser:')) {
      lines[0] = inject.trim();
      setEditorValue(lines.join('\n'));
    } else {
      setEditorValue(inject + text);
    }
    document.getElementById('code-settings-dlg').remove();
    addDebugLog('ok', '⚙ 设置已更新: ' + browser + ', headless=' + headless + ', timeout=' + timeout + 'ms');
  }

  /** 获取调试日志纯文本内容 */
  function getDebugLogText() {
    var body = document.getElementById('code-debug-body');
    var lines = body.querySelectorAll('.debug-line');
    var text = '';
    lines.forEach(function(div) {
      var tEl = div.querySelector('.t');
      var msgEl = div.querySelector('span:last-child');
      if (msgEl) {
        text += (tEl ? tEl.textContent + ' ' : '') + msgEl.textContent + '\n';
      }
    });
    return text;
  }

  /** 复制调试日志 */
  function copyLog() {
    var text = getDebugLogText();
    if (!text) { addDebugLog('warn', '⚠ 无日志可复制'); return; }
    navigator.clipboard.writeText(text).then(function() {
      addDebugLog('ok', '📋 调试日志已复制到剪贴板');
    }).catch(function() {
      addDebugLog('error', '! 复制失败');
    });
  }

  /** 下载调试日志为文件 */
  function downloadLog() {
    var text = getDebugLogText();
    if (!text) { addDebugLog('warn', '⚠ 无日志可下载'); return; }
    var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.download = 'debug_log_' + ts + '.txt';
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    addDebugLog('ok', '📥 已下载调试日志');
  }

  /** 发送调试日志到最后一条消息的输入框 */
  function sendLogToInput() {
    var text = getDebugLogText();
    if (!text) { addDebugLog('warn', '⚠ 无日志可发送'); return; }
    var input = document.getElementById('chat-input');
    if (input) {
      input.value = text;
      input.focus();
      addDebugLog('ok', '📨 调试日志已发送到输入框');
    } else {
      addDebugLog('error', '! 找不到输入框');
    }
  }

  /** 添加调试日志 */
  function addDebugLog(level, msg) {
    var body = document.getElementById('code-debug-body');
    var empty = body.querySelector('.code-debug-empty');
    if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'debug-line ' + level;
    var t = new Date().toLocaleTimeString();
    div.innerHTML = '<span class="t">[' + t + ']</span><span>' + msg + '</span>';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  /** 清空调试日志 */
  function clearDebugLog() {
    var body = document.getElementById('code-debug-body');
    body.innerHTML = '<div class="code-debug-empty">调试日志已清空</div>';
  }

  /** 代码/日志分隔线拖拽 */
  function initCodeSplitter() {
    var splitter = document.getElementById('code-splitter');
    var debugPanel = document.getElementById('code-debug');
    if (!splitter || !debugPanel) return;
    splitter.addEventListener('mousedown', function(e) {
      e.preventDefault();
      var startY = e.clientY;
      var startH = debugPanel.getBoundingClientRect().height;
      document.body.classList.add('resizing');
      splitter.classList.add('active');
      function onMove(ev) {
        var delta = ev.clientY - startY;
        var newH = Math.max(60, startH - delta);
        debugPanel.style.flexBasis = newH + 'px';
        debugPanel.style.flexBasis = newH + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        splitter.classList.remove('active');
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
// --- CodeMirror 初始化 ---
  var codeMirrorEditor = null;

  function initCodeEditor() {
    var src = document.getElementById('code-editor-src');
    codeMirrorEditor = CodeMirror(function(elt) {
      var wrap = document.getElementById('code-editor-wrap');
      wrap.appendChild(elt);
    }, {
      value: src.value || '',
      mode: 'javascript',
      theme: 'dracula',
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 2,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      extraKeys: {
        "Ctrl-Q": function(cm){ cm.foldCode(cm.getCursor()); },
        "Ctrl-/": function(cm){ cm.toggleComment(cm.getCursor()); }
      }
    });
    // 监听内容变化，同步到隐藏 textarea（用于表单提交）
    codeMirrorEditor.on('change', function() {
      src.value = codeMirrorEditor.getValue();
    });
  }

  // 页面加载完成后初始化 CodeMirror
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCodeEditor);
  } else {
    initCodeEditor();
  }
  initCodeSplitter();
