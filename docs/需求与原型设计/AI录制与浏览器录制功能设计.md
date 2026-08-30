# AI 录制与浏览器录制 功能设计文档

> 版本：v1.0 | 日期：2026-08-29 | 状态：设计稿（基于 BrickCore Node/TS 重构实现整理）
> 关联文档：[Web-UI自动化工具需求讨论.md](./Web-UI自动化工具需求讨论.md)、[ACCEPTANCE.md](./ACCEPTANCE.md)

---

## 1. 概述

### 1.1 背景

本工具是面向测试人员的 Web-UI 自动化测试平台（BrickCore Node/TS 版），核心链路为：**录制生成脚本 → 任务化执行 → 报告产出**。录制是整条链路的入口，直接决定脚本质量与用户上手成本。

系统提供两种互补的录制模式：

| 维度 | 浏览器录制（Browser Recording） | AI 录制（AI Recording） |
|------|------|------|
| 交互方式 | 用户在真实浏览器中手动操作，系统被动捕获 | 用户输入自然语言任务描述，AI Agent 自主探索执行 |
| 适用人群 | 熟悉业务流程的测试人员 | 任何角色（含开发、产品） |
| 产物 | 原始操作事件流 → 标准步骤 | AI 执行轨迹（含截图/推理）→ 标准步骤 |
| 脚本质量 | 依赖用户操作规范性 | 依赖 LLM 规划质量，自动生成语义化定位 |
| 成本 | 无 LLM 成本，确定性高 | 有 LLM 成本，效率高 |
| 典型场景 | 精确回放复杂交互（拖拽、悬停、键盘组合） | 快速冒烟、探索性测试、流程发现 |

### 1.2 系统架构现状

```
+-------------------+      HTTP + 回调(X-Internal-Token)  +-------------------+
| web-ui (Backend)  | <---------------------------------> |  runner (Runner)  |
| :3000             |   POST /record/start 等             |  :9377            |
|                   |                                     |                   |
| agent.routes.ts   |   POST /api/agent/run (SSE)         |  recording.ts     |
| agent-runner.ts   |   —— 仅 Backend 内部 ——>            |  recorder-script  |
| page/exec routes  |                                     |  debug-session.ts |
+-------------------+                                     +-------------------+
        |                                                          |
        v                                                          v
+-------------------+                                     +-------------------+
| smartbrowser 包    |                                     |  Playwright       |
| AgentExplorer     |                                     |  Chromium/Firefox |
| Planner/Locator   |                                     |  WebKit           |
+-------------------+                                     +-------------------+
```

- **web-ui（Backend，:3000）**：面向前端的 HTTP/SSE API，承载 AI 录制全流程与录制项目管理。
- **runner（Runner，:9377）**：独立进程，持有 Playwright 浏览器实例，承载浏览器录制与交互调试。
- **smartbrowser**：AI 探索引擎（`UiMcpAgentExplorer`），被 Backend 的 `agent-runner.ts` 调用。
- **shared**：跨进程契约类型（`RecordStartPayload`、`RecordedAction`、`DebugSessionPayload`、`DEBUG_EVENTS` 等）与环境配置。

### 1.3 术语

| 术语 | 定义 |
|------|------|
| 录制项目（Project） | 录制产物载体，`type: 'ai' \| 'browser'`，含脚本内容与参数 Schema |
| 录制会话（Record Session） | 一次浏览器录制过程，由 Runner 侧 `RecordingSession` 封装 |
| Agent 会话（Agent Session） | 一次 AI 录制过程，由 Backend 侧 `AgentSession` 封装，可跨请求复用 |
| 调试会话（Debug Session） | 交互式调试过程，支持高亮/拾取/单步执行 |
| 定位策略（Locator Strategy） | 生成元素候选定位器的策略：`default` / `tolerant` / `robust` / `semantic_first` / `semantic` |
| 步骤（Step） | 标准化操作单元：`{ method, params, locator }` |
| SSE | Server-Sent Events，AI 录制实时事件流的传输方式 |

---

## 2. 功能需求

优先级定义：P0 = 首版必须，P1 = 一期内，P2 = 二期。

### 2.1 浏览器录制（Browser Recording）

#### FR-B1 录制会话生命周期管理（P0）

