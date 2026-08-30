/**
 * 执行记录器：为每次执行生成 reports/<ts>_<suite_execution_id>/ 目录
 * （execution.json + index.html + screenshots/）。
 * 1:1 对照 brick_runner_http/runner/execution_recorder.py。
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { settings } from "@brickcore/shared";

// ── 裁剪上限，避免超大内存/文件 ──
export const MAX_NETWORK_PER_STEP = 200;
export const MAX_NETWORK_TOTAL = 2000;
export const MAX_CONSOLE = 500;
export const MAX_BODY_CHARS = 4000;

function nowIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function tsName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 文本截断（超限时追加「…[截断，共 N 字符]」） */
export function shorten(text: string | null | undefined, limit: number): string | null {
  if (text === null || text === undefined) return null;
  if (text.length > limit) return text.slice(0, limit) + `\n…[截断，共 ${text.length} 字符]`;
  return text;
}

export interface NetworkEntry {
  step_index: number;
  url: string;
  status: number | null;
  status_text: string | null;
  method: string;
  resource_type: string | null;
  post_data: string | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  body: string | null;
}

export interface ConsoleEntry {
  step_index: number;
  type: string;
  text: string | null;
}

/** 绑定单个 Playwright Page，采集网络协议 + console 日志 */
export class PageCapture {
  currentStep = -1;
  network: NetworkEntry[] = [];
  console: ConsoleEntry[] = [];

  attach(page: Page): PageCapture {
    page.on("response", (r) => void this.onResponse(r));
    page.on("console", (m) => void this.onConsole(m));
    return this;
  }

  private async onResponse(response: any): Promise<void> {
    try {
      const req = response.request();
      let postData: string | null = null;
      try {
        if (req.postData()) postData = shorten(req.postData(), MAX_BODY_CHARS);
      } catch {
        postData = null;
      }
      const entry: NetworkEntry = {
        step_index: this.currentStep,
        url: response.url(),
        status: response.status ? Number(response.status) : null,
        status_text: response.statusText ? String(response.statusText) : null,
        method: req.method(),
        resource_type: req.resourceType ? String(req.resourceType()) : null,
        post_data: postData,
        request_headers: Object.fromEntries(Object.entries(req.headers() ?? {}).slice(0, 100)) as Record<string, string>,
        response_headers: Object.fromEntries(Object.entries(response.headers() ?? {}).slice(0, 100)) as Record<string, string>,
        body: null,
      };
      this.network.push(entry);
      if (this.network.length >= MAX_NETWORK_TOTAL) this.network.splice(0, 100);
      // 异步读取响应体，不阻塞事件入列
      void this.fillBody(entry, response);
    } catch {
      /* pass */
    }
  }

  private async fillBody(entry: NetworkEntry, response: any): Promise<void> {
    try {
      const body = await Promise.race([
        response.body(),
        new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]);
      entry.body = shorten(
        Buffer.from(body as Uint8Array).toString("utf-8"),
        MAX_BODY_CHARS,
      );
    } catch {
      entry.body = null;
    }
  }

  private async onConsole(msg: any): Promise<void> {
    try {
      this.console.push({
        step_index: this.currentStep,
        type: String(msg.type()),
        text: shorten(msg.text(), MAX_BODY_CHARS),
      });
      if (this.console.length > MAX_CONSOLE) this.console.splice(0, 50);
    } catch {
      /* pass */
    }
  }

  /** 取出指定步骤的网络/console 事件（按 step_index 过滤） */
  take(stepIndex: number): { network: NetworkEntry[]; console: ConsoleEntry[] } {
    return {
      network: this.network.filter((e) => e["step_index"] === stepIndex).slice(0, MAX_NETWORK_PER_STEP),
      console: this.console.filter((c) => c["step_index"] === stepIndex),
    };
  }

  takeAll(): { network: NetworkEntry[]; console: ConsoleEntry[] } {
    return { network: this.network, console: this.console };
  }
}

type StepRecord = Record<string, any>;
type CaseRecord = Record<string, any>;

