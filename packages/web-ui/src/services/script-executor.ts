/**
 * 脚本执行器：JS/PY 上传脚本走本地子进程（复用 exec.routes 的子进程模式）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.14（任务执行适配·双通道）。
 * 脚本约定：async run(page, params)；params 注入环境变量 AUTOTEST_PARAMS。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeEnv, resolveNodeModules } from "../routes/exec.routes.js";

export interface ScriptRunHooks {
  onLog: (level: "info" | "error" | "ok", text: string) => void;
}

export interface ScriptRunResult {
  ok: boolean;
  exitCode: number;
  error?: string;
  /** 执行过程自动截图（绝对路径，按 step_N 排序） */
  screenshots?: string[];
  /** 临时目录（调用方用后清理，保留截图文件存活） */
  tmpDir?: string;
}

/**
 * 执行 JS/PY 脚本直至退出。
 * 步骤语义：脚本自身通过 console 输出进度；Backend 记录 stdout/stderr 为日志。
 */
export async function runScript(
  code: string,
  lang: "js" | "py",
  params: Record<string, unknown>,
  hooks: ScriptRunHooks,
  cwd?: string,
): Promise<ScriptRunResult> {
  const tmpDir = path.join(os.tmpdir(), `autotest-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const suffix = lang === "js" ? ".js" : ".py";
  const scriptPath = path.join(tmpDir, `script${suffix}`);
  writeFileSync(scriptPath, code, "utf-8");
  // params 通过文件传递（避免命令行长度/转义问题）
  const paramsPath = path.join(tmpDir, "params.json");
  writeFileSync(paramsPath, JSON.stringify(params), "utf-8");

/** 收集执行截图（step_N_xxx.png，按序号排序） */
function collectShots(tmpDir: string): string[] {
  try {
    const dir = path.join(tmpDir, "shots");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

  return new Promise<ScriptRunResult>((resolve) => {
    const cmd = lang === "js" ? "node" : process.env.PYTHON || "python";
    const shotDir = path.join(tmpDir, "shots");
    mkdirSync(shotDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...nodeEnv(), AUTOTEST_PARAMS_FILE: paramsPath, AUTOTEST_SCREENSHOT_DIR: shotDir };
    // 资源文件目录注入：脚本可按相对路径引用任务资源
    if (cwd) {
      env["AUTOTEST_RESOURCES_DIR"] = cwd;
      // JS 脚本可直接 require('playwright')；Python 需自行安装
      const nm = resolveNodeModules();
      if (nm) env["NODE_PATH"] = nm + path.delimiter + (env["NODE_PATH"] ?? "");
    }
    const proc = spawn(cmd, [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cwd ?? tmpDir,
    });

    let stderrTail = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        const t = line.trim();
        if (t) hooks.onLog("info", t);
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) hooks.onLog("error", t);
      }
    });

    proc.once("close", (code) => {
      // 收集截图；tmpDir 由调用方用后清理（保证截图文件存活到复制完成）
      const shots = collectShots(tmpDir);
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        hooks.onLog("ok", "脚本执行完成 (exit 0)");
        resolve({ ok: true, exitCode, screenshots: shots, tmpDir });
      } else {
        resolve({ ok: false, exitCode, error: stderrTail || `脚本异常退出 (exit ${exitCode})`, screenshots: shots, tmpDir });
      }
    });
    proc.once("error", (err) => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* pass */
      }
      resolve({ ok: false, exitCode: -1, error: `无法启动 ${cmd}: ${err.message}` });
    });
  });
}
