/**
 * 脚本执行路由（Node / Python 子进程 + SSE 日志流）。
 * 1:1 对照 agent_web_ui/server_pkg/exec_routes.py。
 */
import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import readline from "node:readline";
import { Router, type Response } from "express";
import { AsyncQueue, SSE_HEADERS } from "@brickcore/shared";
import { ARTIFACTS_DIR } from "../paths.js";
import { readJsonBody, wrap } from "../http-error.js";

export const execRouter: Router = Router();

type LogEvent = { type: "log"; level: "info" | "error" | "ok"; text: string };
/** 步骤事件：生成脚本的 autoShot 每步输出 @@STEP@@ 标记行 → SSE 实时推给前端时间线 */
type StepEvent = {
  type: "step";
  step: number;
  desc: string;
  method: string;
  locator: string;
  url: string;
  screenshot: string;
};
const STEP_MARK = "@@STEP@@";
const DEBUG_SHOTS_REL = "artifacts/debug-shots";

// ---------------- NODE_PATH 解析 ----------------
let _NODE_MODULES_PATH: string | null = null;
let _NODE_MODULES_RESOLVED = false;

/**
 * 定位 npm 全局 node_modules（node 子进程 require('playwright') 依赖它）。
 * 脚本写在系统临时目录，node 从临时目录向上找不到 node_modules；
 * playwright 由 npm 全局安装，用 `npm root -g` 解析并注入 NODE_PATH。
 */
export function resolveNodeModules(): string | null {
  if (_NODE_MODULES_RESOLVED) return _NODE_MODULES_PATH;
  let found = "";
  try {
    // Windows 上 npm 是 npm.cmd，subprocess 无法直接执行，用 cmd /c 解析
    const root =
      os.platform() === "win32"
        ? execFileSync("cmd", ["/c", "npm root -g"], { encoding: "utf8", timeout: 10000 }).trim()
        : execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 }).trim();
    if (root && isDir(path.join(root, "playwright"))) found = root;
  } catch {
    /* pass */
  }
  _NODE_MODULES_PATH = found;
  _NODE_MODULES_RESOLVED = true;
  return found || null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** node 子进程环境：注入 NODE_PATH 使 require('playwright') 可解析。 */
export function nodeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env } as Record<string, string | undefined>;
  const nm = resolveNodeModules();
  if (nm) {
    const sep = path.delimiter;
    env["NODE_PATH"] = nm + (env["NODE_PATH"] ? sep + env["NODE_PATH"] : "");
  }
  return env as NodeJS.ProcessEnv;
}

// ---------------- SSE 泵 ----------------
async function pumpStream(
  res: Response,
  queue: AsyncQueue<LogEvent | StepEvent | { type: "done" }>,
): Promise<void> {
  while (true) {
    let evt: LogEvent | StepEvent | { type: "done" };
    try {
      // 对齐 asyncio.wait_for(queue.get(), 1.0)：超时继续循环
      evt = await queue.get(1000);
    } catch {
      continue;
    }
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (evt.type === "done") break;
  }
}

interface ScriptSpec {
  suffix: ".js" | ".py";
  startText: string;
  okText: (code: number) => string;
  errText: (code: number) => string;
  notFoundText?: string;
  spawnCmd: () => string;
  env?: () => NodeJS.ProcessEnv;
}

