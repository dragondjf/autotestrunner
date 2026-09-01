/**
 * code-generator.js
 * 代码生成核心逻辑：将执行步骤 steps[] 翻译为 Playwright JS / Python / JSON 脚本。
 * 由 agent_web_ui/index.html 引入，通过全局对象 CodeGenerator 调用。
 */
(function (global) {
  'use strict';

  /** 对单引号/反斜杠/换行做转义，用于生成代码字面量 */
  function codeEscape(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
  }

  /** 压平多行文本（desc 可能含换行），避免嵌入注释时产生非法代码 */
  function oneLine(s) {
    return String(s == null ? '' : s).replace(/\s*\r?\n\s*/g, ' ').trim();
  }

  /** DSL 值去两侧成对包裹引号；字面 \n 序列归一为空格（Playwright 文本匹配做空白归一化） */
  function unquoteVal(v) {
    var t = String(v == null ? '' : v).trim();
    if (t.length >= 2 && ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') ||
        (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'"))) {
      t = t.slice(1, -1).trim();
    }
    return t.replace(/\\n/g, ' ');
  }

  /**
   * 平台定位 DSL → Playwright 原生定位表达式（不含 page. 锚，链式段以 . 连接）。
   * 定位规则（高→低）：getByRole > getByText > getByLabel > getByPlaceholder
   * > getByAltText > getByTitle > getByTestId > CSS > XPath（最后考虑）。
   * 语义与运行时解析器（locator-utils）保持一致。
   */
  function toPlaywrightExpr(loc) {
    var raw = String(loc == null ? '' : loc).trim();
    if (!raw) return '';
    function seg(s) {
      var m;
      m = s.match(/^get_by_role=([^,]+),\s*([\s\S]+)$/);
      if (m) {
        var role = unquoteVal(m[1]).trim();
        var name = unquoteVal(m[2]);
        // LLM 变体：title= 非 accessible name → 退 getByTitle；name= 前缀剥离
        var tm = name.match(/^title=["']?([\s\S]*?)["']?$/);
        if (tm) return "getByTitle('" + codeEscape(unquoteVal(tm[1])) + "')";
        var nm = name.match(/^name=["']?([\s\S]*?)["']?$/);
        if (nm) name = unquoteVal(nm[1]);
        return name
          ? "getByRole('" + role + "', { name: '" + codeEscape(name) + "' })"
          : "getByRole('" + role + "')";
      }
      m = s.match(/^get_by_role=(.+)$/);
      if (m) return "getByRole('" + unquoteVal(m[1]).trim() + "')";
      m = s.match(/^get_by_text=([\s\S]+)$/);
      if (m) return "getByText('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^get_by_label=([\s\S]+)$/);
      if (m) return "getByLabel('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^get_by_placeholder=([\s\S]+)$/);
      if (m) return "getByPlaceholder('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^get_by_alt_text=([\s\S]+)$/);
      if (m) return "getByAltText('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^get_by_title=([\s\S]+)$/);
      if (m) return "getByTitle('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^get_by_test_id=([\s\S]+)$/);
      if (m) return "getByTestId('" + codeEscape(unquoteVal(m[1])) + "')";
      m = s.match(/^nth\s*=\s*(\d+)$/);
      if (m) return 'nth(' + m[1] + ')';
      // 绝对 XPath（/html/...）需显式 xpath= 前缀；// 开头 Playwright 自动识别
      var sel = /^\/(?!\/)/.test(s) ? 'xpath=' + s : s;
      return "locator('" + codeEscape(sel) + "')";
    }
    return raw.split(' >> ').map(function (p) { return seg(p.trim()); }).join('.');
  }

  /** Python 版定位表达式（page.get_by_role(...)，不带 page. 锚） */
  function toPlaywrightExprPy(loc) {
    return toPlaywrightExpr(loc)
      .replace(/getByRole\('([^']+)',\s*\{\s*name: ('[^']*')\s*\}\)/g, "get_by_role('$1', name=$2)")
      .replace(/getByRole\('([^']+)'\)/g, "get_by_role('$1')")
      .replace(/getByText\(/g, 'get_by_text(')
      .replace(/getByLabel\(/g, 'get_by_label(')
      .replace(/getByPlaceholder\(/g, 'get_by_placeholder(')
      .replace(/getByAltText\(/g, 'get_by_alt_text(')
      .replace(/getByTitle\(/g, 'get_by_title(')
      .replace(/getByTestId\(/g, 'get_by_test_id(');
  }

  /** 将 steps[] 翻译为完整的 Playwright JS 脚本 */
  function generatePlaywrightCode(steps) {
    if (!steps || !steps.length) return '// 暂无执行步骤，请先执行一个 Agent 任务\n// 然后点击「刷新」按钮生成脚本\n';
    var h = 'const { chromium } = require(\'playwright\');\n\n(async () => {\n  const browser = await chromium.launch({ headless: false });\n  const context = await browser.newContext();\n  const page = await context.newPage();\n\n';
    var body = '';
    var currentUrl = '';
    steps.forEach(function (s, idx) {
      // 双通道录制的时间线 step 号可能重复/乱序 → 按输出顺序重编
      body += '  // ===== Step ' + (idx + 1) + (s.desc ? ': ' + oneLine(s.desc) : '') + ' =====\n';
      if (s.url && s.url !== currentUrl) {
        body += '  await page.goto(\'' + codeEscape(s.url) + '\');\n';
        currentUrl = s.url;
      }
      var method = s.method || '';
      var ex = toPlaywrightExpr(s.locator ? s.locator : (s.selector || ''));
      var val = s.value || '';
      switch (method) {
        case 'click':
          if (ex) body += '  await page.' + ex + '.click();\n';
          break;
        case 'fill':
        case 'type':
          if (ex) body += '  await page.' + ex + '.fill(\'' + codeEscape(val) + '\');\n';
          break;
        case 'select':
          if (ex) body += '  await page.' + ex + '.selectOption(\'' + codeEscape(val) + '\');\n';
          break;
        case 'navigate':
          body += '  await page.goto(\'' + codeEscape(val || s.url) + '\');\n';
          break;
        case 'wait_for_selector':
          if (ex) body += '  await page.' + ex + '.waitFor({ timeout: 5000 });\n';
          break;
        case 'screenshot':
          body += '  await page.screenshot({ path: \'screenshot_step_' + s.step + '.png\' });\n';
          break;
        case 'press':
          body += ex
            ? '  await page.' + ex + '.press(\'' + codeEscape(val) + '\');\n'
            : '  await page.keyboard.press(\'' + codeEscape(val) + '\');\n';
          break;
        case 'hover':
          if (ex) body += '  await page.' + ex + '.hover();\n';
          break;
        case 'check':
          if (ex) body += '  await page.' + ex + '.check();\n';
          break;
        case 'uncheck':
          if (ex) body += '  await page.' + ex + '.uncheck();\n';
          break;
        case 'click_at':
          body += '  await page.mouse.click(' + (s.sx || 0) + ', ' + (s.sy || 0) + ');\n';
          break;
        case 'drag':
          body += '  await page.mouse.move(' + (s.sx || 0) + ', ' + (s.sy || 0) + ');\n';
          body += '  await page.mouse.down();\n';
          body += '  await page.mouse.move(' + (s.ex || 0) + ', ' + (s.ey || 0) + ', { steps: 8 });\n';
          body += '  await page.mouse.up();\n';
          break;
        default:
          if (ex) {
            if (val) body += '  await page.' + ex + '.fill(\'' + codeEscape(val) + '\');\n';
            else body += '  await page.' + ex + '.click();\n';
          }
          break;
      }
      if (s.screenshot) {
        body += '  await page.screenshot({ path: \'screenshot_step_' + s.step + '.png\' });\n';
      }
      body += '\n';
    });
    var foot = '  await browser.close();\n})();\n';
    return h + body + foot;
  }

  /** 将 steps[] 翻译为完整的 Python Playwright 脚本 */
  function generatePythonCode(steps) {
    if (!steps || !steps.length) return '# 暂无执行步骤，请先执行一个 Agent 任务\n# 然后点击「刷新」按钮生成脚本\n';
    var h = 'from playwright.sync_api import sync_playwright\n\n\ndef run():\n    with sync_playwright() as p:\n        browser = p.chromium.launch(headless=False)\n        context = browser.new_context()\n        page = context.new_page()\n\n';
    var body = '';
    var currentUrl = '';
    steps.forEach(function (s, idx) {
      body += '        # ===== Step ' + (idx + 1) + (s.desc ? ': ' + oneLine(s.desc) : '') + ' =====\n';
      if (s.url && s.url !== currentUrl) {
        body += '        page.goto(\'' + codeEscape(s.url) + '\')\n';
        currentUrl = s.url;
      }
      var method = s.method || '';
      var ex = toPlaywrightExprPy(s.locator ? s.locator : (s.selector || ''));
      var val = s.value || '';
      switch (method) {
        case 'click':
          if (ex) body += '        page.' + ex + '.click()\n';
          break;
        case 'fill':
        case 'type':
          if (ex) body += '        page.' + ex + '.fill(\'' + codeEscape(val) + '\')\n';
          break;
        case 'select':
          if (ex) body += '        page.' + ex + '.select_option(\'' + codeEscape(val) + '\')\n';
          break;
        case 'navigate':
          body += '        page.goto(\'' + codeEscape(val || s.url) + '\')\n';
          break;
        case 'wait_for_selector':
          if (ex) body += '        page.' + ex + '.wait_for(timeout=5000)\n';
          break;
        case 'screenshot':
          body += '        page.screenshot(path=\'screenshot_step_' + s.step + '.png\')\n';
          break;
        case 'press':
          body += ex
            ? '        page.' + ex + '.press(\'' + codeEscape(val) + '\')\n'
            : '        page.keyboard.press(\'' + codeEscape(val) + '\')\n';
          break;
        case 'hover':
          if (ex) body += '        page.' + ex + '.hover()\n';
          break;
        case 'check':
          if (ex) body += '        page.' + ex + '.check()\n';
          break;
        case 'uncheck':
          if (ex) body += '        page.' + ex + '.uncheck()\n';
          break;
        default:
          if (ex) {
            if (val) body += '        page.' + ex + '.fill(\'' + codeEscape(val) + '\')\n';
            else body += '        page.' + ex + '.click()\n';
          }
          break;
      }
      body += '\n';
    });
    var foot = '        browser.close()\n\n\nrun()\n';
    return h + body + foot;
  }

  /** 将 steps[] 导出为 JSON 格式 */
  function generateJsonCode(steps) {
    if (!steps || !steps.length) return '// 暂无执行步骤，请先执行一个 Agent 任务\n// 然后点击「刷新」按钮生成脚本\n';
    return JSON.stringify(steps, null, 2);
  }

  /** 根据语言生成代码 */
  function generate(steps, lang) {
    if (lang === 'py') return generatePythonCode(steps);
    if (lang === 'json') return generateJsonCode(steps);
    return generatePlaywrightCode(steps);
  }

  // 暴露全局接口
  global.CodeGenerator = {
    generate: generate,
    generatePlaywrightCode: generatePlaywrightCode,
    generatePythonCode: generatePythonCode,
    generateJsonCode: generateJsonCode,
    toPlaywrightExpr: toPlaywrightExpr,
    toPlaywrightExprPy: toPlaywrightExprPy,
    codeEscape: codeEscape,
    oneLine: oneLine
  };
})(window);
