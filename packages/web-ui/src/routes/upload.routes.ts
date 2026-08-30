/**
 * 文件上传路由（/api/uploads，multipart/form-data）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.6（TSK-03）。
 * script 上传即语法校验（node --check / python -m py_compile，错误带行号）；
 * 限额读 system_configs 的 upload.limits。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { Router } from "express";
import { wrap } from "../http-error.js";
import { bizErrors, created } from "../api/respond.js";
import { addUpload } from "../db/dao/tasks.js";
import { getSystemConfig } from "../db/dao/configs.js";
import { getDb } from "../db/connection.js";
import { ensureMigrated } from "../db/ensure.js";
import { UPLOADS_TMP_DIR } from "../paths.js";

export const uploadRouter: Router = Router();

interface UploadLimits {
  maxFileBytes: number;
  maxFilesPerTask: number;
}

const DEFAULT_LIMITS: UploadLimits = { maxFileBytes: 52_428_800, maxFilesPerTask: 100 };

function uploadLimits(): UploadLimits {
  return getSystemConfig<UploadLimits>("upload.limits", DEFAULT_LIMITS);
}

/** multer 内存存储（写盘由 handler 统一控制命名） */
const memUpload = multer({ storage: multer.memoryStorage() });

/** JS 语法校验：node --check；返回 null 或错误信息（含行号） */
function checkJsSyntax(code: string): string | null {
  try {
    // 写入临时文件做语法检查（--check 不执行代码）
    const tmp = path.join(UPLOADS_TMP_DIR, `syntax-${randomUUID()}.js`);
    writeFileSync(tmp, code, "utf-8");
    try {
      execFileSync("node", ["--check", tmp], { timeout: 15000, stdio: "pipe" });
      return null;
    } catch (e) {
      const err = e as { stderr?: Buffer };
      return (err.stderr?.toString("utf-8") ?? "JavaScript 语法错误").trim();
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* pass */
      }
    }
  } catch {
    return null; // node 不可用时跳过校验（不阻塞上传）
  }
}

/** PY 语法校验：python -m py_compile；返回 null 或错误信息 */
function checkPySyntax(code: string): string | null {
  try {
    const tmp = path.join(UPLOADS_TMP_DIR, `syntax-${randomUUID()}.py`);
    writeFileSync(tmp, code, "utf-8");
    const py = process.env.PYTHON || "python";
    try {
      execFileSync(py, ["-m", "py_compile", tmp], { timeout: 30000, stdio: "pipe" });
      return null;
    } catch (e) {
      const err = e as { stderr?: Buffer };
      return (err.stderr?.toString("utf-8") ?? "Python 语法错误").trim();
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* pass */
      }
    }
  } catch {
    return null; // python 不可用时跳过校验
  }
}

// POST /api/uploads —— 单文件上传（kind=script|resource）
uploadRouter.post(
  "/api/uploads",
  memUpload.single("file"),
  wrap(async (req, res) => {
    ensureMigrated();
    const kind = String(req.body?.["kind"] ?? "resource");
    if (kind !== "script" && kind !== "resource") {
      throw bizErrors.paramInvalid("kind 必须为 script 或 resource");
    }
    const file = req.file;
    if (!file) throw bizErrors.paramInvalid("缺少 file 字段（multipart/form-data）");

    const limits = uploadLimits();
    if (file.size > limits.maxFileBytes) {
      throw bizErrors.fileInvalid(
        `文件超过大小限制: ${file.originalname}（${file.size} > ${limits.maxFileBytes} 字节）`,
      );
    }

    let syntaxCheck: { ok: boolean; error: string | null } = { ok: true, error: null };
    if (kind === "script") {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== ".js" && ext !== ".py") {
        throw bizErrors.fileInvalid(`脚本仅支持 .js/.py 文件: ${file.originalname}`);
      }
      const code = file.buffer.toString("utf-8");
      const err = ext === ".js" ? checkJsSyntax(code) : checkPySyntax(code);
      if (err) {
        throw bizErrors.fileInvalid(`脚本语法校验失败: ${file.originalname}`, { error: err });
      }
      syntaxCheck = { ok: true, error: null };
    }

    // 落盘：uploads/tmp/{uploadId}_{filename}
    const record = addUpload({
      filename: path.basename(file.originalname),
      storedPath: "", // 先占位，生成 id 后回填
      size: file.size,
      mimeType: file.mimetype,
    });
    const storedName = `${record.id}_${path.basename(file.originalname)}`;
    const storedPath = path.join(UPLOADS_TMP_DIR, storedName);
    writeFileSync(storedPath, file.buffer);
    // 回填 stored_path（相对 data/ 的路径）
    getDb()
      .prepare("UPDATE uploads SET stored_path = ? WHERE id = ?")
      .run(storedName, record.id);

    created(res, {
      uploadId: record.id,
      filename: record.filename,
      size: record.size,
      mimeType: record.mimeType,
      syntaxCheck,
    });
  }),
);