/** 一次执行（一个 suite 任务）的完整记录器 */
export class ExecutionRecorder {
  readonly suiteExecutionId: number;
  readonly suite: Record<string, any>;
  readonly env: Record<string, any>;
  readonly runnerId: string;
  readonly dir: string;
  readonly shotsDir: string;
  readonly startedAt: string;
  readonly jsonPath: string;
  readonly htmlPath: string;

  private readonly _preSteps: StepRecord[] = [];
  private readonly _cases = new Map<number, CaseRecord>();
  private readonly _captures = new Map<number, PageCapture>();
  private readonly _caseOrder: number[] = [];

  constructor(suiteExecutionId: number, suite: Record<string, any>, env: Record<string, any>, runnerId: string) {
    this.suiteExecutionId = suiteExecutionId;
    this.suite = suite ?? {};
    this.env = env ?? {};
    this.runnerId = runnerId;

    const base = settings.reportDir;
    const ts = tsName();
    const name = `${ts}_${suiteExecutionId}`;
    let dir = path.join(base, name);
    let counter = 1;
    while (existsSync(dir)) {
      dir = path.join(base, `${name}_${counter}`);
      counter += 1;
    }
    this.dir = dir;
    this.shotsDir = path.join(dir, "screenshots");
    mkdirSync(this.shotsDir, { recursive: true });
    this.startedAt = nowIso();
    this.jsonPath = path.join(dir, "execution.json");
    this.htmlPath = path.join(dir, "index.html");
  }

  // ── 用例生命周期 ──
  beginCase(executionId: number, caseId: unknown, name: string, page: Page): void {
    const capture = new PageCapture();
    capture.attach(page);
    this._captures.set(executionId, capture);
    this._cases.set(executionId, {
      execution_id: executionId,
      case_id: caseId,
      name,
      status: "pending",
      error: null,
      started_at: nowIso(),
      ended_at: null,
      duration_ms: null,
      steps: [],
    });
    this._caseOrder.push(executionId);
  }

  endCase(executionId: number, status: string, error?: string | null): void {
    const c = this._cases.get(executionId);
    if (!c) return;
    c["status"] = status;
    c["error"] = error ?? null;
    c["ended_at"] = nowIso();
    const started = parseIso(String(c["started_at"]));
    const ended = parseIso(String(c["ended_at"]));
    c["duration_ms"] = started && ended ? Math.round((ended - started) * 1000) : null;
  }

  // ── 步骤记录 ──
  private recordStepInternal(
    execId: number,
    step: Record<string, any>,
    status: string,
    error: string | null | undefined,
    durationMs: number,
    screenshotB64: string | null | undefined,
    folder: string,
    extra?: Record<string, unknown> | null,
  ): StepRecord {
    const capture = this._captures.get(execId);
    const event = capture ? capture.take(Number(step["_step_index"] ?? 0)) : { network: [], console: [] };
    const rec: StepRecord = {
      step_index: step["_step_index"] ?? 0,
      method: step["method"],
      keyword: step["keyword"] ?? "",
      params: step["params"] ?? {},
      status,
      error: error ?? null,
      duration_ms: durationMs,
      screenshot: null,
      network: event.network,
      console: event.console,
    };
    if (extra) rec["extra"] = extra;

    if (screenshotB64) {
      const fname = `${folder}_s${step["_step_index"] ?? 0}.png`;
      try {
        const raw = screenshotB64.split(",").slice(-1)[0]!;
        writeFileSync(path.join(this.shotsDir, fname), Buffer.from(raw, "base64"));
        rec["screenshot"] = `screenshots/${fname}`;
      } catch {
        /* pass */
      }
    }
    return rec;
  }

  recordPreStep(
    step: Record<string, any>,
    status: string,
    error: string | null,
    durationMs: number,
    screenshotB64: string | null,
  ): void {
    this._preSteps.push(this.recordStepInternal(-1, step, status, error, durationMs, screenshotB64, "pre"));
  }