| 项 | 需求 |
|----|------|
| 启动 | Backend 调用 `POST {runner}/record/start`，携带 `record_session_id`、`url`、`description`、`max_record_time`（默认 600s）、`hover_delay_ms`（默认 1000ms）、`recording_locator_strategy`（默认 `default`）及回调配置 |
| 停止 | 用户主动停止（`POST /record/:id/stop`）或超时自动停止；停止后 Runner 回调结果并清理浏览器 |
| 暂停/恢复 | `POST /record/:id/control`，`action: pause \| resume \| clear`；暂停期间捕获的动作丢弃 |
| 清空 | `clear` 动作丢弃已捕获的全部动作，重新开始 |
| 超时保护 | `max_record_time` 到期自动停止，防止会话泄漏 |
| 异常兜底 | 浏览器启动失败/页面崩溃时，回调 `status: failed` 并携带错误信息 |

#### FR-B2 用户操作捕获（P0）

注入脚本（`recorder-script.ts` 产物）在页面上下文中监听并捕获：

| 操作类型 | 捕获时机 | 说明 |
|---------|---------|------|
| click / dblclick | 事件触发 | 记录目标元素候选定位器与元信息 |
| input | change/blur 合并 | 同一输入框连续键入合并为一条，避免碎片化 |
| select | change | 下拉选择 |
| keydown | Enter / Tab / Escape | 仅捕获关键键，避免噪音 |
| scroll | 防抖 500ms | 滚动位置记录 |
| navigation | 页面跳转 | 记录 URL 变化 |
| popup / dialog | 弹窗事件 | 记录弹窗类型与处理 |
| hover 目标 | 悬停 `hover_delay_ms` 后 | 用于悬停菜单类交互的定位 |

#### FR-B3 多级定位策略与候选定位器（P0）

每条捕获动作必须携带**候选定位器数组**（`candidates`）与**元素元信息**（`meta`），供回放时降级重试：

- **candidates**：按策略生成有序候选列表，回放时依次尝试。
- **meta**：`tag`、`text`、`role`、`ariaLabel`、`placeholder`、`id`、`name`、`type`、`classes`、`cssPath`、`xpath`、`attributes`。

五种策略：

| 策略 | 规则 | 适用场景 |
|------|------|---------|
| `default` | id > test-id > data-testid > aria > text > css | 通用默认 |
| `tolerant` | 在 default 基础上追加 partial text 匹配 | 动态文本页面 |
| `robust` | 多属性组合定位（tag+class+attr） | 结构复杂页面 |
| `semantic_first` | role+name 语义定位优先 | 组件化前端（如 AntD） |
| `semantic` | 仅语义定位 | 严格语义化页面 |

#### FR-B4 实时心跳与状态回传（P0）

- Runner 按 `RECORD_HEARTBEAT_INTERVAL`（默认 1s）向 Backend 心跳端点上报：会话状态、已捕获动作（`raw_actions`）、iframe 监听状态（`frames: { total, listening, items }`）。
- 心跳与结果回调均携带 `X-Internal-Token` 头做内部鉴权。
- Backend 依据心跳刷新"录制中"状态；心跳超时判定会话失联。

#### FR-B5 录制数据结构化（P0）

原始动作（`RecordedAction`）字段契约：

```typescript
interface RecordedAction {
  action: string;                 // click | input | select | keydown | scroll | navigate | ...
  selector: string;               // 首选定位器
  candidates: string[];           // 候选定位器（降级重试）
  meta: Record<string, unknown>;  // 元素元信息（tag/text/role/aria/...）
  value?: string;                 // 输入值/选择值
  ts: number;                     // 时间戳
  frame?: string;                 // 所属 frame 标识
  url?: string;                   // 发生页面
  extra?: Record<string, unknown>; // 弹窗/键盘等附加信息
}
```

#### FR-B6 视频录制（P1）

录制会话开启 Playwright `recordVideo`，产物 MP4 存入报告目录，与步骤日志关联展示。

#### FR-B7 交互式调试（P1）

调试会话（`DebugSession`）支持在录制/编辑过程中与页面实时交互：

