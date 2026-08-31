const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  console.log("初始 tabs:", pages.length);
  // 1. 在页面 A 点击 target=_blank 链接 → 打开新 tab
  await pages[0].click("#open-new");
  await new Promise((r) => setTimeout(r, 2500));
  const after = ctx.pages();
  console.log("点击后 tabs:", after.length, "| 新页 url:", after[1]?.url());
  // 2. 在新 tab 输入（模拟用户在新页操作）
  await after[after.length - 1].fill("input[name=search]", "hello-tab");
  await after[after.length - 1].click("button");
  await new Promise((r) => setTimeout(r, 2500)); // 等心跳采集
  // 3. 切回页面 A 再点一次（测试返回切换）
  await pages[0].bringToFront();
  await new Promise((r) => setTimeout(r, 2500));
  console.log("操作完成");
  await browser.close();
})();
