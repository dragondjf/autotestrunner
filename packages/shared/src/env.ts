/**
 * runner 配置（1:1 对照 brick_runner_http/config.py，环境变量全部同名）。
 */
import os from "node:os";
import path from "node:path";

function envStr(key: string, def: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
}

function envInt(key: string, def: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

function envFloat(key: string, def: number): number {
  const v = parseFloat(process.env[key] ?? "");
  return Number.isFinite(v) ? v : def;
}

function parseViewport(spec: string): { width: number; height: number } {
  // config.py RECORD_VIEWPORT: "1366,768"；解析失败回退 (1366, 768)
  const parts = String(spec).split(",").map((s) => parseInt(s.trim(), 10));
  const width = Number.isFinite(parts[0]) ? parts[0]! : 1366;
  const height = Number.isFinite(parts[1]) ? parts[1]! : 768;
  return { width, height };
}

const backendUrl = envStr("BACKEND_URL", "http://localhost:8000").replace(/\/+$/, "");

export const settings = {
  runnerId: envStr("RUNNER_ID", os.hostname()),
  runnerPort: envInt("RUNNER_PORT", 8900),
  runnerHost: envStr("RUNNER_HOST", "0.0.0.0"),
  runnerVersion: envStr("RUNNER_VERSION", "1.0.0"),
  backendUrl,
  apiKey: envStr("API_KEY", "brickcore-runner-secret"),
  internalApiKey: envStr("INTERNAL_API_KEY", "brickcore-internal-2026"),
  // config.py: os.getenv("HEADLESS", "1") == "1"
  headless: envStr("HEADLESS", "1") === "1",
  browserType: envStr("BROWSER_TYPE", "chromium"),
  maxConcurrent: envInt("MAX_CONCURRENT", 2),
  heartbeatInterval: envFloat("HEARTBEAT_INTERVAL", 10),
  debugPollInterval: envFloat("DEBUG_POLL_INTERVAL", 0.5),
  // config.py: os.getenv("RECORD_HEADLESS", "0") == "1"（录制默认 headed）
  recordHeadless: envStr("RECORD_HEADLESS", "0") === "1",
  recordHeartbeatInterval: envFloat("RECORD_HEARTBEAT_INTERVAL", 1),
  recordViewport: parseViewport(envStr("RECORD_VIEWPORT", "1366,768")),
  recordPageLoadTimeoutMs: envInt("RECORD_PAGE_LOAD_TIMEOUT_MS", 60000),
  // 录制浏览器 CDP 调试端口（>0 时开启，供自动化/调试连接操作录制浏览器）
  recordCdpPort: envInt("RECORD_CDP_PORT", 0),
  reportDir: envStr("REPORT_DIR", path.resolve(process.cwd(), "reports")),

  // 派生回调 URL（config.py BACKEND_URL + 路径）
  registerUrl: `${backendUrl}/runner/http/register`,
  heartbeatUrl: `${backendUrl}/runner/http/heartbeat`,
  progressUrl: `${backendUrl}/runner/http/progress`,
  resultUrl: `${backendUrl}/runner/http/result`,
  screenshotsUrl: `${backendUrl}/runner/http/screenshots`,
} as const;

export type Settings = typeof settings;
