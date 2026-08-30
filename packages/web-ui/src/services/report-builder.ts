/**
 * 报告导出：HTML 自包含模板渲染 + PDF（Playwright Chromium page.pdf，决策记录 #3）。
 * 设计依据：docs/需求设计/数据库与API设计.md §2.11（RPT-03/04，AC-RPT-03-1 离线可看）。
 * 导出任务（export_jobs）异步驱动，已有缓存直接复用（html_path/pdf_path 回填）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { getReport, listReportSteps, reportTaskResults, updateReport } from "../db/dao/reports.js";
import { fetchExecutionLogs } from "../db/dao/runs.js";
import { parseJsonField } from "../db/dao/common.js";
import { createExportJob, getExportJob, updateExportJob } from "../db/dao/reports.js";
import { getTask } from "../db/dao/tasks.js";
import { BASE_DIR, REPORT_EXPORTS_DIR } from "../paths.js";
import { logger } from "../logging.js";

/** HTML 报告模板（自包含：内联样式 + base64 截图，离线可看） */
export function renderReportHtml(reportId: string): string {
  const report = getReport(reportId);
  if (!report) throw new Error("报告不存在");
  const steps = listReportSteps(report.id, 1, 1000).list;
  // 脚本通道：执行日志与自动截图（screenshot 事件）
  const logs = report.executionId ? fetchExecutionLogs(report.executionId, 0, 300).logs : [];
  const shotLogs = logs.filter((l) => l.event === "screenshot");
  const gallery = shotLogs.length
    ? shotLogs
        .map((l) => {
          const p = parseJsonField<{ screenshotPath?: string }>(l.payload, {});
          const rel = p.screenshotPath || "";
          return `<div style="margin:6px 4px;display:inline-block;vertical-align:top">
            <img src="${inlineImage(rel)}" alt="${escapeHtml(l.message)}" style="max-width:300px;border:1px solid #e5e7eb;border-radius:8px;display:block"/>
            <div style="font-size:11px;color:#6b7280;text-align:center;padding:4px 0">${escapeHtml(l.message)} · ${escapeHtml(String(l.ts).slice(11, 19))}</div>
          </div>`;
        })
        .join("")
    : "";
  const logRows = logs
    .filter((l) => l.event === "log" || l.event === "status")
    .map(
      (l) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:12px;white-space:nowrap">${escapeHtml(String(l.ts).slice(11, 19))}</td><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${l.level === "ok" ? "#16a34a" : l.level === "error" ? "#dc2626" : "#374151"}">${escapeHtml(l.message)}</td></tr>`,
    )
    .join("");
  const task = report.taskId ? getTask(report.taskId) : null;
  const passRate = report.passRate.toFixed(1);

  const statusColor = (s: string): string =>
    s === "passed" || s === "success" ? "#16a34a" : s === "failed" || s === "error" ? "#dc2626" : "#6b7280";

  const stepRows = steps
    .map((s) => {
      const shot = s.screenshotPath
        ? `<img src="${inlineImage(s.screenshotPath)}" alt="步骤 ${s.stepIndex} 截图" style="max-width:640px;border:1px solid #e5e7eb;border-radius:6px;margin-top:6px;"/>`
        : "";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${s.stepIndex}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;"><code>${escapeHtml(s.method)}</code></td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${escapeHtml(s.description)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:${statusColor(s.status)};font-weight:600;">${s.status}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${s.durationMs ?? "-"} ms</td>
      </tr>
      ${shot ? `<tr><td colspan="5" style="padding:0 12px 12px;">${shot}</td></tr>` : ""}
      ${s.error ? `<tr><td colspan="5" style="padding:0 12px 12px;color:#dc2626;">错误：${escapeHtml(s.error)}</td></tr>` : ""}`;
    })
    .join("");

  const taskResultRows =
    report.type === "plan"
      ? `<h2 style="font-size:16px;margin:24px 0 8px;">任务结果</h2>
         <table style="width:100%;border-collapse:collapse;font-size:13px;">
           <thead><tr style="background:#f9fafb;text-align:left;">
             <th style="padding:8px 12px;">任务</th><th style="padding:8px 12px;">结果</th><th style="padding:8px 12px;">Run</th>
           </tr></thead>
           <tbody>${reportTaskResults(report)
             .map(
               (r) => `<tr>
                 <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${escapeHtml(String(r["name"] ?? r["taskId"]))}</td>
                 <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:${statusColor(String(r["status"]))};font-weight:600;">${escapeHtml(String(r["status"]))}</td>
                 <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;"><code>${escapeHtml(String(r["runId"] ?? ""))}</code></td>
               </tr>`,
             )
             .join("")}</tbody>
         </table>`
      : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>测试报告 · ${escapeHtml(report.name)}</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; background: #f9fafb; color: #111827; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  .cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 18px; min-width: 110px; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; font-size: 13px; }
  th { background: #f9fafb; text-align: left; padding: 8px 12px; font-size: 12px; color: #6b7280; }
</style>
</head>
<body><div class="wrap">
  <h1>${escapeHtml(report.name)}${report.type === "plan" ? "（计划汇总）" : ""}</h1>
  <div class="meta">
    报告 ID ${escapeHtml(report.id)} ·
    ${task ? `任务 ${escapeHtml(task.name)} · ` : ""}
    状态 <b style="color:${statusColor(report.status)};">${report.status}</b> ·
    开始 ${escapeHtml(report.startedAt ?? "-")} · 耗时 ${report.durationMs ?? "-"} ms
  </div>
  ${report.errorMessage ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:13px;">${escapeHtml(report.errorMessage)}</div>` : ""}
  <div class="cards">
    <div class="card"><div class="k" style="font-size:12px;color:#6b7280;">通过率</div><div class="v">${passRate}%</div></div>
    <div class="card"><div class="k" style="font-size:12px;color:#6b7280;">总步骤</div><div class="v">${report.totalSteps}</div></div>
    <div class="card"><div class="k" style="font-size:12px;color:#6b7280;">通过</div><div class="v" style="color:#16a34a;">${report.passedSteps}</div></div>
    <div class="card"><div class="k" style="font-size:12px;color:#6b7280;">失败</div><div class="v" style="color:#dc2626;">${report.failedSteps}</div></div>
    <div class="card"><div class="k" style="font-size:12px;color:#6b7280;">跳过</div><div class="v">${report.skippedSteps}</div></div>
  </div>
  ${taskResultRows}
  ${steps.length ? `<h2 style="font-size:16px;margin:24px 0 8px;">步骤详情</h2>
  <table>
    <thead><tr><th style="padding:8px 12px;">#</th><th style="padding:8px 12px;">操作</th><th style="padding:8px 12px;">描述</th><th style="padding:8px 12px;">状态</th><th style="padding:8px 12px;">耗时</th></tr></thead>
    <tbody>${stepRows}</tbody>
  </table>` : ""}
  ${gallery ? `<h2 style="font-size:16px;margin:24px 0 8px;">执行截图（${shotLogs.length} 张）</h2>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px">${gallery}</div>` : ""}
  ${logRows ? `<h2 style="font-size:16px;margin:24px 0 8px;">执行日志（脚本通道）</h2>
  <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:12px;">
    <thead><tr style="background:#f9fafb;text-align:left;"><th style="padding:6px 12px;">时间</th><th style="padding:6px 12px;">内容</th></tr></thead>
    <tbody>${logRows}</tbody>
  </table>` : ""}
  <div style="margin-top:28px;color:#9ca3af;font-size:12px;">生成于 ${new Date().toISOString()} · AutoTest Runner</div>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 截图内联为 data URL（离线可看）；文件缺失时返回空 */
function inlineImage(relativePath: string): string {
  try {
    const abs = path.join(BASE_DIR, relativePath);
    if (!existsSync(abs)) return "";
    return `data:image/png;base64,${readFileSync(abs).toString("base64")}`;
  } catch {
    return "";
  }
}

/** HTML 导出（同步落盘）；返回相对 data/ 的路径 */
export function exportReportHtml(reportId: string): string {
  const html = renderReportHtml(reportId);
  mkdirSync(REPORT_EXPORTS_DIR, { recursive: true });
  const rel = `reports/exports/${reportId}.html`;
  writeFileSync(path.join(REPORT_EXPORTS_DIR, `${reportId}.html`), html, "utf-8");
  return rel;
}

/** PDF 分页模板：封面一页 + 每个步骤单独一页（脚本通道：每张截图一页 + 日志页） */
export function renderReportPdfHtml(reportId: string): string {
  const report = getReport(reportId);
  if (!report) throw new Error("报告不存在");
  const task = report.taskId ? getTask(report.taskId) : null;
  const steps = listReportSteps(report.id, 1, 1000).list;
  const passRate = report.passRate.toFixed(1);
  const statusColor = (s: string): string =>
    s === "passed" || s === "success" ? "#16a34a" : s === "failed" || s === "error" ? "#dc2626" : "#6b7280";

  // 封面页
  let pages = `<div class="page">
    <h1>${escapeHtml(report.name)}${report.type === "plan" ? "（计划汇总）" : ""}</h1>
    <div class="meta">
      报告 ID ${escapeHtml(report.id)} ·
      ${task ? `任务 ${escapeHtml(task.name)} · ` : ""}
      状态 <b style="color:${statusColor(report.status)};">${report.status}</b> ·
      开始 ${escapeHtml(report.startedAt ?? "-")} · 耗时 ${report.durationMs ?? "-"} ms
    </div>
    ${report.errorMessage ? `<div class="err">${escapeHtml(report.errorMessage)}</div>` : ""}
    <div class="cards">
      <div class="card"><div class="k">通过率</div><div class="v">${passRate}%</div></div>
      <div class="card"><div class="k">总步骤</div><div class="v">${report.totalSteps}</div></div>
      <div class="card"><div class="k">通过</div><div class="v" style="color:#16a34a;">${report.passedSteps}</div></div>
      <div class="card"><div class="k">失败</div><div class="v" style="color:#dc2626;">${report.failedSteps}</div></div>
      <div class="card"><div class="k">跳过</div><div class="v">${report.skippedSteps}</div></div>
    </div>
    ${steps.length ? `<p style="color:#6b7280;font-size:13px;">共 ${steps.length} 步 · 每步一页</p>` : ""}
  </div>`;

  // 每步一页（Runner 通道：结构化步骤）
  for (const s of steps) {
    pages += `<div class="page">
      <div class="step-head">步骤 ${s.stepIndex} <span class="st ${s.status === "passed" ? "passed" : "failed"}">${escapeHtml(s.status)}</span></div>
      <div class="row"><span class="k">操作</span><code>${escapeHtml(s.method)}</code></div>
      <div class="row"><span class="k">描述</span>${escapeHtml(s.description || "-")}</div>
      <div class="row"><span class="k">耗时</span>${s.durationMs ?? "-"} ms</div>
      ${s.error ? `<div class="err">错误：${escapeHtml(s.error)}</div>` : ""}
      ${s.screenshotPath ? `<img src="${inlineImage(s.screenshotPath)}" alt="步骤 ${s.stepIndex} 截图"/>` : ""}
      <div class="foot">AutoTest Runner · 步骤 ${s.stepIndex}/${steps.length}</div>
    </div>`;
  }

  // 脚本通道：每张截图一页 + 日志页
  if (!steps.length && report.executionId) {
    const logs = fetchExecutionLogs(report.executionId, 0, 300).logs;
    const shotLogs = logs.filter((l) => l.event === "screenshot");
    for (const l of shotLogs) {
      const p = parseJsonField<{ screenshotPath?: string }>(l.payload, {});
      pages += `<div class="page">
        <div class="step-head">截图 ${escapeHtml(l.message)} <span class="mono">${escapeHtml(String(l.ts).slice(11, 19))}</span></div>
        ${p.screenshotPath ? `<img src="${inlineImage(p.screenshotPath)}" alt="${escapeHtml(l.message)}"/>` : ""}
        <div class="foot">AutoTest Runner · 截图 ${escapeHtml(l.message)}</div>
      </div>`;
    }
    const logRows = logs
      .filter((l) => l.event === "log" || l.event === "status")
      .map(
        (l) =>
          `<tr><td style="color:#6b7280;white-space:nowrap;">${escapeHtml(String(l.ts).slice(11, 19))}</td><td style="color:${l.level === "ok" ? "#16a34a" : l.level === "error" ? "#dc2626" : "#374151"}">${escapeHtml(l.message)}</td></tr>`,
      )
      .join("");
    if (logRows) {
      pages += `<div class="page">
        <div class="step-head">执行日志</div>
        <table><thead><tr><th style="text-align:left;">时间</th><th style="text-align:left;">内容</th></tr></thead><tbody>${logRows}</tbody></table>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>测试报告 · ${escapeHtml(report.name)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; color: #111827; }
  .page { break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 16px; min-width: 100px; }
  .card .k { font-size: 12px; color: #6b7280; }
  .card .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .step-head { font-size: 18px; font-weight: 700; margin-bottom: 14px; }
  .st { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; margin-left: 8px; }
  .st.passed { background: #dcfce7; color: #16a34a; }
  .st.failed { background: #fee2e2; color: #dc2626; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #6b7280; font-weight: 400; }
  .row { font-size: 13px; margin-bottom: 8px; }
  .row .k { color: #6b7280; display: inline-block; min-width: 56px; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .err { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 8px; padding: 8px 12px; font-size: 13px; margin: 10px 0; }
  img { display: block; max-width: 100%; max-height: 200mm; margin: 12px auto 0; border: 1px solid #e5e7eb; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
  th { background: #f9fafb; padding: 8px 10px; font-size: 12px; color: #6b7280; }
  td { border-bottom: 1px solid #f3f4f6; padding: 6px 10px; }
  .foot { color: #9ca3af; font-size: 11px; margin-top: 12px; }
</style>
</head>
<body>${pages}</body></html>`;
}

/** PDF 导出（Chromium 打印分页 HTML，每步一页）；返回相对路径。浏览器缺失时抛错由任务标 failed */
export async function exportReportPdf(reportId: string): Promise<string> {
  const { chromium } = await import("playwright");
  mkdirSync(REPORT_EXPORTS_DIR, { recursive: true });
  const rel = `reports/exports/${reportId}.pdf`;
  const outAbs = path.join(REPORT_EXPORTS_DIR, `${reportId}.pdf`);
  const tmpHtml = path.join(REPORT_EXPORTS_DIR, `${reportId}.tmp.html`);
  writeFileSync(tmpHtml, renderReportPdfHtml(reportId), "utf-8");
  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileUrl(tmpHtml), { waitUntil: "load" });
      await page.pdf({ path: outAbs, format: "A4", printBackground: true });
    } finally {
      await browser.close();
    }
  } finally {
    try {
      rmSync(tmpHtml, { force: true });
    } catch {
      /* pass */
    }
  }
  return rel;
}

function pathToFileUrl(p: string): string {
  return `file:///${p.replace(/\\/g, "/")}`;
}

/** 发起导出（幂等：已有缓存直接 done；否则建任务并后台执行） */
export function startExport(reportId: string, format: "html" | "pdf"): string {
  const report = getReport(reportId);
  if (!report) throw new Error("报告不存在");
  const cached = format === "html" ? report.htmlPath : report.pdfPath;
  const job = createExportJob(reportId, format);
  if (cached) {
    updateExportJob(job.id, { status: "done", progress: 100, filePath: cached });
    return job.id;
  }
  void (async () => {
    try {
      updateExportJob(job.id, { progress: 30 });
      const rel = format === "html" ? exportReportHtml(reportId) : await exportReportPdf(reportId);
      updateExportJob(job.id, { status: "done", progress: 100, filePath: rel });
      updateReport(reportId, format === "html" ? { htmlPath: rel } : { pdfPath: rel });
      logger.info("[export] 报告 %s 导出 %s 完成: %s", reportId, format, rel);
    } catch (e) {
      updateExportJob(job.id, { status: "failed", error: (e as Error).message });
      logger.exception("[export] 报告 %s 导出 %s 失败: %s", reportId, format, (e as Error).message);
    }
  })();
  return job.id;
}

export function getExportStatus(exportId: string) {
  return getExportJob(exportId);
}
