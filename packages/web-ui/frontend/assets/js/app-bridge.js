/**
 * app.html 真实数据桥接层（AutoTest Console）。
 * 原型静态数据替换为后端 API（/api/*）实时数据：
 *   - 任务工作台：统计卡 + 任务表（GET /api/dashboard/stats、GET /api/tasks）
 *   - 任务行操作：执行（POST /api/tasks/:id/run）/ 编辑跳转 / 报告跳转
 *   - 录制项目：列表渲染（GET /api/projects）+ 删除确认接 DELETE
 *   - 测试计划：列表渲染（GET /api/plans）
 *   - 测试报告：列表渲染（GET /api/reports）
 *   - 执行监控：选中 runId 后轮询（GET /api/task-runs/:id + /logs + stop）
 * 原型交互（主题切换/抽屉/分页/拖拽）全部保留。
 */
(function () {
  "use strict";

  // ===== API 基础封装（{code,message,data} 包络） =====
  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(body.message || body.detail || `请求失败 (${res.status})`);
    }
    // 旧契约接口（/api/sessions、/api/inspect/sessions 等）返回裸数组/裸对象，直接透传
    return body.data !== undefined ? body.data : body;
  }

  // ===== 工具 =====
  function fmtTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }
  function statusTag(status) {
    const map = {
      pending: ["gray", "待执行"], running: ["cyan", "执行中"], retrying: ["amber", "重试中"],
      success: ["green", "成功"], failed: ["red", "失败"], stopped: ["gray", "已停止"],
      queued: ["cyan", "排队中"], completed: ["green", "已完成"], error: ["red", "错误"],
      idle: ["gray", "空闲"], paused: ["amber", "已暂停"], passed: ["green", "通过"],
      skipped: ["gray", "跳过"], lost: ["red", "失联"], draft: ["gray", "草稿"],
      ready: ["green", "就绪"], archived: ["gray", "已归档"], recording: ["cyan", "录制中"],
    };
    const [cls, label] = map[status] || ["gray", status || "-"];
    return `<span class="tag ${cls}">${label}</span>`;
  }

  // 延迟到原型脚本执行完成（bridge 在其后加载）
  const ready = (fn) => {
    if (document.readyState === "complete") setTimeout(fn, 0);
    else window.addEventListener("load", () => setTimeout(fn, 0));
  };

  /** 统一分页控件（列表右下角）：« 页码 … » + 「共 N 条 · 第 x/y 页」 */
  function renderPager(el, { page, pageSize, total, onPage }) {
    if (!el) return;
    const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
    const cur = Math.min(Math.max(1, page), totalPages);
    const pg = (n, label, cls, disabled) =>
      `<button class="pg ${cls || ""}" ${disabled ? "disabled" : ""} data-p="${n}">${label ?? n}</button>`;
    // 页码窗口：首/尾恒显，当前页 ±1，超 9 页用省略号
    let nums = "";
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      if (totalPages <= 9 || i === 1 || i === totalPages || Math.abs(i - cur) <= 1) pages.push(i);
    }
    let prev = 0;
    for (const i of pages) {
      if (prev && i - prev > 1) nums += `<span class="mono" style="color:var(--text3);font-size:11px;padding:0 2px">…</span>`;
      nums += pg(i, i, i === cur ? "on" : "");
      prev = i;
    }
    el.innerHTML =
      pg(cur - 1, "«", "", cur <= 1) +
      nums +
      pg(cur + 1, "»", "", cur >= totalPages) +
      `<span style="font-size:11px;color:var(--text3);margin-left:8px" class="mono">共 ${total || 0} 条 · 第 ${cur}/${totalPages} 页</span>`;
    el.querySelectorAll(".pg:not(:disabled)").forEach((b) => {
      b.addEventListener("click", () => {
        let n = Number(b.dataset.p);
        if (b.textContent.trim() === "«") n = cur - 1;
        if (b.textContent.trim() === "»") n = cur + 1;
        if (n >= 1 && n <= totalPages && n !== cur) onPage && onPage(n);
      });
    });
  }

  // ===== 列表 / 卡片 双视图模式（默认列表，切换用已加载数据重渲染） =====
  const pageViews = { history: "list", reports: "list", plans: "list", projects: "list" };
  const viewData = {};
  function setPageView(key, mode) {
    pageViews[key] = mode === "card" ? "card" : "list";
    const seg = document.getElementById(`view-${key}`);
    if (seg) seg.querySelectorAll("span").forEach((s) => s.classList.toggle("on", s.dataset.view === pageViews[key]));
    if (viewData[key]) renderPageView(key, viewData[key]);
  }
  function renderPageView(key, data) {
    viewData[key] = data;
    const isList = pageViews[key] === "list";
    const list = data.list || [];
    if (key === "history") {
      document.getElementById("th-cards").style.display = isList ? "none" : "grid";
      document.querySelector("#page-task-history .tasktable").style.display = isList ? "block" : "none";
      if (isList) document.getElementById("th-tbody").innerHTML = renderHistoryRows(list);
      else document.getElementById("th-cards").innerHTML = renderHistoryCards(list);
      syncBatchSel("th-tbody");
    } else if (key === "reports") {
      document.getElementById("rpt-cards").style.display = isList ? "none" : "grid";
      document.querySelector("#page-reports .card").style.display = isList ? "block" : "none";
      if (isList) document.getElementById("rpt-tbody").innerHTML = renderHistoryRows(list);
      else document.getElementById("rpt-cards").innerHTML = renderHistoryCards(list);
      syncBatchSel("rpt-tbody");
    } else if (key === "plans") {
      document.getElementById("plan-grid").style.display = isList ? "none" : "grid";
      document.querySelector("#page-plans .card").style.display = isList ? "block" : "none";
      if (isList) document.getElementById("plan-tbody").innerHTML = renderPlanRows(list);
      else document.getElementById("plan-grid").innerHTML = renderPlanCards(list);
      syncBatchSel("plan-tbody");
    } else if (key === "projects") {
      document.getElementById("proj-grid").style.display = isList ? "none" : "grid";
      document.querySelector("#page-projects .card").style.display = isList ? "block" : "none";
      if (isList) document.getElementById("proj-tbody").innerHTML = renderProjRows(list);
      else document.getElementById("proj-grid").innerHTML = renderProjCards(list);
      syncBatchSel("proj-tbody");
    }
  }

  /** 报告行模板（历史管理 / 报告中心共用） */
  function renderHistoryRows(list) {
    if (!list.length) return `<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:36px">暂无报告</td></tr>`;
    const stColor = { success: "var(--success)", failed: "var(--danger)", stopped: "var(--text3)", skipped: "var(--text3)" };
    return list
      .map((r) => `<tr data-row="${esc(r.id)}" data-id="${esc(r.id)}" data-type="${esc(r.type || "task")}">
        <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
        <td class="mono">${esc(r.id)}</td>
        <td class="mono">${esc(r.executionId || "-")}</td>
        <td><span class="tag ${r.status === "success" ? "green" : "red"}">${esc(r.status)}</span></td>
        <td class="mono" style="color:${stColor[r.status] || "var(--text)"}">${r.passRate}%</td>
        <td class="mono">${r.totalSteps}</td>
        <td class="mono">${r.durationMs ? (r.durationMs / 1000).toFixed(1) + "s" : "-"}</td>
        <td class="mono">${fmtTime(r.createdAt)}</td>
        <td>${reportOps(r)}</td></tr>`)
      .join("");
  }

  /** 报告操作按钮（行/卡片共用） */
  function reportOps(r) {
    return `<button class="btn ghost row-btn" onclick="Bridge.openReport('${esc(r.id)}')">查看</button>
      <button class="btn ghost row-btn" onclick="Bridge.openTaskExecMonitor('${esc(r.runId || "")}')">监控</button>
      <button class="btn ghost row-btn" onclick="Bridge.exportReport(this,'HTML')">导出</button>
      <button class="btn danger row-btn" onclick="Bridge.deleteReportById('${esc(r.id)}')">删除</button>`;
  }

  /** 报告卡片模板（历史管理 / 报告中心共用） */
  function renderHistoryCards(list) {
    if (!list.length) return `<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:36px">暂无报告</div>`;
    const stColor = { success: "var(--success)", failed: "var(--danger)", stopped: "var(--text3)", skipped: "var(--text3)" };
    return list
      .map((r) => `<div class="rpt-card" style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="tag ${r.status === "success" ? "green" : "red"}">${esc(r.status)}</span>
          <b class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.id)}</b>
          <span style="margin-left:auto;color:var(--text3);font-size:10px" class="mono">${fmtTime(r.createdAt)}</span>
        </div>
        <div class="mono" style="font-size:11px;color:var(--text2)">迭代 ${esc(r.executionId || "-")} · <span style="color:${stColor[r.status] || "var(--text)"}">${r.passRate}%</span> · ${r.totalSteps} 步 · ${r.durationMs ? (r.durationMs / 1000).toFixed(1) + "s" : "-"}</div>
        <div style="display:flex;gap:6px;margin-top:auto;padding-top:4px">${reportOps(r)}</div>
      </div>`)
      .join("");
  }

  /** 计划行模板 */
  function renderPlanRows(list) {
    if (!list.length) return `<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:36px">暂无测试计划 · 「+ 新建计划」编排任务</td></tr>`;
    const stMap = { idle: ["gray", "空闲"], running: ["cyan", "运行中"], paused: ["amber", "已暂停"], completed: ["green", "已完成"], failed: ["red", "失败"], stopped: ["gray", "已停止"] };
    return list
      .map((p) => {
        const [scls, slabel] = stMap[p.status] || ["gray", p.status];
        return `<tr data-id="${esc(p.id)}">
          <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
          <td onclick="Bridge.openPlanDrawer('${esc(p.id)}')" style="cursor:pointer"><b>${esc(p.name)}</b></td>
          <td class="mono">${esc(p.cronExpr || "手动")}</td>
          <td><span class="tag ${scls}">${slabel}</span></td>
          <td class="mono">${p.taskCount ?? "-"}</td>
          <td style="color:var(--text2)">${esc(p.description || "")}</td>
          <td class="mono">${fmtTime(p.lastRunAt || p.createdAt)}</td>
          <td>
            <button class="btn ghost row-btn" onclick="Bridge.runPlan('${esc(p.id)}')">执行</button>
            <button class="btn ghost row-btn" onclick="Bridge.openPlanModalForEdit('${esc(p.id)}')">编辑</button>
            <button class="btn danger row-btn" onclick="Bridge.confirmDelPlan('${esc(p.name)}','${esc(p.id)}')">删除</button>
          </td></tr>`;
      })
      .join("");
  }

  /** 计划卡片模板（现有卡片样式） */
  function renderPlanCards(list) {
    if (!list.length) return `<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:40px">暂无测试计划 · 「+ 新建计划」编排任务</div>`;
    const stMap = { idle: ["gray", "空闲"], running: ["cyan", "运行中"], paused: ["amber", "已暂停"], completed: ["green", "已完成"], failed: ["red", "失败"], stopped: ["gray", "已停止"] };
    return list
      .map((p) => {
        const [scls, slabel] = stMap[p.status] || ["gray", p.status];
        return `<div class="plan" data-name="${esc(p.name)}" data-id="${esc(p.id)}" onclick="Bridge.openPlanDrawer('${esc(p.id)}')">
          <div class="p-top"><span class="tag ${scls}">${slabel}</span><b class="p-name">${esc(p.name)}</b><span class="p-cron">${esc(p.cronExpr || "手动")}</span></div>
          <div class="p-desc">${esc(p.description || `${p.taskCount} 个任务 · 串行执行`)}</div>
          <div class="p-meta"><span>${p.taskCount} 个任务</span><span>最近 ${fmtTime(p.lastRunAt || p.createdAt)}</span></div>
          <div class="p-actions"><button class="btn" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.runPlan('${esc(p.id)}')">▶ 执行</button><button class="btn" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.openPlanModalForEdit('${esc(p.id)}')">✏️ 编辑</button><button class="btn danger" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.confirmDelPlan('${esc(p.name)}','${esc(p.id)}')">删除</button></div>
        </div>`;
      })
      .join("");
  }

  /** 项目行模板 */
  function renderProjRows(list) {
    if (!list.length) return `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">暂无录制项目 · 「新建录制」创建第一个项目</td></tr>`;
    const typeLabel = { ai: "AI 录制", browser: "浏览器录制" };
    const statusMap = { ready: ["green", "就绪"], draft: ["amber", "草稿"], archived: ["gray", "归档"] };
    return list
      .map((p) => {
        const [scls, slabel] = statusMap[p.status] || ["gray", p.status];
        const t = typeLabel[p.type] || p.type;
        return `<tr data-id="${esc(p.id)}">
          <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
          <td onclick="Bridge.openProject('${esc(p.id)}')" style="cursor:pointer"><b>${esc(p.name)}</b></td>
          <td>${esc(t)}</td>
          <td><span class="tag ${scls}">${slabel}</span></td>
          <td class="mono">${p.stepsCount ?? 0}</td>
          <td class="mono">${fmtTime(p.createdAt)}</td>
          <td>
            <button class="btn primary row-btn" onclick="Bridge.startRecord('${esc(p.id)}')">启动录制</button>
            <button class="btn ghost row-btn" onclick="Bridge.openRecHistory('${esc(p.id)}')">历史录制</button>
            <button class="btn ghost row-btn" onclick="Bridge.openLatestDebug('${esc(p.id)}')">脚本调试</button>
            <button class="btn ghost row-btn" onclick="Bridge.openProjModal('${esc(p.id)}')">编辑</button>
            <button class="btn danger row-btn" onclick="Bridge.confirmDelProj('${esc(p.name)}','${esc(p.id)}')">删除</button>
          </td></tr>`;
      })
      .join("");
  }

  /** 项目卡片模板（现有卡片样式） */
  function renderProjCards(list) {
    if (!list.length) return `<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:40px">暂无录制项目 · 「新建录制」创建第一个项目</div>`;
    const typeLabel = { ai: "AI 录制", browser: "浏览器录制" };
    const statusMap = { ready: ["green", "就绪"], draft: ["amber", "草稿"], archived: ["gray", "归档"] };
    return list
      .map((p) => {
        const [scls, slabel] = statusMap[p.status] || ["gray", p.status];
        const isAi = p.type === "ai";
        return `<div class="proj" data-name="${esc(p.name)}" data-id="${esc(p.id)}" data-type="${typeLabel[p.type]}" onclick="Bridge.openProject('${esc(p.id)}')">
          <div class="top"><span class="proj-ico" style="background:var(--tag-${isAi ? "ai" : "br"}-bg);color:var(--tag-${isAi ? "ai" : "br"}-tx)">${isAi ? "✦" : "🌐"}</span><span class="name">${esc(p.name)}</span><span class="tag ${scls}" style="margin-left:auto">${slabel}</span></div>
          <div class="desc">${esc(p.description || typeLabel[p.type] + "项目")}</div>
          <div class="meta"><span class="mono">${fmtTime(p.createdAt).slice(5, 10)}</span> · <span>${typeLabel[p.type]}</span> · <span>${p.stepsCount ?? 0} 步</span></div>
          <div class="actions"><button class="btn primary" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.startRecord('${esc(p.id)}')">启动录制</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.openRecHistory('${esc(p.id)}')">历史录制</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.openLatestDebug('${esc(p.id)}')">脚本调试</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.openProjModal('${esc(p.id)}')">编辑</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.confirmDelProj('${esc(p.name)}','${esc(p.id)}')">删除</button></div></div>`;
      })
      .join("");
  }

  // ===== 1. 工作台：全数据 dashboard =====
  async function loadDashboard() {
    try {
      const [stats, trend, recent, recentProjects, recentTasks, recentReports] = await Promise.all([
        api("/api/dashboard/stats"),
        api("/api/dashboard/trend?days=7"),
        api("/api/dashboard/recent-runs?limit=6"),
        api("/api/projects?page=1&pageSize=5").catch(() => ({ list: [] })),
        api("/api/tasks?page=1&pageSize=5").catch(() => ({ list: [] })),
        api("/api/reports?page=1&pageSize=5").catch(() => ({ list: [] })),
      ]);

      // 统计卡（六维）
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      const t = stats.tasks;
      set("dash-projects", stats.projects.total);
      set("dash-projects-sub", `${stats.projects.ready} ready · AI ${stats.projects.ai} / 浏览器 ${stats.projects.browser}`);
      set("dash-tasks", t.total);
      set("dash-tasks-sub", `成功 ${t.byStatus.success} · 失败 ${t.byStatus.failed} · 停止 ${t.byStatus.stopped}`);
      set("dash-plans", stats.plans.total);
      set("dash-plans-sub", stats.plans.running > 0 ? `${stats.plans.running} 个运行中` : "全部空闲");
      set("dash-reports", stats.reports24h.total);
      set("dash-reports-sub", `24h 通过率 ${stats.reports24h.passRate}%`);
      set("dash-pending", t.byStatus.pending);
      set("dash-running", t.byStatus.running + t.byStatus.retrying);
      set("dash-running-sub", stats.queue.running ? `当前: ${stats.queue.currentTaskName ?? "-"}` : "无运行任务");
      const hint = document.getElementById("dash-queue-hint");
      if (hint) hint.textContent = `队列 ${stats.queue.queueLength} 个等待 · 串行槽位 ${stats.queue.running ? "1/1" : "0/1"}`;

      // 趋势图（纯 CSS 柱状，成功/失败堆叠）
      const trendEl = document.getElementById("dash-trend");
      if (trendEl) {
        const buckets = trend.buckets || [];
        const max = Math.max(1, ...buckets.map((b) => b.total));
        trendEl.innerHTML = buckets
          .map((b) => {
            const h = Math.round((b.total / max) * 100);
            const failH = b.total > 0 ? Math.round((b.failed / b.total) * h) : 0;
            const okH = h - failH;
            const date = b.date.slice(5);
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px" title="${b.date}：${b.total} 份（成功 ${b.success} / 失败 ${b.failed}，通过率 ${b.passRate}%）">
              <div style="width:70%;height:150px;display:flex;flex-direction:column;justify-content:flex-end">
                <div style="height:${failH}%;background:var(--danger);border-radius:3px 3px 0 0"></div>
                <div style="height:${Math.max(okH, b.total ? 4 : 0)}%;background:var(--success);border-radius:0 0 3px 3px"></div>
              </div>
              <span class="mono" style="font-size:10px;color:var(--text3)">${date}</span>
            </div>`;
          })
          .join("");
      }

      // 最近执行列表
      const recentEl = document.getElementById("dash-recent");
      if (recentEl) {
        recentEl.innerHTML = (recent.list || []).length
          ? recent.list
              .map(
                (r) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="Bridge.openRun('${esc(r.runId)}')">
                  ${statusTag(r.status === "completed" ? "completed" : r.status)}
                  <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.taskName || r.taskId)}</b>
                  <span class="mono" style="color:var(--text3);font-size:11px">${r.scheduleMode === "manual" ? "手动" : r.scheduleMode === "count" ? `迭代 ${r.currentIteration}/${r.plannedIterations ?? "-"}` : "按时长"}</span>
                  <span class="mono" style="color:${r.successCount > 0 && r.failedCount === 0 ? "var(--success)" : r.failedCount > 0 ? "var(--danger)" : "var(--text3)"};font-size:11px">${r.successCount}✓/${r.failedCount}✕</span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px">暂无执行记录</div>`;
      }
      // 最近录制面板（项目）
      const rpEl = document.getElementById("dash-recent-projects");
      if (rpEl) {
        rpEl.innerHTML = (recentProjects.list || []).length
          ? recentProjects.list
              .map(
                (p) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="go('page-projects');Bridge.openProject('${esc(p.id)}')">
                  <span style="width:20px;text-align:center">${p.type === "ai" ? "✦" : "🌐"}</span>
                  <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</b>
                  ${statusTag(p.status)}
                  <span class="mono" style="color:var(--text3);font-size:11px">${p.stepsCount} 步</span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px">暂无录制项目</div>`;
      }

      // 最近任务面板
      const rtEl = document.getElementById("dash-recent-tasks");
      if (rtEl) {
        rtEl.innerHTML = (recentTasks.list || []).length
          ? recentTasks.list
              .map(
                (t) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="go('page-task-list');openTaskRow('${esc(t.name)}','${esc(t.id)}')">
                  ${statusTag(t.status)}
                  <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b>
                  <span class="mono" style="color:var(--text3);font-size:11px">${esc(t.scheduleMode === "manual" ? "手动" : t.scheduleMode === "count" ? "循环" : "时长")}</span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px">暂无任务</div>`;
      }

      // 最近报告面板
      const rrEl = document.getElementById("dash-recent-reports");
      if (rrEl) {
        rrEl.innerHTML = (recentReports.list || []).length
          ? recentReports.list
              .map(
                (r) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="Bridge.openReport('${esc(r.id)}')">
                  ${statusTag(r.status)}
                  <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</b>
                  <span class="mono" style="color:${r.passRate >= 100 ? "var(--success)" : r.passRate > 0 ? "var(--warning, orange)" : "var(--danger)"};font-size:11px">${r.passRate}%</span>
                  <span class="mono" style="color:var(--text3);font-size:11px">${fmtTime(r.createdAt).slice(5, 10)}</span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px">暂无报告</div>`;
      }
    } catch (e) {
      /* 统计失败静默 */
    }
  }

  function closeTaskWizardIfOpen() {
    const mask = document.getElementById("task-wizard-mask");
    const modal = document.getElementById("task-wizard-modal");
    mask?.classList.remove("show");
    modal?.classList.remove("show");
  }

  /** 最近执行点击 → 跳监控页绑定该 run */
  function openRun(runId) {
    window.go?.("page-exec");
    bindMonitor(runId);
  }

  async function loadTasks(page) {
    page = page || 1;
    const tbody = document.getElementById("task-tbody");
    if (!tbody) return;
    try {
      const data = await api(`/api/tasks?page=${page}&pageSize=10`);
      renderPager(document.getElementById("task-pager"), {
        page, pageSize: 10, total: data.total,
        onPage: (p) => { loadTasks(p); window.scrollTo && document.querySelector("#tasktable")?.scrollIntoView({ block: "start" }); },
      });
      if (!data.list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">暂无任务 · 点击「新建任务」创建第一个测试任务</td></tr>`;
        syncBatchSel("task-tbody");
        return;
      }
      tbody.innerHTML = renderTaskRows(data.list);
      syncBatchSel("task-tbody");
      // 看板视图：真实任务按状态分组渲染
      renderBoard(data.list);
      // 筛选计数
      const cnt = { all: data.total, pending: 0, running: 0, done: 0, failed: 0 };
      for (const t of data.list) {
        if (t.status === "success") cnt.done++;
        else if (t.status === "failed" || t.status === "stopped") cnt.failed++;
        else if (t.status === "running" || t.status === "retrying") cnt.running++;
        else cnt.pending++;
      }
      ["all", "pending", "running", "done", "failed"].forEach((k) => {
        const el = document.getElementById(`cnt-${k}`);
        if (el) el.textContent = String(cnt[k]);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:24px">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  /** 任务行渲染模板（列表/筛选共用） */
  function renderTaskRows(list) {
    return list
      .map(
        (t) => `<tr data-row="${esc(t.id)}" data-id="${esc(t.id)}">
          <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
          <td onclick="Bridge.openTaskExec('${esc(t.id)}','${esc(t.name)}')" style="cursor:pointer;color:var(--text)"><b>${esc(t.name)}</b></td>
          <td>${esc(t.projectName || "-")}</td>
          <td>${statusTag(t.status)}</td>
          <td class="mono">${esc(t.browserType)}</td>
          <td class="mono">${t.lastRunAt ? fmtTime(t.lastRunAt).slice(5, 16) : "未执行"}</td>
          <td>
            <button class="btn ghost row-btn" onclick="Bridge.openTaskDetail('${esc(t.id)}','${esc(t.name)}')">详情</button>
            <button class="btn ghost row-btn" onclick="Bridge.editTaskFromDrawer()">编辑</button>
            <button class="btn ghost row-btn" onclick="Bridge.dwOpenTaskScript('${esc(t.id)}','${esc(t.name)}')">调试</button>
            <button class="btn ghost row-btn" onclick="Bridge.runTask('${esc(t.id)}')">执行</button>
            <button class="btn ghost row-btn" onclick="Bridge.openTaskHistory('${esc(t.id)}','${esc(t.name)}')">历史</button>
          </td></tr>`
      )
      .join("");
  }

  /** 看板：任务按状态分组（pending/running/done/failed） */
  function renderBoard(tasks) {
    const groups = {
      pending: { label: "待执行", color: "amber", items: [] },
      running: { label: "执行中", color: "cyan", items: [] },
      done: { label: "已完成", color: "green", items: [] },
      failed: { label: "失败", color: "red", items: [] },
    };
    for (const t of tasks) {
      const key = t.status === "success" ? "done" : t.status === "failed" || t.status === "stopped" ? "failed" : t.status === "running" || t.status === "retrying" ? "running" : "pending";
      groups[key].items.push(t);
    }
    const board = document.getElementById("board");
    if (!board) return;
    board.innerHTML = Object.entries(groups)
      .map(
        ([key, g]) => `<div class="col ${g.color}" data-col="${key}">
          <div class="col-head"><span class="col-dot"></span><b>${g.label}</b><span class="col-count">${g.items.length}</span></div>
          ${g.items.length
            ? g.items
                .map(
                  (t) => `<div class="taskcard" data-name="${esc(t.name)}" data-id="${esc(t.id)}" onclick="Bridge.openTaskExec('${esc(t.id)}','${esc(t.name)}')">
                    <div class="tc-top"><span class="tag ${t.projectId ? "ai" : "browser"}">${esc(t.scriptLang === "js" ? "JS" : t.scriptLang === "py" ? "PY" : "步骤")}</span><span class="tc-name">${esc(t.name)}</span></div>
                    <div class="tc-meta">${esc(t.browserType)} · ${t.lastRunAt ? fmtTime(t.lastRunAt).slice(5, 16).replace(" ", " ") : "未执行"}</div>
                  </div>`
                )
                .join("")
            : `<div style="color:var(--text3);font-size:12px;padding:14px 8px">暂无任务</div>`}
        </div>`
      )
      .join("");
  }

  // ===== 2. 任务详情抽屉：执行历史 =====
  async function openTaskExec(taskId, name) {
    try {
      window.__currentTaskId = taskId;
      window.__currentTaskName = name;
      const data = await api(`/api/tasks/${taskId}/executions?page=1&pageSize=10`);
      const drawer = document.getElementById("task-drawer");
      if (!drawer) return;
      const title = document.getElementById("task-d-title");
      if (title) title.textContent = name || "任务详情";
      const hist = drawer.querySelector(".hist-list");
      if (hist) {
        hist.innerHTML = data.list.length
          ? data.list
              .map(
                (h) => `<div class="hist-item" onclick="Bridge.openReplay(${h.id})">
                  <span class="mono">第 ${h.iterationIndex} 次</span>${statusTag(h.status)}
                  <span class="p-mini">${fmtTime(h.startedAt)} · ${h.durationMs ? (h.durationMs / 1000).toFixed(1) + "s" : "-"}</span>
                  <span class="go">回放 →</span></div>`
              )
              .join("")
          : `<div style="color:var(--text3);padding:12px 0">暂无执行历史</div>`;
      }
      document.getElementById("task-mask")?.classList.add("show");
      drawer.classList.add("show");
    } catch (e) {
      window.toast?.("加载执行历史失败", e.message);
    }
  }

  // ===== 3. 执行任务 =====
  async function runTask(taskId) {
    try {
      const data = await api(`/api/tasks/${taskId}/run`, { method: "POST", body: "{}" });
      window.toast?.(data.queuePosition <= 1 ? "任务已开始执行" : "任务已加入执行队列", `Run: ${data.runId}`);
      await loadTasks();
      await loadDashboard();
      // 跳到监控页并绑定该 run
      window.go?.("page-exec", null, { taskId });
      bindMonitor(data.runId);
    } catch (e) {
      window.toast?.("执行失败", e.message);
    }
  }

  // ===== 4. 执行监控：绑定 run 轮询 =====
  let monitorTimer = null;
  let monitorRunId = null;
  let monitorSeq = 0;

  function bindMonitor(runId) {
    monitorRunId = runId;
    monitorSeq = 0;
    execM.seqs = {};
    execM.tlCount = 0;
    execM.logCount = 0;
    execM.protocol = null;
    const logEl = document.getElementById("exec-log");
    if (logEl) logEl.innerHTML = `<div style="color:var(--text3)">等待执行日志…</div>`;
    const tl = document.getElementById("exec-timeline");
    if (tl) { tl.innerHTML = `<div style="color:var(--text3);font-size:12px">执行后每一步实时记录（含截图）</div>`; }
    const cnt = document.getElementById("exec-tl-count");
    if (cnt) cnt.textContent = "0 步";
    const lc = document.getElementById("exec-log-count");
    if (lc) lc.textContent = "0";
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(pollMonitor, 2000);
    pollMonitor();
  }

  /** 调度模式描述（执行监控顶部） */
  function scheduleLabel(mode, planned) {
    if (mode === "count") return `按次数 · ${planned ?? "-"} 次`;
    if (mode === "duration") return "按时长执行";
    return "手动执行";
  }

  async function pollMonitor() {
    if (!monitorRunId) return;
    if (!document.getElementById("page-exec")?.classList.contains("active")) return; // 页面不可见时暂停拉取
    try {
      const run = await api(`/api/task-runs/${monitorRunId}`);
      // 录制 json 协议（任务→项目→录制会话 actions），拉取一次缓存
      if (!execM.protocol) {
        const pr = await api(`/api/task-runs/${monitorRunId}/protocol`).catch(() => null);
        execM.protocol = pr?.steps || [];
      }
      // 顶部信息：任务 id / 迭代 / 名称·调度 / 统计行 / 指标格（替换原型静态数据）
      const titleMono = document.querySelector("#page-exec .page-title .mono");
      if (titleMono) titleMono.textContent = run.taskId || "";
      const titleTag = document.querySelector("#page-exec .page-title .tag");
      if (titleTag) titleTag.textContent = `迭代 ${run.currentIteration ?? "-"} / ${run.plannedIterations ?? "-"}`;
      const subEl = document.querySelector("#page-exec .page-sub");
      if (subEl) subEl.textContent = `${run.taskName || "任务"} · ${scheduleLabel(run.scheduleMode, run.plannedIterations)} · 实时执行状态`;
      const statLine = document.querySelector("#page-exec .exe-top .h-row .mono");
      if (statLine) statLine.textContent = `迭代 ${run.currentIteration ?? 0}/${run.plannedIterations ?? "-"} · 已完成 ${run.completedIterations ?? 0} 次 · elapsed ${run.elapsedMs ? (run.elapsedMs / 1000).toFixed(1) + "s" : "-"} · queue ${run.queuePosition ?? 0}/1`;
      const gridVals = document.querySelectorAll("#page-exec .exe-grid .exe-item .val");
      if (gridVals.length >= 4) {
        gridVals[1].textContent = scheduleLabel(run.scheduleMode, run.plannedIterations);
        gridVals[2].textContent = `第 ${run.currentIteration ?? 0} 次`;
        gridVals[3].textContent = run.startedAt ? fmtTime(run.startedAt).slice(11) : "-";
      }
      // 状态区
      const tag = document.getElementById("exec-status-tag");
      if (tag) {
        const map = { running: ["cyan", "执行中"], completed: ["green", "已完成"], stopped: ["gray", "已停止"], queued: ["cyan", "排队中"], error: ["red", "错误"] };
        const [cls, label] = map[run.status] || ["gray", run.status];
        tag.className = `tag ${cls}`;
        tag.innerHTML = `<span class="status-dot" style="width:6px;height:6px"></span>${label}`;
      }
      const val = document.getElementById("exec-status-val");
      if (val) {
        val.textContent = run.status.toUpperCase();
        val.style.color = run.status === "completed" ? "var(--success)" : run.status === "stopped" || run.status === "error" ? "var(--danger)" : "var(--primary)";
      }
      const bar = document.getElementById("exec-bar");
      if (bar) {
        const pct = run.plannedIterations ? Math.round((run.completedIterations / run.plannedIterations) * 100) : run.status === "completed" ? 100 : 15;
        bar.style.width = pct + "%";
        if (run.status === "completed") bar.style.background = "var(--success)";
        if (run.status === "stopped" || run.status === "error") bar.style.background = "var(--danger)";
      }
      const stopBtn = document.getElementById("exec-stop-btn");
      if (stopBtn) stopBtn.disabled = ["completed", "stopped", "error"].includes(run.status);
      execM.runId = monitorRunId;
      // 左栏：执行轮次（含展开状态）
      await execRenderRounds(run);
      // 中栏：全部轮次时间线聚合（与录制页同构，实时累积）
      await execAppendTimeline(run);
      // 右栏：调试日志增量
      const logEl = document.getElementById("exec-log");
      if (logEl) {
        const logs = await api(`/api/task-runs/${monitorRunId}/logs?afterSeq=${monitorSeq}&limit=200`);
        for (const l of logs.logs || []) {
          const color = l.level === "ok" ? "var(--success)" : l.level === "error" ? "var(--danger)" : "var(--text2)";
          const div = document.createElement("div");
          div.innerHTML = `<span style="color:var(--text3)">${fmtTime(l.ts).slice(11)}</span> <span style="color:${color}">[${l.level.toUpperCase()}] ${esc(l.message)}</span>`;
          logEl.appendChild(div);
        }
        if (logs.logs?.length) {
          logEl.scrollTop = logEl.scrollHeight;
          execM.logCount += logs.logs.length;
          const cnt = document.getElementById("exec-log-count");
          if (cnt) cnt.textContent = String(execM.logCount);
          const hint = logEl.querySelector("div[style*='color:var(--text3)']");
          if (hint) hint.remove();
        }
        monitorSeq = logs.nextSeq || monitorSeq;
      }
      // 终态停止轮询
      if (["completed", "stopped", "error"].includes(run.status) && monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
        window.toast?.("执行已结束", `成功 ${run.successCount} · 失败 ${run.failedCount}`);
      }
    } catch (e) {
      /* run 可能已不存在 */
    }
  }

  async function stopMonitor() {
    if (!monitorRunId) return;
    try {
      await api(`/api/task-runs/${monitorRunId}/stop`, { method: "POST", body: "{}" });
      window.toast?.("停止请求已发送", "已产生的数据保留");
    } catch (e) {
      window.toast?.("停止失败", e.message);
    }
  }

  // ===== 5. 历史回放（执行迭代） =====
  async function openReplay(executionId) {
    try {
      const exec = await api(`/api/executions/${executionId}`);
      const title = document.getElementById("replay-title");
      if (title) title.textContent = `第 ${exec.iterationIndex} 次迭代 · 回放`;
      const drawer = document.getElementById("replay-drawer");
      if (drawer) {
        // 填充详情行（前 4 个 detail-item）
        const items = drawer.querySelectorAll(".drawer-body .detail-item");
        const vals = [
          fmtTime(exec.startedAt),
          `${exec.taskName || ""} · 尝试 ${exec.attempt + 1}`,
          exec.status === "success" ? "通过" : exec.status,
          exec.durationMs ? (exec.durationMs / 1000).toFixed(1) + "s" : "-",
        ];
        items.forEach((item, i) => {
          if (vals[i] !== undefined) item.querySelector(".v").textContent = vals[i];
        });
        // 日志
        const logs = await api(`/api/executions/${executionId}/logs?afterSeq=0&limit=500`);
        const logEl = drawer.querySelector(".log");
        if (logEl) {
          logEl.innerHTML =
            logs.logs.length
              ? logs.logs
                  .map(
                    (l) => `<div><span class="t">${fmtTime(l.ts).slice(11)}</span> <span class="${l.level === "ok" ? "ok" : l.level === "error" ? "err" : "info"}">[${l.level.toUpperCase()}] ${esc(l.message)}</span></div>`
                  )
                  .join("")
              : `<div style="color:var(--text3)">无日志</div>`;
        }
        // 步骤截图（steps 有 screenshotUrl 的渲染图片）
        const shots = drawer.querySelector(".shots");
        if (shots) {
          const withShot = (exec.steps || []).filter((s) => s.screenshotUrl);
          shots.innerHTML = withShot.length
            ? withShot
                .map(
                  (s) => `<div class="shot" onclick="openLb('步骤 ${s.stepIndex}')" style="background-image:url('${s.screenshotUrl}');background-size:cover"><span class="cap">步骤 ${s.stepIndex}</span></div>`
                )
                .join("")
            : `<div style="color:var(--text3);grid-column:1/-1">无截图</div>`;
        }
      }
      document.getElementById("replay-mask")?.classList.add("show");
      drawer?.classList.add("show");
    } catch (e) {
      window.toast?.("回放加载失败", e.message);
    }
  }

  // ===== 6. 录制项目：卡片网格 =====
  async function loadProjects(page) {
    page = page || 1;
    const grid = document.querySelector("#page-projects .proj-grid");
    if (!grid) return;
    try {
      const data = await api(`/api/projects?page=${page}&pageSize=12`);
      renderPager(document.getElementById("proj-pager"), {
        page, pageSize: 12, total: data.total,
        onPage: (p) => loadProjects(p),
      });
      renderPageView("projects", data);
      const sub = document.querySelector("#page-projects .page-sub");
      if (sub) sub.textContent = `AI 录制与浏览器录制统一管理 · 共 ${data.total} 个项目 · 点击查看详情`;
    } catch (e) {
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--danger);padding:24px">加载失败：${esc(e.message)}</div>`;
    }
  }

  /** 项目删除确认（复用原型 confirm 弹窗） */
  function confirmDelProj(name, id) {
    window.__confirmType = "proj";
    window.__confirmId = id;
    window.__confirmName = name;
    document.getElementById("confirm-title").textContent = "确认删除项目";
    document.getElementById("confirm-msg").innerHTML =
      `确定删除项目 <b style="color:var(--text)">${esc(name)}</b> ？<br>将删除该项目的全部关联任务、执行历史与报告，且不可恢复。`;
    document.getElementById("confirm-ok-btn").textContent = "确认删除";
    document.getElementById("confirm-mask")?.classList.add("show");
    document.getElementById("confirm-modal")?.classList.add("show");
  }

  /** 计划删除确认 */
  function confirmDelPlan(name, id) {
    window.__confirmType = "plan";
    window.__confirmId = id;
    window.__confirmName = name;
    document.getElementById("confirm-title").textContent = "确认删除计划";
    document.getElementById("confirm-msg").innerHTML =
      `确定删除计划 <b style="color:var(--text)">${esc(name)}</b> ？<br>将删除该计划及全部执行历史，且不可恢复。`;
    document.getElementById("confirm-ok-btn").textContent = "确认删除";
    document.getElementById("confirm-mask")?.classList.add("show");
    document.getElementById("confirm-modal")?.classList.add("show");
  }

  async function openProject(projectId) {
    try {
      const p = await api(`/api/projects/${projectId}`);
      const drawer = document.getElementById("proj-drawer");
      if (!drawer) return;
      document.getElementById("proj-d-title").textContent = p.name;
      document.getElementById("proj-d-id").textContent = p.id;
      document.getElementById("proj-d-type").textContent = p.type === "ai" ? "AI 录制" : "浏览器录制";
      const st = document.getElementById("proj-d-status");
      if (st) {
        const map = { ready: ["green", "就绪"], draft: ["gray", "草稿"], archived: ["gray", "已归档"] };
        const [cls, label] = map[p.status] || ["gray", p.status];
        st.className = `tag ${cls}`;
        st.textContent = label;
      }
      document.getElementById("proj-d-tasks").textContent = `${p.tasks?.length ?? 0} 个`;

      // 脚本内容（真实 scriptContent）
      const scriptEl = document.getElementById("proj-d-script");
      if (scriptEl) {
        scriptEl.textContent = p.scriptContent && p.scriptContent.trim() ? p.scriptContent : "// 暂无脚本";
      }
      const langEl = document.getElementById("proj-d-script-lang");
      if (langEl) langEl.textContent = p.scriptLang || "-";
      window.__currentProjectId = projectId;

      // 录制步骤（recordConfig.steps 留档）
      const cfg = p.recordConfig || {};
      const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
      const stepsEl = document.getElementById("proj-d-steps");
      const cntEl = document.getElementById("proj-d-steps-count");
      if (cntEl) cntEl.textContent = steps.length ? `共 ${steps.length} 步` : "";
      if (stepsEl) {
        stepsEl.innerHTML = steps.length
          ? steps
              .map(
                (s, i) => `<div class="pick-item"><span class="p-order">${i + 1}</span>${esc(s.desc || s.method)}<span style="margin-left:auto;color:var(--text3);font-size:11px" class="mono">${esc((s.locator || {}).primary || s.method)}</span></div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px;padding:6px 2px">无录制步骤（${p.scriptLang === "js" ? "脚本直存" : "未录制"}）</div>`;
      }

      // 录制历史：AI 项目 → /api/sessions；浏览器录制项目 → /api/inspect/sessions（按 startUrl 关联）
      loadProjectHistory(projectId, p.type, p.startUrl);

      document.getElementById("proj-mask")?.classList.add("show");
      drawer.classList.add("show");
    } catch (e) {
      window.toast?.("项目详情加载失败", e.message);
    }
  }

  /** 嵌入页会话历史列表（AI 页 / 浏览器录制页） */
  async function loadEmbedHistory(kind) {
    const el = document.getElementById(kind === "ai" ? "ai-sess-history" : "browser-sess-history");
    if (!el) return;
    try {
      let sessions = [];
      if (kind === "ai") {
        const all = await api("/api/sessions");
        sessions = (Array.isArray(all) ? all : []).slice(0, 8).map((s) => ({
          id: s.session_id, kind: "ai", url: s.start_url, title: s.title || "AI 会话",
          steps: s.step_count,
          time: new Date(Number(s.updated_at) * 1000).toISOString().slice(0, 16).replace("T", " "),
        }));
      } else {
        const all = await api("/api/inspect/sessions");
        sessions = all.slice(0, 8).map((s) => ({
          id: s.sid, kind: "inspect", url: s.start_url, title: "浏览器录制",
          steps: s.step_count,
          time: new Date(Number(s.updated_at) * 1000).toISOString().slice(0, 16).replace("T", " "),
          alive: s.alive,
        }));
      }
      el.innerHTML = sessions.length
        ? sessions
            .map(
              (s) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="Bridge.openSessionHistory('${esc(s.id)}','${s.kind}')">
                <span class="tag ${s.kind === "ai" ? "cyan" : "red"}" style="flex-shrink:0">${s.kind === "ai" ? "AI" : "浏览器"}</span>
                <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)">${esc(s.url || s.title)}</span>
                <span class="mono" style="color:var(--text3);font-size:11px">${s.steps} 步</span>
                <span class="mono" style="color:var(--text3);font-size:11px">${s.time}</span>
                <span style="color:var(--primary);font-size:11px">查看 →</span>
              </div>`
            )
            .join("")
        : `<div style="color:var(--text3);font-size:12px">暂无${kind === "ai" ? " AI " : "浏览器"}录制会话</div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--text3);font-size:12px">会话历史加载失败</div>`;
    }
  }

  /** 关闭视频播放 */
  function dwCloseVideo() {
    const lb = document.getElementById(dwQ("dw-video-lb"));
    if (lb) lb.style.display = "none";
  }

  /** 编辑任务：打开向导预填名称（保存走 PUT） */
  function editTaskFromDrawer() {
    const taskId = window.__currentTaskId;
    const name = window.__currentTaskName || "任务";
    window.__editingTaskId = taskId || null;
    window.openTaskWizard && window.openTaskWizard();
    setTimeout(() => {
      const n = document.getElementById("task-name");
      if (n) n.value = name;
    }, 200);
    window.toast?.("已载入任务配置进行编辑", name);
  }

  /** 停止执行：有活跃 run → 真实 stop */
  async function stopTaskFromDrawer() {
    const taskId = window.__currentTaskId;
    if (!taskId) {
      window.toast?.("无任务上下文", "");
      return;
    }
    try {
      const q = await api("/api/config/queue/status");
      const running = q.currentRunId ? await api(`/api/task-runs/${q.currentRunId}`).catch(() => null) : null;
      if (running && running.taskId === taskId) {
        await api(`/api/task-runs/${running.runId}/stop`, { method: "POST", body: "{}" });
        window.toast?.("停止请求已发送", "已产生的数据保留");
      } else {
        window.toast?.("该任务无运行中的执行", "");
      }
    } catch (e) {
      window.toast?.("操作失败", e.message);
    }
  }

  /** 查看最近报告 */
  async function openTaskLatestReport() {
    const taskId = window.__currentTaskId;
    if (!taskId) return;
    try {
      const d = await api(`/api/reports?taskId=${taskId}&page=1&pageSize=1`);
      if (d.list?.length) {
        closeDrawer("task");
        openReport(d.list[0].id);
      } else {
        window.toast?.("该任务暂无报告", "执行任务后生成");
      }
    } catch (e) {
      window.toast?.("报告查询失败", e.message);
    }
  }

  /** 批量执行选中任务 */
  async function batchRunTasks() {
    const ids = getCheckedTaskIds();
    if (!ids.length) {
      window.toast?.("请先勾选任务", "");
      return;
    }
    let ok = 0;
    for (const id of ids) {
      try {
        await api(`/api/tasks/${id}/run`, { method: "POST", body: "{}" });
        ok++;
      } catch (e) { /* 单个失败继续 */ }
    }
    window.toast?.(`已批量执行 ${ok}/${ids.length} 个任务`, "已加入执行队列");
    loadTasks();
  }

  /** 勾选任务 id 集合 */
  function getCheckedTaskIds() {
    return getCheckedIds("task-tbody");
  }

  /** 勾选 id 集合（通用：行勾选框 → 所在行 data-id） */
  function getCheckedIds(tbodyId) {
    const ids = [];
    document.querySelectorAll(`#${tbodyId} .row-check:checked`).forEach((cb) => {
      const tr = cb.closest("tr");
      if (tr?.dataset?.id) ids.push(tr.dataset.id);
    });
    return ids;
  }

  /** 批量删除通用入口：确认弹窗 → confirmOk(batchDel) 逐个 DELETE（单个失败继续） */
  function batchDelete({ tbodyId, label, endpoint, warning, reload }) {
    const ids = getCheckedIds(tbodyId);
    if (!ids.length) {
      window.toast?.("请先勾选", "");
      return;
    }
    window.__batchDel = { ids, label, endpoint, reload };
    document.getElementById("confirm-title").textContent = "确认批量删除";
    document.getElementById("confirm-msg").innerHTML =
      `确定删除选中的 <b style="color:var(--text)">${ids.length}</b> 个${label}？<br>${warning}`;
    document.getElementById("confirm-ok-btn").textContent = "确认删除";
    window.__confirmType = "batchDel";
    document.getElementById("confirm-mask")?.classList.add("show");
    document.getElementById("confirm-modal")?.classList.add("show");
  }

  /** 批量删除选中任务（确认后逐个 DELETE） */
  function batchDeleteTasks() {
    batchDelete({
      tbodyId: "task-tbody",
      label: "测试任务",
      endpoint: (id) => `/api/tasks/${id}`,
      warning: "将删除任务脚本、资源、执行历史与报告，且不可恢复。",
      reload: () => {
        loadTasks();
        loadDashboard();
      },
    });
  }

  /** 批量删除选中计划（执行中的计划后端拒绝，逐个跳过） */
  function batchDeletePlans() {
    batchDelete({
      tbodyId: "plan-tbody",
      label: "测试计划",
      endpoint: (id) => `/api/plans/${id}`,
      warning: "将删除计划及全部执行历史，且不可恢复；执行中的计划会被跳过。",
      reload: () => {
        loadPlans();
        loadDashboard();
      },
    });
  }

  /** 批量删除报告（报告中心 / 任务历史两处共用，按当前所在页取勾选） */
  function batchDeleteReports() {
    const inHistory = document.getElementById("page-task-history")?.classList.contains("active");
    batchDelete({
      tbodyId: inHistory ? "th-tbody" : "rpt-tbody",
      label: "测试报告",
      endpoint: (id) => `/api/reports/${id}`,
      warning: "将删除报告记录，且不可恢复；任务与计划不受影响。",
      reload: () => {
        if (inHistory && window.__thTaskId) loadTaskHistory(window.__thTaskId, window.__thTaskName);
        else loadReports();
        loadDashboard();
      },
    });
  }

  /** 批量删除录制项目（含运行中任务的项目后端拒绝，逐个跳过） */
  function batchDeleteProjects() {
    batchDelete({
      tbodyId: "proj-tbody",
      label: "录制项目",
      endpoint: (id) => `/api/projects/${id}`,
      warning: "将删除项目及其全部关联任务、执行历史与报告，且不可恢复；执行中的任务会被跳过。",
      reload: () => {
        loadProjects();
        loadDashboard();
      },
    });
  }

  // ===== 列表批量选择（任务/计划/报告/历史/项目 统一：全选 + 已选计数 + 三态） =====
  const SEL_SCOPES = [
    { all: "check-all", count: "sel-count", tbody: "task-tbody" },
    { all: "plan-check-all", count: "plan-sel-count", tbody: "plan-tbody" },
    { all: "rpt-check-all", count: "rpt-sel-count", tbody: "rpt-tbody" },
    { all: "th-check-all", count: "th-sel-count", tbody: "th-tbody" },
    { all: "proj-check-all", count: "proj-sel-count", tbody: "proj-tbody" },
  ];
  /** 同步某列表的「已选 N 项」与全选框三态（列表重渲染后勾选清零，也调它复位） */
  function syncBatchSel(tbodyId) {
    const scope = SEL_SCOPES.find((s) => s.tbody === tbodyId);
    if (!scope) return;
    const boxes = document.querySelectorAll(`#${scope.tbody} .row-check`);
    const checked = document.querySelectorAll(`#${scope.tbody} .row-check:checked`);
    const cnt = document.getElementById(scope.count);
    if (cnt) cnt.textContent = String(checked.length);
    const all = document.getElementById(scope.all);
    if (all) {
      all.checked = boxes.length > 0 && checked.length === boxes.length;
      all.indeterminate = checked.length > 0 && checked.length < boxes.length;
    }
  }
  function initBatchSel() {
    SEL_SCOPES.forEach(({ all, tbody }) => {
      const allEl = document.getElementById(all);
      if (!allEl) return;
      allEl.addEventListener("change", () => {
        document.querySelectorAll(`#${tbody} .row-check`).forEach((c) => (c.checked = allEl.checked));
        syncBatchSel(tbody);
      });
    });
    // 行勾选框随列表重渲染重建 → 用事件委托保证计数始终生效
    document.addEventListener("change", (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.classList.contains("row-check")) return;
      const tr = cb.closest("tr");
      const tbody = tr?.parentElement;
      if (tbody?.id) syncBatchSel(tbody.id);
    });
  }

  /** 任务筛选（状态） */
  function filterTasks(f) {
    document.querySelectorAll("#task-filters .filter-chip").forEach((s) => s.classList.toggle("on", s.dataset.f === f));
    const map = { all: "", pending: "&status=pending", running: "&status=running", done: "&status=success", failed: "&status=failed" };
    loadTasksWithFilter(map[f] || "");
  }

  async function loadTasksWithFilter(statusQuery, page) {
    page = page || 1;
    const tbody = document.getElementById("task-tbody");
    if (!tbody) return;
    try {
      const data = await api(`/api/tasks?page=${page}&pageSize=10${statusQuery}`);
      renderPager(document.getElementById("task-pager"), {
        page, pageSize: 10, total: data.total,
        onPage: (p) => loadTasksWithFilter(statusQuery, p),
      });
      tbody.innerHTML = renderTaskRows(data.list);
      if (data.total === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">无匹配任务</td></tr>`;
      }
      syncBatchSel("task-tbody");
    } catch (e) { /* pass */ }
  }

  /** 全局搜索：按关键词查任务/项目，结果跳转并提示 */
  async function globalSearch() {
    const v = document.getElementById("global-search")?.value?.trim();
    if (!v) return;
    try {
      const [tasks, projects] = await Promise.all([
        api(`/api/tasks?keyword=${encodeURIComponent(v)}&page=1&pageSize=5`).catch(() => ({ list: [], total: 0 })),
        api(`/api/projects?keyword=${encodeURIComponent(v)}&page=1&pageSize=5`).catch(() => ({ list: [], total: 0 })),
      ]);
      const t = tasks.total || 0;
      const p = projects.total || 0;
      if (t > 0 || p > 0) {
        window.toast?.(`找到 ${t} 个任务 / ${p} 个项目`, `关键词：${v}`);
        // 优先任务
        if (t > 0) {
          go("page-task-list");
          loadTasksWithFilter("");
        } else {
          go("page-projects");
          loadProjects();
        }
      } else {
        window.toast?.("未匹配到任务或项目", `关键词：${v}`);
      }
    } catch (e) {
      window.toast?.("搜索失败", e.message);
    }
  }

  // ===== 向导第 2 步：真实文件上传（脚本 + 资源） =====
  let __wizScriptUpload = null;   // {uploadId, filename, size}
  let __wizResourceUploads = [];  // [{uploadId, filename, size}]

  /** 选择并上传脚本文件 */
  function dwPickScript() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".js,.py";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append("kind", "script");
        fd.append("file", file);
        const res = await fetch("/api/uploads", { method: "POST", body: fd });
        const body = await res.json();
        if (body.code !== 0) throw new Error(body.message || "上传失败");
        __wizScriptUpload = { uploadId: body.data.uploadId, filename: file.name, size: file.size };
        const chip = document.getElementById("wiz-script-chip");
        if (chip) {
          chip.style.display = "flex";
          chip.innerHTML = `<span class="file-chip"><span>📄 ${esc(file.name)}</span><span class="mono" style="color:var(--text3)">${(file.size / 1024).toFixed(1)} KB</span><span class="tag ai">已上传</span><span class="fx" onclick="Bridge.dwClearScript()">✕</span></span>`;
        }
        window.toast?.("脚本已上传", body.data.uploadId);
        // 切到「上传脚本文件」来源
        const src = document.getElementById("src-upload");
        if (src && !src.classList.contains("on")) setScriptSrc && setScriptSrc("upload");
      } catch (e) {
        window.toast?.("脚本上传失败", e.message);
      }
    };
    input.click();
  }

  /** 移除脚本 */
  function dwClearScript() {
    __wizScriptUpload = null;
    const chip = document.getElementById("wiz-script-chip");
    if (chip) chip.style.display = "none";
  }

  /** 批量选择并上传资源文件 */
  function dwPickResource() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      let ok = 0;
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append("kind", "resource");
          fd.append("file", file);
          const res = await fetch("/api/uploads", { method: "POST", body: fd });
          const body = await res.json();
          if (body.code === 0) {
            __wizResourceUploads.push({ uploadId: body.data.uploadId, filename: file.name, size: file.size });
            ok++;
          }
        } catch (e) { /* 单个失败继续 */ }
      }
      renderWizResources();
      window.toast?.(`已上传 ${ok}/${files.length} 个资源文件`, "");
    };
    input.click();
  }

  /** 渲染资源列表 */
  function renderWizResources() {
    const list = document.getElementById("wiz-res-list");
    if (!list) return;
    list.innerHTML = __wizResourceUploads.length
      ? __wizResourceUploads
          .map(
            (r, i) => `<span class="file-chip"><span>${esc(r.filename)}</span><span class="mono" style="color:var(--text3)">${(r.size / 1024).toFixed(1)} KB</span><span class="tag browser">资源</span><span class="fx" onclick="Bridge.dwRemoveResource(${i})">✕</span></span>`
          )
          .join("")
      : "";
  }

  /** 移除资源 */
  function dwRemoveResource(idx) {
    __wizResourceUploads.splice(idx, 1);
    renderWizResources();
  }

  /** 任务列表「脚本调试」：进入脚本调试工作台并直接加载该任务脚本快照 */
  async function dwOpenTaskScript(taskId, taskName) {
    window.go?.("page-debug-task", "task", { taskId }); // 任务脚本调试独立页 + URL 带任务 id
    // 等待工作台初始化完成（首次进入时 dwInit 会触发自动加载，需在其后写入）
    for (let i = 0; i < 20; i++) {
      if (window.__dwInited) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 600)); // 等自动加载落定
    try {
      // 任务快照经 db://tasks/{id}/scriptSnapshot 直接读取（不依赖文件树归属项目）
      const data = await api(`/api/debug-workbench/file?path=${encodeURIComponent(`db://tasks/${taskId}/scriptSnapshot`)}`);
      const codeEl = document.getElementById(dwQ("dw-code"));
      if (codeEl) codeEl.value = data.content;
      const titleEl = document.getElementById(dwQ("dw-code-title"));
      if (titleEl) titleEl.textContent = `${taskName || data.name}.${data.lang}`;
      const langEl = document.getElementById(dwQ("dw-code-lang"));
      if (langEl) langEl.textContent = data.lang || "-";
      window.toast?.("已加载任务脚本", taskName);
      // 高亮文件树对应项（若存在）
      document.querySelectorAll(".dw-file").forEach((el) => {
        el.style.background = el.getAttribute("data-path")?.includes(`/tasks/${taskId}/`) ? "var(--primary-dim)" : "";
      });
    } catch (e) {
      window.toast?.("任务脚本加载失败", e.message);
    }
  }

  /** 任务行「👁 详情」：进入任务详情只读页 */
  function openTaskDetail(taskId, taskName) {
    window.go?.("page-task-detail", "task", { taskId });
    loadTaskDetail(taskId, taskName);
  }

  /** 渲染任务详情只读页（全部信息） */
  async function loadTaskDetail(taskId, taskName) {
    window.__thTaskId = taskId;
    window.__thTaskName = taskName || "任务";
    window.__currentTaskId = taskId;
    window.__currentTaskName = taskName;
    try {
      const t = await api(`/api/tasks/${taskId}`);
      const idEl = document.getElementById("td-task-id");
      if (idEl) idEl.textContent = taskId;
      const stEl = document.getElementById("td-status");
      if (stEl) {
        const map = { pending: ["gray", "待执行"], running: ["cyan", "执行中"], retrying: ["amber", "重试中"], success: ["green", "成功"], failed: ["red", "失败"], stopped: ["gray", "已停止"] };
        const [cls, label] = map[t.status] || ["gray", t.status];
        stEl.className = `tag ${cls}`;
        stEl.textContent = label;
      }
      // 基本信息
      const project = t.projectId ? await api(`/api/projects/${t.projectId}`).catch(() => null) : null;
      const basic = document.getElementById("td-basic");
      if (basic) {
        basic.innerHTML = [
          ["任务名称", t.name],
          ["任务描述", t.description || "-"],
          ["所属项目", project ? project.name : (t.projectId || "无（独立脚本）")],
          ["脚本来源", t.scriptSource === "project" ? "录制项目" : "上传脚本"],
          ["脚本语言", t.scriptLang],
          ["浏览器", t.browserType + (t.browserPath ? ` · ${t.browserPath}` : "")],
          ["状态", t.status],
          ["创建时间", String(t.createdAt || "-").slice(0, 19).replace("T", " ")],
          ["更新时间", String(t.updatedAt || "-").slice(0, 19).replace("T", " ")],
          ["最近执行", t.lastRunAt ? String(t.lastRunAt).slice(0, 19).replace("T", " ") : "未执行"],
        ]
          .map(([k, v]) => `<div class="sum-item"><span class="k">${k}</span><span class="v">${esc(String(v))}</span></div>`)
          .join("");
      }
      // 调度与参数
      const params = t.params && typeof t.params === "object" && Object.keys(t.params).length ? JSON.stringify(t.params, null, 2) : "（无参数）";
      const sc = t.scheduleConfig || {};
      const schedDesc = t.scheduleMode === "count" ? `按次数循环 · ${sc.iterations} 次` : t.scheduleMode === "time" ? `按时间循环 · ${(sc.durationMs || 0) / 60000} 分钟` : "手动执行";
      const sched = document.getElementById("td-sched");
      if (sched) {
        sched.innerHTML = [
          ["调度方式", schedDesc],
          ["迭代间隔", `${sc.intervalMs || 0} ms`],
          ["重试上限", String(t.maxRetries)],
          ["执行参数", `<pre style="margin:4px 0 0;font-family:var(--mono);font-size:11px;color:var(--text2);white-space:pre-wrap;max-height:120px;overflow:auto">${esc(params)}</pre>`],
        ]
          .map(([k, v]) => `<div class="sum-item"><span class="k">${k}</span><span class="v">${v}</span></div>`)
          .join("");
      }
      // 脚本快照
      const sl = document.getElementById("td-script-lang");
      if (sl) sl.textContent = t.scriptLang || "-";
      const scriptEl = document.getElementById("td-script");
      if (scriptEl) scriptEl.textContent = t.scriptSnapshot || "// 无脚本";
      // 文件
      const fc = document.getElementById("td-file-count");
      if (fc) fc.textContent = t.files?.length ? `(${t.files.length})` : "";
      const filesEl = document.getElementById("td-files");
      if (filesEl) {
        filesEl.innerHTML = t.files?.length
          ? t.files
              .map((f) => `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--input-bg);border-radius:6px;font-size:12px">
                <span>${f.kind === "script" ? "📄" : "🗂"}</span><span style="flex:1">${esc(f.filename)}</span>
                <span class="mono" style="color:var(--text3);font-size:11px">${(f.size / 1024).toFixed(1)} KB</span>
              </div>`)
              .join("")
          : `<div style="color:var(--text3);font-size:12px">无关联文件</div>`;
      }
      // 执行摘要
      const exec = await api(`/api/tasks/${taskId}/executions?page=1&pageSize=10`).catch(() => null);
      const execEl = document.getElementById("td-exec");
      if (execEl) {
        if (exec?.total) {
          const success = exec.list.filter((e) => e.status === "success").length;
          execEl.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:8px">
              <span style="color:var(--text3)">共 ${exec.total} 次迭代</span><span style="color:var(--success)">成功 ${success}</span><span style="color:var(--danger)">失败 ${exec.total - success}</span>
            </div>
            ${exec.list.slice(0, 5).map((e) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
              <span class="mono" style="color:var(--text3)">#${e.iterationIndex}</span>${e.status}
              <span class="mono" style="color:var(--text3);font-size:11px">${e.durationMs ? (e.durationMs / 1000).toFixed(1) + "s" : "-"}</span>
              <span style="margin-left:auto;color:var(--primary);cursor:pointer" onclick="Bridge.openReplay(${e.id})">回放 →</span>
            </div>`).join("")}`;
        } else {
          execEl.innerHTML = `<div style="color:var(--text3);font-size:12px">该任务尚未执行</div>`;
        }
      }
    } catch (e) {
      window.toast?.("任务详情加载失败", e.message);
    }
  }

  /** 任务行「📄 历史管理」：进入该任务历史管理页（报告列表） */
  function openTaskHistory(taskId, taskName) {
    window.go?.("page-task-history", "task", { taskId });
    loadTaskHistory(taskId, taskName);
  }

  /** 渲染任务历史管理页：该任务的报告列表 */
  async function loadTaskHistory(taskId, taskName, page) {
    page = page || 1;
    window.__thTaskId = taskId;
    window.__thTaskName = taskName || "任务";
    window.__currentTaskId = taskId;
    window.__currentTaskName = taskName;
    const nameEl = document.getElementById("th-task-name");
    if (nameEl) nameEl.textContent = `${taskName || ""} · ${taskId}`;
    const tbody = document.getElementById("th-tbody");
    if (!tbody) return;
    try {
      const d = await api(`/api/reports?taskId=${taskId}&page=${page}&pageSize=10`);
      renderPager(document.getElementById("th-pager"), {
        page, pageSize: 10, total: d.total,
        onPage: (p) => loadTaskHistory(taskId, taskName, p),
      });
      renderPageView("history", d);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--danger);padding:24px">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  /** 历史管理：报告 → 执行监控（绑定该报告对应 run；runId 缺失时提示） */
  function openTaskExecMonitor(runId) {
    if (!runId) {
      window.toast?.("该报告无执行记录", "无法进入执行监控");
      return;
    }
    window.go?.("page-exec", "task", { run: runId });
    bindMonitor(runId);
  }

  /** 历史管理页删除报告（确认后删） */
  async function deleteReportById(reportId) {
    window.__delReportId = reportId;
    document.getElementById("confirm-title").textContent = "确认删除报告";
    document.getElementById("confirm-msg").innerHTML = `确定删除报告 <b style="color:var(--text)">${esc(reportId)}</b> ？<br>将删除报告及其导出文件。`;
    document.getElementById("confirm-ok-btn").textContent = "确认删除";
    window.__confirmType = "delReport";
    document.getElementById("confirm-mask")?.classList.add("show");
    document.getElementById("confirm-modal")?.classList.add("show");
  }

  /** 一键创建测试任务（项目脚本来源 → 任务快照自动复制） */
  async function createTaskFromProject(projectId) {
    try {
      const p = await api(`/api/projects/${projectId}`);
      if (p.status !== "ready") {
        window.toast?.("项目未就绪", "仅 ready 项目可创建任务（先去编辑改状态）");
        return;
      }
      const task = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: `${p.name}-任务`,
          description: `由录制项目「${p.name}」一键创建`,
          scriptSource: "project",
          projectId,
          browserType: "chromium",
          schedule: { mode: "manual" },
        }),
      });
      window.toast?.("测试任务已创建", task.id);
      window.go?.("page-task-list");
      loadTasks();
    } catch (e) {
      window.toast?.("创建失败", e.message);
    }
  }

  /** 报告趋势图渲染（真实 trend API，日/周/月粒度） */
  async function renderReportTrend(taskId, granularity) {
    const chart = document.getElementById("rpt-chart");
    if (!chart || !taskId) return;
    try {
      const d = await api(`/api/reports/trend?taskId=${taskId}&granularity=${granularity}&limit=14`);
      const buckets = d.buckets || [];
      const max = Math.max(1, ...buckets.map((x) => x.total));
      chart.innerHTML = buckets.length
        ? buckets
            .map((x) => {
              const h = Math.round((x.total / max) * 100);
              const failH = x.total > 0 ? Math.round((x.failed / x.total) * h) : 0;
              return `<div class="barx" title="${x.bucket}：${x.total} 份（成功 ${x.success}/失败 ${x.failed}，通过率 ${x.passRate}%）">
                <div style="height:150px;display:flex;flex-direction:column;justify-content:flex-end">
                  <div style="height:${failH}%;background:var(--danger)"></div>
                  <div style="height:${Math.max(h - failH, x.total ? 4 : 0)}%;background:var(--primary)"></div>
                </div><span class="x">${esc(x.bucket.slice(-5))}</span></div>`;
            })
            .join("")
        : `<div style="color:var(--text3);font-size:12px;padding:20px 0">暂无趋势数据</div>`;
    } catch (e) {
      chart.innerHTML = `<div style="color:var(--danger);font-size:12px;padding:20px 0">趋势加载失败</div>`;
    }
  }

  /** 趋势粒度切换（日/周/月） */
  function reportTrend(granularity) {
    document.querySelectorAll("#trend-seg span").forEach((s) => s.classList.toggle("on", s.dataset.g === granularity));
    if (window.__reportTaskId) renderReportTrend(window.__reportTaskId, granularity);
  }

  /** 卡片「🎬 视频」：脚本回放录制视频并播放 */
  async function recordVideo(projectId) {
    const btn = document.querySelector(`.proj[data-id="${esc(projectId)}"] button` + '[onclick*="recordVideo"]');
    if (btn) { btn.disabled = true; btn.textContent = "⏺ 录制中…"; }
    try {
      const d = await api("/api/record/script-run", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      if (!d.videoUrl) {
        window.toast?.("录制失败", "无视频产物（项目无步骤流？）");
        return;
      }
      window.toast?.("视频录制完成", `${d.stepsCompleted} 步 · ${(d.durationMs / 1000).toFixed(1)}s`);
      dwPlayVideo(d.videoUrl);
    } catch (e) {
      window.toast?.("视频录制失败", e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🎬 视频"; }
    }
  }

  /** 视频播放 Lightbox */
  function dwPlayVideo(url) {
    let lb = document.getElementById(dwQ("dw-video-lb"));
    if (!lb) {
      lb = document.createElement("div");
      lb.id = "dw-video-lb";
      lb.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:96;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px";
      lb.innerHTML =
        '<video controls autoplay style="max-width:92vw;max-height:80vh;border-radius:10px;background:#000;box-shadow:0 24px 80px rgba(0,0,0,.6)"></video>' +
        '<div style="color:#ddd;font-size:12px;cursor:pointer" onclick="Bridge.dwCloseVideo()">点击任意处关闭 (Esc)</div>';
      lb.addEventListener("click", () => (lb.style.display = "none"));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") lb.style.display = "none";
      });
      document.body.appendChild(lb);
    }
    lb.querySelector("video").src = url;
    lb.style.display = "flex";
  }

  /** 卡片「启动」：按项目类型跳对应录制页（嵌入页），预填起始 URL */
  async function startRecord(projectId) {
    try {
      const p = await api(`/api/projects/${projectId}`);
      if (p.type === "ai") {
        // AI 录制：跳 AI 页并预填 URL/描述
        sessionStorage.setItem("autotest.prefill", JSON.stringify({ projectId, url: p.startUrl, desc: p.description || "" }));
        window.go?.("page-ai");
        activateEmbed("page-ai");
        // 嵌入页加载后 postMessage 预填（iframe 可能未就绪，双通道兜底）
        setTimeout(() => {
          const frame = document.getElementById("embed-ai");
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ type: "autotest.prefill", url: p.startUrl, desc: p.description || "" }, "*");
          }
        }, 1200);
        window.toast?.("已进入 AI 录制", p.startUrl || p.name);
      } else {
        // 浏览器录制：跳 inspect 页，URL 自动填入（postMessage 预填）
        sessionStorage.setItem("autotest.prefill", JSON.stringify({ projectId, url: p.startUrl }));
        window.go?.("page-browser");
        activateEmbed("page-browser");
        setTimeout(() => {
          const frame = document.getElementById("embed-browser");
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ type: "autotest.prefill", url: p.startUrl, projectId }, "*");
          }
        }, 1200);
        window.toast?.("已进入浏览器录制", p.startUrl || p.name);
      }
    } catch (e) {
      window.toast?.("启动失败", e.message);
    }
  }

  /** 卡片「历史」入口：打开项目抽屉并滚动至录制历史区块 */
  async function openProjectHistory(projectId) {
    await openProject(projectId);
    await new Promise((r) => setTimeout(r, 400));
    const drawer = document.getElementById("proj-drawer");
    const hist = document.getElementById("proj-d-history");
    if (drawer && hist) {
      hist.scrollIntoView({ behavior: "smooth", block: "center" });
      // 闪烁提示定位
      hist.style.outline = "2px solid var(--primary)";
      setTimeout(() => (hist.style.outline = ""), 1500);
    }
  }

  /** 项目 → 录制历史（会话列表） */
  async function loadProjectHistory(projectId, type, startUrl) {
    const el = document.getElementById("proj-d-history");
    if (!el) return;
    try {
      let sessions = [];
      if (type === "ai") {
        // AI 会话历史：start_url 与项目 startUrl 前缀匹配（或项目无 URL 时全部）
        const all = await api("/api/sessions");
        sessions = (Array.isArray(all) ? all : [])
          .filter((s) => !startUrl || String(s.start_url || "").startsWith(startUrl.replace(/\/$/, "")))
          .slice(0, 10)
          .map((s) => ({
            id: s.session_id,
            kind: "ai",
            url: s.start_url,
            title: s.title || "AI 会话",
            steps: s.step_count,
            time: new Date(Number(s.updated_at) * 1000).toISOString().slice(0, 16).replace("T", " "),
          }));
      } else {
        // 浏览器录制会话历史：start_url 匹配
        const all = await api("/api/inspect/sessions");
        sessions = all
          .filter((s) => !startUrl || String(s.start_url || "").startsWith(startUrl.replace(/\/$/, "").split("#")[0]))
          .slice(0, 10)
          .map((s) => ({
            id: s.sid,
            kind: "inspect",
            url: s.start_url,
            title: "浏览器录制",
            steps: s.step_count,
            time: new Date(Number(s.updated_at) * 1000).toISOString().slice(0, 16).replace("T", " "),
            alive: s.alive,
          }));
      }
      window.__projectHistory = sessions;
      el.innerHTML = sessions.length
        ? sessions
            .map(
              (s) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px;cursor:pointer" onclick="Bridge.openSessionHistory('${esc(s.id)}','${s.kind}')">
                <span class="tag ${s.kind === "ai" ? "cyan" : "red"}" style="flex-shrink:0">${s.kind === "ai" ? "AI" : "浏览器"}</span>
                <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)">${esc(s.url || s.title)}</span>
                <span class="mono" style="color:var(--text3);font-size:11px">${s.steps} 步</span>
                <span class="mono" style="color:var(--text3);font-size:11px">${s.time}</span>
                <span style="color:var(--primary);font-size:11px">查看 →</span>
              </div>`
            )
            .join("")
        : `<div style="color:var(--text3);font-size:12px">暂无相关录制会话</div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--text3);font-size:12px">会话历史加载失败：${esc(e.message)}</div>`;
    }
  }

  // ==================== 历史录制（列表页）与脚本调试入口 ====================

  /** 行「历史录制」：进入历史录制列表页并定位到该项目 */
  async function openRecHistory(projectId) {
    window.__recHistProjectId = projectId;
    window.go?.("page-rec-history", "record", { projectId });
    await recHistInit();
    await recHistLoad();
  }

  /** 历史录制页：项目下拉初始化（保持当前选中） */
  async function recHistInit() {
    const sel = document.getElementById("rec-hist-project");
    if (!sel) return;
    try {
      const data = await api("/api/projects?page=1&pageSize=100");
      const prev = sel.value || window.__recHistProjectId || "";
      sel.innerHTML = (data.list || [])
        .map((p) => `<option value="${esc(p.id)}" data-type="${esc(p.type)}" data-url="${esc(p.startUrl || "")}">${esc(p.name)}</option>`)
        .join("");
      let target = prev;
      if (!target) {
        // 侧边栏直达等无显式上下文 → 预选最近一次录制会话所属项目，
        // 否则默认停在首个项目，刚「结束并保存」的会话会被误认为没进历史
        try {
          const latest = (await api("/api/inspect/sessions")).find((s) => s.project_id);
          if (latest) target = String(latest.project_id);
        } catch { /* pass */ }
      }
      if (target && (data.list || []).some((p) => p.id === target)) sel.value = target;
      window.__recHistProjectId = sel.value || null;
    } catch (e) {
      window.toast?.("项目列表加载失败", e.message);
    }
  }

  /** 历史录制页分页状态（项目切换重置；删除后留在当前页收敛） */
  const recHistPager = { page: 1, pageSize: 10 };

  /** 历史录制页：加载所选项目的录制会话列表（浏览器 inspect 会话 + AI 会话） */
  async function recHistLoad(targetPage) {
    const sel = document.getElementById("rec-hist-project");
    const tbody = document.getElementById("rec-hist-tbody");
    if (!sel || !tbody) return;
    // 显式传页码（翻页）；未传（项目切换/刷新/删除后重载）沿用当前页
    if (typeof targetPage === "number") recHistPager.page = targetPage;
    const opt = sel.selectedOptions?.[0];
    const projectId = sel.value;
    if (window.__recHistProjectId !== projectId) recHistPager.page = 1; // 项目切换 → 回第 1 页
    window.__recHistProjectId = projectId;
    const pType = opt?.getAttribute("data-type") || "browser";
    const startUrl = opt?.getAttribute("data-url") || "";
    const prefix = startUrl.replace(/\/$/, "").split("#")[0];
    const match = (u) => !prefix || String(u || "").startsWith(prefix);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">加载中…</td></tr>`;
    try {
      const items = [];
      if (pType === "ai") {
        const all = await api("/api/sessions");
        for (const s of Array.isArray(all) ? all : []) {
          if (match(s.start_url)) {
            items.push({
              id: s.session_id,
              kind: "ai",
              url: s.start_url || "-",
              steps: s.step_count ?? 0,
              alive: false,
              time: Number(s.updated_at || s.created_at || 0),
            });
          }
        }
      } else {
        const all = await api("/api/inspect/sessions");
        for (const s of Array.isArray(all) ? all : []) {
          // 优先按会话绑定的 project_id（录制项目页发起时写入）；旧会话无绑定 → 起始 URL 前缀匹配兜底
          const bound = s.project_id ? String(s.project_id) === projectId : null;
          if (bound === true || (bound === null && match(s.start_url))) {
            items.push({
              id: s.sid,
              kind: "inspect",
              url: s.start_url || "-",
              steps: s.step_count ?? 0,
              alive: !!s.alive,
              time: Number(s.updated_at || s.created_at || 0),
            });
          }
        }
      }
      items.sort((a, b) => b.time - a.time);
      const pagerEl = document.getElementById("rec-hist-pager");
      if (!items.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">该项目暂无录制会话 · 点右上「+ 新建录制」开始</td></tr>`;
        if (pagerEl) pagerEl.innerHTML = "";
        return;
      }
      // 客户端分页：会话总量有限（本地录制数据），全量拉取后切片
      const totalPages = Math.max(1, Math.ceil(items.length / recHistPager.pageSize));
      recHistPager.page = Math.min(Math.max(1, recHistPager.page), totalPages);
      const pageItems = items.slice((recHistPager.page - 1) * recHistPager.pageSize, recHistPager.page * recHistPager.pageSize);
      tbody.innerHTML = pageItems
        .map(
          (s) => `<tr>
          <td class="mono" title="${esc(s.id)}">${esc(String(s.id).slice(0, 16))}…</td>
          <td>${s.kind === "ai" ? "AI 会话" : "浏览器录制"}</td>
          <td class="mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.url)}">${esc(s.url)}</td>
          <td class="mono">${s.steps}</td>
          <td>${s.alive ? '<span class="tag cyan">进行中</span>' : '<span class="tag gray">已结束</span>'}</td>
          <td class="mono">${s.time ? fmtTime(s.time * 1000) : "-"}</td>
          <td>
            <button class="btn ghost row-btn" onclick="Bridge.openSessionDebug('${esc(s.id)}','${esc(s.kind)}','${esc(projectId)}')">脚本调试</button>
            <button class="btn ghost row-btn" onclick="Bridge.openSessionHistory('${esc(s.id)}','${esc(s.kind)}')">查看</button>
            <button class="btn danger row-btn" onclick="Bridge.recHistDelete('${esc(s.id)}','${esc(s.kind)}')">删除</button>
          </td></tr>`,
        )
        .join("");
      renderPager(pagerEl, {
        page: recHistPager.page,
        pageSize: recHistPager.pageSize,
        total: items.length,
        onPage: (n) => recHistLoad(n),
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:36px">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  /** 历史录制页「+ 新建录制」：对所选项目启动一次新录制（增） */
  async function recHistNew() {
    const pid = document.getElementById("rec-hist-project")?.value || window.__recHistProjectId;
    if (!pid) {
      window.toast?.("请先选择项目", "");
      return;
    }
    await startRecord(pid);
  }

  /** 历史录制页「删除」：删除录制会话（删） */
  async function recHistDelete(sessionId, kind) {
    if (kind === "ai") {
      window.toast?.("AI 会话不支持在此删除", "可在 AI 录制页管理");
      return;
    }
    if (!window.confirm?.("确认删除该录制会话？删除后时间线不可恢复。")) return;
    try {
      await api(`/api/inspect/sessions/${sessionId}`, { method: "DELETE" });
      window.toast?.("录制会话已删除");
      await recHistLoad();
    } catch (e) {
      window.toast?.("删除失败", e.message);
    }
  }

  /** 行「脚本调试」：进入该项目最近一次录制的脚本调试（无会话则调试项目脚本） */
  async function openLatestDebug(projectId) {
    let latest = null;
    try {
      const opt = await api(`/api/projects/${projectId}`);
      if ((opt.type || "browser") !== "ai") {
        const prefix = String(opt.startUrl || "").replace(/\/$/, "").split("#")[0];
        const all = await api("/api/inspect/sessions");
        latest = (Array.isArray(all) ? all : [])
          .filter((s) => !prefix || String(s.start_url || "").startsWith(prefix))
          .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))[0];
      }
    } catch {
      /* 项目信息失败 → 退回项目工作台 */
    }
    if (latest) {
      await openSessionDebug(latest.sid, "inspect", projectId);
    } else {
      await enterProjectDebug(projectId);
      window.toast?.("未找到录制会话", "已打开项目脚本调试（由项目步骤生成）");
    }
  }

  /** 会话级脚本调试：把该次录制生成的脚本装入调试工作台（改） */
  async function openSessionDebug(sessionId, kind, projectId) {
    if (kind === "ai") {
      await enterProjectDebug(projectId);
      return;
    }
    try {
      const d = await api(`/api/inspect/session/${sessionId}/timeline`);
      const steps = d.steps || [];
      const script = steps.length ? generateSessionScript(steps, d.start_url || "") : "// 该会话无录制步骤";
      await enterProjectDebug(projectId, { sessionId });
      const codeEl = document.getElementById(dwQ("dw-code"));
      if (codeEl) codeEl.value = script;
      const titleEl = document.getElementById(dwQ("dw-code-title"));
      if (titleEl) titleEl.textContent = `会话脚本 ${String(sessionId).slice(0, 8)}…`;
      dw.filePath = null; // 会话脚本未落盘：保存需另存到项目
      dwLog("info", `已载入录制会话脚本（${steps.length} 步）· 可编辑后保存到项目`);
      // 右侧步骤栏 + 时间线 Tab：完整呈现录制步骤与截图（与录制时间线保持一致）
      const mapped = steps.map((s) => ({
        method: s.method,
        // click_at 的坐标在会话数据是顶层 sx/sy，单步执行读取 params.x/y
        params:
          s.method === "click_at"
            ? { x: Number(s.sx ?? 0), y: Number(s.sy ?? 0), value: s.value ?? "" }
            : { value: s.value ?? "" },
        locator: { primary: String(s.locator || "") },
        desc: s.desc || s.method,
        url: s.url || "",
        screenshot: s.screenshot || "",
        success: s.success !== false,
      }));
      dw.sessionSteps = mapped;
      dw.steps = mapped;
      dwRenderSessionSteps(mapped);
      dwTlSeedFromSteps(mapped);
    } catch (e) {
      window.toast?.("会话脚本加载失败", e.message);
    }
  }

  /** 进入项目脚本调试工作台：切到 page-debug 并选中该项目 */
  async function enterProjectDebug(projectId, extraQs) {
    // URL 带工程 id（会话脚本调试再带 sessionId）：刷新/分享深链可恢复上下文
    window.go?.("page-debug", "record", { projectId: projectId || "", ...(extraQs || {}) });
    dw.dom = "record";
    // 首次进入时 go() 会触发 dwInit(record)（异步）→ 等项目下拉就绪再操作，避免互相覆盖
    for (let i = 0; i < 20; i++) {
      const sel = document.getElementById(dwQ("dw-project"));
      if (sel?.options.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 600)); // 等自动加载落定（与 dwOpenTaskScript 同模式）
    const sel = document.getElementById(dwQ("dw-project"));
    if (sel) {
      sel.value = projectId;
      if (sel.value !== projectId) sel.selectedIndex = 0; // 项目不在列表（已删?）→ 回退首个
      dw.projectId = sel.value;
    }
    await dwLoadFiles();
    dwSwitchTab("code");
  }


  /** 计划暂停/恢复（真实 API） */
  async function togglePlanPause() {
    const planId = window.__currentPlanId;
    if (!planId) {
      window.toast?.("无计划上下文", "请先打开计划详情");
      return;
    }
    try {
      const plan = await api(`/api/plans/${planId}`);
      const btn = document.getElementById("btn-plan-pause");
      if (plan.status === "running") {
        await api(`/api/plans/${planId}/pause`, { method: "POST", body: "{}" });
        window.toast?.("计划已暂停", "当前任务完成后不再启动下一任务");
        if (btn) { btn.textContent = "▶ 恢复计划"; }
      } else if (plan.status === "paused") {
        await api(`/api/plans/${planId}/resume`, { method: "POST", body: "{}" });
        window.toast?.("计划已恢复", "继续调度");
        if (btn) { btn.textContent = "⏸ 暂停计划"; }
      } else {
        window.toast?.("仅运行中/已暂停计划可操作", "");
      }
    } catch (e) {
      window.toast?.("操作失败", e.message);
    }
  }

  /** 计划查看报告：最近一份汇总/任务报告 */
  async function openPlanReport() {
    const planId = window.__currentPlanId;
    if (!planId) return;
    try {
      const d = await api(`/api/reports?planId=${planId}&page=1&pageSize=1`);
      if (d.list?.length) {
        openReport(d.list[0].id);
      } else {
        window.toast?.("该计划暂无报告", "执行计划后生成");
      }
    } catch (e) {
      window.toast?.("报告查询失败", e.message);
    }
  }

  /** 打开会话历史详情（步骤 / 时间线 / 脚本 三栏视图） */
  async function openSessionHistory(sessionId, kind) {
    try {
      let steps = [];
      let startUrl = "";
      let alive = false;
      if (kind === "inspect") {
        const d = await api(`/api/inspect/session/${sessionId}/timeline`);
        steps = d.steps || [];
        startUrl = d.start_url || "";
        alive = d.alive;
      } else {
        const d = await api(`/api/sessions/${sessionId}`);
        startUrl = String(d.start_url || "");
        steps = (Array.isArray(d.steps) ? d.steps : []).map((s, i) => ({
          step: i + 1,
          method: s.method || s.type || "step",
          desc: s.desc || s.description || "",
          locator: s.locator || s.selector || "",
          value: s.value ?? s.params?.value ?? "",
          url: s.url || "",
          success: s.status !== "failed",
        }));
      }
      window.__sessionView = { sessionId, kind, steps, startUrl };

      // 头部：标题 / 状态 / 元信息
      document.getElementById("rs-title").textContent = kind === "ai" ? "AI 录制会话" : "浏览器录制会话";
      const stEl = document.getElementById("rs-status");
      if (stEl) stEl.innerHTML = alive ? '<span class="tag cyan">进行中</span>' : '<span class="tag gray">已结束</span>';
      document.getElementById("rs-meta").textContent =
        `${sessionId} · ${startUrl || "-"} · ${steps.length} 步`;

      // 栏 1：步骤（紧凑列表，点击同步时间线）
      const stepEl = document.getElementById("rs-steps");
      const countEl = document.getElementById("rs-steps-count");
      if (countEl) countEl.textContent = steps.length ? `${steps.length} 步` : "";
      if (stepEl) {
        stepEl.innerHTML = steps.length
          ? steps
              .map(
                (s, i) => `<div class="pick-item${i === 0 ? " on" : ""}" id="rs-step-${i}" style="cursor:pointer" onclick="Bridge.rsFocusStep(${i})">
                  <span class="p-order">${s.step ?? i + 1}</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.desc || s.method)}</span>
                  <span class="rs-method${s.success === false ? " bad" : ""}">${esc(s.method)}</span>
                </div>`,
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px;padding:6px 2px">该会话无步骤</div>`;
      }

      // 栏 2：时间线（详情卡片 + 截图）
      const tl = document.getElementById("rs-timeline");
      if (tl) {
        tl.innerHTML = steps.length
          ? steps
              .map((s, i) => {
                const meta = [
                  s.url ? ["URL", s.url] : null,
                  s.locator ? ["定位器", s.locator] : null,
                  s.value !== "" && s.value != null ? ["值", s.value] : null,
                ].filter(Boolean)
                  .map(([k, v]) => `<div><b>${k}</b> ${esc(String(v).slice(0, 220))}</div>`)
                  .join("");
                const shot = s.screenshot
                  ? `<img class="rs-shot" src="${s.screenshot}" onclick="window.open(this.src,'_blank')" alt="step ${i + 1}">`
                  : "";
                return `<div class="rs-card${i === 0 ? " on" : ""}" id="rs-card-${i}">
                  <div class="rs-head">
                    <span class="p-order">${s.step ?? i + 1}</span>
                    <span class="rs-desc">${esc(s.desc || s.method)}</span>
                    <span class="rs-method${s.success === false ? " bad" : ""}">${esc(s.method)}</span>
                  </div>
                  ${meta ? `<div class="rs-meta">${meta}</div>` : ""}
                  ${shot}
                </div>`;
              })
              .join("")
          : `<div style="color:var(--text3);font-size:12px;padding:6px 2px">该会话无步骤</div>`;
      }

      // 栏 3：脚本
      const scriptEl = document.getElementById("rs-script");
      if (scriptEl) {
        scriptEl.textContent = steps.length ? generateSessionScript(steps, startUrl) : "// 无步骤";
      }
      window.go?.("rec-session", "record");
    } catch (e) {
      window.toast?.("会话详情加载失败", e.message);
    }
  }

  /** 步骤列表 ↔ 时间线卡片联动定位 */
  function rsFocusStep(idx) {
    document.querySelectorAll("#rs-steps .pick-item").forEach((el) => el.classList.remove("on"));
    document.getElementById(`rs-step-${idx}`)?.classList.add("on");
    document.querySelectorAll("#rs-timeline .rs-card").forEach((el) => el.classList.remove("on"));
    const card = document.getElementById(`rs-card-${idx}`);
    if (card) {
      card.classList.add("on");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /** 从会话视图进入脚本调试（把该会话脚本装入调试工作台） */
  async function openSessionDebugFromView() {
    const view = window.__sessionView;
    if (!view) return;
    const projectId = window.__recHistProjectId || null;
    await openSessionDebug(view.sessionId, view.kind, projectId);
  }

  /** 会话时间线 → Playwright JS（与后端 script-generator 同构） */
  /** 字符串字面量转义：单引号/反斜杠转义，换行转 \n 序列（保留原语义） */
  function toPwLit(v) {
    return String(v ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n");
  }

  /** DSL 值去两侧成对包裹引号；字面 \n 序列归一为空格（Playwright 文本匹配做空白归一化） */
  function pwUnquote(v) {
    let t = String(v ?? "").trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      t = t.slice(1, -1).trim();
    }
    return t.replace(/\\n/g, " ");
  }

  /**
   * 平台定位 DSL → Playwright 原生定位表达式（不含 page. 锚，链式段以 . 连接）。
   * 定位规则（高→低）：getByRole > getByText > getByLabel > getByPlaceholder
   * > getByAltText > getByTitle > getByTestId > CSS > XPath（最后考虑）。
   */
  function toPwExpr(loc) {
    const raw = String(loc ?? "").trim();
    if (!raw) return "";
    const jsLit = (v) => `'${toPwLit(v)}'`;
    const seg = (s) => {
      let m;
      if ((m = s.match(/^get_by_role=([^,]+),\s*([\s\S]+)$/))) {
        const role = pwUnquote(m[1]).trim();
        let name = pwUnquote(m[2]);
        const tm = name.match(/^title=["']?([\s\S]*?)["']?$/);
        if (tm) return `getByTitle(${jsLit(pwUnquote(tm[1]))})`;
        const nm = name.match(/^name=["']?([\s\S]*?)["']?$/);
        if (nm) name = pwUnquote(nm[1]);
        return name ? `getByRole('${role}', { name: ${jsLit(name)} })` : `getByRole('${role}')`;
      }
      if ((m = s.match(/^get_by_role=(.+)$/))) return `getByRole('${pwUnquote(m[1]).trim()}')`;
      if ((m = s.match(/^get_by_text=([\s\S]+)$/))) return `getByText(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^get_by_label=([\s\S]+)$/))) return `getByLabel(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^get_by_placeholder=([\s\S]+)$/))) return `getByPlaceholder(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^get_by_alt_text=([\s\S]+)$/))) return `getByAltText(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^get_by_title=([\s\S]+)$/))) return `getByTitle(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^get_by_test_id=([\s\S]+)$/))) return `getByTestId(${jsLit(pwUnquote(m[1]))})`;
      if ((m = s.match(/^nth\s*=\s*(\d+)$/))) return `nth(${m[1]})`;
      const sel = /^\/(?!\/)/.test(s) ? `xpath=${s}` : s;
      return `locator(${jsLit(sel)})`;
    };
    return raw.split(" >> ").map((p) => seg(p.trim())).join(".");
  }

  function generateSessionScript(steps, startUrl) {
    // desc 可能含换行（多行页面标题/文本）：注释压成单行，避免生成非法 JS
    const oneLine = (v) => String(v ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
    // 起始地址：startUrl 缺失（录制时未产生开场导航步骤）→ 取时间线首个带 url 的步骤（录制起始页）
    const initUrl = startUrl || steps.map((s) => s.url || "").find(Boolean) || "";
    let out = "const { chromium } = require('playwright');\n\n(async () => {\n  const browser = await chromium.launch({ headless: false });\n  const page = await browser.newPage();\n\n";
    if (initUrl) out += `  await page.goto('${toPwLit(initUrl)}');\n`;
    // 双通道录制的时间线 step 号可能重复/乱序 → 按输出顺序重编
    let stepSeq = 0;
    for (const s of steps) {
      const loc = String(s.locator || "");
      const val = String(s.value || "");
      const ex = toPwExpr(loc);
      stepSeq++;
      out += `  // Step ${stepSeq}: ${oneLine(s.desc || s.method)}\n`;
      if (s.method === "click_at") {
        const x = Number((s.params || {}).x ?? 0);
        const y = Number((s.params || {}).y ?? 0);
        out += `  await page.mouse.click(${x}, ${y});\n`;
      } else if (/fill|input|type/.test(s.method) && ex) out += `  await page.${ex}.fill('${toPwLit(val)}');\n`;
      else if (/click/.test(s.method)) out += ex ? `  await page.${ex}.click();\n` : (val ? `  await page.${toPwExpr(val)}.click();\n` : "");
      else if (/navigate|open_url|goto/.test(s.method)) out += `  await page.goto('${toPwLit(val || s.url || "")}');\n`;
      else if (ex) out += val ? `  await page.${ex}.fill('${toPwLit(val)}');\n` : `  await page.${ex}.click();\n`;
    }
    out += "  await browser.close();\n})();\n";
    return out;
  }

  /** 会话详情 Tab 切换 */
  /** 复制会话生成脚本 */
  async function copySessScript() {
    const el = document.getElementById("rs-script");
    if (!el?.textContent) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      window.toast?.("脚本已复制到剪贴板");
    } catch {
      window.toast?.("复制失败", "请手动选择复制");
    }
  }

  /** 复制项目脚本 */
  async function copyProjScript() {
    const el = document.getElementById("proj-d-script");
    if (!el?.textContent) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      window.toast?.("脚本已复制到剪贴板");
    } catch {
      window.toast?.("复制失败", "请手动选择复制");
    }
  }

  /** 会话 → 保存为录制项目（复用 record_config 步骤流 → 项目） */
  async function saveSessAsProject() {
    const view = window.__sessionView;
    if (!view?.steps?.length) {
      window.toast?.("该会话无步骤", "无法保存");
      return;
    }
    const name = `${view.kind === "ai" ? "AI" : "浏览器"}录制-${new Date().toISOString().slice(5, 16).replace("T", "-")}`;
    try {
      const steps = view.steps.map((s, i) => ({
        method: s.method,
        params: { value: s.value ?? "" },
        locator: { primary: String(s.locator || "") },
        desc: s.desc || s.method,
      }));
      steps.unshift({ method: "open_url", params: { value: view.startUrl }, locator: { primary: "" }, desc: "打开页面" });
      // 先建项目（存步骤流），再 regenerate 生成脚本
      const created = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name, type: view.kind === "ai" ? "ai" : "browser", status: "ready",
          startUrl: view.startUrl, scriptContent: "", scriptLang: "js", recordConfig: { steps },
        }),
      });
      await api(`/api/projects/${created.id}/regenerate-script`, { method: "POST", body: "{}" });
      window.toast?.("已保存为录制项目", name);
      window.go?.("rec-history", "record");
      await loadProjects();
    } catch (e) {
      window.toast?.("保存失败", e.message);
    }
  }

  async function createTaskFrom(projectId) {
    closeDrawer("proj");
    window.__preselectedProjectId = projectId;
    window.openTaskWizard && window.openTaskWizard();
    window.toast?.("已预填关联项目", projectId);
    // 向导第 2 步的项目选择下拉若存在则赋值；不存在则稍后渲染注入
    setTimeout(() => {
      const sel = document.getElementById("wiz-project");
      if (sel) sel.value = projectId;
    }, 200);
    // 确保 wiz-project 存在（若向导无该下拉，则在其第 2 步表单注入）
    await ensureWizardProjectSelect(projectId);
  }

  /** 向导第 2 步项目下拉填充（真实 ready 项目）；selectedId 预选 */
  async function ensureWizardProjectSelect(selectedId) {
    const sel = document.getElementById("wiz-project");
    if (!sel) return;
    try {
      const data = await api("/api/projects?page=1&pageSize=100&status=ready");
      sel.innerHTML = data.list.length
        ? data.list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}（${p.stepsCount} 步 · ${p.type === "ai" ? "AI" : "浏览器"}录制）</option>`).join("")
        : `<option value="">（暂无 ready 项目）</option>`;
      if (selectedId) sel.value = selectedId;
    } catch (e) {
      sel.innerHTML = `<option value="">加载项目失败</option>`;
    }
  }

  async function deleteProject(projectId, name) {
    try {
      const data = await api(`/api/projects/${projectId}`, { method: "DELETE" });
      window.toast?.("已删除项目", `关联任务 ${data.deletedTasks} 个一并删除`);
      await loadProjects();
    } catch (e) {
      window.toast?.("删除失败", e.message);
    }
  }

  // ===== 7. 测试计划：卡片网格 =====
  async function loadPlans(page) {
    page = page || 1;
    const grid = document.getElementById("plan-grid");
    if (!grid) return;
    try {
      const data = await api(`/api/plans?page=${page}&pageSize=12`);
      renderPager(document.getElementById("plan-pager"), {
        page, pageSize: 12, total: data.total,
        onPage: (p) => loadPlans(p),
      });
      renderPageView("plans", data);
    } catch (e) {
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--danger);padding:24px">加载失败：${esc(e.message)}</div>`;
    }
  }

  /** 计划详情抽屉（真实任务清单） */
  async function openPlanDrawer(planId) {
    try {
      const plan = await api(`/api/plans/${planId}`);
      const drawer = document.getElementById("plan-drawer");
      if (!drawer) return;
      window.__currentPlanId = plan.id;
      const title = document.getElementById("plan-d-title");
      if (title) title.textContent = plan.name;
      // 暂停/恢复按钮状态跟随计划状态
      const pauseBtn = document.getElementById("btn-plan-pause");
      if (pauseBtn) {
        const running = plan.status === "running";
        pauseBtn.textContent = running ? "⏸ 暂停计划" : plan.status === "paused" ? "▶ 恢复计划" : "暂停计划";
        pauseBtn.disabled = !(running || plan.status === "paused");
      }
      const chips = drawer.querySelector(".p-tasks, .pt-chip")?.parentElement;
      if (chips && plan.tasks) {
        chips.innerHTML = plan.tasks
          .map((t) => `<span class="pt-chip">${esc(t.name)}</span>`)
          .join("");
      }
      document.getElementById("plan-mask")?.classList.add("show");
      drawer.classList.add("show");
    } catch (e) {
      window.toast?.("计划详情加载失败", e.message);
    }
  }

  async function runPlan(planId) {
    try {
      const data = await api(`/api/plans/${planId}/run`, { method: "POST", body: "{}" });
      window.toast?.("计划已开始执行", `PlanRun: ${data.planRunId}`);
      await loadPlans();
    } catch (e) {
      window.toast?.("计划执行失败", e.message);
    }
  }

  async function deletePlan(planId, name) {
    try {
      await api(`/api/plans/${planId}`, { method: "DELETE" });
      window.toast?.("已删除计划", name);
      await loadPlans();
    } catch (e) {
      window.toast?.("删除失败", e.message);
    }
  }

  // ===== 8. 测试报告：列表 =====
  async function loadReports(page) {
    page = page || 1;
    const tbody = document.getElementById("rpt-tbody");
    if (!tbody) return;
    try {
      const data = await api(`/api/reports?page=${page}&pageSize=10`);
      renderPager(document.getElementById("report-pager"), {
        page, pageSize: 10, total: data.total,
        onPage: (p) => loadReports(p),
      });
      // 与任务历史管理完全一致的行结构（全任务历史汇总），支持列表/卡片双模式
      renderPageView("reports", data);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger)">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  // ===== 9. 报告详情：导出接真实 API =====
  async function exportReport(btn, fmt) {
    const format = String(fmt || "").toLowerCase();
    const reportId = window.currentReportId || "latest";
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "导出中…";
    const bar = document.getElementById("export-bar");
    try {
      const started = await api(`/api/reports/${reportId}/exports`, {
        method: "POST",
        body: JSON.stringify({ format }),
      });
      // 轮询导出任务
      const done = await new Promise((resolve, reject) => {
        const t = setInterval(async () => {
          try {
            const job = await api(`/api/exports/${started.exportId}`);
            if (bar) {
              bar.classList.add("show");
              bar.querySelector(".bar i").style.width = job.progress + "%";
              const pct = document.getElementById("export-pct");
              if (pct) pct.textContent = job.progress + "%";
            }
            if (job.status === "done") {
              clearInterval(t);
              resolve(job);
            } else if (job.status === "failed") {
              clearInterval(t);
              reject(new Error(job.error || "导出失败"));
            }
          } catch (e) {
            clearInterval(t);
            reject(e);
          }
        }, 300);
      });
      window.toast?.(`已导出 ${format.toUpperCase()} 报告`, `${reportId}.${format}`);
      // 触发下载
      if (done.downloadUrl) window.open(done.downloadUrl, "_blank");
    } catch (e) {
      window.toast?.("导出失败", e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      setTimeout(() => bar?.classList.remove("show"), 800);
    }
  }

  async function openReport(reportId) {
    window.currentReportId = reportId;
    window.go?.("page-report");
    try {
      const r = await api(`/api/reports/${reportId}`);
      window.go?.("page-report", null, { taskId: r.taskId || "", reportId });
      // ---- 与导出的 HTML 报告完全一致：标题 / meta / 错误横幅 / 统计卡 ----
      const nameEl = document.getElementById("rpt-name");
      if (nameEl) nameEl.textContent = r.name;
      const stColor = r.status === "success" ? "var(--success)" : r.status === "failed" || r.status === "error" ? "var(--danger)" : "var(--text3)";
      const meta = document.getElementById("rpt-meta");
      if (meta) {
        meta.innerHTML =
          `报告 ID <span class="mono">${esc(r.id)}</span>` +
          (r.taskId ? ` · 任务 <span class="mono">${esc(r.taskId)}</span>` : "") +
          ` · 状态 <b style="color:${stColor}">${esc(r.status)}</b>` +
          ` · 开始 <span class="mono">${esc(String(r.startedAt || "-").slice(0, 19).replace("T", " "))}</span>` +
          ` · 耗时 <span class="mono">${r.durationMs ? (r.durationMs / 1000).toFixed(1) + "s" : "-"}</span>`;
      }
      const errBox = document.getElementById("rpt-error");
      if (errBox) {
        errBox.style.display = r.errorMessage ? "block" : "none";
        errBox.textContent = r.errorMessage || "";
      }
      const setNum = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(v ?? "-");
      };
      setNum("rpt-c-passrate", r.passRate + "%");
      setNum("rpt-c-total", r.totalSteps);
      setNum("rpt-c-passed", r.passedSteps);
      setNum("rpt-c-failed", r.failedSteps);
      setNum("rpt-c-skipped", r.skippedSteps);
      // ---- 主体：步骤表（有结构化步骤）或 截图 gallery + 日志表（脚本通道） ----
      const stepsBox = document.getElementById("rpt-steps-box");
      const galleryBox = document.getElementById("rpt-gallery-box");
      const logBox = document.getElementById("rpt-log-box");
      const logs = r.logsPreview || [];
      const shotLogs = logs.filter((l) => l.event === "screenshot");
      const stb = document.getElementById("rpt-steps-tbody");
      const hasSteps = r.steps && r.steps.length > 0;
      if (stepsBox) stepsBox.style.display = hasSteps ? "block" : "none";
      if (galleryBox) galleryBox.style.display = !hasSteps && shotLogs.length ? "block" : "none";
      if (logBox) logBox.style.display = !hasSteps ? "block" : "none";
      if (stb) {
        // 步骤表（与导出 HTML 相同：操作 code / 描述 / 状态 / 耗时 ms + 行下截图与错误）
        stb.innerHTML = hasSteps
          ? r.steps
              .map(
                (s) => `<tr>
                  <td class="mono">${s.stepIndex}</td>
                  <td class="mono" style="font-size:11.5px"><code>${esc(s.method)}</code></td>
                  <td>${esc(s.description || "")}</td>
                  <td style="color:${s.status === "passed" ? "var(--success)" : "var(--danger)"};font-weight:600">${esc(s.status)}</td>
                  <td class="mono">${s.durationMs ?? "-"} ms</td>
                </tr>
                ${s.screenshotUrl ? `<tr><td colspan="5" style="padding:0 12px 12px"><img src="${esc(s.screenshotUrl)}" alt="步骤 ${s.stepIndex} 截图" style="max-width:640px;width:100%;border:1px solid var(--border);border-radius:6px;cursor:zoom-in" onclick="Bridge.dwTlZoomImage('${esc(s.screenshotUrl)}')"/></td></tr>` : ""}
                ${s.error ? `<tr><td colspan="5" style="padding:0 12px 12px;color:var(--danger)">错误：${esc(s.error)}</td></tr>` : ""}`
              )
              .join("")
          : `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:16px">无结构化步骤（脚本通道执行，见下方截图与日志）</td></tr>`;
      }
      // 截图 gallery（脚本通道；与导出 HTML 相同网格，点击放大）
      const gallery = document.getElementById("rpt-gallery");
      const gCnt = document.getElementById("rpt-gallery-count");
      if (gCnt) gCnt.textContent = shotLogs.length ? `(${shotLogs.length} 张)` : "";
      if (gallery) {
        gallery.innerHTML = shotLogs.length
          ? shotLogs
              .map((l) => {
                const shot = l.payload?.screenshotPath || "";
                return `<div style="text-align:center">
                  <img src="/api/files/${esc(shot)}" alt="${esc(l.message)}" style="max-width:300px;border:1px solid var(--border);border-radius:8px;display:block;cursor:zoom-in" onclick="Bridge.dwTlZoomImage('/api/files/${esc(shot)}')" title="点击放大"/>
                  <div style="font-size:11px;color:var(--text3);padding:4px 0" class="mono">${esc(l.message)} · ${esc(String(l.ts || "").slice(11, 19))}</div>
                </div>`;
              })
              .join("")
          : `<div style="color:var(--text3);font-size:12px">无截图</div>`;
      }
      // 执行日志表（脚本通道；与导出 HTML 相同：时间 / 内容）
      const logTbody = document.getElementById("rpt-log-tbody");
      if (logTbody) {
        const logRows = logs.filter((l) => l.event === "log" || l.event === "status");
        logTbody.innerHTML = logRows.length
          ? logRows
              .map(
                (l) => `<tr>
                  <td class="mono" style="color:var(--text3);white-space:nowrap">${esc(String(l.ts || "").slice(11, 19))}</td>
                  <td style="color:${l.level === "ok" ? "var(--success)" : l.level === "error" ? "var(--danger)" : "var(--text2)"}">${esc(l.message)}</td>
                </tr>`,
              )
              .join("")
          : `<tr><td colspan="2" style="color:var(--text3);text-align:center;padding:12px">暂无执行日志</td></tr>`;
      }
      window.toast?.("已加载报告", r.name);
    } catch (e) {
      window.toast?.("报告加载失败", e.message);
    }
  }

  // ===== 10. 4 步向导：创建任务提交 =====
  async function submitWizard(executeNow) {
    const name = document.getElementById("task-name")?.value?.trim();
    if (!name) {
      window.toast?.("请填写任务名称", "第 1 步校验");
      return;
    }
    try {
      // 项目来源：向导第 2 步的项目选择（wiz-project，createTaskFrom 预填）或全局记录
      const projectId =
        document.getElementById("wiz-project")?.value ||
        window.__preselectedProjectId ||
        "";
      if (!projectId) {
        window.toast?.("请先在「脚本与资源」步骤选择录制项目", "第 2 步必填");
        return;
      }
      // 调度配置：读取向导第 3 步真实选择（window.__wizScheduleMode 或默认 manual）
      const schedMode = window.__wizScheduleMode || "manual";
      const schedule = { mode: schedMode };
      if (schedMode === "count") {
        schedule.iterations = Math.max(1, Number(document.getElementById("count-val")?.value || 1));
      } else if (schedMode === "time") {
        const unitMs = { "秒": 1000, "分钟": 60000, "小时": 3600000, "天": 86400000 };
        const unit = document.getElementById("dur-unit")?.value || "分钟";
        schedule.durationMs = Number(document.getElementById("dur-val")?.value || 10) * (unitMs[unit] || 60000);
      }
      // 脚本来源：上传（真实 uploadId）或项目
      let scriptSource = "project";
      const body = {
        name,
        description: document.getElementById("task-desc")?.value || "",
        scriptSource,
        projectId,
        browserType: "chromium",
        schedule,
        executeNow: executeNow === true,
      };
      if (window.__wizScriptUpload) {
        body.scriptSource = "upload";
        body.scriptUploadId = window.__wizScriptUpload.uploadId;
        body.resourceUploadIds = window.__wizResourceUploads.map((r) => r.uploadId);
      } else if (!projectId) {
        window.toast?.("请选择录制项目或上传脚本文件", "第 2 步必填");
        return;
      }
      const data = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      window.__preselectedProjectId = null;
      if (executeNow) {
        window.toast?.("任务已保存，开始执行", data.id);
        window.go?.("page-exec", null, { taskId: data.id });
        const run = await api(`/api/tasks/${data.id}/run`, { method: "POST", body: "{}" });
        bindMonitor(run.runId);
      } else {
        window.toast?.("任务创建成功", data.id);
        closeTaskWizardIfOpen();
      }
      await loadTasks();
    } catch (e) {
      window.toast?.("创建失败", e.message);
    }
  }

  // ===== 工具：关闭抽屉 =====
  function closeDrawer(which) {
    const map = { proj: ["proj-mask", "proj-drawer"], task: ["task-mask", "task-drawer"], plan: ["plan-mask", "plan-drawer"] };
    (map[which] || []).forEach((id) => document.getElementById(id)?.classList.remove("show"));
  }

  // ===== 11. 项目编辑/新建弹窗：真实保存 =====

  /** 打开项目弹窗（编辑模式预填真实值；无 id 为新建模式） */
  async function openProjModal(projectId) {
    window.__editingProjId = projectId || null;
    const title = document.getElementById("proj-modal-title");
    if (title) title.textContent = projectId ? "编辑项目" : "新建项目";
    if (projectId) {
      try {
        const p = await api(`/api/projects/${projectId}`);
        const set = (id, v) => {
          const el = document.getElementById(id);
          if (el) el.value = v;
        };
        set("proj-name", p.name);
        set("proj-desc", p.description || "");
        set("proj-type", p.type === "browser" ? "浏览器录制" : "AI 录制");
        set("proj-status", p.status === "ready" ? "就绪" : p.status === "archived" ? "归档" : "草稿");
      } catch (e) {
        window.toast?.("载入项目失败", e.message);
        return;
      }
    } else {
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v;
      };
      set("proj-name", "");
      set("proj-desc", "");
      set("proj-type", "AI 录制");
      set("proj-status", "草稿");
    }
    document.getElementById("proj-modal-mask")?.classList.add("show");
    document.getElementById("proj-modal")?.classList.add("show");
  }

  async function saveProjModal() {
    const name = document.getElementById("proj-name")?.value?.trim();
    if (!name) {
      window.toast?.("请填写项目名称", "必填项");
      return;
    }
    const typeText = document.getElementById("proj-type")?.value || "AI 录制";
    const statusText = document.getElementById("proj-status")?.value || "草稿";
    const type = typeText.includes("浏览器") ? "browser" : "ai";
    const status = statusText === "就绪" ? "ready" : statusText === "归档" ? "archived" : "draft";
    const description = document.getElementById("proj-desc")?.value || "";
    const editingId = window.__editingProjId;
    try {
      const body = { name, description, type, status };
      if (editingId) {
        await api(`/api/projects/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
        window.toast?.("项目已保存", name);
      } else {
        await api("/api/projects", { method: "POST", body: JSON.stringify({ ...body, scriptContent: "" }) });
        window.toast?.("项目已创建", `${name} · 去录制生成脚本`);
      }
      window.__editingProjId = null;
      closeProjModal();
      await loadProjects();
    } catch (e) {
      window.toast?.("保存失败", e.message);
    }
  }

  // ===== 12. 计划新建弹窗：任务列表真实渲染 + 创建 =====
  async function openPlanModalForCreate() {
    const pick = document.getElementById("pl-pick");
    if (pick) {
      try {
        const data = await api("/api/tasks?page=1&pageSize=50");
        pick.innerHTML = data.list.length
          ? data.list
              .map(
                (t) => `<div class="pick-item" data-task-id="${esc(t.id)}" onclick="Bridge.togglePick(this)"><span class="grip">⋮⋮</span><span class="p-order"></span>${esc(t.name)}<span class="mono" style="margin-left:auto;color:var(--text3);font-size:11px">${esc(t.projectName || "-")}</span></div>`
              )
              .join("")
          : `<div style="color:var(--text3);padding:14px">暂无任务 · 请先创建任务</div>`;
      } catch (e) {
        pick.innerHTML = `<div style="color:var(--danger);padding:14px">加载任务失败：${esc(e.message)}</div>`;
      }
    }
    const title = document.getElementById("plan-modal-title");
    if (title) title.textContent = "新建测试计划";
    document.getElementById("plan-modal-mask")?.classList.add("show");
    document.getElementById("plan-modal")?.classList.add("show");
  }

  function togglePick(el) {
    el.classList.toggle("sel");
    // 重排序号
    document.querySelectorAll("#pl-pick .pick-item.sel .p-order").forEach((n, i) => (n.textContent = i + 1));
  }

  async function savePlanModal() {
    const name = document.getElementById("pl-name")?.value?.trim();
    if (!name) {
      window.toast?.("请填写计划名称", "必填项");
      return;
    }
    const taskIds = Array.from(document.querySelectorAll("#pl-pick .pick-item.sel")).map((el) =>
      el.getAttribute("data-task-id")
    );
    if (!taskIds.length) {
      window.toast?.("请至少勾选 1 个任务", "必填项");
      return;
    }
    const cronInput = document.querySelector("#plan-modal input.mono");
    const cronExpr = cronInput?.value?.trim() || null;
    const editingPlanId = window.__editingPlanId;
    try {
      if (editingPlanId) {
        await api(`/api/plans/${editingPlanId}`, {
          method: "PUT",
          body: JSON.stringify({ name, taskIds, cronExpr }),
        });
        window.toast?.("计划已保存", `${name} · ${taskIds.length} 个任务`);
      } else {
        await api("/api/plans", {
          method: "POST",
          body: JSON.stringify({ name, taskIds, cronExpr }),
        });
        window.toast?.("计划已创建", `${name} · ${taskIds.length} 个任务`);
      }
      window.__editingPlanId = null;
      closePlanModal();
      await loadPlans();
    } catch (e) {
      window.toast?.("保存失败", e.message);
    }
  }

  /** 计划编辑弹窗（预填真实计划：名称 + 任务勾选） */
  async function openPlanModalForEdit(planId) {
    try {
      const plan = await api(`/api/plans/${planId}`);
      const title = document.getElementById("plan-modal-title");
      if (title) title.textContent = `编辑计划 · ${plan.name}`;
      const nameInput = document.getElementById("pl-name");
      if (nameInput) nameInput.value = plan.name;
      const cronInput = document.querySelector("#plan-modal input.mono");
      if (cronInput) cronInput.value = plan.cronExpr || "";
      // 任务勾选列表：真实任务 + 该计划已选的标 sel
      const pick = document.getElementById("pl-pick");
      if (pick) {
        const data = await api("/api/tasks?page=1&pageSize=50");
        const planTaskIds = (plan.tasks || []).map((t) => t.id);
        pick.innerHTML = data.list.length
          ? data.list
              .map((t) => {
                const sel = planTaskIds.includes(t.id) ? " sel" : "";
                return `<div class="pick-item${sel}" data-task-id="${esc(t.id)}" onclick="Bridge.togglePick(this)"><span class="grip">⋮⋮</span><span class="p-order"></span>${esc(t.name)}<span class="mono" style="margin-left:auto;color:var(--text3);font-size:11px">${esc(t.projectName || "-")}</span></div>`;
              })
              .join("")
          : `<div style="color:var(--text3);padding:14px">暂无任务</div>`;
        // 重排序号
        document.querySelectorAll("#pl-pick .pick-item.sel .p-order").forEach((n, i) => (n.textContent = i + 1));
      }
      document.getElementById("plan-modal-mask")?.classList.add("show");
      document.getElementById("plan-modal")?.classList.add("show");
      window.__editingPlanId = planId;
    } catch (e) {
      window.toast?.("载入计划失败", e.message);
    }
  }

  // ===== 13. 创建录制：真实建项目 + 跳转嵌入录制页 =====

  /** AI 录制入口：建 draft 项目 → 激活嵌入 AI 观测台（URL/描述经 sessionStorage 预填） */
  async function startAiRecord(btn) {
    const name = document.getElementById("rec-name")?.value?.trim();
    if (!name) {
      window.toast?.("请先填写项目名称", "必填项");
      document.getElementById("rec-name")?.focus();
      return;
    }
    const url = document.getElementById("rec-url")?.value?.trim();
    const desc = document.getElementById("rec-desc")?.value?.trim();
    if (!url) {
      window.toast?.("请填写目标 URL", "必填项");
      return;
    }
    try {
      const project = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, type: "ai", status: "draft", startUrl: url, description: desc || "", scriptContent: "" }),
      });
      // 预填信息传给嵌入的 AI 观测台
      sessionStorage.setItem("autotest.prefill", JSON.stringify({ projectId: project.id, url, desc }));
      window.toast?.("项目已创建，进入 AI 录制", name);
      window.go?.("page-ai");
      activateEmbed("page-ai");
      // 通知嵌入页预填（同源 iframe 可直接访问）
      try {
        const frame = document.getElementById("embed-ai");
        if (frame?.contentWindow) {
          frame.contentWindow.postMessage({ type: "autotest.prefill", url, desc }, "*");
        }
      } catch (e) { /* 跨域安全异常忽略 */ }
    } catch (e) {
      window.toast?.("创建失败", e.message);
    }
  }

  /** 浏览器录制入口：建 draft 项目 → 激活嵌入 inspect 调试器 */
  async function startBrowserRecord() {
    const name = document.getElementById("rec-name")?.value?.trim();
    if (!name) {
      window.toast?.("请先填写项目名称", "必填项");
      document.getElementById("rec-name")?.focus();
      return;
    }
    const url = document.getElementById("rec-url")?.value?.trim();
    try {
      const project = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, type: "browser", status: "draft", startUrl: url || "", description: "", scriptContent: "" }),
      });
      sessionStorage.setItem("autotest.prefill", JSON.stringify({ projectId: project.id, url }));
      window.toast?.("项目已创建，进入浏览器录制", name);
      window.go?.("page-browser");
      activateEmbed("page-browser");
    } catch (e) {
      window.toast?.("创建失败", e.message);
    }
  }

  // ===== 导出全局 Bridge（供 onclick 调用） =====
  window.Bridge = {
    runTask,
    batchRunTasks,
    batchDeleteTasks,
    batchDeletePlans,
    batchDeleteReports,
    batchDeleteProjects,
    filterTasks,
    editTaskFromDrawer,
    stopTaskFromDrawer,
    openTaskLatestReport,
    openTaskExec,
    openTaskHistory,
    openTaskDetail,
    loadTaskDetail,
    loadTaskHistory,
    setPageView,
    deleteReportById,
    openTaskExecMonitor,
    dwOpenTaskScript,
    openReplay,
    openProject,
    createTaskFrom,
    deleteProject,
    confirmDelProj,
    confirmDelPlan,
    runPlan,
    deletePlan,
    openReport,
    exportReport,
    submitWizard,
    stopMonitor,
    bindMonitor,
    saveProjModal,
    openProjModal,
    startRecord,
    dwPickScript,
    dwClearScript,
    dwPickResource,
    dwRemoveResource,
    globalSearch,
    restorePageParams,
    createTaskFromProject,
    recordVideo,
    dwPlayVideo,
    reportTrend,
    dwCloseVideo,
    execToggleRound,
    execClearLog,
    execLinkToTimeline,
    execToggleProtocol,
    dwInit,
    dwSetMode,
    dwLoadFiles,
    dwToggleShots,
    dwOpenFile,
    dwGenFromSteps,
    dwSaveCode,
    dwCreateTask,
    dwRunCode,
    dwToggleSession,
    dwRunStep,
    dwHighlightStep,
    dwTogglePick,
    dwToggleLog,
    dwSwitchTab,
    dwTlClear,
    dwTlZoomImage,
    dwRunAllSteps,
    dwCopyCode,
    openProjectHistory,
    openRecHistory,
    recHistInit,
    recHistLoad,
    recHistDelete,
    recHistNew,
    openLatestDebug,
    openSessionDebug,
    openSessionHistory,
    rsFocusStep,
    openSessionDebugFromView,
    copySessScript,
    copyProjScript,
    saveSessAsProject,
    openPlanModalForCreate,
    openRun,
    openPlanModalForEdit,
    openPlanDrawer,
    togglePlanPause,
    openPlanReport,
    ensureWizardProjectSelect,
    startAiRecord,
    startBrowserRecord,
    togglePick,
    savePlanModal,
    reload: () => Promise.all([loadDashboard(), loadTasks(), loadProjects(), loadPlans(), loadReports()]),
  };

  // ===== 原型函数增强（保持原签名，内部替换） =====
  ready(() => {
    // URL 上下文恢复钩子（app.html hashchange/DOMContentLoaded 调用）
    window.__restorePageParams = restorePageParams;
    // inspect 录制页「⚡ 脚本调试」→ 嵌入 iframe postMessage 通知父页 SPA 跳转工作台
    window.addEventListener("message", (ev) => {
      const d = ev.data;
      if (!d || d.type !== "autotest.sessionDebug" || !d.sid) return;
      openSessionDebug(String(d.sid), "inspect", d.projectId ? String(d.projectId) : null);
    });
    // 列表批量选择：全选/已选计数/三态（任务·计划·报告·历史·项目）
    initBatchSel();
    // 全量加载 + 向导项目下拉预填
    window.Bridge.reload();
    ensureWizardProjectSelect().catch(() => {});

    // 原型 openTaskRow(name) → 详情+历史
    window.openTaskRow = function (name, taskId) {
      if (taskId) {
        Bridge.openTaskExec(taskId, name);
        return;
      }
      document.getElementById("task-d-title").textContent = name || "任务详情";
      document.getElementById("task-mask")?.classList.add("show");
      document.getElementById("task-drawer")?.classList.add("show");
    };

    // 原型 confirmOk：按类型执行真实删除
    window.confirmOk = async function () {
      const type = window.__confirmType;
      const id = window.__confirmId;
      const name = window.__confirmName;
      closeConfirm();
      if (type === "plan" && id) deletePlan(id, name || "");
      else if (type === "proj" && id) deleteProject(id, name || "");
      else if (type === "delReport" && window.__delReportId) {
        const rid = window.__delReportId;
        window.__delReportId = null;
        try {
          await api(`/api/reports/${rid}`, { method: "DELETE" });
          window.toast?.("报告已删除", rid);
          if (window.__thTaskId) loadTaskHistory(window.__thTaskId, window.__thTaskName);
        } catch (e) {
          window.toast?.("删除失败", e.message);
        }
      }
      else if (type === "batchDel" && window.__batchDel) {
        const { ids, label, endpoint, reload } = window.__batchDel;
        let okN = 0;
        let failN = 0;
        for (const id of ids) {
          try {
            await api(endpoint(id), { method: "DELETE" });
            okN++;
          } catch (e) {
            failN++; // 单个失败继续（如执行中的计划/项目会被后端拒绝）
          }
        }
        window.__batchDel = null;
        window.toast?.(`已删除 ${okN}/${ids.length} 个${label}`, failN ? `${failN} 个删除失败（可能执行中）` : "");
        reload && reload();
      }
      else if (type === "stop") {
        stopMonitor();
        // 原型的停止视觉反馈
        const tag = document.getElementById("exec-status-tag");
        if (tag) {
          tag.className = "tag red";
          tag.innerHTML = '<span class="status-dot" style="width:6px;height:6px;background:var(--danger)"></span>已停止';
        }
        const val = document.getElementById("exec-status-val");
        if (val) {
          val.textContent = "STOPPED";
          val.style.color = "var(--danger)";
        }
        const btn = document.getElementById("exec-stop-btn");
        if (btn) btn.disabled = true;
      }
      window.__confirmType = null;
      window.__confirmId = null;
      window.__confirmName = null;
    };

    // 原型 exportReport(btn, fmt) → 真实导出
    window.exportReport = exportReport;

    // 原型 stopExec（confirmOk stop 分支已接管，保持幂等）
    // 向导第 4 步「创建」按钮（若存在）
    const wizBtn = document.querySelector("#page-task-create .btn.primary:last-of-type");
    if (wizBtn && wizBtn.textContent.includes("创建")) {
      wizBtn.addEventListener("click", submitWizard);
    }

    // 录制页内嵌：AI 录制 / 浏览器录制 为同源 iframe 懒加载（首次进入才加载，之后常驻保留会话）
    const EMBED_PAGES = ["page-ai", "page-browser"];
    EMBED_PAGES.forEach((pageId) => {
      document.querySelectorAll(`.nav-item[data-page='${pageId}']`).forEach((el) => {
        el.addEventListener("click", () => setTimeout(() => activateEmbed(pageId), 50));
      });
    });
    // go() 后也激活（面包屑/搜索跳转等路径）
    const origGo = window.go;
    if (origGo) {
      window.go = function (id, secKey, params) {
        origGo(id, secKey, params);
        if (EMBED_PAGES.includes(id)) setTimeout(() => activateEmbed(id), 50);
        if (id === "page-debug" || id === "page-debug-task") {
          const dom = id === "page-debug-task" ? "task" : "record";
          if (window.__dwInitedDom !== dom) {
            window.__dwInitedDom = dom;
            dwInit(dom).catch(() => {});
          }
        }
      };
    }

    // 直接进入调试工作台（hash 深链/刷新）→ 初始化
    if (document.getElementById("page-debug")?.classList.contains("active") || document.getElementById("page-debug-task")?.classList.contains("active")) {
      const dom = document.getElementById("page-debug-task")?.classList.contains("active") ? "task" : "record";
      if (window.__dwInitedDom !== dom) {
        window.__dwInitedDom = dom;
        dwInit(dom).catch(() => {});
      }
    }
    // 直接进入嵌入页（刷新/深链场景）
    if (EMBED_PAGES.some((id) => document.getElementById(id)?.classList.contains("active"))) {
      const active = EMBED_PAGES.find((id) => document.getElementById(id)?.classList.contains("active"));
      if (active) activateEmbed(active);
    }

    // 深链 run 绑定由 restorePageParams("exec", {run}) 处理（hash 参数源）
  });

  // ===== 14. 交互调试工作台（左文件树 / 中代码+日志 / 右步骤栏） =====
  const dw = { projectId: null, filePath: null, logOpen: true, pickMode: false, sid: null, steps: [], mode: "headless", dom: "record" };
  /** 双实例工作台 DOM 映射：任务域（page-debug-task）id 加 _t 后缀 */
  function dwQ(base) {
    return dw.dom === "task" ? base + "_t" : base;
  }

  /** 运行模式切换（无头 / 有头） */
  function dwSetMode(mode) {
    dw.mode = mode;
    document.querySelectorAll("#dw-mode span").forEach((s) => s.classList.toggle("on", s.dataset.mode === mode));
    window.toast?.(mode === "headless" ? "已切换为无头模式" : "已切换为有头模式", mode === "headless" ? "运行/调试不弹浏览器窗口" : "运行/调试弹出真实浏览器窗口");
  }

  /** 初始化工作台（域：record=录制项目脚本 / task=任务脚本快照） */
  async function dwInit(dom) {
    if (dom === "task" || dom === "record") {
      dw.dom = dom;
      dw.filePath = null; // 域切换重置（各自独立加载首个脚本）
    }
    try {
      const sel = document.getElementById(dwQ("dw-project"));
      if (!sel) return;
      if (dw.dom === "task") {
        const tasks = await api("/api/tasks?page=1&pageSize=50");
        sel.innerHTML = tasks.list.length
          ? tasks.list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")
          : `<option value="">（暂无任务）</option>`;
        if (tasks.list.length) {
          dw.projectId = tasks.list[0].id;
          sel.value = dw.projectId;
          await dwLoadFiles();
        }
      } else {
        const data = await api("/api/projects?page=1&pageSize=50");
        sel.innerHTML = data.list.length
          ? data.list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")
          : `<option value="">（暂无项目）</option>`;
        if (data.list.length) {
          dw.projectId = data.list[0].id;
          sel.value = dw.projectId;
          await dwLoadFiles();
        }
      }
    } catch (e) {
      window.toast?.("工作台初始化失败", e.message);
    } finally {
      window.__dwInited = true; // 初始化完成标志（等待方不再空转轮询）
    }
  }

  /** 加载文件树 + 步骤（record=项目文件 / task=任务快照）；用户切换项目时清除会话步骤状态 */
  async function dwLoadFiles() {
    const sel = document.getElementById(dwQ("dw-project"));
    if (!sel?.value) return;
    if (dw.projectId !== sel.value) dw.sessionSteps = null;
    dw.projectId = sel.value;
    try {
      if (dw.dom === "task") {
        // 任务域：文件树 = 任务脚本快照（db://tasks/{id}/scriptSnapshot）
        const tree = document.getElementById(dwQ("dw-file-tree"));
        if (tree) {
          tree.innerHTML = `<div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px" class="dw-file" data-path="db://tasks/${esc(dw.projectId)}/scriptSnapshot" onclick="Bridge.dwOpenFile('db://tasks/${esc(dw.projectId)}/scriptSnapshot')">
            <span>📄</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sel.selectedOptions?.[0]?.textContent || dw.projectId)}-snapshot.js</span><span class="mono" style="color:var(--text3);font-size:10px">快照</span>
          </div>`;
        }
        await dwLoadSteps();
        await dwOpenFile(`db://tasks/${dw.projectId}/scriptSnapshot`);
        return;
      }
      const data = await api(`/api/debug-workbench/files?projectId=${dw.projectId}`);
      const tree = document.getElementById(dwQ("dw-file-tree"));
      const kindIcon = { script: "📄", resource: "🗂", generated: "⚡" };
      if (tree) {
        // 截图归组到 screenshots 目录节点（默认折叠），不再与脚本文件平铺混排
        const imgs = data.files.filter((f) => f.kind === "image");
        const rest = data.files.filter((f) => f.kind !== "image");
        const rowHtml = (f) => `<div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px" class="dw-file" data-path="${esc(f.path)}" onclick="Bridge.dwOpenFile('${esc(f.path)}')">
                  <span>${kindIcon[f.kind] || "📄"}</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.name)}">${esc(f.name)}</span>
                  <span class="mono" style="color:var(--text3);font-size:10px">${f.size > 1024 ? Math.round(f.size / 1024) + "K" : f.size + "B"}</span>
                </div>`;
        const imgRowHtml = (f) => `<div style="display:flex;align-items:center;gap:7px;padding:6px 8px 6px 20px;border-radius:6px;cursor:pointer;font-size:12px" title="点击在新标签页查看">
                  <span>🖼</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
                  <span class="mono" style="color:var(--text3);font-size:10px">${f.size > 1024 ? Math.round(f.size / 1024) + "K" : f.size + "B"}</span>
                  <span style="color:var(--primary);font-size:10px" onclick="window.open('/api/files/${esc(f.path)}','_blank')">↗</span>
                </div>`;
        const shotsHtml = imgs.length
          ? `<div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;background:var(--input-bg)" onclick="Bridge.dwToggleShots()">
                  <span>🖼</span><span style="flex:1">screenshots（运行/录制截图）</span>
                  <span class="mono" style="color:var(--text3);font-size:10px">${imgs.length}</span>
                  <span id="dw-shots-arrow" style="color:var(--text3);font-size:10px">▸</span>
                </div>
                <div id="dw-shots-list" style="display:none;flex-direction:column;gap:1px">${imgs.map(imgRowHtml).join("")}</div>`
          : "";
        tree.innerHTML =
          (rest.length ? rest.map(rowHtml).join("") : `<div style="color:var(--text3);font-size:12px;padding:8px 4px">该项目无文件</div>`) +
          shotsHtml;
      }
      const cnt = document.getElementById(dwQ("dw-file-count"));
      if (cnt) cnt.textContent = data.files.length ? `(${data.files.length})` : "";
      await dwLoadSteps();
      // 自动加载第一个文件（项目生成脚本）→ 打开即见脚本（db:// 可编辑版优先，跳过磁盘镜像）
      if (data.files.length && !dw.filePath) {
        const first =
          data.files.find((f) => f.kind === "generated" && String(f.path).startsWith("db://")) ||
          data.files.find((f) => f.kind !== "image") ||
          data.files[0];
        if (first) await dwOpenFile(first.path);
      }
    } catch (e) {
      window.toast?.("文件树加载失败", e.message);
    }
  }

  /** 打开文件（db:// 虚拟或磁盘；图片走 /api/files 放大预览） */
  async function dwOpenFile(filePath) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(filePath)) {
      Bridge.dwTlZoomImage(`/api/files/${filePath}`);
      return;
    }
    try {
      const data = await api(`/api/debug-workbench/file?path=${encodeURIComponent(filePath)}`);
      const codeEl = document.getElementById(dwQ("dw-code"));
      if (codeEl) codeEl.value = data.content;
      const titleEl = document.getElementById(dwQ("dw-code-title"));
      if (titleEl) titleEl.textContent = data.name || filePath.split("/").pop();
      const langEl = document.getElementById(dwQ("dw-code-lang"));
      if (langEl) langEl.textContent = data.lang || "-";
      dw.filePath = filePath;
      dwLog("info", `已打开文件 ${data.name}`);
      document.querySelectorAll(".dw-file").forEach((el) => {
        el.style.background = el.getAttribute("data-path") === filePath ? "var(--primary-dim)" : "";
      });
    } catch (e) {
      window.toast?.("文件打开失败", e.message);
    }
  }

  /** 由步骤生成代码（前端同构生成器） */
  function dwGenFromSteps() {
    const steps = dw.steps || [];
    if (!steps.length) {
      window.toast?.("无录制步骤", "先录制生成步骤");
      return;
    }
    const p = dwGenScript(steps);
    const codeEl = document.getElementById(dwQ("dw-code"));
    if (codeEl) codeEl.value = p;
    dwLog("ok", `已由 ${steps.length} 步生成脚本`);
  }

  function dwGenScript(steps) {
    let out = "const { chromium } = require('playwright');\n\n(async () => {\n  const browser = await chromium.launch({ headless: false });\n  const page = await browser.newPage();\n\n";
    for (const s of steps) {
      const loc = String((s.locator || {}).primary || "");
      const val = String((s.params || {}).value || "");
      out += `  // ${s.desc || s.method}\n`;
      if (s.method === "click_at") {
        const x = Number((s.params || {}).x ?? 0);
        const y = Number((s.params || {}).y ?? 0);
        out += `  await page.mouse.click(${x}, ${y});
`;
      } else if (/fill|input|type/.test(s.method) && loc) out += `  await page.fill('${loc}', '${val}');
`;
      else if (/click/.test(s.method)) out += `  await page.click('${loc || val}');\n`;
      else if (/navigate|open_url|goto/.test(s.method)) out += `  await page.goto('${val}');\n`;
      else if (loc) out += val ? `  await page.fill('${loc}', '${val}');\n` : `  await page.click('${loc}');\n`;
    }
    out += "  await browser.close();\n})();\n";
    return out;
  }

  /** 交互调试「🧪 创建任务」：当前编辑器代码 → 上传 → 一键创建测试任务 */
  async function dwCreateTask() {
    const codeEl = document.getElementById(dwQ("dw-code"));
    const code = codeEl?.value?.trim();
    if (!code) {
      window.toast?.("无代码可创建", "先在编辑器加载或生成代码");
      return;
    }
    const projName = document.getElementById("dw-project option:checked")?.textContent || "调试";
    try {
      // 1. 上传代码为脚本文件（语法校验后端执行）
      const fd = new FormData();
      fd.append("kind", "script");
      fd.append("file", new Blob([code], { type: "text/javascript" }), "workbench.js");
      const upRes = await fetch("/api/uploads", { method: "POST", body: fd });
      const upBody = await upRes.json();
      if (upBody.code !== 0) throw new Error(upBody.message || "上传失败");
      // 2. 创建任务（upload 来源，快照=当前代码）
      const task = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: `${projName}-调试任务`,
          description: "由交互调试工作台一键创建",
          scriptSource: "upload",
          scriptUploadId: upBody.data.uploadId,
          browserType: "chromium",
          schedule: { mode: "manual" },
        }),
      });
      dwLog("ok", `测试任务已创建: ${task.id}`);
      window.toast?.("测试任务已创建", task.id);
    } catch (e) {
      dwLog("error", `创建任务失败: ${e.message}`);
      window.toast?.("创建失败", e.message);
    }
  }

  /** 保存代码到项目（PUT scriptContent）；任务域快照不可变 → 提示 */
  async function dwSaveCode() {
    if (dw.dom === "task") {
      window.toast?.("任务脚本快照不可变", "可用「创建任务」另存新任务");
      return;
    }
    const codeEl = document.getElementById(dwQ("dw-code"));
    if (!codeEl?.value?.trim() || !dw.projectId) {
      window.toast?.("无代码可保存", "");
      return;
    }
    try {
      await api(`/api/projects/${dw.projectId}`, {
        method: "PUT",
        body: JSON.stringify({ scriptContent: codeEl.value, scriptLang: "js" }),
      });
      dwLog("ok", "代码已保存到项目 scriptContent");
      window.toast?.("已保存到项目", "scriptContent 更新");
    } catch (e) {
      window.toast?.("保存失败", e.message);
    }
  }

  /** 运行代码（本地子进程，经后端 exec 端点，SSE 流式日志） */
  async function dwRunCode() {
    const codeEl = document.getElementById(dwQ("dw-code"));
    if (!codeEl?.value?.trim()) {
      window.toast?.("无代码可运行", "");
      return;
    }
    dwLog("info", `▶ 开始运行脚本（${dw.mode === "headless" ? "无头" : "有头"}）…`);
    try {
      // 按运行模式改写 launch 配置
      let code = codeEl.value;
      if (dw.mode === "headless") {
        code = code.replace(/headless:\s*false/g, "headless: true").replace(/headless:\s*true/g, "headless: true");
      } else {
        code = code.replace(/headless:\s*true/g, "headless: false").replace(/headless:\s*false/g, "headless: false");
      }
      // 步骤间隔（ms）：注入脚本 env，autoShot 每步后等待；0=不等待
      const stepGap = Math.max(0, Number(document.getElementById(dwQ("dw-step-gap"))?.value ?? 0) || 0);
      const resp = await fetch("/api/agent/run-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, stepIntervalMs: stepGap }),
      });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const data = line.replace(/^data: /, "");
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === "step") {
              // 脚本每步的 @@STEP@@ 标记 → 时间线实时卡片（步骤/描述/定位器/URL/截图）
              dwTlAdd({
                kind: "manual",
                method: evt.method || "step",
                desc: evt.desc || `步骤 ${evt.step}`,
                locator: evt.locator || "",
                url: evt.url || "",
                success: true,
                screenshot: evt.screenshot || "",
              });
              dwLog("info", `✓ 步骤 ${evt.step} ${evt.desc || evt.method || ""}`);
              continue;
            }
            if (evt.type === "log") {
              dwLog(evt.level === "error" ? "error" : "info", evt.text);
              // 关键节点同步进时间线（与执行监控一致：开始/结束留卡片）
              if (/执行 JavaScript 脚本|JS 脚本执行完成|JS 脚本异常退出/.test(String(evt.text || ""))) {
                dwTlAdd({
                  kind: "manual",
                  method: evt.level === "error" ? "error" : "run",
                  desc: String(evt.text || ""),
                  locator: "",
                  url: "",
                  success: evt.level !== "error",
                  screenshot: "",
                });
              }
            }
            if (evt.type === "done") dwLog("ok", "脚本运行结束");
          } catch { /* 忽略非 JSON */ }
        }
      }
    } catch (e) {
      dwLog("error", `运行失败: ${e.message}`);
    }
  }

  /** 连接/断开调试会话（inspect 会话承载单步执行） */
  async function dwToggleSession() {
    const btn = document.getElementById(dwQ("dw-session-btn"));
    if (dw.sid) {
      try {
        await api(`/api/inspect/session/${dw.sid}/close`, { method: "POST", body: "{}" });
      } catch { /* pass */ }
      dw.sid = null;
      if (btn) { btn.textContent = "▶ 连接调试会话"; btn.classList.remove("danger"); }
      dwLog("info", "调试会话已断开");
      return;
    }
    try {
      const p = await api(`/api/projects/${dw.projectId}`);
      const url = p.startUrl || "about:blank";
      const d = await api("/api/inspect/session", {
        method: "POST",
        body: JSON.stringify({ start_url: url, headless: dw.mode === "headless" }),
      });
      dw.sid = d.sid;
      if (btn) { btn.textContent = "⏹ 断开会话"; btn.classList.add("danger"); }
      dwLog("ok", `调试会话已连接（${url}）`);
      window.toast?.("调试会话已连接", url);
    } catch (e) {
      window.toast?.("会话连接失败", e.message);
    }
  }

  /** 高亮步骤目标元素 */
  async function dwHighlightStep(idx) {
    const s = (dw.steps || [])[idx];
    if (!s || !dw.sid) {
      window.toast?.("请先连接调试会话", "");
      return;
    }
    try {
      await api(`/api/inspect/session/${dw.sid}/act`, {
        method: "POST",
        body: JSON.stringify({ action: "highlight", locator: String((s.locator || {}).primary || "") }),
      });
      dwLog("info", `已高亮: ${(s.locator || {}).primary || ""}`);
    } catch (e) {
      dwLog("error", `高亮失败: ${e.message}`);
    }
  }

  /** 拾取模式切换 */
  async function dwTogglePick() {
    if (!dw.sid) {
      window.toast?.("请先连接调试会话", "");
      return;
    }
    dw.pickMode = !dw.pickMode;
    try {
      await api(`/api/inspect/session/${dw.sid}/act`, {
        method: "POST",
        body: JSON.stringify({ action: "pick_mode", enabled: dw.pickMode }),
      });
      dwLog("info", dw.pickMode ? "🎯 拾取模式已开启（在浏览器中点击元素）" : "拾取模式已关闭");
      window.toast?.(dw.pickMode ? "拾取模式开启" : "拾取模式关闭", dw.pickMode ? "浏览器内点击元素回填定位器" : "");
    } catch (e) {
      dwLog("error", `拾取切换失败: ${e.message}`);
    }
  }

  /** 日志追加 */
  function dwLog(level, msg) {
    const el = document.getElementById(dwQ("dw-log"));
    if (!el) return;
    const color = level === "ok" ? "var(--success)" : level === "error" ? "var(--danger)" : "var(--text2)";
    const t = new Date().toTimeString().slice(0, 8);
    const div = document.createElement("div");
    div.innerHTML = `<span style="color:var(--text3)">${t}</span> <span style="color:${color}">${esc(msg)}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    const cnt = document.getElementById(dwQ("dw-log-count"));
    if (cnt) cnt.textContent = String(el.children.length - 1);
  }

  /** 日志面板折叠 */
  function dwToggleLog() {
    const el = document.getElementById(dwQ("dw-log"));
    const hint = document.getElementById(dwQ("dw-log-toggle-hint"));
    if (!el) return;
    dw.logOpen = !dw.logOpen;
    el.style.display = dw.logOpen ? "block" : "none";
    if (hint) hint.textContent = dw.logOpen ? "▾ 收起" : "▸ 展开";
  }

  /** 复制代码 */
  async function dwCopyCode() {
    const codeEl = document.getElementById(dwQ("dw-code"));
    if (!codeEl?.value) return;
    try {
      await navigator.clipboard.writeText(codeEl.value);
      window.toast?.("代码已复制");
    } catch {
      window.toast?.("复制失败", "请手动选择");
    }
  }

  // ===== 15. 调试工作台 · 顶部 Tab（代码 / 时间线） =====
  const dwTl = { steps: [] };

  /** Tab 切换 */
  function dwSwitchTab(tab) {
    document.querySelectorAll("#dw-tabs span").forEach((s) => s.classList.toggle("on", s.dataset.tab === tab));
    const codeTab = document.getElementById(dwQ("dw-tab-code"));
    const tlTab = document.getElementById(dwQ("dw-tab-timeline"));
    if (codeTab) codeTab.style.display = tab === "code" ? "flex" : "none";
    if (tlTab) tlTab.style.display = tab === "timeline" ? "flex" : "none";
  }

  /** 时间线卡片（与执行监控 execTlCard 同构：状态/描述/方法/定位器/URL/大图截图） */
  function dwTlRenderCard(s) {
    const box = document.getElementById(dwQ("dw-timeline"));
    if (!box) return;
    // 清掉占位提示
    const hint = box.querySelector("div[style*='color:var(--text3)']");
    if (hint && dwTl.steps.length <= 1) hint.remove();
    const card = document.createElement("div");
    card.className = "dw-tl-card";
    const st = s.success === false ? '<span style="color:var(--danger)">✕</span>' : s.warning ? '<span style="color:var(--warning, orange)">⚠</span>' : '<span style="color:var(--success)">✓</span>';
    const t = new Date().toTimeString().slice(0, 8);
    card.innerHTML =
      `<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--input-bg);border-radius:var(--radius);border-left:3px solid ${s.success === false ? "var(--danger)" : s.warning ? "var(--warning, orange)" : "var(--success)"}">` +
      `<span class="mono" style="color:var(--text3);font-size:10px">步骤 ${s.step}</span>${st}` +
      `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.desc || "")}">${esc(s.desc || s.method)}</span>` +
      `<span class="tag ${s.kind === "manual" ? "ai" : "browser"}" style="font-size:10px">${esc(s.method)}</span>` +
      `<span class="mono" style="color:var(--text3);font-size:10px">${t}</span>` +
      `</div>` +
      (s.url ? `<div class="mono" style="padding:2px 12px 4px 34px;font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.url)}">${esc(s.url)}</div>` : "") +
      (s.locator ? `<div class="mono" style="padding:2px 12px 4px 34px;font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.locator)}</div>` : "") +
      (s.screenshot
        ? `<img src="${s.screenshot}" alt="步骤截图" style="display:block;width:100%;max-height:420px;object-fit:contain;object-position:left top;border-radius:6px;margin:2px 12px 6px;cursor:zoom-in" onclick="Bridge.dwTlZoomImage(this.src)"/>`
        : "") +
      (s.error ? `<div style="padding:0 12px 6px 34px;font-size:11px;color:var(--danger)">${esc(s.error)}</div>` : "");
    box.appendChild(card);
    box.scrollTop = box.scrollHeight;
  }

  /** 时间线追加事件（单步执行/运行脚本都走这里） */
  function dwTlAdd(evt) {
    evt.step = dwTl.steps.length + 1;
    dwTl.steps.push(evt);
    dwTlRenderCard(evt);
    const cnt = document.getElementById(dwQ("dw-tl-count"));
    if (cnt) cnt.textContent = `${dwTl.steps.length} 步`;
    const badge = document.getElementById(dwQ("dw-tl-badge"));
    if (badge) badge.textContent = `(${dwTl.steps.length})`;
  }

  /** 时间线截图放大预览：支持 ‹ › 按钮 / ← → 键 / 滚轮 翻图，Esc 或点击遮罩关闭 */
  function dwTlZoomImage(src) {
    // this.src 为绝对 URL，归一化为相对路径（与 pool 收集的 getAttribute 一致）
    const norm = String(src || "").startsWith(location.origin) ? String(src).slice(location.origin.length) : String(src || "");
    // 收集候选截图：当前时间线（执行监控/调试工作台/报告列表）全部卡片图
    const pool = [];
    const seen = new Set();
    const collect = (root) => {
      if (!root) return;
      root.querySelectorAll("img[src*='/api/files/']").forEach((im) => {
        const s = im.getAttribute("src");
        if (s && !seen.has(s)) { seen.add(s); pool.push(s); }
      });
    };
    collect(document.getElementById("exec-timeline"));
    collect(document.getElementById(dwQ("dw-timeline")));
    collect(document.getElementById("rpt-logs-list"));
    collect(document.querySelector("#page-report table"));
    if (!pool.includes(norm)) pool.push(norm);
    openShotGallery(norm, pool);
  }

  /** 截图画廊：定位到 src，支持上下步翻图 */
  function openShotGallery(src, pool) {
    let lb = document.getElementById(dwQ("dw-shot-lb"));
    if (!lb) {
      lb = document.createElement("div");
      lb.id = dwQ("dw-shot-lb");
      lb.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:95;display:none;align-items:center;justify-content:center;flex-direction:column";
      lb.innerHTML =
        '<img style="max-width:88vw;max-height:80vh;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.5)"/>' +
        '<div style="display:flex;align-items:center;gap:14px;margin-top:12px;color:#fff;font-size:13px">' +
        '<button class="sg-prev" style="background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;width:36px;height:36px;font-size:18px;cursor:pointer;line-height:1">‹</button>' +
        '<span class="sg-info" style="font-family:var(--mono);min-width:70px;text-align:center">0/0</span>' +
        '<button class="sg-next" style="background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;width:36px;height:36px;font-size:18px;cursor:pointer;line-height:1">›</button>' +
        '<span style="color:rgba(255,255,255,.6);font-size:11px;margin-left:8px">← → 或滚轮翻图 · Esc 关闭</span>' +
        "</div>";
      lb.addEventListener("click", (e) => { if (e.target === lb) lb.style.display = "none"; });
      lb.querySelector(".sg-prev").addEventListener("click", (e) => { e.stopPropagation(); sgStep(-1); });
      lb.querySelector(".sg-next").addEventListener("click", (e) => { e.stopPropagation(); sgStep(1); });
      lb.addEventListener("wheel", (e) => { e.preventDefault(); sgStep(e.deltaY > 0 ? 1 : -1); }, { passive: false });
      if (!window.__sgKeyBound) {
        window.__sgKeyBound = true;
        document.addEventListener("keydown", (e) => {
          const vis = document.getElementById(dwQ("dw-shot-lb"));
          if (!vis || vis.style.display === "none") return;
          if (e.key === "Escape") vis.style.display = "none";
          else if (e.key === "ArrowLeft") sgStep(-1);
          else if (e.key === "ArrowRight") sgStep(1);
        });
      }
      document.body.appendChild(lb);
    }
    // 状态：当前图池 + 索引
    window.__sgPool = pool;
    window.__sgIdx = Math.max(0, pool.indexOf(src));
    sgRender();
    lb.style.display = "flex";
  }

  /** 画廊翻图（-1 上一张 / +1 下一张） */
  function sgStep(dir) {
    const pool = window.__sgPool || [];
    if (!pool.length) return;
    window.__sgIdx = (window.__sgIdx + dir + pool.length) % pool.length;
    sgRender();
  }

  /** 画廊渲染当前图 */
  function sgRender() {
    const lb = document.getElementById(dwQ("dw-shot-lb"));
    if (!lb) return;
    const pool = window.__sgPool || [];
    const idx = Math.min(Math.max(0, window.__sgIdx || 0), Math.max(0, pool.length - 1));
    lb.querySelector("img").src = pool[idx] || "";
    lb.querySelector(".sg-info").textContent = `${idx + 1}/${pool.length}`;
    const prev = lb.querySelector(".sg-prev");
    const next = lb.querySelector(".sg-next");
    if (prev) prev.style.visibility = pool.length > 1 ? "visible" : "hidden";
    if (next) next.style.visibility = pool.length > 1 ? "visible" : "hidden";
  }

  /** 时间线清空 */
  function dwTlClear() {
    dwTl.steps = [];
    const box = document.getElementById(dwQ("dw-timeline"));
    if (box) box.innerHTML = `<div style="color:var(--text3);font-size:12px">已清空 · 单步执行的每一步实时记录在这里</div>`;
    const cnt = document.getElementById(dwQ("dw-tl-count"));
    if (cnt) cnt.textContent = "0 步";
    const badge = document.getElementById(dwQ("dw-tl-badge"));
    if (badge) badge.textContent = "";
  }

  /** 文件树 screenshots 分组折叠/展开 */
  function dwToggleShots() {
    const list = document.getElementById(dwQ("dw-shots-list"));
    const arrow = document.getElementById(dwQ("dw-shots-arrow"));
    if (!list) return;
    const open = list.style.display === "none";
    list.style.display = open ? "flex" : "none";
    if (arrow) arrow.textContent = open ? "▾" : "▸";
  }

  /** 步骤栏渲染到两个 Tab（代码 Tab 右栏 + 时间线 Tab 右栏共用数据） */
  async function dwLoadSteps() {
    // 会话脚本载入的录制步骤优先：与录制时间线保持一致（含截图），项目切换时清除回退项目步骤
    if (dw.sessionSteps) {
      dw.steps = dw.sessionSteps;
      dwRenderSessionSteps(dw.sessionSteps);
      return;
    }
    if (dw.dom === "task") {
      const msg = `<div style="color:var(--text3);font-size:12px;padding:8px 4px">任务脚本无录制步骤（脚本调试 = 编辑/运行）</div>`;
      for (const id of ["dw-steps", "dw-steps2"]) {
        const el = document.getElementById(dwQ(id));
        if (el) el.innerHTML = msg;
      }
      return;
    }
    try {
      const p = await api(`/api/projects/${dw.projectId}`);
      const cfg = p.recordConfig || {};
      const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
      dw.steps = steps;
      const render = (containerId, countId) => {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = steps.length
          ? steps
              .map(
                (s, i) => `<div class="dw-step" data-idx="${i}" data-panel="${containerId}" style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px">
                  <span class="mono" style="color:var(--text3);font-size:10px">${i + 1}</span>
                  <span class="tag ${p.type === "ai" ? "ai" : "browser"}" style="font-size:10px">${esc(s.method)}</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.desc || "")}">${esc(s.desc || s.method)}</span>
                  <button class="btn ghost row-btn" onclick="Bridge.dwHighlightStep(${i})">高亮</button>
                  <button class="btn ghost row-btn" onclick="Bridge.dwRunStep(${i})">执行</button>
                  <span class="dw-st mono" style="font-size:11px"></span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px;padding:8px 4px">无录制步骤（可由录制页生成）</div>`;
        const cnt = document.getElementById(countId);
        if (cnt) cnt.textContent = steps.length ? `(${steps.length})` : "";
      };
      render("dw-steps", "dw-step-count");
      render("dw-steps2", "dw-step-count2");
    } catch (e) { /* 静默 */ }
  }

  /** 会话录制步骤渲染到两个步骤栏（含截图缩略图；高亮/单步执行与项目步骤同构） */
  function dwRenderSessionSteps(steps) {
    const render = (containerId, countId) => {
      const el = document.getElementById(dwQ(containerId));
      if (!el) return;
      el.innerHTML = steps.length
        ? steps
            .map(
              (s, i) => `<div class="dw-step" data-idx="${i}" data-panel="${containerId}" style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:var(--input-bg);border-radius:var(--radius);font-size:12px">
                  <div style="display:flex;align-items:center;gap:6px">
                    <span class="mono" style="color:var(--text3);font-size:10px">${i + 1}</span>
                    <span class="tag browser" style="font-size:10px">${esc(s.method)}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.desc || "")}">${esc(s.desc || s.method)}</span>
                    <button class="btn ghost row-btn" onclick="Bridge.dwHighlightStep(${i})">高亮</button>
                    <button class="btn ghost row-btn" onclick="Bridge.dwRunStep(${i})">执行</button>
                    <span class="dw-st mono" style="font-size:11px"></span>
                  </div>
                  ${s.url ? `<div class="mono" style="font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.url)}</div>` : ""}
                  ${s.screenshot ? `<img src="${s.screenshot}" alt="步骤 ${i + 1} 截图" loading="lazy" style="width:100%;max-height:110px;object-fit:cover;object-position:top;border-radius:6px;border:1px solid var(--border);cursor:zoom-in" onclick="Bridge.dwTlZoomImage(this.src)"/>` : ""}
                </div>`,
            )
            .join("")
        : `<div style="color:var(--text3);font-size:12px;padding:8px 4px">无录制步骤（可由录制页生成）</div>`;
      const cnt = document.getElementById(countId);
      if (cnt) cnt.textContent = steps.length ? `(${steps.length})` : "";
    };
    render("dw-steps", "dw-step-count");
    render("dw-steps2", "dw-step-count2");
  }

  /** 时间线 Tab 预填完整录制步骤（与录制时间线一致）；此后单步执行/运行继续追加 */
  function dwTlSeedFromSteps(steps) {
    dwTl.steps = [];
    const box = document.getElementById(dwQ("dw-timeline"));
    if (box) box.innerHTML = "";
    steps.forEach((s, i) => {
      const card = { ...s, step: i + 1, kind: "record", success: s.success !== false };
      dwTl.steps.push(card);
      dwTlRenderCard(card);
    });
    const cnt = document.getElementById(dwQ("dw-tl-count"));
    if (cnt) cnt.textContent = `${dwTl.steps.length} 步`;
    const badge = document.getElementById(dwQ("dw-tl-badge"));
    if (badge) badge.textContent = dwTl.steps.length ? `(${dwTl.steps.length})` : "";
  }

  /** 单步执行增强：状态同步两个面板 + 时间线记录 */
  async function dwRunStep(idx) {
    const s = (dw.steps || [])[idx];
    if (!s) return;
    if (!dw.sid) {
      window.toast?.("请先连接调试会话", "右上角「连接调试会话」");
      return;
    }
    // 两个面板的该步骤状态都置“…”
    document.querySelectorAll(`.dw-step[data-idx="${idx}"] .dw-st`).forEach((el) => (el.textContent = "…"));
    try {
      const loc = String((s.locator || {}).primary || "");
      const val = String((s.params || {}).value || "");
      // click_at 步骤：坐标点击走独立 action（step 方法集不含 click_at）
      let d;
      if (s.method === "click_at") {
        d = await api(`/api/inspect/session/${dw.sid}/act`, {
          method: "POST",
          body: JSON.stringify({
            action: "click_at",
            x: Number((s.params || {}).x ?? 0),
            y: Number((s.params || {}).y ?? 0),
          }),
        });
      } else {
        d = await api(`/api/inspect/session/${dw.sid}/act`, {
          method: "POST",
          body: JSON.stringify({ action: "step", method: s.method, locator: loc, value: val }),
        });
      }
      const okRun = d.ok !== false;
      const evt = d.event || {};
      document.querySelectorAll(`.dw-step[data-idx="${idx}"] .dw-st`).forEach((el) => {
        el.textContent = okRun ? "✓" : "✕";
        el.style.color = okRun ? "var(--success)" : "var(--danger)";
      });
      dwLog(okRun ? "ok" : "error", `步骤 ${idx + 1} ${s.method} ${okRun ? "通过" : "失败: " + (d.error || "")}`);
      // 时间线记录（用 inspect 返回的真实事件：desc/locator/截图）
      dwTlAdd({
        kind: "manual",
        method: s.method,
        desc: evt.desc || s.desc || s.method,
        locator: loc,
        success: okRun,
        error: okRun ? null : d.error || "",
        url: evt.url || "",
        screenshot: evt.screenshot || "",
      });
    } catch (e) {
      document.querySelectorAll(`.dw-step[data-idx="${idx}"] .dw-st`).forEach((el) => {
        el.textContent = "✕";
        el.style.color = "var(--danger)";
      });
      dwLog("error", `步骤 ${idx + 1} 异常: ${e.message}`);
      dwTlAdd({ kind: "manual", method: s.method, desc: s.desc || s.method, locator: String((s.locator || {}).primary || ""), success: false, error: e.message, screenshot: "" });
    }
  }

  /** 顺序执行全部步骤（时间线 Tab 主按钮） */
  async function dwRunAllSteps() {
    if (!dw.sid) {
      window.toast?.("请先连接调试会话", "");
      return;
    }
    if (!dw.steps?.length) {
      window.toast?.("无录制步骤", "");
      return;
    }
    dwTlClear();
    dwLog("info", `▶▶ 开始顺序执行 ${dw.steps.length} 步…`);
    // 步骤间隔：与「▶ 运行」共用同一配置（输入缺省 500ms，0=不等待）
    const gap = Math.max(0, Number(document.getElementById(dwQ("dw-step-gap"))?.value ?? 500) || 0);
    let okCount = 0;
    for (let i = 0; i < dw.steps.length; i++) {
      await dwRunStep(i);
      const st = document.querySelector(`#dw-steps2 .dw-step[data-idx="${i}"] .dw-st`)?.textContent;
      if (st === "✓") okCount++;
      if (gap > 0 && i < dw.steps.length - 1) await new Promise((r) => setTimeout(r, gap));
    }
    dwLog(okCount === dw.steps.length ? "ok" : "error", `顺序执行完成：${okCount}/${dw.steps.length} 通过`);
    window.toast?.("顺序执行完成", `${okCount}/${dw.steps.length} 步通过`);
  }

  /** URL 上下文恢复：exec?run / exec?taskId / debug-task?taskId / report?taskId&reportId */
  async function restorePageParams(key, params) {
    try {
      if (key === "exec") {
        // 1) 直接绑定指定 run（执行后跳转/分享深链：#/exec?run=run_xxx）
        if (params.run) {
          bindMonitor(params.run);
          return;
        }
        // 2) 任务上下文：绑定该任务当前/最近 run
        if (params.taskId) {
          const q = await api("/api/config/queue/status").catch(() => null);
          if (q?.currentRunId) {
            const r = await api(`/api/task-runs/${q.currentRunId}`).catch(() => null);
            if (r && r.taskId === params.taskId) { bindMonitor(r.runId); return; }
          }
          const execs = await api(`/api/tasks/${params.taskId}/executions?page=1&pageSize=1`).catch(() => null);
          if (execs?.list?.length) {
            bindMonitor(execs.list[0].runId);
          }
          return;
        }
        // 3) 无上下文（#/exec 直达）：默认绑定最近一次任务运行
        const recent = await api("/api/dashboard/recent-runs?limit=1").catch(() => null);
        if (recent?.list?.length) bindMonitor(recent.list[0].runId);
      } else if (key === "debug-task" && params.taskId) {
        // 任务脚本调试：加载该任务快照
        const task = await api(`/api/tasks/${params.taskId}`).catch(() => null);
        if (task) {
          const d = await api(`/api/debug-workbench/file?path=${encodeURIComponent(`db://tasks/${params.taskId}/scriptSnapshot`)}`).catch(() => null);
          if (d) {
            const codeEl = document.getElementById(dwQ("dw-code"));
            if (codeEl) codeEl.value = d.content;
            const titleEl = document.getElementById(dwQ("dw-code-title"));
            if (titleEl) titleEl.textContent = `${task.name}.${d.lang}`;
          }
          // 恢复任务下拉选中（等 dwInit 填充完成）
          for (let i = 0; i < 20; i++) {
            const sel = document.getElementById(dwQ("dw-project"));
            if (sel?.options.length) {
              if ([...sel.options].some((o) => o.value === params.taskId)) sel.value = params.taskId;
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      } else if (key === "task-detail" && params.taskId) {
        const task = await api(`/api/tasks/${params.taskId}`).catch(() => null);
        if (task) loadTaskDetail(task.id, task.name);
      } else if (key === "task-history" && params.taskId) {
        const task = await api(`/api/tasks/${params.taskId}`).catch(() => null);
        if (task) loadTaskHistory(task.id, task.name);
      } else if (key === "rec-history") {
        // 历史录制：恢复项目上下文（projectId 可选，缺省选首个项目）
        window.__recHistProjectId = params.projectId || null;
        await recHistInit();
        await recHistLoad();
      } else if (key === "debug" && params.sessionId) {
        // 录制页独立打开时「⚡ 脚本调试」深链：直接装入该会话脚本
        await openSessionDebug(params.sessionId, "inspect", params.projectId || null);
      } else if (key === "debug" && params.projectId) {
        // 脚本调试深链：恢复该工程的工作台上下文
        await enterProjectDebug(params.projectId);
      } else if (key === "report") {
        // 报告详情：reportId 优先（已打开同报告则跳过），否则按 taskId 查最近报告
        if (params.reportId) {
          if (window.currentReportId !== params.reportId) await openReport(params.reportId);
        } else if (params.taskId) {
          const d = await api(`/api/reports?taskId=${params.taskId}&page=1&pageSize=1`).catch(() => null);
          if (d?.list?.length) await openReport(d.list[0].id);
        }
      }
    } catch (e) { /* 恢复失败静默 */ }
  }

  // ===== 执行监控 · 三栏（轮次 / 时间线 / 日志） =====
  const execM = { runId: null, seqs: {}, rounds: {}, roundContent: {}, tlCount: 0, logCount: 0, protocol: null };

  /** 时间线卡片（与录制页 step-card 同构：状态/描述/方法/定位器/截图） */
  function execTlCard(evt) {
    const st = evt.success === false ? '<span style="color:var(--danger)">✕</span>'
      : evt.warning ? '<span style="color:var(--warning, orange)">⚠</span>'
      : '<span style="color:var(--success)">✓</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--input-bg);border-radius:var(--radius);border-left:3px solid ${evt.success === false ? "var(--danger)" : evt.warning ? "var(--warning, orange)" : "var(--success)"}">
      <span class="mono" style="color:var(--text3);font-size:10px">${evt.step ?? ""}</span>${st}
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(evt.desc || "")}">${esc(evt.desc || evt.method || "")}</span>
      <span class="tag ${evt.kind === "manual" ? "ai" : "browser"}" style="font-size:10px">${esc(evt.method || "")}</span>
    </div>` +
    (evt.locator ? `<div class="mono" style="padding:2px 12px 4px 34px;font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(evt.locator)}</div>` : "") +
    (evt.screenshot ? `<img src="${evt.screenshot}" style="display:block;width:100%;max-height:420px;object-fit:contain;object-position:left top;border-radius:6px;margin:2px 12px 6px;cursor:zoom-in" onclick="Bridge.dwTlZoomImage(this.src)"/>` : "") +
    (evt.error ? `<div style="padding:0 12px 6px 34px;font-size:11px;color:var(--danger)">${esc(evt.error)}</div>` : "");
  }

  /** 录制协议步骤 → 可读文本（method/params/locator 精简 JSON） */
  function execProtocolText(st) {
    if (!st) return "";
    const out = {};
    const pick = ["method", "desc", "value", "url", "key", "path", "button", "index", "waitMs", "count", "assertText"];
    for (const k of pick) {
      if (st[k] !== undefined && st[k] !== null && st[k] !== "") out[k] = st[k];
    }
    if (st.params && typeof st.params === "object") out.params = st.params;
    if (st.locator) out.locator = typeof st.locator === "string" ? st.locator : st.locator.primary || st.locator;
    const s = JSON.stringify(out, null, 1);
    return s.replace(/^\{|}$/g, "").trim() || JSON.stringify(st);
  }

  /** 展开/收起某步的录制协议详情 */
  function execToggleProtocol(idx, btn) {
    const row = btn?.parentElement?.nextElementSibling;
    if (row && row.classList.contains("exec-prot-row")) {
      row.style.display = row.style.display === "none" ? "block" : "none";
      btn.textContent = row.style.display === "none" ? "📄" : "📖";
    }
  }

  /** 左栏：执行轮次渲染（含展开步骤） */
  async function execRenderRounds(run) {
    const el = document.getElementById("exec-rounds");
    const cnt = document.getElementById("exec-round-count");
    if (!el) return;
    const its = run.iterations || [];
    if (cnt) cnt.textContent = its.length ? `(${its.length})` : "";
    el.innerHTML = its.length
      ? its
          .map((it) => {
            const open = execM.rounds[it.executionId];
            return `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
              <div style="display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;font-size:12px;background:${open ? "var(--primary-dim)" : "var(--input-bg)"}" onclick="Bridge.execToggleRound(${it.executionId})">
                <span class="mono" style="color:var(--text3);font-size:10px">#${it.iterationIndex}</span>
                <span class="tag ${it.status === "success" ? "green" : it.status === "running" || it.status === "retrying" ? "cyan" : it.status === "failed" ? "red" : "gray"}" style="font-size:10px">${it.status}</span>
                <span class="mono" style="margin-left:auto;color:var(--text3);font-size:10px">${it.durationMs ? (it.durationMs / 1000).toFixed(1) + "s" : "…"}</span>
                <span style="color:var(--text3);font-size:10px">${open ? "▾" : "▸"}</span>
              </div>
              <div id="exec-round-${it.executionId}" style="display:${open ? "block" : "none"};padding:6px 10px;font-size:11px;max-height:180px;overflow-y:auto;background:var(--panel)">
                ${execM.roundContent[it.executionId] || `<div style="color:var(--text3);font-size:11px;padding:2px 0">加载步骤…</div>`}
              </div>
            </div>`;
          })
          .join("")
      : `<div style="color:var(--text3);font-size:12px;padding:8px 4px">暂无轮次</div>`;
  }

  /** 轮次展开/收起：加载该轮次步骤（report_steps 或日志截图） */
  async function execToggleRound(executionId) {
    execM.rounds[executionId] = !execM.rounds[executionId];
    const box = document.getElementById(`exec-round-${executionId}`);
    const open = execM.rounds[executionId];
    if (!box) return;
    box.style.display = open ? "block" : "none";
    if (open) {
      try {
        const exec = await api(`/api/executions/${executionId}`);
        const steps = exec.steps || [];
        if (steps.length) {
          const html = steps
            .map((s) => `<div style="padding:4px 0;border-bottom:1px dashed var(--border);cursor:pointer" onclick="Bridge.execLinkToTimeline(${executionId}, null, ${s.stepIndex})" title="点击定位到时间线对应步骤">
              <div style="display:flex;gap:6px;align-items:center">
                <span class="mono" style="color:var(--text3);font-size:10px">${s.stepIndex}</span>
                <span style="color:${s.status === "passed" ? "var(--success)" : "var(--danger)"}">${s.status === "passed" ? "✓" : "✕"}</span>
                <span class="tag ${s.status === "passed" ? "green" : "red"}" style="font-size:10px">${esc(s.method || "")}</span>
                <span class="mono" style="margin-left:auto;color:var(--text3);font-size:10px">${s.durationMs ? (s.durationMs / 1000).toFixed(1) + "s" : ""}</span>
                <span style="color:var(--primary);font-size:10px">📍</span>
              </div>
              <div class="mono" style="font-size:10.5px;color:var(--text2);padding:2px 0 0 20px;word-break:break-all">${esc(s.description || "")}</div>
            </div>`)
            .join("");
          box.innerHTML = html;
          execM.roundContent[executionId] = html;
        } else {
          // 脚本通道：显示每步记录（截图事件 + 录制 json 协议详情）
          const logs = await api(`/api/executions/${executionId}/logs?afterSeq=0&limit=100`);
          const shots = (logs.logs || []).filter((l) => l.event === "screenshot");
          const lines = (logs.logs || []).filter((l) => l.event === "log" || l.event === "status").slice(-6);
          const prot = execM.protocol || [];
          const stepRows = shots.length
            ? shots.map((l, i) => {
                // 指令：优先录制协议（method · desc），其次截图文件名 tag，最后事件标识
                const st = prot[i] || null;
                const p = (l.payload || {}).screenshotPath || "";
                const fname = String(p.split("/").pop() || "").replace(/\.[^.]+$/, "");
                const fm = /^step_(\d+)(?:_(.*))?$/i.exec(fname);
                const instr = fm?.[2] ? String(fm[2]).replace(/_+/g, " ").trim().slice(0, 48) : "";
                const label = st
                  ? `${String(st.method || "step")}${st.desc ? " · " + String(st.desc).slice(0, 40) : ""}`
                  : instr || l.message || "截图";
                return `<div style="display:flex;gap:6px;padding:3px 0;align-items:center;border-bottom:1px dashed var(--border);cursor:pointer" onclick="Bridge.execLinkToTimeline(${executionId}, '${esc(String(l.message || ""))}')" title="点击定位到时间线截图">
                  <span class="mono" style="color:var(--text3);font-size:10px">${fm ? Number(fm[1]) : i + 1}</span>
                  <span style="color:var(--success)">✓</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span>
                  <span class="mono" style="color:var(--text3);font-size:10px">${String(l.ts || "").slice(11, 19)}</span>
                  <span style="color:var(--primary);font-size:10px">📍</span>
                  ${st ? `<span style="cursor:pointer;color:var(--text3);font-size:10px" onclick="event.stopPropagation();Bridge.execToggleProtocol(${i}, this)" title="查看录制协议">📄</span>` : ""}
                </div>${st ? `<div class="exec-prot-row" style="display:none;padding:4px 8px;margin:0 0 6px;background:var(--input-bg);border-radius:6px;font-family:var(--mono);font-size:10px;line-height:1.6;color:var(--text2);white-space:pre-wrap;word-break:break-all">${esc(execProtocolText(st))}</div>` : ""}`;
              }).join("")
            : "";
          const html = stepRows + (lines.length
            ? lines.map((l) => `<div style="padding:2px 0;color:${l.level === "ok" ? "var(--success)" : l.level === "error" ? "var(--danger)" : "var(--text2)"}">${esc(l.message)}</div>`).join("")
            : (stepRows ? "" : `<div style="color:var(--text3);font-size:11px">该轮次无步骤记录</div>`));
          box.innerHTML = html;
          execM.roundContent[executionId] = html;
        }
      } catch (e) {
        box.innerHTML = `<div style="color:var(--text3);font-size:11px">步骤加载失败</div>`;
      }
    }
    // 就地更新箭头与高亮（避免整栏重渲染重置展开内容）
    const head = box.closest("div")?.querySelector("div[onclick*='execToggleRound']");
    if (head) {
      head.style.background = open ? "var(--primary-dim)" : "var(--input-bg)";
      const arrow = head.querySelector("span:last-child");
      if (arrow) arrow.textContent = open ? "▾" : "▸";
    }
  }

  /** 中栏：聚合全部轮次时间线（轮询增量拉取各轮次日志 → 卡片） */
  async function execAppendTimeline(run) {
    const tl = document.getElementById("exec-timeline");
    if (!tl) return;
    const items = run.iterations || [];
    let added = 0;
    for (const it of items) {
      const execId = it.executionId;
      const after = execM.seqs[execId] ?? 0;
      try {
        const d = await api(`/api/executions/${execId}/logs?afterSeq=${after}&limit=200`);
        for (const l of d.logs || []) {
          if (l.event === "screenshot") {
            const shot = l.payload?.screenshotPath;
            // 截图文件名 = step_NN_指令tag.png → 解析步骤号 + 指令
            const fname = shot ? String(shot.split("/").pop() || "").replace(/\.[^.]+$/, "") : "";
            const fm = /^step_(\d+)(?:_(.*))?$/i.exec(fname);
            const stepNo = fm ? Number(fm[1]) : 0;
            const instr = fm?.[2] ? String(fm[2]).replace(/_+/g, " ").trim().slice(0, 48) : "";
            // 指令优先：录制 json 协议（method · desc），文件名 tag 兜底
            const st = (execM.protocol || [])[Math.max(0, stepNo - 1)] || null;
            const desc = st
              ? `${String(st.method || "step")}${st.desc ? " · " + String(st.desc) : ""}`
              : instr || l.message || "截图";
            const card = document.createElement("div");
            card.className = "exec-tl-card";
            card.setAttribute("data-exec", String(execId));
            card.setAttribute("data-step", String(l.message || ""));
            card.innerHTML = execTlCard({
              step: stepNo ? `步骤 ${stepNo}` : `#${it.iterationIndex}`,
              desc,
              method: `轮次 #${it.iterationIndex}`,
              kind: "manual",
              success: true,
              screenshot: shot ? `/api/files/${shot}` : "",
              locator: st?.locator ? execProtocolText(st) : "",
            });
            tl.appendChild(card);
            added++;
          } else if (l.event === "step") {
            const stIdx = l.payload?.stepIndex;
            const card = document.createElement("div");
            card.className = "exec-tl-card";
            card.setAttribute("data-exec", String(execId));
            card.setAttribute("data-step", stIdx != null ? `step_${stIdx}` : String(l.message || ""));
            card.innerHTML = execTlCard({
              step: stIdx != null ? `步骤 ${stIdx}` : `#${it.iterationIndex}`,
              desc: l.payload?.method ? `${l.payload.method}` : l.message || "",
              method: `轮次 #${it.iterationIndex}`,
              kind: "manual",
              success: l.level !== "error",
              error: l.level === "error" ? l.message : "",
            });
            tl.appendChild(card);
            added++;
          }
        }
        execM.seqs[execId] = d.nextSeq || after;
      } catch (e) { /* 单轮次拉取失败跳过 */ }
    }
    if (added) {
      execM.tlCount += added;
      const cnt = document.getElementById("exec-tl-count");
      if (cnt) cnt.textContent = `${execM.tlCount} 步`;
      tl.scrollTop = tl.scrollHeight;
      const hint = tl.querySelector("div[style*='color:var(--text3)']");
      if (hint) hint.remove();
    }
  }

  /** 右栏：日志追加 */
  function execAppendLog(level, msg) {
    const el = document.getElementById("exec-log");
    if (!el) return;
    const hint = el.querySelector("div[style*='color:var(--text3)']");
    if (hint) hint.remove();
    const color = level === "ok" ? "var(--success)" : level === "error" ? "var(--danger)" : "var(--text2)";
    const div = document.createElement("div");
    div.innerHTML = `<span style="color:var(--text3)">${new Date().toTimeString().slice(0, 8)}</span> <span style="color:${color}">${esc(msg)}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    execM.logCount++;
    const cnt = document.getElementById("exec-log-count");
    if (cnt) cnt.textContent = String(execM.logCount);
  }

  /** 左栏步骤 → 中栏时间线联动：滚动定位 + 高亮 */
  async function execLinkToTimeline(executionId, stepTag, stepIndex) {
    const tl = document.getElementById("exec-timeline");
    if (!tl) return;
    // 等待卡片存在（时间线可能尚未聚合到该轮次）
    let target = null;
    for (let i = 0; i < 12 && !target; i++) {
      if (stepTag) {
        target = tl.querySelector(`.exec-tl-card[data-exec="${executionId}"][data-step="${stepTag}"]`);
      } else if (stepIndex != null) {
        target = tl.querySelector(`.exec-tl-card[data-exec="${executionId}"][data-step="step_${stepIndex}"]`)
          || tl.querySelector(`.exec-tl-card[data-exec="${executionId}"]`);
      } else {
        target = tl.querySelector(`.exec-tl-card[data-exec="${executionId}"]`);
      }
      if (!target) await new Promise((r) => setTimeout(r, 400));
    }
    if (!target) {
      window.toast?.("时间线暂无对应步骤", "执行完成后可查看");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.style.outline = "2px solid var(--primary)";
    target.style.transition = "outline .2s";
    setTimeout(() => (target.style.outline = ""), 1800);
    // 同步展开该轮次（左栏高亮当前步骤）
    const roundHead = document.querySelector(`#exec-rounds div[onclick*='execToggleRound']`);
    void roundHead;
  }

  /** 清空右栏日志 */
  function execClearLog() {
    const el = document.getElementById("exec-log");
    if (el) el.innerHTML = `<div style="color:var(--text3)">日志已清空</div>`;
    execM.logCount = 0;
    const cnt = document.getElementById("exec-log-count");
    if (cnt) cnt.textContent = "0";
  }

  /** 嵌入页懒加载：首次激活设置 iframe src（此后常驻保留会话） */
  function activateEmbed(pageId) {
    const frame = document.getElementById(pageId === "page-ai" ? "embed-ai" : "embed-browser");
    if (frame && !frame.src) {
      frame.src = frame.getAttribute("data-src") || "";
    }
    // 加载对应会话历史
    loadEmbedHistory(pageId === "page-ai" ? "ai" : "browser").catch(() => {});
  }
})();