| 能力 | 说明 |
|------|------|
| 元素高亮 | 命令 `highlight`，在页面上框选指定元素 |
| 拾取模式 | 命令 `pick_mode`，鼠标悬停高亮 + 点击选中，返回定位器 |
| 单步执行 | `step_click` / `step_input` / `step_select` / `step_scroll` / `step_navigate` / `step_wait` / `step_assert` / `step_extract` / `step_screenshot` / `step_script` |
| 页面内热键 | Ctrl+Shift+U 拾取、Ctrl+Shift+H 高亮、Ctrl+Shift+I 检查、Ctrl+Shift+D 调试 |
| 事件回调 | `started` / `page_ready` / `command_result` / `step_started` / `step_finished` / `step_failed` / `log` / `error` / `stopped` |

命令通过轮询（`DEBUG_POLL_INTERVAL` 默认 0.5s）从 Backend 拉取，结果通过回调端点回传。

### 2.2 AI 录制（AI Recording）

#### FR-A1 自然语言任务发起（P0）

用户提交 `instruction`（自然语言任务描述）+ `url`（起始地址），Backend 启动 Agent 探索，全程 SSE 流式返回事件。

#### FR-A2 Agent 探索循环（P0）

`UiMcpAgentExplorer.agentExplore()` 核心循环：

```
snapshot（页面快照/可交互元素树）
   → LLM 规划（输出下一步动作 JSON）
   → 执行动作（Playwright）
   → 断言/观察结果
   → 循环，直到任务完成或达到 max_steps（默认 25）
```

#### FR-A3 实时步骤事件流（P0）

SSE 事件契约（`event` + `data`，`data` 内含 `session_id`）：

| 事件 | 触发时机 | 关键字段 |
|------|---------|---------|
| `session_started` | 会话创建 | session_id、url、instruction、mode |
| `step_started` | 步骤开始 | step_index、action、selector |
| `step_finished` | 步骤成功 | step_index、duration_ms、result |
| `step_failed` | 步骤失败 | step_index、error、screenshot |
| `llm_request` | 发起 LLM 调用 | prompt 摘要 |
| `llm_response` | LLM 返回 | 规划内容 |
| `llm_error` | LLM 调用失败 | error |
| `task_complete` | 任务完成 | summary、总步数、耗时 |
| `task_failed` | 任务失败 | reason、已完成步数 |
| `session_closed` | 会话关闭 | session_id |
| `error` | 系统级错误 | message |

#### FR-A4 会话复用与多轮任务（P0）

- `session_id` + `resume: true`：在既有浏览器上下文上继续新任务（保留登录态）。
- `keep_alive: true`：SSE 结束后不关闭浏览器，供后续复用。
- 空闲会话由 GC 自动回收（默认 30 分钟）。

#### FR-A5 QA 问答模式（P1）

`mode: 'qa'`：Agent 只观察不操作，针对页面内容回答问题，用于页面信息提取与验证。

#### FR-A6 卡死检测与自动重规划（P0）

| 检测 | 阈值 | 处置 |
|------|------|------|
| 重复动作 | 连续 3 次相同动作 | 触发重规划（LLM 重新决策） |
| 无进展 | 连续 5 次无新 URL/新元素 | 触发重规划 |
| 重规划上限 | 最多 3 次 | 判定 `task_failed` |

#### FR-A7 定位自愈（Locator Heal）（P1）

步骤执行定位失败时，将候选定位器与页面快照交由 LLM 修复，修复后重试；仍失败则上报 `step_failed`。

#### FR-A8 步骤转脚本（P0）

AI 执行轨迹（步骤序列）一键转换为标准测试脚本（与浏览器录制产物同构：`{ method, params, locator }` 步骤流），落入录制项目 `scriptContent`。

#### FR-A9 LLM 配置管理（P0）

- `GET /api/agent/config` / `POST /api/agent/config`：读取/保存 LLM 供应商、模型、API Key、温度等。
- 支持请求级覆盖（`llm_config` 字段），便于多模型对比。

#### FR-A10 会话观测（P1）

- 会话列表：`GET /api/agent/sessions`（含 status、steps_completed/failed、last_active、screenshot_available）。
- 历史事件回放：`GET /api/agent/sessions/:id/events`（SSE，环形缓冲最近 1000 条）。
- 实时截图：`GET /api/agent/sessions/:id/screenshot`（LRU 缓存，上限 10MB）。

### 2.3 共用需求

#### FR-C1 录制项目管理（P0）

- 项目字段：`name`、`type: 'ai' | 'browser'`、`description`、`scriptContent`、`paramsSchema`、`status: draft | ready | archived`。
- 两种录制产物统一落入项目模型，后续任务/计划/报告链路无差别消费。
- 对应需求文档 PR-01 ~ PR-06。

