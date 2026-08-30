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

  async function loadTasks() {
    const tbody = document.getElementById("task-tbody");
    if (!tbody) return;
    try {
      const data = await api("/api/tasks?page=1&pageSize=10");
      if (!data.list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:36px">暂无任务 · 点击「新建任务」创建第一个测试任务</td></tr>`;
        return;
      }
      tbody.innerHTML = data.list
        .map(
          (t) => `<tr data-row="${esc(t.id)}" data-id="${esc(t.id)}">
            <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
            <td onclick="openTaskRow('${esc(t.name)}','${esc(t.id)}')" style="cursor:pointer;color:var(--text)"><b>${esc(t.name)}</b></td>
            <td>${esc(t.projectName || "-")}</td>
            <td>${statusTag(t.status)}</td>
            <td class="mono">${esc(t.browserType)}</td>
            <td class="mono">0/3</td>
            <td>
              <span class="row-edit" title="编辑任务" onclick="editTaskRow(this)">✏️</span>
              <span class="row-act" title="执行" onclick="Bridge.runTask('${esc(t.id)}')">▶</span>
              <span class="row-act" title="查看历史" onclick="Bridge.openTaskExec('${esc(t.id)}','${esc(t.name)}')">📄</span>
            </td></tr>`
        )
        .join("");
      const pager = document.querySelector("#tasktable .pager .mono");
      if (pager) pager.textContent = `共 ${data.total} 条`;
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:24px">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  // ===== 2. 任务详情抽屉：执行历史 =====
  async function openTaskExec(taskId, name) {
    try {
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
      window.go?.("page-exec");
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
    const logEl = document.getElementById("log");
    if (logEl) logEl.innerHTML = "";
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(pollMonitor, 2000);
    pollMonitor();
  }

  async function pollMonitor() {
    if (!monitorRunId) return;
    if (!document.getElementById("page-exec")?.classList.contains("active")) return; // 页面不可见时暂停拉取
    try {
      const run = await api(`/api/task-runs/${monitorRunId}`);
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
      // 迭代摘要：利用已有元素（第2个 h-row 的调度类型标签）
      // 日志增量
      const logEl = document.getElementById("log");
      if (logEl) {
        const logs = await api(`/api/task-runs/${monitorRunId}/logs?afterSeq=${monitorSeq}&limit=200`);
        if (logs.logs.length) {
          for (const l of logs.logs) {
            const div = document.createElement("div");
            const cls2 = l.level === "ok" ? "ok" : l.level === "error" ? "err" : l.level === "warn" ? "err" : "info";
            div.innerHTML = `<span class="t">${fmtTime(l.ts).slice(11)}</span> <span class="${cls2}">[${l.level.toUpperCase()}] ${esc(l.message)}</span>`;
            logEl.appendChild(div);
          }
          logEl.scrollTop = logEl.scrollHeight;
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
  async function loadProjects() {
    const grid = document.querySelector("#page-projects .proj-grid");
    if (!grid) return;
    try {
      const data = await api("/api/projects?page=1&pageSize=12");
      if (!data.list.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:40px">暂无录制项目 · 「新建录制」创建第一个项目</div>`;
        return;
      }
      const typeLabel = { ai: "AI 录制", browser: "浏览器录制" };
      const statusMap = { ready: ["green", "就绪"], draft: ["amber", "草稿"], archived: ["gray", "归档"] };
      grid.innerHTML = data.list
        .map((p) => {
          const [scls, slabel] = statusMap[p.status] || ["gray", p.status];
          const isAi = p.type === "ai";
          return `<div class="proj" data-name="${esc(p.name)}" data-id="${esc(p.id)}" data-type="${typeLabel[p.type]}" onclick="Bridge.openProject('${esc(p.id)}')">
            <div class="top"><span class="proj-ico" style="background:var(--tag-${isAi ? "ai" : "br"}-bg);color:var(--tag-${isAi ? "ai" : "br"}-tx)">${isAi ? "✦" : "🌐"}</span><span class="name">${esc(p.name)}</span><span class="tag ${scls}" style="margin-left:auto">${slabel}</span></div>
            <div class="desc">${esc(p.description || typeLabel[p.type] + "项目")}</div>
            <div class="meta"><span class="mono">${fmtTime(p.createdAt).slice(5, 10)}</span> · <span>${typeLabel[p.type]}</span> · <span>${p.stepsCount} 步</span></div>
            <div class="actions"><button class="btn primary" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.startRecord('${esc(p.id)}')">▶ 启动</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.openProjModal('${esc(p.id)}')">编辑</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.openProjectHistory('${esc(p.id)}')">历史${p.sessionCount && p.sessionCount > 0 ? `(${p.sessionCount})` : ""}</button><button class="btn ghost" style="padding:5px 8px" onclick="event.stopPropagation();Bridge.confirmDelProj('${esc(p.name)}','${esc(p.id)}')">删除</button></div></div>`;
        })
        .join("");
      const sub = document.querySelector("#page-projects .page-sub");
      if (sub) sub.textContent = `AI 录制与浏览器录制统一管理 · 共 ${data.total} 个项目 · 点击卡片查看详情`;
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
            frame.contentWindow.postMessage({ type: "autotest.prefill", url: p.startUrl }, "*");
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

  /** 打开会话历史详情（时间线 / JSON 协议 / 生成脚本） */
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

      // 填充抽屉头部
      document.getElementById("sess-d-title").textContent = kind === "ai" ? "AI 录制会话" : "浏览器录制会话";
      document.getElementById("sess-d-id").textContent = sessionId.slice(0, 16) + "…";
      document.getElementById("sess-d-url").textContent = startUrl || "-";
      const stEl = document.getElementById("sess-d-status");
      if (stEl) {
        stEl.innerHTML = alive ? '<span class="tag cyan">进行中</span>' : '<span class="tag gray">已结束</span>';
      }
      document.getElementById("sess-d-steps").textContent = String(steps.length);

      // 时间线视图
      const tl = document.getElementById("sess-timeline");
      if (tl) {
        tl.innerHTML = steps.length
          ? steps
              .map(
                (s) => `<div class="pick-item">
                  <span class="p-order">${s.step ?? "-"}</span>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.desc || s.method)}</span>
                  <span class="mono" style="color:${s.success === false ? "var(--danger)" : "var(--text3)"};font-size:11px">${esc(s.method)}</span>
                </div>`
              )
              .join("")
          : `<div style="color:var(--text3);font-size:12px;padding:6px 2px">该会话无步骤</div>`;
      }
      // JSON 协议视图
      const jsonEl = document.getElementById("sess-json");
      if (jsonEl) {
        jsonEl.textContent = JSON.stringify(
          steps.map((s) => ({ step: s.step, method: s.method, desc: s.desc, locator: s.locator, value: s.value, url: s.url })),
          null,
          2,
        );
      }
      // 生成脚本视图（生成器在后端：临时用前端简化版同构输出）
      const scriptEl = document.getElementById("sess-script");
      if (scriptEl) {
        scriptEl.textContent = steps.length ? generateSessionScript(steps, startUrl) : "// 无步骤";
      }
      // 默认 tab 复位
      switchSessTab("timeline");
      document.getElementById("sess-mask")?.classList.add("show");
      document.getElementById("sess-drawer")?.classList.add("show");
    } catch (e) {
      window.toast?.("会话详情加载失败", e.message);
    }
  }

  /** 会话时间线 → Playwright JS（与后端 script-generator 同构） */
  function generateSessionScript(steps, startUrl) {
    let out = "const { chromium } = require('playwright');\n\n(async () => {\n  const browser = await chromium.launch({ headless: false });\n  const page = await browser.newPage();\n\n";
    if (startUrl) out += `  await page.goto('${startUrl}');\n`;
    for (const s of steps) {
      const loc = String(s.locator || "");
      const val = String(s.value || "");
      out += `  // Step ${s.step ?? ""}: ${s.desc || s.method}\n`;
      if (/fill|input|type/.test(s.method) && loc) out += `  await page.fill('${loc}', '${val}');\n`;
      else if (/click/.test(s.method)) out += `  await page.click('${loc || val}');\n`;
      else if (/navigate|open_url|goto/.test(s.method)) out += `  await page.goto('${val || s.url || ""}');\n`;
      else if (loc) out += val ? `  await page.fill('${loc}', '${val}');\n` : `  await page.click('${loc}');\n`;
    }
    out += "  await browser.close();\n})();\n";
    return out;
  }

  /** 会话详情 Tab 切换 */
  function switchSessTab(tab) {
    document.querySelectorAll("#sess-tabs span").forEach((s) => s.classList.toggle("on", s.dataset.tab === tab));
    ["timeline", "json", "script"].forEach((t) => {
      const el = document.getElementById(`sess-tab-${t}`);
      if (el) el.style.display = t === tab ? "block" : "none";
    });
  }

  /** 复制会话生成脚本 */
  async function copySessScript() {
    const el = document.getElementById("sess-script");
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
      closeSessDrawer();
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
  async function loadPlans() {
    const grid = document.getElementById("plan-grid");
    if (!grid) return;
    try {
      const data = await api("/api/plans?page=1&pageSize=12");
      if (!data.list.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text3);padding:40px">暂无测试计划 · 「+ 新建计划」编排任务</div>`;
        return;
      }
      grid.innerHTML = data.list
        .map((p) => {
          const stMap = { idle: ["gray", "空闲"], running: ["cyan", "运行中"], paused: ["amber", "已暂停"], completed: ["green", "已完成"], failed: ["red", "失败"], stopped: ["gray", "已停止"] };
          const [scls, slabel] = stMap[p.status] || ["gray", p.status];
          return `<div class="plan" data-name="${esc(p.name)}" data-id="${esc(p.id)}" onclick="Bridge.openPlanDrawer('${esc(p.id)}')">
            <div class="p-top"><span class="tag ${scls}">${slabel}</span><b class="p-name">${esc(p.name)}</b><span class="p-cron">${esc(p.cronExpr || "手动")}</span></div>
            <div class="p-desc">${esc(p.description || `${p.taskCount} 个任务 · 串行执行`)}</div>
            <div class="p-meta"><span>${p.taskCount} 个任务</span><span>最近 ${fmtTime(p.lastRunAt || p.createdAt)}</span></div>
            <div class="p-actions"><button class="btn" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.runPlan('${esc(p.id)}')">▶ 执行</button><button class="btn" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.openPlanModalForEdit('${esc(p.id)}')">✏️ 编辑</button><button class="btn danger" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();Bridge.confirmDelPlan('${esc(p.name)}','${esc(p.id)}')">🗑</button></div>
          </div>`;
        })
        .join("");
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
      const title = document.getElementById("plan-d-title");
      if (title) title.textContent = plan.name;
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
  async function loadReports() {
    const tbody = document.querySelector("#page-reports table tbody");
    if (!tbody) return;
    try {
      const data = await api("/api/reports?page=1&pageSize=10");
      if (!data.list.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:36px">暂无测试报告 · 去执行任务生成报告</td></tr>`;
        return;
      }
      tbody.innerHTML = data.list
        .map(
          (r) => `<tr data-row="${esc(r.id)}">
            <td><input type="checkbox" class="row-check" style="accent-color:var(--primary)"></td>
            <td onclick="Bridge.openReport('${esc(r.id)}')" style="cursor:pointer"><b>${esc(r.name)}</b></td>
            <td>${r.type === "plan" ? "计划汇总" : esc(r.name)}</td>
            <td>${r.type === "plan" ? "计划" : "任务"}</td>
            <td class="mono">${r.passRate}%</td>
            <td>${statusTag(r.status)}</td>
            <td class="mono">${fmtTime(r.createdAt)}</td>
            <td><span class="row-act" title="详情" onclick="Bridge.openReport('${esc(r.id)}')">📄</span></td></tr>`
        )
        .join("");
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
      const title = document.querySelector("#page-report .page-title");
      if (title) title.childNodes[0].textContent = `${r.name} `;
      // 概览数值
      const nums = document.querySelectorAll("#page-report .stats .stat .num");
      if (nums.length >= 5) {
        nums[0].textContent = r.passRate + "%";
        nums[1].textContent = r.totalSteps;
        nums[2].textContent = r.passedSteps;
        nums[3].textContent = r.failedSteps;
        nums[4].textContent = r.durationMs ? (r.durationMs / 1000).toFixed(1) + "s" : "-";
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
      const body = {
        name,
        description: document.getElementById("task-desc")?.value || "",
        scriptSource: "project",
        projectId,
        browserType: "chromium",
        schedule: { mode: "manual" },
        executeNow: executeNow === true,
      };
      const data = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      window.__preselectedProjectId = null;
      if (executeNow) {
        window.toast?.("任务已保存，开始执行", data.id);
        window.go?.("page-exec");
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
    openTaskExec,
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
    openProjectHistory,
    openSessionHistory,
    switchSessTab,
    copySessScript,
    copyProjScript,
    saveSessAsProject,
    openPlanModalForCreate,
    openRun,
    openPlanModalForEdit,
    openPlanDrawer,
    ensureWizardProjectSelect,
    startAiRecord,
    startBrowserRecord,
    togglePick,
    savePlanModal,
    reload: () => Promise.all([loadDashboard(), loadTasks(), loadProjects(), loadPlans(), loadReports()]),
  };

  // ===== 原型函数增强（保持原签名，内部替换） =====
  ready(() => {
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
    window.confirmOk = function () {
      const type = window.__confirmType;
      const id = window.__confirmId;
      const name = window.__confirmName;
      closeConfirm();
      if (type === "plan" && id) deletePlan(id, name || "");
      else if (type === "proj" && id) deleteProject(id, name || "");
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
    // go() 后也激活（面包屑/搜索跳转等路径）
    const origGo = window.go;
    if (origGo) {
      window.go = function (id) {
        origGo(id);
        if (EMBED_PAGES.includes(id)) setTimeout(() => activateEmbed(id), 50);
      };
    }

    // 直接进入嵌入页（刷新/深链场景）
    if (EMBED_PAGES.some((id) => document.getElementById(id)?.classList.contains("active"))) {
      const active = EMBED_PAGES.find((id) => document.getElementById(id)?.classList.contains("active"));
      if (active) activateEmbed(active);
    }

    // URL 带 runId 时自动绑定监控（任务执行后跳转）
    const params = new URLSearchParams(location.search);
    const runId = params.get("run");
    if (runId) bindMonitor(runId);
  });

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
