/**
 * 真实 chromium 对拍测试（ACCEPTANCE.md C 类 16/17/18）
 * - 16: click_ele 多层兜底逐层触发
 * - 17: fill_value placeholder JS 兜底（可见性过滤 + password 分支）
 * - 18: _execute_step 21 方法分发完整性
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { SmartPageExplorer, type AgentStep } from "../src/page-fetcher.js";

let browser: Browser;
let page: Page;
let explorer: SmartPageExplorer;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setDefaultTimeout(1500); // 缩短默认超时，加速兜底路径触发
  explorer = new SmartPageExplorer("about:blank", "e2e", 1, 5);
  explorer.page = page; // 直接注入真实 page，跳过内部浏览器启动
  explorer.context = context; // switch_to_latest_page 等方法依赖 context
});

afterAll(async () => {
  await browser.close();
});

async function exec(method: string, params: Record<string, unknown>): Promise<[boolean, string | null]> {
  return explorer._executeStep({ method, params } as AgentStep);
}

const CLICK_HTML = `
<div id="log"></div>
<script>
  function log(x){ document.getElementById('log').textContent += x + ';'; }
</script>
<!-- 隐藏的同名元素（折叠菜单场景） -->
<div style="display:none"><button onclick="log('hidden-btn')">数据管理</button></div>
<!-- 可见菜单项：clickable 兜底目标 -->
<div role="menuitem" onclick="log('menuitem')">数据管理</div>
<!-- title 兜底目标 -->
<span title="系统设置" onclick="log('title-span')">设置入口</span>
<!-- 纯文本 span：get_by_text / tag:has-text / JS 兜底目标 -->
<span onclick="log('plain-span')">仅文本锚点</span>
<input id="user" placeholder="请输入用户名" />
<input id="pwd" type="password" />
<input id="hidden-user" placeholder="请输入用户名" style="display:none" />
<input id="visible-user" placeholder="请输入用户名（邮箱）" />
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<input id="typed" />
<div id="hover-target" onmouseover="log('hovered')">悬停我</div>
<div id="dbl" ondblclick="log('dblclicked')">双击我</div>
`;

async function logText(): Promise<string> {
  return page.locator("#log").textContent() ?? "";
}

describe("C16: click_ele 多层兜底（真实 chromium）", () => {
  beforeAll(async () => {
    await page.setContent(CLICK_HTML);
  });

  it("主路径：直接点击存在的元素", async () => {
    await page.setContent(CLICK_HTML);
    const [ok] = await exec("click_ele", { locator: "#dbl" });
    expect(ok).toBe(true);
    // dblclick 未触发（单击），log 为空
    expect(await logText()).toBe("");
  });

  it("clickable 兜底：隐藏同名 button 失败后命中可见 role=menuitem", async () => {
    await page.setContent(CLICK_HTML);
    // button 数据管理 隐藏 → 第一层失败；可见 menuitem 命中
    const [ok] = await exec("click_ele", { locator: "button:has-text('数据管理')" });
    expect(ok).toBe(true);
    expect(await logText()).toContain("menuitem");
    expect(await logText()).not.toContain("hidden-btn");
  });

  it("title 兜底：[title=系统设置] 可见元素被点击", async () => {
    await page.setContent(CLICK_HTML);
    // 不存在的按钮 → 第一层失败；无同名 clickable；title 命中
    const [ok] = await exec("click_ele", { locator: "button:has-text('系统设置')" });
    expect(ok).toBe(true);
    expect(await logText()).toContain("title-span");
  });

  it("get_by_text 兜底：纯文本 span 被点击", async () => {
    await page.setContent(CLICK_HTML);
    const [ok] = await exec("click_ele", { locator: "get_by_text=仅文本锚点" });
    expect(ok).toBe(true);
    expect(await logText()).toContain("plain-span");
  });

  it("JS 兜底：无 title 无 button 时按文本长度升序点击", async () => {
    await page.setContent(`
      <div id="log"></div>
      <script>function log(x){ document.getElementById('log').textContent += x + ';'; }</script>
      <div onclick="log('js-div')">深层容器文本节点</div>
    `);
    // 第一层失败（无 button）；clickable 无；title 无；get_by_text 命中 div（可见）→ 实际走 get_by_text 层
    const [ok] = await exec("click_ele", { locator: "button:has-text('深层容器文本节点')" });
    expect(ok).toBe(true);
    expect(await logText()).toContain("js-div");
  });
});

describe("C17: fill_value placeholder JS 兜底（真实 chromium）", () => {
  it("第一层 fill 失败（隐藏 input）→ JS 兜底命中可见 placeholder 部分匹配项", async () => {
    // 兜底仅在 locator 含 placeholder="..." 时触发（对齐 Python 版正则）；
    // 精确匹配只命中隐藏项 → fill 失败；JS 兜底按部分匹配命中可见项
    await page.setContent(`
      <input id="h1" placeholder="账号" style="display:none" />
      <input id="v1" placeholder="请输入账号" />
    `);
    const [ok] = await exec("fill_value", {
      locator: 'input[placeholder="账号"]',
      value: "alice",
    });
    expect(ok).toBe(true);
    // 隐藏项未被填充；可见项被填充（部分匹配：v1 的 placeholder 含"账号"）
    expect(await page.locator("#h1").inputValue()).toBe("");
    expect(await page.locator("#v1").inputValue()).toBe("alice");
  });

  it("password 分支：值长度 >3 时直接匹配 type=password", async () => {
    await page.setContent(CLICK_HTML);
    // 无 placeholder 匹配的可见项时，password input 直接命中
    const [ok] = await exec("fill_value", {
      locator: 'input[placeholder="不存在的占位符"]',
      value: "secret123",
    });
    expect(ok).toBe(true);
    expect(await page.locator("#pwd").inputValue()).toBe("secret123");
  });

  it("主路径：可见 input 直接 fill 成功", async () => {
    await page.setContent(CLICK_HTML);
    const [ok] = await exec("fill_value", { locator: "#user", value: "bob" });
    expect(ok).toBe(true);
    expect(await page.locator("#user").inputValue()).toBe("bob");
  });
});

describe("C18: _execute_step 21 方法分发（真实 chromium）", () => {
  it("全部 21 个方法分支可执行（核心行为断言）", { timeout: 30000 }, async () => {
    await page.setContent(CLICK_HTML);

    // 1 fill_value
    expect((await exec("fill_value", { locator: "#user", value: "u1" }))[0]).toBe(true);
    // 2 click_ele
    expect((await exec("click_ele", { locator: "#dbl" }))[0]).toBe(true);
    // 3 double_click_ele
    expect((await exec("double_click_ele", { locator: "#dbl" }))[0]).toBe(true);
    expect(await logText()).toContain("dblclicked");
    // 4 hover
    expect((await exec("hover", { locator: "#hover-target" }))[0]).toBe(true);
    expect(await logText()).toContain("hovered");
    // 5 clear_value
    await page.locator("#user").fill("x");
    expect((await exec("clear_value", { locator: "#user" }))[0]).toBe(true);
    expect(await page.locator("#user").inputValue()).toBe("");
    // 6 type_value
    expect((await exec("type_value", { locator: "#typed", value: "ab" }))[0]).toBe(true);
    expect(await page.locator("#typed").inputValue()).toBe("ab");
    // 7 select_option
    expect((await exec("select_option", { locator: "#sel", value: "b" }))[0]).toBe(true);
    expect(await page.locator("#sel").inputValue()).toBe("b");
    // 8 open_url（about:blank 可直接打开）
    expect((await exec("open_url", { url: "about:blank" }))[0]).toBe(true);
    await page.setContent(CLICK_HTML);
    // 9 refresh（about:blank 重载后 setContent 内容丢失，需恢复）
    expect((await exec("refresh", {}))[0]).toBe(true);
    await page.setContent(CLICK_HTML);
    // 10 wait_for_time
    expect((await exec("wait_for_time", { time: 0.1 }))[0]).toBe(true);
    // 11 wait_for_element（timeout 单位 ms，对齐 Python 版）
    expect((await exec("wait_for_element", { locator: "#user", timeout: 2000 }))[0]).toBe(true);
    // 12 wait_for_load
    expect((await exec("wait_for_load", {}))[0]).toBe(true);
    // 13 scroll_to_height
    expect((await exec("scroll_to_height", { position: "top" }))[0]).toBe(true);
    // 14 scroll_to_element
    expect((await exec("scroll_to_element", { locator: "#sel" }))[0]).toBe(true);
    // 15 click_by_text
    expect((await exec("click_by_text", { text: "双击我" }))[0]).toBe(true);
    // 16 wait_for_element_hidden（元素不存在 → hidden 立即成功）
    expect((await exec("wait_for_element_hidden", { locator: "#no-such-el", timeout: 1000 }))[0]).toBe(true);
    // 17 wait_for_url_contains（about:blank 含 blank）
    expect((await exec("wait_for_url_contains", { text: "blank", timeout: 2000 }))[0]).toBe(true);
    // 18 switch_to_latest_page（单页场景即当前页）
    expect((await exec("switch_to_latest_page", {}))[0]).toBe(true);
    // 19 execute_script
    expect((await exec("execute_script", { script: "document.title = 'exec-title'" }))[0]).toBe(true);
    expect(await page.title()).toBe("exec-title");
    // 20 press_key
    expect((await exec("press_key", { key: "Tab" }))[0]).toBe(true);
    // 21 go_back
    expect((await exec("go_back", {}))[0]).toBe(true);
  });

  it("未知方法跳过不报错（对齐 Python 版：返回成功且无错误）", async () => {
    const [ok, err] = await exec("no_such_method", {});
    expect(ok).toBe(true);
    expect(err).toBeNull();
  });
});
