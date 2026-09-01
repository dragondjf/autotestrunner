/**
 * 文件访问路由（/api/files/*）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.15。
 * 白名单目录 + 路径穿越防护；视频支持 Range（HTML5 播放器拖动）。
 */
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { wrap } from "../http-error.js";
import { bizErrors } from "../api/respond.js";
import {
  ARTIFACTS_DIR,
  BASE_DIR,
  PROJECT_FILES_DIR,
  RECORD_SESSIONS_DIR,
  RECORDINGS_DIR,
  REPORT_EXPORTS_DIR,
  TASK_FILES_DIR,
} from "../paths.js";

export const fileRouter: Router = Router();

/** 白名单根目录（相对 data/ 前缀 -> 绝对路径） */
const WHITELIST: Record<string, string> = {
  "artifacts": ARTIFACTS_DIR,
  "reports": BASE_DIR === REPORT_EXPORTS_DIR ? REPORT_EXPORTS_DIR : path.dirname(REPORT_EXPORTS_DIR),
  "task-files": TASK_FILES_DIR,
  "project-files": PROJECT_FILES_DIR,
  "record-sessions": RECORD_SESSIONS_DIR,
  "recordings": RECORDINGS_DIR,
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript",
  ".py": "text/plain; charset=utf-8",
};

function resolveSafe(relative: string): { abs: string; firstSeg: string } {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const firstSeg = normalized.split("/")[0] ?? "";
  const root = WHITELIST[firstSeg];
  if (!root) throw bizErrors.paramInvalid(`禁止访问的目录: ${firstSeg || "(空)"}`);
  const abs = path.resolve(root, normalized.slice(firstSeg.length + 1));
  // 防穿越：解析后必须仍在白名单根内
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
    throw bizErrors.paramInvalid("非法路径");
  }
  return { abs, firstSeg };
}

function serveFile(req: Request, res: Response): void {
  const relative = req.params[0] ?? "";
  const { abs } = resolveSafe(relative);

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw bizErrors.notFound("文件不存在");
  }
  if (!stat.isFile()) throw bizErrors.notFound("文件不存在");

  const ext = path.extname(abs).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  // 视频支持 Range 请求
  const range = req.headers.range;
  if (range && (ext === ".mp4" || ext === ".webm")) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.setHeader("Content-Length", String(end - start + 1));
        createReadStream(abs, { start, end }).pipe(res);
        return;
      }
    }
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`);
    res.end();
    return;
  }

  res.setHeader("Content-Length", String(stat.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // 导出文件以附件下载，其余内联
  if (ext === ".pdf" || abs.includes(path.sep + "exports" + path.sep)) {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(path.basename(abs))}"`);
  }
  createReadStream(abs).pipe(res);
}

fileRouter.get("/api/files/*", wrap(serveFile));
fileRouter.head("/api/files/*", wrap(serveFile));
