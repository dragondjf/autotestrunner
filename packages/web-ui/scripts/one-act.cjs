const { chromium } = require("../node_modules/playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
  const ctx = browser.contexts()[0];
  const p0 = ctx.pages()[0];
  await p0.waitForTimeout(2500);
  await p0.evaluate(() => { const a = [...document.querySelectorAll("a")].find((x) => (x.textContent || "").includes("开始对话")); if (a) a.click(); });
  console.log("点击完成（此后不再操作，观察 15s）");
  await browser.close();
})();
