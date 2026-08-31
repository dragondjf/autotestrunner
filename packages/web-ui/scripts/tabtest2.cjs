const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  let page = await context.newPage();
  await page.goto("http://127.0.0.1:8100/b");
  console.log("url:", page.url());
  console.log("input[placeholder] 数量:", await page.locator('input[placeholder="搜索"]').count());
  console.log("input 数量:", await page.locator("input").count());
  console.log("HTML:", (await page.content()).slice(0, 300));
  await browser.close();
})();
