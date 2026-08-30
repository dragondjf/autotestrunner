/**
 * 测试前置：把路径指向临时目录，避免污染真实的 agent_web_ui 目录与 llm_configs.json。
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(path.join(os.tmpdir(), "brickcore-webui-"));
mkdirSync(path.join(dir, "assets"), { recursive: true });
mkdirSync(path.join(dir, "static", "screenshots", "explore"), { recursive: true });
writeFileSync(path.join(dir, "index.html"), "<html><body>index</body></html>");
writeFileSync(path.join(dir, "inspect.html"), "<html><body>inspect</body></html>");
writeFileSync(path.join(dir, "code-generator.js"), "window.CodeGenerator = {};");
writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app');");

process.env.WEB_UI_DIR = dir;
process.env.STATIC_DIR = path.join(dir, "static");
