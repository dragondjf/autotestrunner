const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  let page = await context.newPage();
  await page.goto("http://127.0.0.1:8100/");
  console.log("1. 首页:", page.url());
  const [newPage] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }).catch(() => null),
    page.click("#open-new"),
  ]);
  if (newPage) { page = newPage; await page.waitForLoadState("domcontentloaded").catch(() => {}); }
  console.log("2. 点击后当前页:", page.url(), "| tabs:", context.pages().length);
  const n = await page.locator('[role="textbox"][placeholder="搜索"], [role="textbox"][aria-label="搜索"]').count();
  console.log("3. 新页 textbox 数量:", n);
  if (n > 0) {
    await page.fill('[role="textbox"][placeholder="搜索"], [role="textbox"][aria-label="搜索"]', "hello");
    console.log("4. fill 成功 ✓");
  } else {
    console.log("4. textbox 未找到 ✗");
  }
  await browser.close();
})();