  recordStep(
    executionId: number,
    step: Record<string, any>,
    status: string,
    error: string | null,
    durationMs: number,
    screenshotB64: string | null,
    extra?: Record<string, unknown> | null,
  ): void {
    const c = this._cases.get(executionId);
    if (!c) {
      console.warn(`record_step 找不到用例: execution_id=${executionId}`);
      return;
    }
    const rec = this.recordStepInternal(
      executionId,
      step,
      status,
      error,
      durationMs,
      screenshotB64,
      String(executionId),
      extra,
    );
    (c["steps"] as StepRecord[]).push(rec);
  }

  setStep(executionId: number, stepIndex: number): void {
    const capture = this._captures.get(executionId);
    if (capture) capture.currentStep = stepIndex;
  }

  isCasePending(executionId: number): boolean {
    const c = this._cases.get(executionId);
    return c !== undefined && !c["ended_at"];
  }

  // ── 完整数据 + 落盘 ──
  buildData(): Record<string, any> {
    const cases = this._caseOrder.map((id) => this._cases.get(id)!).filter(Boolean);
    return {
      generated_at: nowIso(),
      runner_id: this.runnerId,
      suite_execution_id: this.suiteExecutionId,
      suite_name: this.suite["name"] ?? this.suite["suite_name"],
      env: this.env,
      started_at: this.startedAt,
      pre_actions: this._preSteps,
      cases,
      summary: this.summarize(cases),
    };
  }

  private summarize(cases: CaseRecord[]): Record<string, number> {
    const stats: Record<string, number> = { passed: 0, failed: 0, skipped: 0, error: 0, stopped: 0 };
    for (const c of cases) {
      const st = String(c["status"]);
      stats[st] = (stats[st] ?? 0) + 1;
    }
    const totalSteps = cases.reduce((n, c) => n + ((c["steps"] as StepRecord[]) ?? []).length, 0);
    const networkTotal = cases.reduce(
      (n, c) => n + ((c["steps"] as StepRecord[]) ?? []).reduce((m, s) => m + (s["network"] as unknown[])?.length, 0),
      0,
    );
    const consoleTotal = cases.reduce(
      (n, c) => n + ((c["steps"] as StepRecord[]) ?? []).reduce((m, s) => m + (s["console"] as unknown[])?.length, 0),
      0,
    );
    return {
      case_total: cases.length,
      case_passed: stats["passed"] ?? 0,
      case_failed: stats["failed"] ?? 0,
      case_skipped: stats["skipped"] ?? 0,
      case_error: stats["error"] ?? 0,
      case_stopped: stats["stopped"] ?? 0,
      step_total: totalSteps,
      network_total: networkTotal,
      console_total: consoleTotal,
    };
  }

  /** 写入 execution.json + index.html（本地落盘） */
  async save(): Promise<void> {
    const data = this.buildData();
    try {
      writeFileSync(this.jsonPath, JSON.stringify(data, replacer(), 2), "utf-8");
    } catch (exc) {
      console.error(`写入 execution.json 失败: ${exc instanceof Error ? exc.message : exc}`);
    }
    try {
      writeFileSync(this.htmlPath, renderHtml(data), "utf-8");
      console.info(`本地执行记录已生成: ${this.dir}`);
    } catch (exc) {
      console.error(`生成 HTML 报告失败: ${exc instanceof Error ? exc.message : exc}`);
    }
  }
}

/** json.dumps(default=str) 等价：非序列化值转字符串 */
function replacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return function (this: unknown, _key: string, value: unknown) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    if (typeof value === "function" || typeof value === "undefined" || typeof value === "symbol") {
      return String(value);
    }
    return value;
  };
}

function parseIso(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  ).getTime();
}

// ════════════════════════════════════════════════════════════════
//  HTML 报告渲染（纯静态单文件，内嵌 CSS/JS，无外部依赖）
// ════════════════════════════════════════════════════════════════