#### FR-C2 步骤编辑与校验（P1）

录制产物在保存前可人工编辑：调整步骤顺序、修改定位器（从 candidates 中切换）、编辑参数值；保存前做脚本语法校验。

#### FR-C3 参数化（P1）

录制时识别的输入值可提取为参数（`paramsSchema`），执行期由任务传入实际值（对应需求文档"任务参数化界面"）。

---

## 3. UX 需求

### 3.1 设计原则

沿用需求文档 UX 总纲：**简洁清晰、状态可见、一致性、高效操作**。录制场景额外强调：

- **过程透明**：录制/AI 执行的每一步都实时可见，杜绝黑盒等待。
- **可中断可恢复**：任何长耗时操作（录制、AI 探索）均可随时停止，且不丢失已产生数据。
- **失败可解释**：每条失败步骤必须给出原因 + 截图，而非笼统报错。

### 3.2 色彩与状态

| 状态 | 色值 | 录制场景应用 |
|------|------|------------|
| 主色 | #0052D9 | 录制按钮、进行中步骤、链接 |
| 成功 | #00A870 | 步骤通过、录制完成、任务完成 |
| 警告 | #ED7B2F | 暂停中、定位降级、重规划提示 |
| 错误 | #E34D59 | 步骤失败、会话失联、任务失败 |
| 背景 | #F5F7FA / #FFFFFF | 页面背景 / 卡片 |

会话状态机（两种录制共用语义）：

```
浏览器录制:  pending → recording → (paused) → completed | failed | stopped
AI 录制:     pending → running  → completed | failed | stopped | expired(GC回收)
```

### 3.3 录制项目创建界面

对应需求文档 10.1，核心是**录制类型分流**：

```
+------------------------------------------------------------+
| 创建录制项目                                                 |
+------------------------------------------------------------+
| 项目名称*: [________________]                               |
| 录制类型*: (●) AI录制    ( ) 浏览器录制                       |
| 目标URL*:  [https://____________]                           |
| 描述:      [________________]                               |
+------------------------------------------------------------+
| ── AI录制模式 ────────────────────────────────              |
| 任务描述*:                                                  |
| [                                                        ] |
| [ 登录系统，进入订单管理，创建一笔测试订单并验证成功提示 ]        |
| [                                                        ] |
|                                              [✦ 生成脚本]   |
+------------------------------------------------------------+
| ── 浏览器录制模式 ────────────────────────────              |
| 提示: 点击启动后打开浏览器，您的操作将被记录                    |
| 定位策略: [default ▼]   最大时长: [600] 秒                    |
|                                              [▶ 启动录制]   |
+------------------------------------------------------------+
```

UX 要点：

- **AI 录制**：大输入框 + 显眼的"生成脚本"主按钮；提供任务描述示例占位符；生成过程进入执行界面（3.5）。
- **浏览器录制**：启动前可配置定位策略与最大时长；启动后跳转录制监控界面（3.4）。
- 类型切换时表单区联动切换，已填写的公共字段（名称/URL/描述）保留。

### 3.4 浏览器录制监控界面

启动录制后，前端展示实时监控面板（数据源：心跳接口聚合）：

```
+------------------------------------------------------------+
| ● 录制中   会话 #1024    00:03:42 / 00:10:00                |
+------------------------------------------------------------+
| [⏸ 暂停]  [▶ 恢复]  [🗑 清空]  [⏹ 停止并保存]               |
+------------------------------------------------------------+
| 已捕获步骤 (12)                              iframe: 2/2 ✓  |
+------------------------------------------------------------+
| #12  click    [用户名输入框]  #username                      |
| #11  input    [密码输入框]    ******                         |
| #10  click    [登录按钮]      button: 登录                   |
| #9   navigate → /dashboard                                  |
| ...                                                         |
+------------------------------------------------------------+
| 提示: 暂停期间操作不会被记录 | 超时将自动停止并保存             |
+------------------------------------------------------------+
```

UX 要点：

