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

  /**
   * 将 smartbrowser 内部定位 DSL 转为 Playwright 原生选择器。
   * 例如：
   *   get_by_placeholder=请输入账号 → input[placeholder="请输入账号"]
   *   get_by_role=button, 登录       → [role="button"]:has-text("登录")
   *   get_by_text=保存               → :text-is("保存")
   *   get_by_label=用户名            → [aria-label="用户名"]
   *   #id / [data-testid] / CSS      → 原样保留
   */
  function toPlaywrightSelector(loc) {
    if (!loc) return loc;
    var s = String(loc).trim();
    var m;
    m = s.match(/^get_by_placeholder=(.+)$/);
    if (m) return 'input[placeholder="' + m[1].replace(/"/g, '\\"') + '"]';
    m = s.match(/^get_by_label=(.+)$/);
    if (m) return '[aria-label="' + m[1].replace(/"/g, '\\"') + '"]';
    m = s.match(/^get_by_title=(.+)$/);
    if (m) return '[title="' + m[1].replace(/"/g, '\\"') + '"]';
    m = s.match(/^get_by_alt_text=(.+)$/);
    if (m) return 'img[alt="' + m[1].replace(/"/g, '\\"') + '"]';
    m = s.match(/^get_by_role=([^,]+),\s*(.+)$/);
    if (m) return '[role="' + m[1].trim() + '"]:has-text("' + m[2].replace(/"/g, '\\"') + '")';
    m = s.match(/^get_by_role=(.+)$/);
    if (m) return '[role="' + m[1].replace(/"/g, '\\"') + '"]';
    m = s.match(/^get_by_text=(.+)$/);
    if (m) return ':text-is("' + m[1].replace(/"/g, '\\"') + '")';
    return s;
  }

  /** 将 steps[] 翻译为完整的 Playwright JS 脚本 */
  function generatePlaywrightCode(steps) {
    if (!steps || !steps.length) return '// 暂无执行步骤，请先执行一个 Agent 任务\n// 然后点击「刷新」按钮生成脚本\n';
    var h = 'const { chromium } = require(\'playwright\');\n\n(async () => {\n  const browser = await chromium.launch({ headless: false });\n  const context = await browser.newContext();\n  const page = await context.newPage();\n\n';
    var body = '';
    var currentUrl = '';
    steps.forEach(function (s) {
      body += '  // ===== Step ' + s.step + (s.desc ? ': ' + s.desc : '') + ' =====\n';
      if (s.url && s.url !== currentUrl) {
        body += '  await page.goto(\'' + codeEscape(s.url) + '\');\n';
        currentUrl = s.url;
      }
      var method = s.method || '';
      var loc = toPlaywrightSelector(s.locator ? s.locator : (s.selector || ''));
      var val = s.value || '';
      switch (method) {
        case 'click':
          body += '  await page.click(\'' + codeEscape(loc) + '\');\n'; break;
        case 'fill':
        case 'type':
          body += '  await page.fill(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\');\n'; break;
        case 'select':
          body += '  await page.selectOption(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\');\n'; break;
        case 'navigate':
          body += '  await page.goto(\'' + codeEscape(val || s.url) + '\');\n'; break;
        case 'wait_for_selector':
          body += '  await page.waitForSelector(\'' + codeEscape(loc) + '\', { timeout: 5000 });\n'; break;
        case 'screenshot':
          body += '  await page.screenshot({ path: \'screenshot_step_' + s.step + '.png\' });\n'; break;
        case 'press':
          body += '  await page.press(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\');\n'; break;
        case 'hover':
          body += '  await page.hover(\'' + codeEscape(loc) + '\');\n'; break;
        case 'check':
          body += '  await page.check(\'' + codeEscape(loc) + '\');\n'; break;
        case 'uncheck':
          body += '  await page.uncheck(\'' + codeEscape(loc) + '\');\n'; break;
        case 'click_at':
          body += '  await page.mouse.click(' + (s.sx || 0) + ', ' + (s.sy || 0) + ');\n'; break;
        case 'drag':
          body += '  await page.mouse.move(' + (s.sx || 0) + ', ' + (s.sy || 0) + ');\n';
          body += '  await page.mouse.down();\n';
          body += '  await page.mouse.move(' + (s.ex || 0) + ', ' + (s.ey || 0) + ', { steps: 8 });\n';
          body += '  await page.mouse.up();\n'; break;
        default:
          if (loc) {
            if (val) body += '  await page.fill(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\');\n';
            else body += '  await page.click(\'' + codeEscape(loc) + '\');\n';
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
    steps.forEach(function (s) {
      body += '    # ===== Step ' + s.step + (s.desc ? ': ' + s.desc : '') + ' =====\n';
      if (s.url && s.url !== currentUrl) {
        body += '    page.goto(\'' + codeEscape(s.url) + '\')\n';
        currentUrl = s.url;
      }
      var method = s.method || '';
      var loc = toPlaywrightSelector(s.locator ? s.locator : (s.selector || ''));
      var val = s.value || '';
      switch (method) {
        case 'click':
          body += '    page.click(\'' + codeEscape(loc) + '\')\n'; break;
        case 'fill':
        case 'type':
          body += '    page.fill(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\')\n'; break;
        case 'select':
          body += '    page.select_option(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\')\n'; break;
        case 'navigate':
          body += '    page.goto(\'' + codeEscape(val || s.url) + '\')\n'; break;
        case 'wait_for_selector':
          body += '    page.wait_for_selector(\'' + codeEscape(loc) + '\', timeout=5000)\n'; break;
        case 'screenshot':
          body += '    page.screenshot(path=\'screenshot_step_' + s.step + '.png\')\n'; break;
        case 'press':
          body += '    page.press(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\')\n'; break;
        case 'hover':
          body += '    page.hover(\'' + codeEscape(loc) + '\')\n'; break;
        case 'check':
          body += '    page.check(\'' + codeEscape(loc) + '\')\n'; break;
        case 'uncheck':
          body += '    page.uncheck(\'' + codeEscape(loc) + '\')\n'; break;
        default:
          if (loc) {
            if (val) body += '    page.fill(\'' + codeEscape(loc) + '\', \'' + codeEscape(val) + '\')\n';
            else body += '    page.click(\'' + codeEscape(loc) + '\')\n';
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
    toPlaywrightSelector: toPlaywrightSelector,
    codeEscape: codeEscape
  };
})(window);
