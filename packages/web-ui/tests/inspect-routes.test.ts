import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createApp } from "../src/app.js";
import { attachInspectWebSocket } from "../src/routes/inspect.routes.js";
import {
  INSPECT_ACTION_GROUPS,
  INSPECT_IDLE_TIMEOUT,
  INSPECT_LOG,
  INSPECT_META,
  INSPECT_SESSIONS,
  inspectDesc,
  inspectFile,
  inspectPersist,
} from "../src/routes/inspect.routes.js";
import { INSPECT_STEP_METHODS } from "../src/routes/agent.routes.js";

const server = http.createServer(createApp());
let baseUrl = "";

beforeAll(async () => {
  attachInspectWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("INSPECT_ACTION_GROUPS（inspect_routes.py:34）", () => {
  it("4 组 21 项，方法全覆盖（4+5+5+7）", () => {
    expect(INSPECT_ACTION_GROUPS).toHaveLength(4);
    expect(INSPECT_ACTION_GROUPS.map((g) => g.group)).toEqual([
      "元素动作", "输入动作", "导航/滚动", "进阶",
    ]);
    const methods = INSPECT_ACTION_GROUPS.flatMap((g) => g.actions.map((a) => a.method));
    expect(methods).toHaveLength(21);
    expect(methods).toContain("click_ele");
    expect(methods).toContain("upload_file");
    expect(methods).toContain("wait_for_url_contains");
  });

  it("GET /api/inspect/actions 原样返回分组配置", async () => {
    const res = await fetch(`${baseUrl}/api/inspect/actions`);
    expect(await res.json()).toEqual(INSPECT_ACTION_GROUPS);
  });
});

describe("INSPECT_STEP_METHODS 白名单", () => {
  it("20 个方法，含 wait_for_url_contains、execute_script", () => {
    expect(INSPECT_STEP_METHODS.size).toBe(20);
    for (const m of ["click_ele", "fill_value", "scroll_to_height", "wait_for_url_contains", "execute_script"]) {
      expect(INSPECT_STEP_METHODS.has(m)).toBe(true);
    }
    expect(INSPECT_STEP_METHODS.has("upload_file")).toBe(false); // 白名单外（走 set_input_files）
  });
});

describe("_inspect_desc（inspect_routes.py:139）", () => {
  it("各方法文案逐条对齐", () => {
    expect(inspectDesc("click_ele", "#btn", null, "登录")).toBe("点击 登录");
    expect(inspectDesc("double_click_ele", "#btn", null, "登录")).toBe("双击 登录");
    // el_text 为空时回退 locator 末段（Python `or` 语义）
    expect(inspectDesc("fill_value", "#u", "abc", null)).toBe('在 #u 输入 "abc"');
    expect(inspectDesc("fill_value", null, "abc", null)).toBe('在 输入框 输入 "abc"');
    expect(inspectDesc("fill_value", "#user", "abc", "用户名")).toBe('在 用户名 输入 "abc"');
    expect(inspectDesc("clear_value", "#u", null, "用户名")).toBe("清空 用户名");
    expect(inspectDesc("select_option", "#s", "A", null)).toBe('选择 #s = "A"');
    expect(inspectDesc("select_option", null, "A", null)).toBe('选择 下拉项 = "A"');
    expect(inspectDesc("press_key", null, "Enter", null)).toBe("按下 Enter");
    expect(inspectDesc("hover", "#a", null, "设置")).toBe("悬停 设置");
    expect(inspectDesc("click_by_text", null, "提交", null)).toBe('点击文本 "提交"');
    expect(inspectDesc("upload_file", null, "D:\\a.png", null)).toBe("上传文件 D:\\a.png");
    expect(inspectDesc("open_url", null, "http://x", null)).toBe("打开 http://x");
    expect(inspectDesc("refresh", null, null, null)).toBe("刷新页面");
    expect(inspectDesc("go_back", null, null, null)).toBe("后退");
    expect(inspectDesc("scroll_to_element", "#e", null, "目标")).toBe("滚动到 目标");
    expect(inspectDesc("scroll_to_height", null, "300", null)).toBe("滚动到 300px");
    expect(inspectDesc("wait_for_time", null, "", null)).toBe("等待 1000ms");
    expect(inspectDesc("wait_for_time", null, 500, null)).toBe("等待 500ms");
    expect(inspectDesc("wait_for_element", "#e", null, null)).toBe("等待元素出现 #e");
    expect(inspectDesc("wait_for_element", null, null, null)).toBe("等待元素出现");
    expect(inspectDesc("wait_for_element_hidden", "#e", null, null)).toBe("等待元素隐藏 #e");
    expect(inspectDesc("wait_for_element_hidden", null, null, null)).toBe("等待元素隐藏");
    expect(inspectDesc("wait_for_load", null, null, null)).toBe("等待加载完成");
    expect(inspectDesc("wait_for_url_contains", null, "abc", null)).toBe("等待 URL 包含 abc");
    expect(inspectDesc("execute_script", null, null, null)).toBe("执行 JS 脚本");
    expect(inspectDesc("unknown_method", null, null, null)).toBe("unknown_method");
  });

  it("无 el_text 时用 locator 末段", () => {
    expect(inspectDesc("click_ele", "get_by_text=登录系统", null, null)).toBe("点击 登录系统");
  });
});

describe("inspect 持久化与会话端点", () => {
  const sid = "unit-test-sid";

  beforeEach(() => {
    if (existsSync(inspectFile(sid))) rmSync(inspectFile(sid));
    INSPECT_SESSIONS.delete(sid);
    INSPECT_LOG.delete(sid);
    INSPECT_META.delete(sid);
  });

  it("落盘格式为 indent=1 且含 steps", () => {
    INSPECT_META.set(sid, { start_url: "http://x", created_at: 1 });
    INSPECT_LOG.set(sid, [{ type: "step", step: 1, method: "click_ele" }]);
    inspectPersist(sid);
    const raw = readFileSync(inspectFile(sid), "utf-8");
    expect(raw).toContain('\n "session_id"'); // indent=1
    const data = JSON.parse(raw);
    expect(data["steps"]).toHaveLength(1);
    expect(data["start_url"]).toBe("http://x");
  });

  it("GET /api/inspect/sessions 列出历史并标记 alive", async () => {
    INSPECT_META.set(sid, { start_url: "http://x", created_at: 1 });
    INSPECT_LOG.set(sid, [{ type: "step", step: 1 }]);
    inspectPersist(sid);
    const res = await fetch(`${baseUrl}/api/inspect/sessions`);
    const items = (await res.json()) as Array<Record<string, any>>;
    const hit = items.find((i) => i["sid"] === sid);
    expect(hit).toBeTruthy();
    expect(hit!["step_count"]).toBe(1);
    expect(hit!["alive"]).toBe(false);
    expect(hit!["start_url"]).toBe("http://x");
  });

  it("GET /api/inspect/session/{sid}/timeline：磁盘回放；不存在 → 404", async () => {
    INSPECT_META.set(sid, { start_url: "http://x", created_at: 1 });
    INSPECT_LOG.set(sid, [{ type: "step", step: 1 }]);
    inspectPersist(sid);
    INSPECT_LOG.delete(sid); // 仅磁盘
    const ok = await fetch(`${baseUrl}/api/inspect/session/${sid}/timeline`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, any>;
    expect(body["alive"]).toBe(false);
    expect(body["steps"]).toHaveLength(1);

    const missing = await fetch(`${baseUrl}/api/inspect/session/never-exist/timeline`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "inspect 历史不存在" });
  });

  it("DELETE /api/inspect/sessions/{sid} 删除磁盘记录", async () => {
    INSPECT_META.set(sid, { start_url: "http://x", created_at: 1 });
    INSPECT_LOG.set(sid, []);
    inspectPersist(sid);
    const res = await fetch(`${baseUrl}/api/inspect/sessions/${sid}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(inspectFile(sid))).toBe(false);
  });

  it("act / close 在会话不存在时返回 404", async () => {
    const act = await fetch(`${baseUrl}/api/inspect/session/no-such/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pageinfo" }),
    });
    expect(act.status).toBe(404);
    expect(await act.json()).toEqual({ detail: "inspect 会话不存在或已关闭" });

    const close = await fetch(`${baseUrl}/api/inspect/session/no-such/close`, { method: "POST" });
    expect(close.status).toBe(404);
  });

  it("act 未知动作 → 422（协议错误，注入假会话）", async () => {
    const fake = { page: null, _close: async () => undefined } as never;
    INSPECT_SESSIONS.set(sid, fake);
    const res = await fetch(`${baseUrl}/api/inspect/session/${sid}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "not_a_action" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "未知动作: not_a_action" });
    INSPECT_SESSIONS.delete(sid);
  });

  it("POST /api/inspect/session 缺 start_url → 422", async () => {
    const res = await fetch(`${baseUrl}/api/inspect/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "start_url 不能为空" });
  });
});

describe("空闲超时常量（B2）", () => {
  it("INSPECT_IDLE_TIMEOUT = 30 分钟", () => {
    expect(INSPECT_IDLE_TIMEOUT).toBe(1800);
  });
});