- **计时器**：已录制时长 / 最大时长，剩余 60s 时警告色提示。
- **步骤列表**：实时追加（心跳驱动），每条含序号、动作类型图标、元素语义名、首选定位器；动作类型用图标区分（click/input/navigate 等）。
- **iframe 状态**：`frames.listening/total`，未监听的 iframe 用警告色提示（可能漏录）。
- **控制按钮**：暂停/恢复互斥切换；"清空"需二次确认；"停止并保存"是主按钮。
- **失联处理**：心跳超时 → 状态转"失联"（错误色），提供"强制结束"入口，已收到的动作仍可保存。

### 3.5 AI 录制执行界面

SSE 事件流驱动的对话式时间线：

```
+------------------------------------------------------------+
| ✦ AI 录制中   会话 sess_a1b2          步骤 5/25              |
+------------------------------------------------------------+
| 任务: 登录系统并创建一笔测试订单                               |
+------------------------------------------------------------+
| ● 步骤 #5  click [创建订单按钮]                    00:02     |
| ● 步骤 #4  input [订单金额] = "99.9"               00:01     |
| ● 步骤 #3  navigate → /orders/new                  00:03     |
| ● 步骤 #2  input [密码] = ******                    00:01     |
| ● 步骤 #1  click [登录]                            00:02     |
| ✦ LLM 正在规划下一步…                                       |
+------------------------------------------------------------+
| [截图预览缩略图]  [查看完整时间线]  [⏹ 停止]                  |
+------------------------------------------------------------+
| ▶ 完成后: [保存为录制项目]  [继续追加任务(复用会话)]           |
+------------------------------------------------------------+
```

UX 要点：

- **步骤时间线**：`step_started` 插入"进行中"行（主色 + 加载动画），`step_finished` 转成功（绿色 + 耗时），`step_failed` 转失败（红色 + 展开错误详情与截图）。
- **LLM 态可视化**：`llm_request`/`llm_response` 之间显示"LLM 正在规划…"动效，让等待可感知。
- **重规划提示**：触发卡死检测重规划时，时间线插入警告色系统条："检测到重复操作，已重新规划"。
- **截图**：当前页面缩略图常驻（`/screenshot` 轮询或事件触发），点击放大。
- **停止不丢数据**：随时停止，已完成步骤仍可"保存为录制项目"。
- **会话复用**：任务完成后提供"继续追加任务"入口（`resume: true`），强调"登录态已保留"。
- **完成态**：`task_complete` 后展示总结卡片（总步数、耗时、成功率）+ 保存/继续操作。

### 3.6 交互调试界面（编辑期）

在项目编辑页内嵌调试能力（对应 FR-B7）：

- **拾取模式**：点击"选取元素"后，页面内悬停高亮元素，点击即回填定位器到当前编辑步骤；热键 Ctrl+Shift+U 等价。
- **单步试跑**：编辑区每条步骤带"单独执行"按钮，执行结果（成功/失败/断言结果/提取值）就地展示。
- **高亮定位**：步骤行 hover 时页面内高亮目标元素，快速确认定位是否准确。

### 3.7 空态与错误反馈

| 场景 | 设计 |
|------|------|
| 无录制项目 | 引导插画 + "创建第一个录制项目"，双入口卡片（AI 录制 / 浏览器录制） |
| LLM 未配置 | AI 录制入口置灰 + 引导配置弹窗（跳转 LLM 配置设置页） |
| Runner 不可达 | 启动录制时报错"执行器未就绪"，提供重试与端口检查指引（:9377） |
| 浏览器启动失败 | 错误详情 + 常见原因（路径错误/无头环境缺依赖） |
| SSE 断连 | 自动重连（指数退避），重连后通过 `/events` 回放环形缓冲补齐缺失事件 |

---

## 4. API 设计与实现

### 4.1 总体协议

| 通道 | 方向 | 协议 | 鉴权 |
|------|------|------|------|
| Backend → Runner | 启动/控制 | HTTP（`http://127.0.0.1:9377`） | `X-Internal-Token` |
| Runner → Backend | 心跳/结果回调 | HTTP POST | `X-Internal-Token` |
| 前端 → Backend（AI 录制） | 任务执行 | SSE（`POST /api/agent/run`） | 业务鉴权 |
| 前端 → Backend（观测） | 列表/截图/事件 | HTTP / SSE | 业务鉴权 |

统一响应包裹：`{ code: 0, message: "success", data: ... }`；SSE 为 `event: <name>\ndata: <json>\n\n` 帧。

### 4.2 浏览器录制 API（Runner 侧）

#### 4.2.1 启动录制

