/**
 * 乱码名称恢复工具（只读分析模式）。
 *
 * 背景：某客户端以 GBK 发送 JSON 请求体，服务端按 UTF-8 有损解码后入库，
 * 产生 "U+FFFD + 个别幸存字符" 的乱码。本脚本按前缀剪枝搜索所有满足
 *   iconv.encode(orig,'gbk').toString('utf8') === stored
 * 的候选原文，用于恢复 tasks/recording_projects/reports 的 name。
 */
const iconv = require("iconv-lite");

// 候选字符集：ASCII + 常用汉字 + 常用标点/数字
const VOCAB =
  "0123456789-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ " +
  "多标签页切换新打开关闭点执行验证录制并序顺次监控截视调浏览器测窗口弹跳转返回等待素输点击" +
  "任务计划流程测试场景平台操作完整登录每冒烟回归调debug零一二三四五六七八九十首末上下" +
  "第页面签制刷加载保存提交开始停止删除编辑复制导入导出书签历史地址栏输入框按钮菜单";

function lossyGbk(s) {
  return iconv.encode(s, "gbk").toString("utf8");
}

/** 搜索所有 orig 使 lossyGbk(orig) === stored，最多返回 limit 个 */
function recover(stored, limit = 8, maxLen = 24) {
  const results = [];
  // 前缀搜索：节点为 { origPrefix, storedPos }；用 lossyGbk(origPrefix) 必须是 stored 前缀剪枝
  // 注意 lossy 解码在末尾可能"截断"多字节序列——为避免误剪，要求 origPrefix 末尾已完整(无悬挂字节)。
  function prune(origPrefix) {
    const d = lossyGbk(origPrefix);
    return stored.startsWith(d);
  }
  function dfs(prefix) {
    if (results.length >= limit) return;
    const d = lossyGbk(prefix);
    if (d === stored) {
      results.push(prefix);
      return;
    }
    if (d.length >= stored.length) return;
    if (prefix.length >= maxLen) return;
    for (const ch of VOCAB) {
      const next = prefix + ch;
      if (prune(next)) dfs(next);
    }
  }
  dfs("");
  return results;
}

const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/autotest.db");

const targets = [];
for (const [table, idCol] of [
  ["tasks", "id"],
  ["recording_projects", "id"],
  ["reports", "id"],
]) {
  const rows = db.prepare(`SELECT id, name FROM ${table}`).all();
  for (const r of rows) {
    if (typeof r.name === "string" && r.name.includes("\uFFFD")) {
      targets.push({ table, id: r.id, name: r.name });
    }
  }
}

for (const t of targets) {
  const cands = recover(t.name);
  console.log(`[${t.table}] ${t.id}`);
  console.log("  stored   :", JSON.stringify(t.name));
  if (cands.length === 0) console.log("  NO MATCH");
  for (const c of cands) {
    console.log("  candidate:", JSON.stringify(c));
  }
}
