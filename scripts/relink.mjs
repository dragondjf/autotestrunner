/**
 * 绿色包依赖链接重建：以源仓库 node_modules 为蓝图，
 * 在包内 app/ 对应路径重建 symlink/junction（指向包内 .pnpm 真实内容），
 * 使包脱离源仓库独立运行。文件级链接无权限时降级为内容拷贝。
 *
 * 用法: node scripts/relink.mjs <源仓库根> <包内 app 根>
 */
import { readdirSync, lstatSync, readlinkSync, symlinkSync, cpSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const srcRoot = process.argv[2];
const appRoot = process.argv[3];

function relink(rel) {
  const s = path.join(srcRoot, rel);
  const d = path.join(appRoot, rel);
  let st;
  try {
    st = lstatSync(s);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    const tgt = readlinkSync(s);
    let newTgt = tgt;
    // 绝对链接指向源仓库 → 重定向为包内同相对位置
    if (tgt.includes("autotestrunner") || path.isAbsolute(tgt)) {
      const tAbs = path.resolve(srcRoot, tgt);
      const tInApp = path.join(appRoot, path.relative(srcRoot, tAbs));
      newTgt = path.relative(path.dirname(d), tInApp);
      // 目标在包内必须存在（.pnpm 真实内容已由 tar 拷贝）
      if (!existsSyncSafe(tInApp)) return;
    }
    rmSync(d, { recursive: true, force: true });
    mkdirSync(path.dirname(d), { recursive: true });
    const isDir = existsSyncSafe(path.resolve(path.dirname(d), newTgt)) && statSyncSafe(path.resolve(path.dirname(d), newTgt))?.isDirectory();
    try {
      symlinkSync(newTgt, d, isDir ? "junction" : "file");
    } catch {
      // 无 symlink 权限：降级为真实内容拷贝
      const abs = path.resolve(path.dirname(d), newTgt);
      cpSync(abs, d, { recursive: true, force: true });
    }
    return;
  }
  if (st.isDirectory()) {
    for (const c of readdirSync(s)) relink(path.join(rel, c));
  }
}

function existsSyncSafe(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function statSyncSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

const bases = ["node_modules"];
// 全部子包的 node_modules 也需重建（web-ui / smartbrowser / runner / shared）
try {
  for (const p of readdirSync(path.join(srcRoot, "packages"))) {
    if (existsSyncSafe(path.join(srcRoot, "packages", p, "node_modules"))) {
      bases.push(path.join("packages", p, "node_modules"));
    }
  }
} catch {
  /* packages 缺失忽略 */
}
for (const base of bases) {
  if (!existsSyncSafe(path.join(srcRoot, base))) continue;
  relink(base);
}
console.log("relink done");