```
POST {runner}/record/start
Content-Type: application/json

{
  "record_session_id": 1024,
  "device_id": "dev_001",
  "url": "https://example.com/login",
  "description": "登录流程录制",
  "max_record_time": 600,
  "hover_delay_ms": 1000,
  "recording_locator_strategy": "default",
  "callback": {
    "callback_url": "http://127.0.0.1:3000/runner/http/record-callback",
    "heartbeat_url": "http://127.0.0.1:3000/runner/http/heartbeat",
    "api_key": "<internal-token>"
  }
}
```

**响应**：`{ code: 0, data: { record_session_id: 1024 } }`

**实现**：`RecordingSession.run()` 后台任务 = 开浏览器（`RECORD_HEADLESS=0` 有头、`RECORD_VIEWPORT=1366,768`、`recordVideo`）→ 注入 `buildRecorderScript(strategy)` → 心跳/超时任务 → 等待停止 → 结果回调 → 清理。

#### 4.2.2 停止录制

```
POST {runner}/record/:record_session_id/stop
```

**语义**：幂等；触发 `_setStop()`，会话收尾后回调最终结果（含全部 `raw_actions` 与视频路径）。

#### 4.2.3 录制控制

```
POST {runner}/record/:record_session_id/control
{ "action": "pause" | "resume" | "clear" }
```

**响应**：`{ code: 0, data: { paused: true, actions: 12 } }`（`lastControlResult`）

#### 4.2.4 心跳上报（Runner → Backend）

```
POST {heartbeat_url}    （间隔 RECORD_HEARTBEAT_INTERVAL = 1s）
X-Internal-Token: <api_key>

{
  "record_session_id": 1024,
  "status": "recording",
  "raw_actions": [ /* RecordedAction[] 增量或全量 */ ],
  "frames": { "total": 2, "listening": 2, "items": [{ "url": "...", "name": "main", "listening": true }] }
}
```

#### 4.2.5 结果回调（Runner → Backend）

```
POST {callback_url}
X-Internal-Token: <api_key>

{
  "record_session_id": 1024,
  "status": "completed" | "failed" | "stopped",
  "actions": [ /* RecordedAction[] 全量 */ ],
  "frames": { ... },
  "video_path": "reports/record_1024/video.mp4",
  "error": null
}
```

#### 4.2.6 时序图

```
前端          Backend(:3000)           Runner(:9377)         浏览器
 | POST /api/record/start |                |                   |
 |----------------------->| POST /record/start                |
 |                        |---------------->|  launch + inject  |
 |                        |    200 {id}     |------------------>|
 |                        |<----------------|                   |
 |<--- 200 {sessionId} ---|                |                   |
 |                        |   heartbeat(1s)|                   |
 |                        |<----------------|  capture actions  |
 |  GET /api/record/:id   |                |<------------------|
 |----------------------->|                |                   |
 |  (轮询/推送步骤列表)     |                |                   |
 | POST /api/record/:id/stop               |                   |
 |----------------------->| POST /record/:id/stop              |
 |                        |---------------->|  finish + cleanup |
 |                        |   result callback                  |
 |                        |<----------------|                   |
 |  GET /api/record/:id/result             |                   |
 |----------------------->|                |                   |
```

### 4.3 交互调试 API（Runner 侧）

#### 4.3.1 启动/停止调试会话

```
POST {runner}/debug/session/start
{
  "debug_session_id": 2048,
  "device_id": "dev_001",
  "url": "https://example.com",
  "description": "步骤编辑调试",
  "hotkeys": { "pick": "ctrl+shift+u", "highlight": "ctrl+shift+h", "inspect": "ctrl+shift+i", "debug": "ctrl+shift+d" },
  "callback": { "callback_url": ".../runner-callback", "command_url": ".../runner-command", "api_key": "..." }
}

POST {runner}/debug/session/:debug_session_id/stop
```

#### 4.3.2 命令轮询与回调

```
Runner → GET {command_url}（每 DEBUG_POLL_INTERVAL=0.5s）
  ← 命令队列: { action: "highlight"|"pick_mode"|"step_run"|"step_click"|"step_input"|
                 "step_select"|"step_scroll"|"step_navigate"|"step_wait"|"step_assert"|
                 "step_extract"|"step_screenshot"|"step_script"|"step_stop",
               payload: {...} }

Runner → POST {callback_url}
  事件: started | page_ready | command_result | step_started |
        step_finished | step_failed | log | error | stopped
```