async function runScriptStream(
  req: { code: string; stepIntervalMs?: number },
  spec: ScriptSpec,
  res: Response,
): Promise<void> {
  const tmpPath = path.join(os.tmpdir(), `brickcore-${randomUUID()}${spec.suffix}`);
  await writeFile(tmpPath, req.code, "utf-8");

  // 调试截图目录：注入白名单路径（artifacts/debug-shots/<runId>），前端经 /api/files 实时取图
  const runId = randomUUID().slice(0, 8);
  const shotDir = path.join(ARTIFACTS_DIR, "debug-shots", runId);

  const queue = new AsyncQueue<LogEvent | StepEvent | { type: "done" }>();

  const execute = async (): Promise<void> => {
    try {
      queue.put({ type: "log", level: "info", text: spec.startText });
      const cmd = spec.spawnCmd();
      const env = spec.env?.() ?? process.env;
      env["AUTOTEST_SCREENSHOT_DIR"] = shotDir;
      // 步骤间隔（ms）：生成脚本每步 autoShot 后等待，避免跑得过快看不清过程
      if ((req.stepIntervalMs ?? 0) > 0) env["AUTOTEST_STEP_INTERVAL_MS"] = String(req.stepIntervalMs);
      const proc = spawn(cmd, [tmpPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const readStream = (stream: NodeJS.ReadableStream, level: "info" | "error"): Promise<void> =>
        new Promise<void>((resolve) => {
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          rl.on("line", (line: string) => {
            // Python: decode(errors="replace").rstrip()，空行跳过
            const text = line.replace(/\s+$/, "");
            if (!text) return;
            // 步骤标记行（stdout）：转 step 事件（截图 URL 指向白名单目录），不进日志流
            if (level === "info" && text.startsWith(STEP_MARK)) {
              try {
                const m = JSON.parse(text.slice(STEP_MARK.length)) as Record<string, unknown>;
                queue.put({
                  type: "step",
                  step: Number(m["step"] ?? 0),
                  desc: String(m["desc"] ?? ""),
                  method: String(m["method"] ?? ""),
                  locator: String(m["locator"] ?? ""),
                  url: String(m["url"] ?? ""),
                  screenshot: m["shot"]
                    ? `/api/files/${DEBUG_SHOTS_REL}/${runId}/${String(m["shot"])}`
                    : "",
                });
              } catch {
                /* 非法标记行丢弃 */
              }
              return;
            }
            queue.put({ type: "log", level, text });
          });
          rl.on("close", () => resolve());
        });

      await Promise.all([readStream(proc.stdout!, "info"), readStream(proc.stderr!, "error")]);

      const retcode: number = await new Promise<number>((resolve) => {
        proc.once("close", (code) => resolve(code ?? 0));
        proc.once("error", () => resolve(-1));
      });

      if (retcode === 0) {
        queue.put({ type: "log", level: "ok", text: spec.okText(0) });
      } else {
        queue.put({ type: "log", level: "error", text: spec.errText(retcode) });
      }
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      if (err?.code === "ENOENT" && spec.notFoundText) {
        queue.put({ type: "log", level: "error", text: spec.notFoundText });
      } else {
        queue.put({
          type: "log",
          level: "error",
          text: `❌ 执行异常: ${String(err?.message ?? e).slice(0, 200)}`,
        });
      }
    } finally {
      try {
        await unlink(tmpPath);
      } catch {
        /* pass */
      }
      queue.put({ type: "done" });
    }
  };

  void execute();

  const head: Record<string, string> = {
    ...SSE_HEADERS,
    "Content-Type": "text/event-stream",
  };
  res.writeHead(200, head);
  res.flushHeaders?.();
  await pumpStream(res, queue);
  res.end();
}

// ---------------- 路由 ----------------
execRouter.post(
  "/api/agent/run-script",
  wrap(async (req, res) => {
    /** 接收 JS 代码，用 node 子进程执行，SSE 流式返回 stdout/stderr。 */
    const body = await readJsonBody(req);
    const code = String(body["code"] ?? "");
    const stepIntervalMs = Math.max(0, Number(body["stepIntervalMs"] ?? 0) || 0);
    await runScriptStream(
      { code, stepIntervalMs },
      {
        suffix: ".js",
        startText: "🚀 执行 JavaScript 脚本 (node)…",
        okText: () => "✅ JS 脚本执行完成 (exit 0)",
        errText: (c) => `❌ JS 脚本异常退出 (exit ${c})`,
        notFoundText: "❌ 未找到 node 命令，请确认已安装 Node.js",
        spawnCmd: () => "node",
        env: () => nodeEnv(),
      },
      res,
    );
  }),
);

execRouter.post(
  "/api/agent/run-python",
  wrap(async (req, res) => {
    /** 接收 Python 代码，用 python 子进程执行，SSE 流式返回 stdout/stderr。 */
    const body = await readJsonBody(req);
    const code = String(body["code"] ?? "");
    await runScriptStream(
      { code },
      {
        suffix: ".py",
        startText: "🚀 执行 Python 脚本…",
        okText: () => "✅ Python 脚本执行完成 (exit 0)",
        errText: (c) => `❌ Python 脚本异常退出 (exit ${c})`,
        spawnCmd: () => process.env.PYTHON || "python",
      },
      res,
    );
  }),
);