const CSS = `
:root{--bg:#f4f6fa;--card:#fff;--border:#e3e8f0;--text:#1f2937;--muted:#6b7280;
--green:#16a34a;--red:#dc2626;--amber:#d97706;--gray:#64748b;--blue:#2563eb;}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC',
'Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.wrap{max-width:1200px;margin:0 auto;padding:24px}
header{background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;padding:24px 28px;
border-radius:12px;margin-bottom:20px}
header h1{margin:0 0 6px;font-size:22px}
header .meta{font-size:13px;opacity:.9}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.card .num{font-size:26px;font-weight:700}
.card .lbl{font-size:12px;color:var(--muted)}
.card.green .num{color:var(--green)}.card.red .num{color:var(--red)}
.card.amber .num{color:var(--amber)}.card.blue .num{color:var(--blue)}
h2{font-size:18px;margin:26px 0 12px;border-left:4px solid var(--blue);padding-left:10px}
.case{border:1px solid var(--border);border-radius:10px;background:var(--card);margin-bottom:14px;
overflow:hidden}
.case-head{display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer;
background:#fbfcfe;border-bottom:1px solid var(--border)}
.case-head:hover{background:#f1f5fb}
.case-name{font-weight:600;flex:1}
.badge{font-size:12px;padding:3px 10px;border-radius:999px;color:#fff;font-weight:600}
.badge.passed{background:var(--green)}.badge.failed{background:var(--red)}
.badge.error{background:var(--red)}.badge.skipped{background:var(--gray)}
.badge.stopped{background:var(--amber)}.badge.pending{background:var(--gray)}
.case-body{padding:10px 16px;display:none}
.case-body.open{display:block}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f1f5fb;font-weight:600;white-space:nowrap}
.step-error{color:var(--red);background:#fef2f2;border-left:3px solid var(--red);
padding:8px 10px;border-radius:6px;margin:6px 0;font-size:13px;white-space:pre-wrap}
.step-pending{color:var(--muted);font-size:12px}
summary{font-weight:600;cursor:pointer;color:var(--blue);font-size:13px}
details{background:#f8fafc;border:1px solid var(--border);border-radius:8px;
padding:6px 12px;margin:6px 0}
details summary{list-style:none}
details summary::before{content:''}
details[open] > summary{margin-bottom:6px}
.code{background:#0f172a;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-family:Consolas,
Monaco,'Courier New',monospace;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.shot{max-width:100%;max-height:320px;border:1px solid var(--border);border-radius:6px;background:#fff;
display:block;margin:8px 0}
.tag{font-size:11px;padding:2px 8px;border-radius:4px;background:#e2e8f0;color:#475569}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
.console-item{border-left:3px solid var(--gray);padding:6px 10px;margin:4px 0;font-size:13px;
background:#f8fafc;border-radius:4px}
.console-item.error{border-left-color:var(--red);background:#fef2f2}
.console-item.warning{border-left-color:var(--amber);background:#fffbeb}
.console-item .t{font-size:11px;color:var(--muted)}
.console-item .s{white-space:pre-wrap;word-break:break-all}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:30px;padding:16px}
.toc{margin-bottom:16px;display:flex;flex-wrap:wrap;gap:8px;font-size:13px}
.toc a{color:var(--blue);text-decoration:none}
.var-table td{font-size:12px}
`;

const JS = `
document.addEventListener('click',function(e){
  var h=e.target.closest('.case-head');
  if(h){var b=h.nextElementSibling;if(b)b.classList.toggle('open');}
});
function esc(s){return s==null?'':String(s).replace(/[&<>\"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}
function showShot(id){var img=document.getElementById(id);img.classList.toggle('zoomed');}
`;