### 4.4 AI 录制 API（Backend 侧）

#### 4.4.1 执行任务（SSE）

```
POST /api/agent/run
Accept: text/event-stream

{
  "instruction": "登录系统并创建一笔测试订单",
  "url": "https://example.com",
  "session_id": "sess_a1b2",        // 可选，配合 resume 复用会话
  "resume": false,                  // true 时在既有上下文继续
  "keep_alive": true,               // SSE 结束后保留浏览器
  "mode": "explore",                // explore | qa
  "max_steps": 25,
  "viewport": { "width": 1366, "height": 768 },
  "timeout_s": 600,
  "headless": false,
  "slowmo_ms": 0,
  "llm_config": { ... }             // 可选，请求级覆盖
}
```

**SSE 事件流**（见 FR-A3 契约）：

```
event: session_started
data: {"session_id":"sess_a1b2","url":"https://example.com","mode":"explore"}

event: step_started
data: {"session_id":"sess_a1b2","step_index":1,"action":"click","selector":"#login-btn"}

event: step_finished
data: {"session_id":"sess_a1b2","step_index":1,"duration_ms":830,"result":{...}}

...

event: task_complete
data: {"session_id":"sess_a1b2","summary":"...","total_steps":8,"elapsed_ms":45200}
```

**实现链路**：`agent.routes.ts`（SSE 写出）→ `agent-runner.ts`（会话注册/事件分发/GC）→ smartbrowser `UiMcpAgentExplorer.agentExplore(request, callbacks)`（探索循环）。

#### 4.4.2 会话管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agent/sessions` | GET | 会话列表：session_id、url、instruction、mode、status、created_at、last_active、steps_completed、steps_failed、screenshot_available |
| `/api/agent/sessions/:id` | DELETE | 删除会话记录（关闭浏览器并移除） |
| `/api/agent/sessions/:id/close` | POST | 主动关闭浏览器（保留会话记录） |
| `/api/agent/sessions/:id/screenshot` | GET | 当前页面截图（PNG，LRU 缓存 10MB） |
| `/api/agent/sessions/:id/events` | GET | SSE 历史事件回放（环形缓冲最近 1000 条） |

#### 4.4.3 LLM 配置

```
GET  /api/agent/config    → { code: 0, data: { provider, model, api_key, temperature, ... } }
POST /api/agent/config    ← { provider, model, api_key, temperature, ... }
```

### 4.5 核心数据结构（shared 契约）

```typescript
// packages/shared/src/types.ts
interface RecordStartPayload {
  record_session_id: number;
  device_id: string;
  url: string;
  description: string;
  max_record_time?: number;              // 默认 600
  hover_delay_ms?: number;               // 默认 1000
  recording_locator_strategy?: string;   // 默认 "default"
  callback?: RecordCallbackConfig;       // { callback_url, heartbeat_url, api_key }
}

interface RecordedAction { /* 见 FR-B5 */ }

interface RecordHeartbeatBody {
  record_session_id: number;
  status: string;
  raw_actions: RecordedAction[];
  frames: RecordFrames;
}

interface DebugSessionPayload {
  debug_session_id: number;
  device_id: string;
  url: string;
  description: string;
  hotkeys?: Record<string, unknown>;
  callback?: DebugCallbackConfig;        // { callback_url, command_url, api_key }
}

const DEBUG_EVENTS = { /* started/page_ready/command_result/step_*/ };
type DebugCommandAction = "highlight" | "pick_mode" | "step_run" | "step_click" | ...;
```

### 4.6 环境配置（shared/env.ts）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BACKEND_URL` | `http://127.0.0.1:3000` | Runner 回调目标 |
| `RUNNER_PORT` | `9377` | Runner 监听端口 |
| `INTERNAL_API_KEY` | - | `X-Internal-Token` 值 |
| `RECORD_HEADLESS` | `0` | 录制默认有头 |
| `RECORD_HEARTBEAT_INTERVAL` | `1` | 录制心跳间隔（秒） |
| `RECORD_VIEWPORT` | `1366,768` | 录制视口 |
| `RECORD_PAGE_LOAD_TIMEOUT_MS` | `60000` | 页面加载超时 |
| `DEBUG_POLL_INTERVAL` | `0.5` | 调试命令轮询间隔（秒） |
| `HEARTBEAT_INTERVAL` | `10` | 执行心跳间隔（秒） |

