/**
 * 脚本回放录制器：逐步执行项目步骤流 + Playwright recordVideo（REC-B06）。
 * 产出 data/recordings/{runId}.webm（无 ffmpeg 时保持 webm，HTML5 可播；决策记录 #4）。
 * 定位器格式与 script-generator 同源（CSS / Playwright 文本定位）。
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { RECORDINGS_DIR } from "../paths.js";
import { newId } from "../db/ids.js";
import { logger } from "../logging.js";

export interface RecordStep {
  method: string;
  params?: { value?: string; x?: number; y?: number };
  locator?: { primary?: string } | string;
}

export interface ScriptRunRecordingResult {
  videoPath: string; // 相对 data/
  stepsCompleted: number;
  durationMs: number;
}

/** 逐步执行 + 录屏（与 script-generator 方法集对齐） */
export async function recordScriptRun(
  steps: RecordStep[],
  startUrl: string,
): Promise<ScriptRunRecordingResult> {
  const runId = newId("run").slice(0, 18);
  const videoDir = path.join(RECORDINGS_DIR, runId);
  mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const t0 = Date.now();
  let completed = 0;
  try {
    for (const s of steps) {
      const method = s.method;
      const val = String(s.params?.value ?? "");
      const x = Number(s.params?.x ?? 0);
      const y = Number(s.params?.y ?? 0);
      const loc = typeof s.locator === "string" ? s.locator : String(s.locator?.primary ?? "");
      switch (method) {
        case "open_url":
        case "navigate":
        case "goto":
          await page.goto(val || startUrl, { waitUntil: "domcontentloaded" });
          break;
        case "fill_value":
        case "fill":
        case "type_value":
        case "type":
          if (loc) await page.fill(loc, val);
          break;
        case "click_ele":
        case "click":
        case "click_by_text":
          await page.click(loc || val);
          break;
        case "click_at":
          await page.mouse.click(x, y);
          break;
        case "select_option":
        case "select":
          if (loc) await page.selectOption(loc, val);
          break;
        case "press_key":
        case "press":
          if (loc) await page.press(loc, val);
          break;
        case "hover":
          if (loc) await page.hover(loc);
          break;
        case "wait_for_element":
        case "wait_for_selector":
          if (loc) await page.waitForSelector(loc, { timeout: 5000 });
          break;
        case "wait_for_time":
          await page.waitForTimeout(Number(val) || 1000);
          break;
        default:
          // 未知方法：有定位器则尝试 click（容错）
          if (loc) await page.click(loc).catch(() => {});
          break;
      }
      completed++;
      await page.waitForTimeout(400); // 步间留帧
    }
  } finally {
    await browser.close(); // 触发 video 落盘
  }
  // recordVideo 产物：{runId}.webm（目录内第一个 .webm）
  const files = readdirSync(videoDir) as string[];
  const videoFile = files.find((f) => f.endsWith(".webm"));
  const rel = videoFile ? `recordings/${runId}/${videoFile}` : "";
  if (!videoFile) logger.warning("[record] 录屏产物缺失 %s", runId);
  return { videoPath: rel, stepsCompleted: completed, durationMs: Date.now() - t0 };
}