/** HTML 转义（html.escape(quote=True)） */
function e(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function func(v: unknown): string {
  if (!v) return "-";
  return e(v);
}

function renderNetwork(netw: NetworkEntry[]): string {
  if (!netw || !netw.length) return '<div class="step-pending">本步骤无网络请求记录</div>';
  const parts: string[] = [`<details><summary>网络协议 (${netw.length} 条请求/响应)</summary>`];
  for (const n of netw) {
    const status = n.status;
    const scls = status && status < 400 ? "green" : status && status < 500 ? "amber" : "red";
    parts.push(
      `<div class="console-item" style="border-left-color:#22c55e">` +
        `<div><span class="tag">${func(n.method)}</span> ` +
        `<span style="font-size:12px;color:#2563eb;word-break:break-all">${e(n.url)}</span></div>` +
        `<div class="t">资源类型 ${func(n.resource_type)} · 状态码 ` +
        `<span style="color:${scls};font-weight:600">${func(status)} ${func(n.status_text)}</span></div>`,
    );
    const details: string[] = [];
    if (n.request_headers && Object.keys(n.request_headers).length) {
      details.push(
        '<details><summary>请求体 / 请求头</summary><div class="code">' +
          e(JSON.stringify({ headers: n.request_headers, post_data: n.post_data })) +
          "</div></details>",
      );
    }
    if ((n.response_headers && Object.keys(n.response_headers).length) || n.body) {
      details.push(
        '<details><summary>响应体 / 响应头</summary><div class="code">' +
          e(JSON.stringify({ headers: n.response_headers, body: n.body })) +
          "</div></details>",
      );
    }
    parts.push(details.join(""));
    parts.push("</div>");
  }
  parts.push("</details>");
  return parts.join("");
}

function renderConsole(consoleList: ConsoleEntry[]): string {
  if (!consoleList || !consoleList.length) return '<div class="step-pending">本步骤无 console 日志</div>';
  const parts: string[] = [`<details><summary>Console (${consoleList.length} 条)</summary>`];
  for (const c of consoleList) {
    const cls = { error: "error", warning: "warning" }[c.type] ?? "";
    parts.push(
      `<div class="console-item ${cls}">` +
        `<span class="tag">${e(c.type)}</span> ` +
        `<span class="s">${e(c.text)}</span>` +
        `</div>`,
    );
  }
  parts.push("</details>");
  return parts.join("");
}

function renderStep(s: StepRecord, isPre = false): string {
  const idx = Number(s["step_index"] ?? 0);
  const label = !isPre ? `#${idx}` : `前置#${idx + 1}`;
  const si = s["status"] ?? "passed";
  const rows: string[] = [];
  rows.push(
    `<tr><td>${label}</td>` +
      `<td><span class="badge ${e(si)}">${e(si)}</span></td>` +
      `<td>${func(s["keyword"])}</td>` +
      `<td>${func(s["method"])}</td>` +
      `<td>${e(s["duration_ms"] ?? 0)} ms</td></tr>`,
  );
  const params = s["params"];
  if (params) {
    rows.push(
      `<tr><td colspan="5"><details><summary>参数</summary>` +
        `<div class="code">${e(JSON.stringify(params, replacer(), 2))}</div>` +
        `</details></td></tr>`,
    );
  }
  if (s["error"]) {
    rows.push(`<tr><td colspan="5"><div class="step-error">${e(s["error"])}</div></td></tr>`);
  }
  if (s["screenshot"]) {
    rows.push(
      `<tr><td colspan="5"><details open><summary>截图</summary>` +
        `<img class="shot" src="${e(s["screenshot"])}" loading="lazy"></details></td></tr>`,
    );
  }
  if ((s["network"] as unknown[])?.length || (s["console"] as unknown[])?.length) {
    const sub = renderNetwork((s["network"] ?? []) as NetworkEntry[]) + renderConsole((s["console"] ?? []) as ConsoleEntry[]);
    rows.push(`<tr><td colspan="5">${sub}</td></tr>`);
  }
  return `<table>${rows.join("")}</table>`;
}

function renderCase(c: CaseRecord): string {
  const sid = c["execution_id"];
  const head =
    `<div class="case-head">` +
    `<span class="badge ${e(c["status"])}">${e(c["status"])}</span>` +
    `<span class="case-name">[${e(c["execution_id"])}] ${e(c["name"] || c["case_id"] || "未命名用例")}</span>` +
    `<span style="font-size:12px;color:var(--muted);white-space:nowrap">${e(c["duration_ms"] ?? 0)} ms</span>` +
    `<span style="color:var(--blue);font-size:12px">步骤 ${(c["steps"] as StepRecord[])?.length ?? 0}</span>` +
    `</div>`;
  const bodyItems: string[] = [];
  if (c["error"]) bodyItems.push(`<div class="step-error">${e(c["error"])}</div>`);
  for (const s of (c["steps"] as StepRecord[]) ?? []) bodyItems.push(renderStep(s));
  if (!bodyItems.length) bodyItems.push('<div class="step-pending">无步骤记录</div>');
  return `<div class="case" id="case-${sid}">${head}<div class="case-body">${bodyItems.join("")}</div></div>`;
}

function renderPre(pre: StepRecord[]): string {
  if (!pre || !pre.length) return '<div class="step-pending">无前置动作</div>';
  return pre.map((s) => renderStep(s, true)).join("");
}

/** 根据执行数据渲染纯 HTML 报告（1:1 render_html） */
export function renderHtml(data: Record<string, any>): string {
  const s = data["summary"] as Record<string, number>;
  const env = (data["env"] ?? {}) as Record<string, unknown>;
  const started = data["started_at"] ?? "-";
  const generated = data["generated_at"] ?? "-";

  const cards = `
    <div class="cards">
      <div class="card blue"><div class="num">${s["case_total"]}</div><div class="lbl">用例数</div></div>
      <div class="card green"><div class="num">${s["case_passed"]}</div><div class="lbl">通过</div></div>
      <div class="card red"><div class="num">${s["case_failed"] + s["case_error"]}</div><div class="lbl">失败/错误</div></div>
      <div class="card amber"><div class="num">${s["case_skipped"] + s["case_stopped"]}</div><div class="lbl">跳过/停止</div></div>
      <div class="card"><div class="num">${s["step_total"]}</div><div class="lbl">步骤总数</div></div>
      <div class="card"><div class="num">${s["network_total"]}</div><div class="lbl">网络协议</div></div>
      <div class="card"><div class="num">${s["console_total"]}</div><div class="lbl">Console</div></div>
    </div>`;

  const envKv =
    Object.entries(env)
      .map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(v)}</td></tr>`)
      .join("") || '<tr><td colspan="2" class="step-pending">无环境变量</td></tr>';

  const tocLinks =
    '<a href="#env">环境</a> <a href="#pre">前置动作</a> ' +
    (data["cases"] as CaseRecord[])
      .map((c) => `<a href="#case-${e(c["execution_id"])}">Case ${e(c["execution_id"])}</a>`)
      .join(" ");

  const casesHtml =
    (data["cases"] as CaseRecord[]).map(renderCase).join("") || '<div class="step-pending">无用例</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>执行报告 - Suite ${e(data["suite_execution_id"])}</title>
<style>${CSS}</style>
<style>img.zoomed{max-height:1200px;cursor:zoom-out}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>BrickCore 执行报告</h1>
  <div class="meta">
    Suite 执行 ID：${e(data["suite_execution_id"])} ·
    套件：${e(data["suite_name"] || "-")} ·
    Runner：${e(data["runner_id"])}
  </div>
  <div class="meta">开始 ${e(started)} · 生成 ${e(generated)}</div>
</header>

${cards}

<h2>目录</h2>
<div class="toc">${tocLinks}</div>

<h2 id="env">执行环境</h2>
<table class="var-table"><tr><th style="width:240px">变量</th><th>值</th></tr>${envKv}</table>

<h2 id="pre">前置动作（pre_actions）</h2>
<div class="case"><div class="case-body open">${renderPre((data["pre_actions"] ?? []) as StepRecord[])}</div></div>

<h2>用例执行记录</h2>
${casesHtml}

<footer>由 BrickCore HTTP Runner 本地生成 · runner_id=${e(data["runner_id"])}</footer>
</div>
<script>${JS}</script>
</body>
</html>`;
}