### 4.7 实现映射（需求 → 代码）

| 需求 | 实现文件 | 状态 |
|------|---------|------|
| FR-B1/B4/B5 生命周期+心跳+结构化 | `packages/runner/src/recording.ts`（`RecordingSession`） | 已实现 |
| FR-B2/B3 捕获+定位策略 | `packages/runner/src/recorder-script.ts`（`buildRecorderScript`） | 已实现 |
| FR-B7 交互调试 | `packages/runner/src/debug-session.ts`（`DebugSession`） | 已实现 |
| FR-A1~A4/A6/A8 AI 录制核心 | `packages/smartbrowser/src/agent-explorer.ts`（`UiMcpAgentExplorer`） | 已实现 |
| FR-A3/A10 事件流+会话观测 | `packages/web-ui/src/agent-runner.ts`（`AgentRunner`/`AgentSession`） | 已实现 |
| FR-A9/A1 API 层 | `packages/web-ui/src/routes/agent.routes.ts` | 已实现 |
| FR-C1 项目管理 | `packages/web-ui/src/routes/page.routes.ts` | 已实现 |
| 契约类型 | `packages/shared/src/types.ts` | 已实现 |
| FR-B6 视频录制 | `recording.ts` recordVideo | 已实现（报告关联待联调） |
| FR-A5 QA 模式 | `agent-explorer.ts` mode=qa | 已实现 |
| FR-A7 定位自愈 | `agent-explorer.ts` locator heal | 已实现 |
| FR-C2/C3 步骤编辑+参数化 | 前端编辑器 + `paramsSchema` | 待建设 |
| 3.3~3.5 前端界面 | 前端页面 | 待建设 |

---

## 5. 非功能需求

| 类别 | 需求 |
|------|------|
| 性能 | 心跳 1s 级实时性；SSE 事件端到端延迟 < 500ms；单机串行录制会话（同一 Runner 同时仅一个活跃录制） |
| 可靠性 | 停止/超时/异常三重兜底；回调失败重试；心跳超时失联判定；Agent 会话 GC（30 分钟空闲） |
| 安全 | 内部通道 `X-Internal-Token` 鉴权；LLM API Key 服务端存储不下发前端明文；录制数据不外传 |
| 资源 | 截图 LRU 缓存上限 10MB；事件环形缓冲 1000 条；会话结束即释放浏览器进程 |
| 兼容 | Chromium / Firefox / WebKit；录制默认有头模式（`RECORD_HEADLESS=0`） |
| 可观测 | Runner/Backend 双侧结构化日志（record_id/session_id 贯穿）；LLM 调用耗时与 token 统计 |

---

## 6. 优先级与里程碑

| 阶段 | 范围 | 内容 |
|------|------|------|
| M1（已完成） | Runner 录制内核 | FR-B1~B5、FR-B7：`recording.ts` + `recorder-script.ts` + `debug-session.ts` |
| M2（已完成） | AI 录制内核 | FR-A1~A4、A6~A9：`agent-explorer.ts` + `agent-runner.ts` + `agent.routes.ts` |
| M3 | 前端界面 | 3.3 创建分流、3.4 录制监控、3.5 AI 执行界面、3.7 空态错误反馈 |
| M4 | 产物闭环 | FR-A8 步骤转脚本落库、FR-C1 项目管理打通、FR-B6 视频关联报告 |
| M5 | 编辑增强 | FR-C2 步骤编辑校验、FR-C3 参数化、3.6 交互调试界面 |

---

## 附录 A：录制类型与需求文档对照

| 本文档 | 需求讨论文档 |
|--------|-------------|
| 2.1 浏览器录制 | 2.2 录制类型 → 浏览器录制；10.1 录制项目创建界面 |
| 2.2 AI 录制 | 2.2 录制类型 → AI录制；4.1 录制项目管理（type: ai） |
| 2.3 共用需求 | 4.1 PR-01~PR-06；10.2 任务参数化界面 |
| 4.4 AI 录制 API | 现有实现（需求文档 API 章节未覆盖，本文档补充） |
| 4.2/4.3 Runner API | 现有实现（需求文档 API 章节未覆盖，本文档补充） |

