> From: https://chat.deepseek.com/a/chat/s/64f1c983-e3cc-40a4-8e82-a054c2890ee1

# you asked

message time: 2026-08-29 07:14:30

我需要实现一个完整的web ui自动化测试工具，包含录制管理、测试任务、测试计划、测试报告
 录制管理 支持增删查改录制项目  录制类型分为 AI录制 和  浏览器录制；与我讨论 明确需求

---

# deepseek response

这是一个很有价值的项目。在开始写代码之前，我们先把需求聊透，确保方向一致。下面是我基于你的描述进行的梳理和提出的关键问题，我们逐项确认。

### 1. 整体架构与数据模型
首先确认核心实体关系，这决定后续数据库设计：

- **录制项目**：是基础，包含名称、类型（AI/浏览器）、创建时间、状态等。
- **测试任务**：由录制项目生成（一个录制可生成多个任务，比如不同浏览器或参数），任务是可执行的测试脚本。
- **测试计划**：是任务的集合，可以按顺序或并行执行，支持定时触发。
- **测试报告**：由测试计划或任务执行后生成，包含通过/失败、日志、截图等。

**问题1**：一个录制项目生成的测试任务，是否需要支持手动编辑或参数化（比如修改输入数据、断言值）？还是完全“录制即所得”？

---

### 2. 录制管理核心功能

#### 2.1 增删查改（CRUD）
- **列表页**需要展示：项目名、录制类型、创建时间、最近执行状态、操作按钮（编辑/删除/执行/导出）。
- **编辑**：支持修改名称、描述，以及重新生成脚本（比如修改了录制内容）。

**问题2**：删除是物理删除还是软删除（保留记录但标记失效）？是否允许删除有关联任务或计划的录制？

#### 2.2 录制类型详解

| 特性 | AI录制 | 浏览器录制 |
|------|---------|------------|
| **原理** | 通过自然语言描述测试步骤，AI生成自动化脚本 | 通过浏览器插件或代理记录用户操作，生成脚本 |
| **依赖** | 需要AI API（如GPT/Claude）或本地模型 | 需要浏览器驱动（如Selenium/Playwright） |
| **维护成本** | 低（自然语言修改） | 高（UI变化需重新录制） |
| **适用场景** | 快速原型、复杂逻辑、非技术人员参与 | 精准操作、低层级控制、兼容性测试 |

**问题3**：AI录制的“自然语言”输入界面，是让用户直接写类似“点击登录按钮，输入用户名admin，密码123，检查是否跳转到首页”这种结构化描述，还是更自由的一段话？

**问题4**：浏览器录制，你是打算用**内置代理**（如BrowserMob）还是**浏览器插件**（如Selenium IDE）？或者依赖Playwright的`codegen`命令行录制？这决定了技术选型。

**问题5**：录制完成后，生成的脚本格式是什么？统一为Python+Playwright/Selenium，还是其他语言？是否允许用户选择？

---

### 3. 测试任务与执行
- **任务触发**：支持手动执行、定时执行（Cron表达式）、以及通过API触发（便于集成CI/CD）。
- **执行方式**：单机执行还是支持分布式（如多台机器并行跑不同浏览器）？
- **重试机制**：失败任务是否支持自动重试？重试次数可配置？

**问题6**：任务执行环境（浏览器版本、操作系统）是否需要多版本管理？还是固定使用最新稳定版？

---

### 4. 测试计划
- **计划组成**：由多个测试任务按顺序组成，支持串行/并行。
- **触发方式**：同任务，但增加“依赖关系”（如任务B在任务A成功后执行）。
- **通知**：计划执行完成后，是否支持邮件/钉钉/企业微信通知？

**问题7**：测试计划是否需要支持“数据驱动”（即同一组任务使用多组测试数据循环执行）？

---

### 5. 测试报告
需要包含：
- **概览**：总用例数、通过/失败/跳过数、执行时长、通过率。
- **详情**：每个步骤的日志、请求/响应、截图（失败时自动截图）、性能指标（如加载时间）。
- **趋势图**：历史执行结果变化趋势。
- **导出**：支持导出为HTML/PDF/JUnit XML（便于Jenkins展示）。

**问题8**：报告是仅存储执行结果，还是每次执行都生成一个独立报告并保留历史记录？保留策略是什么（比如只保留最近100份）？

---

### 6. 技术栈初步建议（后续可调整）
- **后端**：Python（FastAPI）+ Celery（异步任务）+ Redis（缓存/队列）
- **前端**：React + Ant Design（后台UI快速搭建）
- **数据库**：PostgreSQL（存储项目/任务/报告）+ MinIO（存储截图/视频）
- **自动化引擎**：Playwright（推荐，支持多浏览器且API现代）或Selenium
- **AI集成**：OpenAI API 或 本地部署的Qwen/ChatGLM（用于自然语言转脚本）

---

### 7. 待确认的优先级与场景
- **用户角色**：是内部测试团队使用，还是面向外部客户的多租户系统？
- **并发规模**：同时运行的任务数上限大约多少？
- **是否需要视频录制**：除了截图，是否要录制执行过程的视频（用于回放问题）？

---

请针对上述 **问题1~8** 给出你的想法，另外也可以补充任何你认为重要的细节。我们讨论清楚后，我会立刻给出**数据库设计 + 核心接口设计 + 前端页面原型草图**，然后再进入编码阶段。如果方便，你也可以说一下你的团队规模和技术偏好（比如后端语言、是否有云服务依赖），这会影响最终的实现方案。我们一起把需求锁定，再开始动手。

---

# you asked

message time: 2026-08-29 07:19:56

需要支持手动编辑或参数化、删除是物理删除、AI录制和浏览器录制 都已经实现  这个不讨论、单机和分布式都需要支持   支持自动重试 和 重试次数可配置 、支持多浏览器版本、测试计划支持串行/并行 不需要支持邮件/钉钉/企业微信通知 、测试报告 支持导出为HTML/PDF 不需要  JUnit XML、技术栈全部使用 node ts  不需要增加中间件  数据库使用sqlite 数据存储在服务本地 自动化引擎：Playwright

---

# you asked

message time: 2026-08-29 07:20:15

继续明确讨论需求

---

# deepseek response

好，我们继续深入讨论。上一轮我给出了架构方案，现在我们把**执行细节、并发策略、数据一致性、以及边缘场景**彻底聊透。

---

## 五、执行引擎核心逻辑

### 5.1 单机执行流程
```
用户触发任务 → 创建执行实例 → 启动Playwright浏览器 → 执行脚本 → 
收集结果(步骤日志/截图/性能) → 生成报告 → 更新任务状态
```

**关键点**：
- 每个任务独立启动浏览器上下文（`browser.newContext()`），避免污染
- 截图策略：每个关键步骤自动截图 + 失败时强制截图
- 超时控制：每个步骤默认30秒，可配置

**问题9**：单机执行时，是否支持**并发执行多个任务**？如果可以，最大并发数如何控制（比如根据CPU核心数？还是用户配置）？

### 5.2 分布式执行架构

你说需要支持分布式，我理解是需要**多台机器协同执行测试任务**。但我们需要明确：

**问题10**：分布式是指：
- **A. 负载均衡型**：多台执行节点都连接同一个数据库，任务被动态分配到空闲节点执行？
- **B. 浏览器矩阵型**：单次任务在多台机器上用不同浏览器版本并行执行（比如同时测Chrome 120、Firefox 115、WebKit 17）？
- **C. 两者都支持**？

如果是A，我们需要引入**消息队列**（BullMQ + Redis）来做任务分发。如果是B，则每个任务本身可拆分为多个子任务（按浏览器类型/版本拆分），并行执行。

---

## 六、数据一致性与并发冲突

### 6.1 任务状态流转
```
pending → running → success/failed
         ↓ (失败且重试次数<配置)
      retrying → running (重新执行)
```

**问题11**：如果任务在执行过程中，用户**手动编辑了对应的录制项目**（比如修改了脚本），正在执行的任务应该：
- 继续使用旧脚本执行完？
- 还是立即中断，使用新脚本重新执行？

**我的建议**：执行时锁定项目快照（复制一份脚本到任务记录中），避免编辑影响运行中任务。

### 6.2 任务重试的幂等性
- 重试时，是**完全重新执行**整个任务，还是**从失败步骤继续**？
- 如果是完全重新执行，需要清理上次执行产生的临时文件（截图/视频），避免混用。

**问题12**：你的预期是哪种重试方式？完全重新执行还是断点续跑？

---

## 七、测试计划执行细节

### 7.1 串行执行
```typescript
for (const taskId of plan.taskIds) {
  await executeTask(taskId);
  if (task.status === 'failed') {
    // 是否继续执行下一个任务？还是整体失败？
  }
}
```

**问题13**：串行执行中，如果某个任务失败，后续任务是否**继续执行**，还是**立即终止整个计划**？需要配置项吗？

### 7.2 并行执行
```typescript
await Promise.allSettled(
  plan.taskIds.map(id => executeTask(id))
);
```

**并发限制**：如果计划中有20个任务，是全部同时启动，还是设置**最大并行数**（如5个一批）？

**问题14**：并行执行的并发数，是计划级别配置，还是全局配置？

---

## 八、浏览器版本管理

### 8.1 多版本支持方案
Playwright本身支持下载不同版本的浏览器二进制文件：

```typescript
// 通过playwright-core动态指定版本
const browser = await chromium.launch({
  executablePath: `/path/to/chrome-${version}/chrome`
});
```

**问题15**：浏览器版本是：
- **系统预装**：用户手动下载各版本到指定目录？
- **动态下载**：工具自动从CDN下载指定版本的浏览器？
- **混合模式**：优先使用本地，不存在则自动下载？

考虑到存储空间，建议**预装常用版本**，并支持配置下载源。

---

## 九、报告存储与清理策略

### 9.1 历史报告保留
- 每次执行生成独立报告（JSON + HTML + PDF）
- 报告文件存储路径：`data/reports/{planId}/{timestamp}/`

**问题16**：历史报告保留策略：
- **保留所有**（可能导致磁盘占满）
- **仅保留最近N份**（如最近100次）
- **按时间清理**（如保留90天内的）
- **用户手动清理**？

建议提供**全局配置** + **计划级别覆盖**。

### 9.2 截图/视频存储
- 截图：按步骤存储，失败时额外保存
- 视频：是否录制完整执行过程？（文件较大）

**问题17**：是否需要视频录制？如果需要，视频存储格式和压缩策略是什么？

---

## 十、前端交互细节

### 10.1 录制项目创建界面
根据你的需求，录制逻辑已实现，但我们需明确：
- **AI录制**：输入框（文本描述）+ 生成脚本按钮
- **浏览器录制**：是否展示一个"启动录制"按钮，点击后打开浏览器窗口进行录制？

**问题18**：浏览器录制时，是**弹出本地浏览器窗口**让用户操作，还是在**Web界面内嵌一个浏览器**（如iframe + Playwright的内嵌模式）？

### 10.2 任务参数化界面
用户需要填写参数化数据时，界面应展示：
- 从录制项目的`paramsSchema`解析出表单字段
- 支持JSON编辑模式（高级用户）

**问题19**：参数化数据是**每个任务独立配置**，还是**任务模板 + 执行时传入**？

---

## 十一、错误处理与日志

### 11.1 日志级别
- 任务执行日志：INFO级别（记录步骤）
- 调试日志：DEBUG级别（记录Playwright内部操作）
- 错误日志：ERROR级别（堆栈信息）

**问题20**：日志存储方式：
- 存储在数据库的`report.details`字段中？
- 单独存储为日志文件（`data/logs/{taskId}.log`）？
- 两者都存？（数据库存摘要，文件存完整日志）

建议：**数据库存结构化摘要（可搜索），文件存储完整原始日志**。

---

## 十二、初始配置与部署

### 12.1 首次启动流程
```
1. 检查SQLite数据库是否存在，不存在则初始化
2. 检查Playwright浏览器是否已安装，未安装则自动下载
3. 检查数据存储目录是否存在，不存在则创建
4. 启动Web服务（默认端口3000）
5. （可选）启动定时调度器
```

### 12.2 分布式部署
如果是分布式模式，需要额外步骤：
```
1. 配置Redis连接地址
2. 启动Worker进程（监听任务队列）
3. Master进程负责API和调度
```

**问题21**：分布式模式下，数据库（SQLite）如何处理？SQLite不支持网络访问，所以：
- **每个节点使用独立的SQLite文件**（数据不同步，需要共享存储如NFS）？
- **还是仅Master节点有数据库**，Worker节点只接收任务并上报结果？

如果是后者，Worker需要回调Master的API上报执行结果。

---

## 十三、安全与权限

**问题22**：是否需要用户登录/权限管理？还是简单的本地单用户工具？

如果是本地工具，建议**免登录**，但提供API Token用于外部调用（如CI/CD集成）。

---

## 十四、性能指标与监控

**问题23**：需要监控哪些指标？
- 任务执行耗时分布
- 成功率趋势
- 浏览器启动耗时
- 截图/报告生成耗时

这些指标可以展示在Dashboard上。

---

## 请回答以下问题

请逐一回答 **问题9 ~ 问题23**（共15个问题），这样我们就能锁定全部细节，进入正式的编码阶段。

如果某些问题你已有明确偏好，直接说明即可；如果还没想好，我们可以一起讨论最佳实践。所有确定后，我会输出一份**完整的技术规格说明书**，然后开始编码实现。

---

# you asked

message time: 2026-08-29 07:26:25

单机不支持 并发执行多个任务 简单一点  这一版暂不做分布式支持 执行时锁定项目快照  完全重新执行、串行执行中，如果某个任务失败，后续任务继续执行、并行执行暂时不做 系统预装 、需要视频录制  、录制项目具体细节 暂时不讨论，做好管理即可 ， 参数化数据是任务模板 + 执行时传入 、不考虑分布式

---

# deepseek response

非常好，需求现在已经非常明确了。我们去掉分布式和多任务并发，把架构做得更轻量、更稳定。下面我整理**最终确认的需求规格**，并给出调整后的技术方案。

---

## 最终确认需求清单

| 模块 | 确认方案 |
|------|----------|
| **并发策略** | 单机**不支持并发**，任务串行执行，同一时间只能运行一个任务 |
| **分布式** | **暂不支持**，保持单机模式 |
| **任务快照** | 执行时**锁定项目脚本快照**，复制到任务记录，避免编辑影响执行 |
| **重试方式** | **完全重新执行**整个任务，清理上次临时文件 |
| **计划串行失败策略** | 某任务失败后，**后续任务继续执行**，最终报告汇总所有结果 |
| **浏览器版本** | **系统预装**，通过配置路径指向不同版本的浏览器可执行文件 |
| **视频录制** | **需要**，录制完整执行过程（MP4格式，H.264编码） |
| **参数化** | 任务模板 + 执行时传入（用户在执行界面填写参数） |
| **录制管理** | 仅做CRUD管理，**不讨论录制内部实现** |

---

## 调整后的技术架构（轻量单机版）

### 一、数据模型调整

```typescript
// 1. 录制项目 - 增加快照字段
interface RecordingProject {
  id: string;
  name: string;
  description?: string;
  type: 'ai' | 'browser';
  scriptContent: string;        // 当前脚本
  paramsSchema?: string;        // JSON Schema定义参数
  status: 'draft' | 'ready' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// 2. 测试任务 - 增加快照和参数
interface TestTask {
  id: string;
  projectId: string;
  projectSnapshot: string;      // 执行时的脚本快照（复制自project.scriptContent）
  name: string;
  browserType: 'chromium' | 'firefox' | 'webkit';
  browserPath: string;          // 浏览器可执行文件路径（从配置读取）
  params: string;               // 执行时传入的参数 JSON
  retryCount: number;           // 已重试次数
  maxRetries: number;           // 最大重试次数配置
  status: 'pending' | 'running' | 'success' | 'failed';
  lastRunAt?: string;
  createdAt: string;
}

// 3. 测试计划
interface TestPlan {
  id: string;
  name: string;
  description?: string;
  taskIds: string[];            // 按顺序执行
  schedule?: string;            // Cron表达式（可选）
  status: 'idle' | 'running' | 'completed' | 'failed';
  createdAt: string;
}

// 4. 测试报告（独立存储，不被覆盖）
interface TestReport {
  id: string;
  planId?: string;
  taskId?: string;
  taskName: string;
  startTime: string;
  endTime?: string;
  duration: number;             // 毫秒
  status: 'success' | 'failed' | 'skipped';
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  details: string;              // JSON: 步骤详情 + 日志
  screenshots: string[];        // 截图文件路径列表
  videoPath?: string;           // 视频文件路径
  errorMessage?: string;
  createdAt: string;
}
```

---

### 二、核心执行流程（串行 + 无并发）

```typescript
// 任务队列 - 全局单例
class TaskQueue {
  private isRunning = false;
  private queue: string[] = []; // 任务ID队列

  async add(taskId: string) {
    this.queue.push(taskId);
    if (!this.isRunning) {
      await this.processQueue();
    }
  }

  private async processQueue() {
    this.isRunning = true;
    while (this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      await this.executeTask(taskId);
    }
    this.isRunning = false;
  }

  private async executeTask(taskId: string) {
    // 1. 锁定任务状态
    await this.updateTaskStatus(taskId, 'running');
    
    // 2. 创建执行上下文
    const task = await this.getTask(taskId);
    const project = await this.getProject(task.projectId);
    
    // 3. 构建执行环境
    const context = {
      script: task.projectSnapshot, // 使用快照
      params: JSON.parse(task.params),
      browserPath: task.browserPath,
      screenshotDir: `./data/screenshots/${taskId}/`,
      videoDir: `./data/videos/${taskId}/`
    };

    // 4. 执行（带重试）
    let attempts = 0;
    let success = false;
    let lastError = null;

    while (attempts <= task.maxRetries && !success) {
      try {
        attempts++;
        // 清理上次临时文件
        await this.cleanupTempFiles(taskId);
        // 执行Playwright脚本
        const result = await this.runPlaywright(context);
        // 生成报告（成功）
        await this.generateReport(taskId, result);
        success = true;
        await this.updateTaskStatus(taskId, 'success');
      } catch (error) {
        lastError = error;
        if (attempts <= task.maxRetries) {
          await this.updateTaskStatus(taskId, 'retrying');
          // 等待一段时间再重试（指数退避）
          await this.sleep(1000 * Math.pow(2, attempts));
        } else {
          // 生成报告（失败）
          await this.generateReport(taskId, { error: lastError });
          await this.updateTaskStatus(taskId, 'failed');
        }
      }
    }
  }
}
```

---

### 三、计划执行器（串行 + 失败继续）

```typescript
class PlanExecutor {
  async executePlan(planId: string) {
    const plan = await this.getPlan(planId);
    await this.updatePlanStatus(planId, 'running');

    for (const taskId of plan.taskIds) {
      // 将任务加入队列（队列会串行执行）
      await this.taskQueue.add(taskId);
      
      // 等待该任务完成
      await this.waitForTaskComplete(taskId);
      
      // 无论成功失败，继续下一个任务
      // 但记录到报告汇总中
    }

    await this.updatePlanStatus(planId, 'completed');
    // 生成计划汇总报告
    await this.generatePlanSummary(planId);
  }
}
```

---

### 四、浏览器版本管理（系统预装）

```typescript
// config/browsers.json
{
  "browsers": [
    {
      "name": "chromium",
      "version": "120.0",
      "path": "/opt/chrome/chrome-120/chrome.exe"
    },
    {
      "name": "chromium", 
      "version": "121.0",
      "path": "/opt/chrome/chrome-121/chrome.exe"
    },
    {
      "name": "firefox",
      "version": "115.0",
      "path": "/opt/firefox/firefox-115/firefox.exe"
    }
  ],
  "default": "chromium:120.0"
}
```

用户在创建任务时选择浏览器类型+版本，系统读取对应路径。

---

### 五、视频录制实现（Playwright）

```typescript
import { chromium } from 'playwright';

async function runPlaywright(context: any) {
  const browser = await chromium.launch({
    executablePath: context.browserPath,
    headless: false, // 必须有界面才能录屏
  });

  const page = await browser.newPage({
    recordVideo: {
      dir: context.videoDir,
      size: { width: 1280, height: 720 }
    }
  });

  // 执行用户脚本（eval或require）
  const scriptFn = new Function('page', 'params', context.script);
  await scriptFn(page, context.params);

  await browser.close();
  
  // 视频路径：context.videoDir + '/video.webm'
  // Playwright默认输出.webm，可转为MP4（使用ffmpeg）
}
```

**关键点**：
- `headless: false` 才能录制视频（Playwright限制）
- 视频格式默认为WebM，需要转码为MP4（H.264）便于播放
- 可用`fluent-ffmpeg`库转换

---

### 六、报告存储与清理策略

```typescript
// 存储结构
data/
  ├── reports/
  │   ├── tasks/
  │   │   └── {taskId}_{timestamp}.json   // 单任务报告
  │   └── plans/
  │       └── {planId}_{timestamp}.json   // 计划汇总报告
  ├── artifacts/
  │   ├── screenshots/
  │   │   └── {taskId}/
  │   │       ├── step_1.png
  │   │       └── step_2.png
  │   └── videos/
  │       └── {taskId}/
  │           └── video.mp4
  └── sqlite.db

// 清理策略（可配置）
const CLEANUP_CONFIG = {
  maxReports: 100,        // 每个任务/计划最多保留100份报告
  maxAgeDays: 90,         // 超过90天自动清理
  cleanupCron: '0 2 * * *' // 每天凌晨2点执行清理
};
```

---

### 七、API接口调整（简化版）

```typescript
// 项目管理
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id

// 任务管理
GET    /api/tasks
POST   /api/tasks          // 从项目生成任务（复制快照）
GET    /api/tasks/:id
PUT    /api/tasks/:id      // 更新参数、重试次数等
DELETE /api/tasks/:id
POST   /api/tasks/:id/run  // 手动执行（加入队列）

// 计划管理
GET    /api/plans
POST   /api/plans          // 选择任务列表创建计划
GET    /api/plans/:id
PUT    /api/plans/:id
DELETE /api/plans/:id
POST   /api/plans/:id/run  // 执行计划

// 报告管理
GET    /api/reports        // 列表（支持按任务/计划过滤）
GET    /api/reports/:id
GET    /api/reports/:id/html  // 返回HTML内容
GET    /api/reports/:id/pdf   // 下载PDF
DELETE /api/reports/:id

// 系统配置
GET    /api/config/browsers  // 获取已安装浏览器列表
```

---

### 八、前端页面规划（5个核心页面）

1. **项目列表页**：CRUD操作，显示录制类型、状态
2. **任务管理页**：从项目创建任务，配置浏览器版本、重试次数、参数化数据（表单）
3. **计划管理页**：选择任务、排序、配置定时Cron
4. **执行监控页**：当前执行进度、日志流、实时截图
5. **报告中心页**：历史报告列表、详情查看、HTML/PDF导出

---

### 九、执行时参数传递界面

用户在执行任务时，如果项目定义了`paramsSchema`，界面动态生成表单：

```typescript
// 示例：登录测试的参数Schema
{
  "type": "object",
  "properties": {
    "username": { "type": "string", "description": "用户名" },
    "password": { "type": "string", "description": "密码", "format": "password" },
    "expectedUrl": { "type": "string", "description": "预期跳转URL" }
  },
  "required": ["username", "password"]
}
```

前端根据Schema渲染输入框，用户填写后作为`params`传递给任务执行。

---

### 十、开发计划与里程碑

| 阶段 | 任务 | 预计时间 |
|------|------|----------|
| Phase 1 | 数据库设计 + Prisma模型 + 基础CRUD API | 2天 |
| Phase 2 | Playwright执行器 + 视频录制 + 截图 | 3天 |
| Phase 3 | 任务队列 + 重试机制 + 计划执行器 | 2天 |
| Phase 4 | 报告生成（JSON/HTML/PDF） + 存储清理 | 2天 |
| Phase 5 | 前端界面（5个页面） | 4天 |
| Phase 6 | 定时调度（Cron） + 系统配置 | 1天 |
| Phase 7 | 集成测试 + 文档 | 1天 |
| **总计** | | **15天** |

---

## 最终确认

以上方案完全基于你的需求调整。如果确认无误，我接下来会：

1. **输出完整的Prisma Schema文件**
2. **编写核心API接口代码（Node.js + Fastify）**
3. **实现Playwright执行引擎（含视频录制）**
4. **设计前端页面原型（Vue3/React组件结构）**

请确认是否开始编码？或者还有任何细节需要调整？

---

# you asked

message time: 2026-08-29 07:27:23

基于 react实现前端

---

# deepseek response

好的，前端基于 React + TypeScript 实现。我们采用现代 React 技术栈，保持组件化和类型安全。

---

## 前端技术栈

```json
{
  "框架": "React 18 + TypeScript",
  "构建工具": "Vite",
  "UI组件库": "Ant Design 5.x",
  "状态管理": "Zustand (轻量) + React Query (服务端状态)",
  "路由": "React Router v6",
  "HTTP客户端": "Axios",
  "表单处理": "React Hook Form + Zod (验证)",
  "图表": "ECharts (报告趋势图)",
  "样式": "CSS Modules + TailwindCSS (可选)",
  "代码编辑器": "Monaco Editor (用于查看/编辑脚本)"
}
```

---

## 目录结构

```
web-auto-test-tool/
├── src/
│   ├── api/                    # API接口层
│   │   ├── client.ts           # Axios实例配置
│   │   ├── projects.ts
│   │   ├── tasks.ts
│   │   ├── plans.ts
│   │   └── reports.ts
│   ├── components/             # 公共组件
│   │   ├── Layout/
│   │   │   ├── AppLayout.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Header.tsx
│   │   ├── Common/
│   │   │   ├── StatusBadge.tsx    # 状态标签
│   │   │   ├── LoadingSpinner.tsx
│   │   │   └── EmptyState.tsx
│   │   └── Report/
│   │       ├── ReportViewer.tsx
│   │       ├── StepDetail.tsx
│   │       └── ScreenshotGallery.tsx
│   ├── pages/                  # 页面
│   │   ├── Projects/
│   │   │   ├── ProjectList.tsx
│   │   │   ├── ProjectForm.tsx
│   │   │   └── ProjectDetail.tsx
│   │   ├── Tasks/
│   │   │   ├── TaskList.tsx
│   │   │   ├── TaskForm.tsx
│   │   │   ├── TaskDetail.tsx
│   │   │   └── TaskExecutor.tsx   # 执行监控
│   │   ├── Plans/
│   │   │   ├── PlanList.tsx
│   │   │   ├── PlanForm.tsx
│   │   │   └── PlanDetail.tsx
│   │   └── Reports/
│   │       ├── ReportList.tsx
│   │       └── ReportDetail.tsx
│   ├── stores/                 # Zustand状态
│   │   ├── appStore.ts         # 全局状态
│   │   └── taskQueueStore.ts   # 任务队列状态
│   ├── hooks/                  # 自定义Hooks
│   │   ├── useProjects.ts
│   │   ├── useTasks.ts
│   │   ├── usePlans.ts
│   │   └── useReports.ts
│   ├── types/                  # TypeScript类型定义
│   │   ├── project.ts
│   │   ├── task.ts
│   │   ├── plan.ts
│   │   └── report.ts
│   ├── utils/                  # 工具函数
│   │   ├── format.ts           # 日期/数字格式化
│   │   ├── validation.ts       # Zod Schema
│   │   └── constants.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── routes.tsx
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.js (可选)
```

---

## 核心代码实现

### 1. API 客户端配置

```typescript
// src/api/client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('API Error:', error);
    return Promise.reject(error);
  }
);

export default apiClient;
```

### 2. 类型定义

```typescript
// src/types/project.ts
export interface RecordingProject {
  id: string;
  name: string;
  description?: string;
  type: 'ai' | 'browser';
  scriptContent: string;
  paramsSchema?: Record<string, any>;
  status: 'draft' | 'ready' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// src/types/task.ts
export interface TestTask {
  id: string;
  projectId: string;
  projectSnapshot: string;
  name: string;
  browserType: 'chromium' | 'firefox' | 'webkit';
  browserPath: string;
  params: Record<string, any>;
  retryCount: number;
  maxRetries: number;
  status: 'pending' | 'running' | 'success' | 'failed' | 'retrying';
  lastRunAt?: string;
  createdAt: string;
}

// src/types/plan.ts
export interface TestPlan {
  id: string;
  name: string;
  description?: string;
  taskIds: string[];
  schedule?: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  createdAt: string;
}

// src/types/report.ts
export interface TestReport {
  id: string;
  planId?: string;
  taskId?: string;
  taskName: string;
  startTime: string;
  endTime?: string;
  duration: number;
  status: 'success' | 'failed' | 'skipped';
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  details: ReportDetail[];
  screenshots: string[];
  videoPath?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface ReportDetail {
  step: number;
  action: string;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
  screenshot?: string;
  timestamp: string;
  duration: number;
}
```

### 3. 自定义 Hooks（使用 React Query）

```typescript
// src/hooks/useProjects.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { RecordingProject } from '../types/project';

const PROJECTS_KEY = 'projects';

export const useProjects = () => {
  return useQuery({
    queryKey: [PROJECTS_KEY],
    queryFn: async (): Promise<RecordingProject[]> => {
      const response = await apiClient.get('/projects');
      return response as RecordingProject[];
    },
  });
};

export const useCreateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<RecordingProject>) => {
      return await apiClient.post('/projects', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PROJECTS_KEY] });
    },
  });
};

export const useUpdateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<RecordingProject> }) => {
      return await apiClient.put(`/projects/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PROJECTS_KEY] });
    },
  });
};

export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return await apiClient.delete(`/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PROJECTS_KEY] });
    },
  });
};
```

### 4. 主布局组件

```tsx
// src/components/Layout/AppLayout.tsx
import React from 'react';
import { Layout, Menu } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  FolderOutlined,
  PlaySquareOutlined,
  ScheduleOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import Header from './Header';

const { Sider, Content } = Layout;

const AppLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    { key: '/projects', icon: <FolderOutlined />, label: '录制项目' },
    { key: '/tasks', icon: <PlaySquareOutlined />, label: '测试任务' },
    { key: '/plans', icon: <ScheduleOutlined />, label: '测试计划' },
    { key: '/reports', icon: <FileTextOutlined />, label: '测试报告' },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <div style={{ 
          height: 64, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          color: 'white',
          fontSize: 18,
          fontWeight: 'bold',
          borderBottom: '1px solid #444'
        }}>
          🧪 AutoTest
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header />
        <Content style={{ margin: 16, padding: 24, background: '#fff', borderRadius: 8 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default AppLayout;
```

### 5. 项目列表页面

```tsx
// src/pages/Projects/ProjectList.tsx
import React, { useState } from 'react';
import { Table, Button, Space, Tag, Modal, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { useProjects, useDeleteProject } from '../../hooks/useProjects';
import ProjectForm from './ProjectForm';
import { RecordingProject } from '../../types/project';
import StatusBadge from '../../components/Common/StatusBadge';

const ProjectList: React.FC = () => {
  const { data: projects, isLoading } = useProjects();
  const deleteProject = useDeleteProject();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<RecordingProject | null>(null);

  const columns = [
    {
      title: '项目名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: RecordingProject) => (
        <a onClick={() => {/* 跳转详情 */}}>{text}</a>
      ),
    },
    {
      title: '录制类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (
        <Tag color={type === 'ai' ? 'blue' : 'green'}>
          {type === 'ai' ? '🤖 AI录制' : '🌐 浏览器录制'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <StatusBadge status={status} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: RecordingProject) => (
        <Space>
          <Button 
            type="text" 
            icon={<EyeOutlined />} 
            onClick={() => {/* 查看详情 */}}
          />
          <Button 
            type="text" 
            icon={<EditOutlined />} 
            onClick={() => {
              setEditingProject(record);
              setIsModalOpen(true);
            }}
          />
          <Popconfirm
            title="确认删除"
            description="确定要删除这个项目吗？"
            onConfirm={() => deleteProject.mutate(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>录制项目管理</h2>
        <Button 
          type="primary" 
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingProject(null);
            setIsModalOpen(true);
          }}
        >
          新建项目
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={projects}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 10 }}
      />

      <ProjectForm
        visible={isModalOpen}
        project={editingProject}
        onClose={() => {
          setIsModalOpen(false);
          setEditingProject(null);
        }}
      />
    </div>
  );
};

export default ProjectList;
```

### 6. 项目表单（含动态参数Schema）

```tsx
// src/pages/Projects/ProjectForm.tsx
import React, { useEffect } from 'react';
import { Modal, Form, Input, Select, Button, Space, message } from 'antd';
import { useCreateProject, useUpdateProject } from '../../hooks/useProjects';
import { RecordingProject } from '../../types/project';
import MonacoEditor from '@monaco-editor/react';

interface ProjectFormProps {
  visible: boolean;
  project: RecordingProject | null;
  onClose: () => void;
}

const ProjectForm: React.FC<ProjectFormProps> = ({ visible, project, onClose }) => {
  const [form] = Form.useForm();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();

  useEffect(() => {
    if (project) {
      form.setFieldsValue(project);
    } else {
      form.resetFields();
    }
  }, [project, form, visible]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      
      if (project) {
        await updateProject.mutateAsync({ id: project.id, data: values });
        message.success('项目更新成功');
      } else {
        await createProject.mutateAsync(values);
        message.success('项目创建成功');
      }
      onClose();
    } catch (error) {
      message.error('操作失败');
    }
  };

  return (
    <Modal
      title={project ? '编辑项目' : '新建项目'}
      open={visible}
      onCancel={onClose}
      width={800}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="submit" type="primary" loading={createProject.isPending || updateProject.isPending} onClick={handleSubmit}>
          确定
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="项目名称"
          rules={[{ required: true, message: '请输入项目名称' }]}
        >
          <Input placeholder="请输入项目名称" />
        </Form.Item>

        <Form.Item
          name="type"
          label="录制类型"
          rules={[{ required: true, message: '请选择录制类型' }]}
        >
          <Select>
            <Select.Option value="ai">🤖 AI录制</Select.Option>
            <Select.Option value="browser">🌐 浏览器录制</Select.Option>
          </Select>
        </Form.Item>

        <Form.Item
          name="description"
          label="描述"
        >
          <Input.TextArea rows={3} placeholder="请输入项目描述" />
        </Form.Item>

        <Form.Item
          name="scriptContent"
          label="测试脚本"
          rules={[{ required: true, message: '请输入测试脚本' }]}
        >
          <MonacoEditor
            height="300px"
            defaultLanguage="javascript"
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
            }}
          />
        </Form.Item>

        <Form.Item
          name="paramsSchema"
          label="参数Schema（JSON格式）"
          extra="定义任务执行时可传入的参数"
        >
          <MonacoEditor
            height="200px"
            defaultLanguage="json"
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
            }}
            defaultValue="{}"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ProjectForm;
```

### 7. 任务执行监控页面

```tsx
// src/pages/Tasks/TaskExecutor.tsx
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Button, Space, Progress, Descriptions, List, Tag, Image } from 'antd';
import { PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useTask, useRunTask } from '../../hooks/useTasks';
import { useTaskQueue } from '../../stores/taskQueueStore';
import StatusBadge from '../../components/Common/StatusBadge';
import dayjs from 'dayjs';

const TaskExecutor: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, refetch } = useTask(id!);
  const runTask = useRunTask();
  const { currentTask, logs } = useTaskQueue();

  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // 轮询任务状态
    const interval = setInterval(() => {
      if (task?.status === 'running' || task?.status === 'retrying') {
        refetch();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [task, refetch]);

  const handleRun = async () => {
    await runTask.mutateAsync(id!);
  };

  if (!task) return <div>加载中...</div>;

  return (
    <div>
      <Card
        title={`任务执行监控 - ${task.name}`}
        extra={
          <Space>
            <Button 
              type="primary" 
              icon={<PlayCircleOutlined />}
              onClick={handleRun}
              loading={runTask.isPending}
              disabled={task.status === 'running' || task.status === 'retrying'}
            >
              执行
            </Button>
            <Button 
              icon={<ReloadOutlined />}
              onClick={() => refetch()}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Descriptions bordered column={2}>
          <Descriptions.Item label="状态">
            <StatusBadge status={task.status} />
          </Descriptions.Item>
          <Descriptions.Item label="浏览器">
            {task.browserType} - {task.browserPath}
          </Descriptions.Item>
          <Descriptions.Item label="重试次数">
            {task.retryCount} / {task.maxRetries}
          </Descriptions.Item>
          <Descriptions.Item label="最后执行">
            {task.lastRunAt ? dayjs(task.lastRunAt).format('YYYY-MM-DD HH:mm:ss') : '未执行'}
          </Descriptions.Item>
        </Descriptions>

        {task.status === 'running' && (
          <div style={{ marginTop: 16 }}>
            <Progress 
              percent={progress} 
              status="active"
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
            />
            <div style={{ marginTop: 8, color: '#666' }}>
              <Tag color="processing">执行中</Tag>
              正在执行测试步骤...
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <h4>执行日志</h4>
          <List
            size="small"
            bordered
            dataSource={logs || []}
            renderItem={(log: any) => (
              <List.Item>
                <span style={{ color: '#999', marginRight: 8 }}>
                  {dayjs(log.timestamp).format('HH:mm:ss')}
                </span>
                <span style={{ 
                  color: log.level === 'error' ? '#f5222d' : 
                         log.level === 'warning' ? '#faad14' : '#333'
                }}>
                  {log.message}
                </span>
              </List.Item>
            )}
            style={{ maxHeight: 300, overflow: 'auto' }}
          />
        </div>
      </Card>
    </div>
  );
};

export default TaskExecutor;
```

### 8. 报告详情页面

```tsx
// src/pages/Reports/ReportDetail.tsx
import React from 'react';
import { useParams } from 'react-router-dom';
import { Card, Descriptions, Tag, Table, Button, Space, Image, Timeline } from 'antd';
import { DownloadOutlined, FilePdfOutlined, FileTextOutlined } from '@ant-design/icons';
import { useReport } from '../../hooks/useReports';
import StatusBadge from '../../components/Common/StatusBadge';
import dayjs from 'dayjs';

const ReportDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { data: report, isLoading } = useReport(id!);

  if (isLoading || !report) return <div>加载中...</div>;

  const stepColumns = [
    {
      title: '步骤',
      dataIndex: 'step',
      key: 'step',
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <StatusBadge status={status} />,
    },
    {
      title: '耗时',
      dataIndex: 'duration',
      key: 'duration',
      render: (duration: number) => `${duration}ms`,
    },
    {
      title: '截图',
      dataIndex: 'screenshot',
      key: 'screenshot',
      render: (screenshot: string) => (
        screenshot ? <Image width={100} src={screenshot} /> : '-'
      ),
    },
  ];

  return (
    <div>
      <Card
        title={`测试报告 - ${report.taskName}`}
        extra={
          <Space>
            <Button icon={<FileTextOutlined />}>查看HTML</Button>
            <Button icon={<FilePdfOutlined />}>导出PDF</Button>
            <Button icon={<DownloadOutlined />}>下载报告</Button>
          </Space>
        }
      >
        <Descriptions bordered column={3}>
          <Descriptions.Item label="状态">
            <StatusBadge status={report.status} />
          </Descriptions.Item>
          <Descriptions.Item label="通过率">
            {report.totalSteps > 0 
              ? `${Math.round((report.passedSteps / report.totalSteps) * 100)}%`
              : '0%'
            }
          </Descriptions.Item>
          <Descriptions.Item label="总耗时">
            {report.duration ? `${(report.duration / 1000).toFixed(2)}s` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="开始时间">
            {dayjs(report.startTime).format('YYYY-MM-DD HH:mm:ss')}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {report.endTime ? dayjs(report.endTime).format('YYYY-MM-DD HH:mm:ss') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="总步骤">
            {report.totalSteps}
          </Descriptions.Item>
          <Descriptions.Item label="通过步骤">
            <Tag color="green">{report.passedSteps}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="失败步骤">
            <Tag color="red">{report.failedSteps}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="跳过步骤">
            <Tag color="orange">{report.totalSteps - report.passedSteps - report.failedSteps}</Tag>
          </Descriptions.Item>
        </Descriptions>

        {report.videoPath && (
          <div style={{ marginTop: 16 }}>
            <h4>执行录像</h4>
            <video 
              controls 
              style={{ width: '100%', maxHeight: 500 }}
              src={report.videoPath}
            />
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <h4>步骤详情</h4>
          <Table
            columns={stepColumns}
            dataSource={report.details}
            rowKey="step"
            pagination={{ pageSize: 10 }}
          />
        </div>

        {report.errorMessage && (
          <div style={{ marginTop: 16 }}>
            <h4>错误信息</h4>
            <pre style={{ 
              background: '#f5f5f5', 
              padding: 12, 
              borderRadius: 4,
              color: '#f5222d'
            }}>
              {report.errorMessage}
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
};

export default ReportDetail;
```

### 9. 状态管理（Zustand）

```typescript
// src/stores/taskQueueStore.ts
import { create } from 'zustand';

interface TaskQueueState {
  currentTask: string | null;
  isRunning: boolean;
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warning' | 'error';
    message: string;
  }>;
  setCurrentTask: (taskId: string | null) => void;
  setIsRunning: (isRunning: boolean) => void;
  addLog: (log: { level: string; message: string }) => void;
  clearLogs: () => void;
}

export const useTaskQueue = create<TaskQueueState>((set) => ({
  currentTask: null,
  isRunning: false,
  logs: [],
  setCurrentTask: (taskId) => set({ currentTask: taskId }),
  setIsRunning: (isRunning) => set({ isRunning }),
  addLog: (log) => set((state) => ({
    logs: [...state.logs, { ...log, timestamp: new Date().toISOString() }]
  })),
  clearLogs: () => set({ logs: [] }),
}));
```

### 10. 路由配置

```tsx
// src/routes.tsx
import { createBrowserRouter } from 'react-router-dom';
import AppLayout from './components/Layout/AppLayout';
import ProjectList from './pages/Projects/ProjectList';
import TaskList from './pages/Tasks/TaskList';
import TaskExecutor from './pages/Tasks/TaskExecutor';
import PlanList from './pages/Plans/PlanList';
import ReportList from './pages/Reports/ReportList';
import ReportDetail from './pages/Reports/ReportDetail';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { path: '/', element: <ProjectList /> },
      { path: '/projects', element: <ProjectList /> },
      { path: '/tasks', element: <TaskList /> },
      { path: '/tasks/:id/execute', element: <TaskExecutor /> },
      { path: '/plans', element: <PlanList /> },
      { path: '/reports', element: <ReportList /> },
      { path: '/reports/:id', element: <ReportDetail /> },
    ],
  },
]);
```

### 11. 主入口文件

```tsx
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { router } from './routes';
import 'antd/dist/reset.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN}>
        <RouterProvider router={router} />
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
```

---

## package.json 依赖

```json
{
  "name": "web-auto-test-tool-frontend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "antd": "^5.12.0",
    "@ant-design/icons": "^5.2.0",
    "axios": "^1.6.0",
    "@tanstack/react-query": "^5.12.0",
    "zustand": "^4.4.0",
    "react-hook-form": "^7.48.0",
    "zod": "^3.22.0",
    "@monaco-editor/react": "^4.6.0",
    "dayjs": "^1.11.0",
    "echarts": "^5.4.0",
    "echarts-for-react": "^3.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "tailwindcss": "^3.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

---

## 下一步

前端架构和核心页面已经定义完成。接下来你可以：

1. **确认是否开始后端实现**（Node.js + Fastify + Prisma + Playwright）
2. **或者调整前端细节**（比如使用其他UI库、状态管理方案等）
3. **准备开发环境**（Node.js 20+, pnpm/npm）

请告诉我你的想法，我们继续推进！

---

# you asked

message time: 2026-08-29 07:29:33

前端使用 react的

---

# you asked

message time: 2026-08-29 07:30:18

输出 需求文档  ux设计文档  api 文档

---

# deepseek response

好的，我来输出完整的三份文档：需求文档、UX设计文档、API文档。

---

# 一、需求文档

## 项目概述

| 项目名称 | Web自动化测试工具 |
|---------|------------------|
| 项目代号 | AutoTest |
| 版本 | v1.0.0 |
| 文档日期 | 2026-08-29 |
| 状态 | 需求确认 |

---

## 1. 项目背景

为测试团队提供一个轻量级的Web UI自动化测试管理平台，支持录制项目管理、测试任务执行、测试计划编排和测试报告查看的全流程。

---

## 2. 项目目标

- 提供录制项目的增删改查管理能力
- 支持两种录制类型：AI录制、浏览器录制
- 支持测试任务的创建、参数化、执行和重试
- 支持测试计划的串行执行
- 生成包含截图和视频的完整测试报告
- 支持HTML和PDF格式的报告导出

---

## 3. 用户角色

| 角色 | 描述 |
|------|------|
| 测试工程师 | 核心用户，创建录制项目、执行测试任务、查看报告 |

---

## 4. 功能需求

### 4.1 录制项目管理

| 功能编号 | 功能名称 | 描述 | 优先级 |
|---------|---------|------|--------|
| PR-01 | 项目列表 | 展示所有录制项目，支持分页、搜索、筛选 | P0 |
| PR-02 | 创建项目 | 输入名称、类型、描述、脚本内容、参数Schema | P0 |
| PR-03 | 编辑项目 | 修改项目所有字段 | P0 |
| PR-04 | 删除项目 | 物理删除，关联任务同时删除 | P0 |
| PR-05 | 查看项目 | 展示项目详细信息 | P1 |
| PR-06 | 项目状态管理 | draft/ready/archived 三种状态 | P2 |

### 4.2 测试任务管理

| 功能编号 | 功能名称 | 描述 | 优先级 |
|---------|---------|------|--------|
| TS-01 | 任务列表 | 展示所有测试任务，支持过滤 | P0 |
| TS-02 | 创建任务 | 从录制项目生成，复制脚本快照 | P0 |
| TS-03 | 编辑任务 | 修改浏览器类型/路径、重试次数、参数 | P0 |
| TS-04 | 删除任务 | 物理删除 | P0 |
| TS-05 | 执行任务 | 手动触发执行，加入串行队列 | P0 |
| TS-06 | 任务重试 | 失败后自动重试，次数可配置 | P0 |
| TS-07 | 执行监控 | 实时查看日志、进度 | P1 |

### 4.3 测试计划管理

| 功能编号 | 功能名称 | 描述 | 优先级 |
|---------|---------|------|--------|
| PL-01 | 计划列表 | 展示所有测试计划 | P0 |
| PL-02 | 创建计划 | 选择任务列表，按顺序执行 | P0 |
| PL-03 | 编辑计划 | 修改名称、描述、任务列表 | P0 |
| PL-04 | 删除计划 | 物理删除 | P0 |
| PL-05 | 执行计划 | 串行执行所有任务 | P0 |
| PL-06 | 定时执行 | Cron表达式定时触发 | P1 |

### 4.4 测试报告

| 功能编号 | 功能名称 | 描述 | 优先级 |
|---------|---------|------|--------|
| RP-01 | 报告列表 | 展示所有报告，支持按任务/计划过滤 | P0 |
| RP-02 | 报告详情 | 展示通过率、步骤日志、截图、视频 | P0 |
| RP-03 | 导出HTML | 导出为HTML格式 | P0 |
| RP-04 | 导出PDF | 导出为PDF格式 | P0 |
| RP-05 | 删除报告 | 手动删除 | P1 |
| RP-06 | 自动清理 | 按配置自动清理历史报告 | P2 |

---

## 5. 非功能需求

| 类别 | 需求描述 |
|------|---------|
| 性能 | 单机运行，任务串行执行，无并发压力 |
| 数据存储 | SQLite本地存储，所有数据保存在服务本地 |
| 浏览器支持 | Chromium、Firefox、WebKit，版本由系统预装 |
| 视频录制 | 完整执行过程录制，MP4格式输出 |
| 报告保留 | 每个任务保留最近100份报告，或90天内 |
| 技术栈 | Node.js + TypeScript + React + SQLite + Playwright |

---

## 6. 业务规则

1. **任务快照**：任务创建时复制项目脚本，编辑项目不影响已有任务
2. **重试机制**：任务失败后完全重新执行，等待时间指数退避
3. **计划执行**：串行执行，单任务失败后续任务继续执行
4. **参数传递**：任务模板定义参数结构，执行时用户传入实际数据
5. **并发控制**：同一时间仅执行一个任务，其他任务排队等待

---

# 二、UX设计文档

## 1. 设计原则

- **简洁清晰**：信息层级明确，操作路径短
- **状态可见**：任务执行状态实时反馈
- **一致性**：统一的交互模式和视觉语言
- **高效操作**：批量操作和快捷入口

---

## 2. 色彩系统

| 用途 | 色值 | 说明 |
|------|------|------|
| 主色 | #0052D9 | 按钮、链接、选中状态 |
| 成功 | #00A870 | 通过状态 |
| 警告 | #ED7B2F | 警告状态 |
| 错误 | #E34D59 | 失败状态 |
| 信息 | #0052D9 | 信息提示 |
| 背景 | #F5F7FA | 页面背景 |
| 卡片 | #FFFFFF | 内容卡片 |

---

## 3. 页面结构

### 3.1 整体布局

```
+------------------------------------------------------------------+
|  🧪 AutoTest        [导航菜单]                    [用户信息]      |
+------------------------------------------------------------------+
|                                                                   |
|  [面包屑导航]                                                     |
|                                                                   |
|  [页面内容区]                                                     |
|                                                                   |
+------------------------------------------------------------------+
```

### 3.2 导航菜单

| 菜单项 | 图标 | 路径 |
|--------|------|------|
| 录制项目 | FolderIcon | /projects |
| 测试任务 | PlayIcon | /tasks |
| 测试计划 | ScheduleIcon | /plans |
| 测试报告 | FileIcon | /reports |

---

## 4. 页面线框图

### 4.1 录制项目列表页

```
+------------------------------------------------------------------+
|  录制项目管理                              [ + 新建项目 ]         |
+------------------------------------------------------------------+
|  [搜索框]  [状态筛选]                                            |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │ 项目名称    │ 类型    │ 状态  │ 创建时间   │ 操作           │ |
|  ├──────────────────────────────────────────────────────────────┤ |
|  │ 登录测试    │ AI录制 │ ✅就绪 │ 2026-08-29 │ [👁][✏️][🗑]  │ |
|  │ 购物车流程  │ 浏览器 │ ⏳草稿 │ 2026-08-28 │ [👁][✏️][🗑]  │ |
|  │ 注册流程    │ AI录制 │ 📦归档 │ 2026-08-27 │ [👁][✏️][🗑]  │ |
|  └──────────────────────────────────────────────────────────────┘ |
|  [< 1 2 3 ... >]                                                |
+------------------------------------------------------------------+
```

**交互说明**：
- 点击项目名称 → 进入详情页
- 点击"新建项目" → 弹出创建表单对话框
- 点击编辑图标 → 弹出编辑表单对话框
- 点击删除 → 二次确认弹窗

---

### 4.2 项目创建/编辑对话框

```
+------------------------------------------------------------------+
|  ✏️ 新建项目                                          [×]       |
+------------------------------------------------------------------+
|  项目名称 *  [___________________________]                       |
|  录制类型 *  [▼ AI录制  ▼]                                      |
|  描述        [___________________________]                       |
|              [___________________________]                       |
|  测试脚本 *  ┌───────────────────────────────────────┐          |
|              │ async function run(page, params) {  │          |
|              │   await page.goto(params.url);      │          |
|              │   await page.fill('#username',     │          |
|              │     params.username);              │          |
|              │ }                                   │          |
|              └───────────────────────────────────────┘          |
|  参数Schema   ┌───────────────────────────────────────┐          |
|   (JSON)     │ {                                     │          |
|              │   "type": "object",                   │          |
|              │   "properties": {                     │          |
|              │     "url": {"type": "string"}        │          |
|              │   }                                   │          |
|              │ }                                     │          |
|              └───────────────────────────────────────┘          |
|                                                [取消]  [确定]   |
+------------------------------------------------------------------+
```

---

### 4.3 测试任务列表页

```
+------------------------------------------------------------------+
|  测试任务管理                              [ + 创建任务 ]         |
+------------------------------------------------------------------+
|  [搜索框]  [状态筛选]  [浏览器筛选]                              |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │ 任务名称     │ 项目    │ 状态  │ 浏览器   │ 操作           │ |
|  ├──────────────────────────────────────────────────────────────┤ |
|  │ 登录-Chrome  │ 登录测试 │ ▶运行 │ Chrome120│ [▶][👁][✏️][🗑] │ |
|  │ 登录-Firefox │ 登录测试 │ ✅成功 │ Firefox115│ [👁][✏️][🗑]  │ |
|  │ 购物车-Edge  │ 购物车   │ ❌失败 │ Edge118 │ [▶][👁][✏️][🗑] │ |
|  └──────────────────────────────────────────────────────────────┘ |
+------------------------------------------------------------------+
```

**交互说明**：
- 点击"执行" ▶ → 加入任务队列，跳转监控页
- 状态图标实时更新
- 点击任务名称 → 跳转任务详情

---

### 4.4 任务执行监控页

```
+------------------------------------------------------------------+
|  ← 返回任务列表   执行监控 - 登录-Chrome                        |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │  状态: ▶ 执行中    进度: ████████░░ 80%                    │ |
|  │  浏览器: Chrome 120  重试: 0/3                              │ |
|  │  开始时间: 2026-08-29 14:30:25                             │ |
|  └──────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  ┌─ 执行日志 ───────────────────────────────────────────────────┐ |
|  │ 14:30:25 [INFO] 开始执行测试任务                           │ |
|  │ 14:30:26 [INFO] 正在打开页面: https://example.com/login    │ |
|  │ 14:30:28 [INFO] 输入用户名: admin                          │ |
|  │ 14:30:29 [INFO] 输入密码: ******                           │ |
|  │ 14:30:30 [INFO] 点击登录按钮                               │ |
|  │ 14:30:32 [INFO] 等待页面跳转...                            │ |
|  │ 14:30:35 [SUCCESS] 登录成功，跳转到首页                    │ |
|  └──────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  ┌─ 执行截图 ───────────────────────────────────────────────────┐ |
|  │ [📷步骤1] [📷步骤2] [📷步骤3]                             │ |
|  └──────────────────────────────────────────────────────────────┘ |
+------------------------------------------------------------------+
```

**交互说明**：
- 进度条实时更新
- 日志自动滚动到底部
- 点击截图可放大查看

---

### 4.5 测试计划管理页

```
+------------------------------------------------------------------+
|  测试计划管理                              [ + 创建计划 ]         |
+------------------------------------------------------------------+
|  [搜索框]  [状态筛选]                                            |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │ 计划名称   │ 任务数 │ 状态   │ 定时   │ 创建时间 │ 操作    │ |
|  ├──────────────────────────────────────────────────────────────┤ |
|  │ 每日回归   │ 5     │ ⏸闲置 │ 每天2点 │ 08-29  │ [▶][✏️][🗑]│ |
|  │ 冒烟测试   │ 3     │ ✅完成 │ -      │ 08-28  │ [▶][✏️][🗑]│ |
|  └──────────────────────────────────────────────────────────────┘ |
+------------------------------------------------------------------+
```

---

### 4.6 创建计划对话框

```
+------------------------------------------------------------------+
|  📋 创建测试计划                                       [×]       |
+------------------------------------------------------------------+
|  计划名称 *  [每日回归测试___________]                           |
|  描述        [每周一至周五执行_____]                             |
|              [_____________________]                             |
|  定时执行    [▼ 每天 02:00  ▼]  [Cron: 0 2 * * *]              |
|                                                                   |
|  选择任务 ┌──────────────────────────────────────────────────┐    |
|          │ [✓] 登录-Chrome    [状态: ✅]                   │    |
|          │ [✓] 登录-Firefox   [状态: ✅]                   │    |
|          │ [✓] 购物车-Edge    [状态: ❌]                   │    |
|          │ [✓] 支付-流程      [状态: ✅]                   │    |
|          │ [ ] 注册-流程      [状态: ⏳]                   │    |
|          └──────────────────────────────────────────────────┘    |
|                                                                   |
|  执行顺序:  [登录-Chrome] → [登录-Firefox] → [购物车-Edge]     |
|            [🔼] [🔽]                                             |
|                                                [取消]  [确定]   |
+------------------------------------------------------------------+
```

---

### 4.7 测试报告列表页

```
+------------------------------------------------------------------+
|  测试报告中心                              [ 🔄 刷新 ]           |
+------------------------------------------------------------------+
|  [搜索框]  [状态筛选]  [时间范围]                                |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │ 报告名称      │ 任务/计划 │ 通过率 │ 状态  │ 时间   │ 操作 │ |
|  ├──────────────────────────────────────────────────────────────┤ |
|  │ 报告_20260829 │ 登录测试  │ 100%  │ ✅通过 │ 14:30  │ [📄][📎]│ |
|  │ 报告_20260829 │ 每日回归  │ 80%   │ ❌失败 │ 02:00  │ [📄][📎]│ |
|  │ 报告_20260828 │ 登录测试  │ 100%  │ ✅通过 │ 昨天   │ [📄][📎]│ |
|  └──────────────────────────────────────────────────────────────┘ |
+------------------------------------------------------------------+
```

---

### 4.8 报告详情页

```
+------------------------------------------------------------------+
|  ← 返回报告列表   📊 测试报告 - 登录测试                        |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │  通过率: 100%  总步骤: 8  通过: 8  失败: 0  耗时: 12.3s   │ |
|  │  [📊趋势图]                                                │ |
|  └──────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  ┌─ 测试摘要 ──────────────────────────────────────────────────┐ |
|  │  任务名称: 登录-Chrome                                     │ |
|  │  执行时间: 2026-08-29 14:30:25 ~ 14:30:37                │ |
|  │  浏览器: Chrome 120.0                                     │ |
|  │  状态: ✅ 通过                                             │ |
|  └────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  ┌─ 执行录像 ──────────────────────────────────────────────────┐ |
|  │  [▶ 播放视频]                                              │ |
|  └────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  ┌─ 步骤详情 ──────────────────────────────────────────────────┐ |
|  │ 步骤 │ 操作         │ 状态  │ 耗时  │ 截图                │ |
|  │ ────┼──────────────┼───────┼───────┼─────────────────────│ |
|  │ 1   │ 打开登录页   │ ✅    │ 1.2s  │ [📷]                │ |
|  │ 2   │ 输入用户名   │ ✅    │ 0.5s  │ [📷]                │ |
|  │ 3   │ 输入密码     │ ✅    │ 0.4s  │ [📷]                │ |
|  │ 4   │ 点击登录     │ ✅    │ 0.8s  │ [📷]                │ |
|  │ 5   │ 验证跳转     │ ✅    │ 0.3s  │ [📷]                │ |
|  └────────────────────────────────────────────────────────────┘ |
|                                                                   |
|  [📄 导出HTML]  [📎 导出PDF]                                    |
+------------------------------------------------------------------+
```

---

## 5. 交互反馈

| 场景 | 反馈方式 |
|------|---------|
| 操作成功 | Message 全局提示，绿色，3秒消失 |
| 操作失败 | Message 全局提示，红色，5秒消失 |
| 加载数据 | Loading 骨架屏 |
| 执行中状态 | 进度条 + 状态标签动画 |
| 删除操作 | Dialog 二次确认 |
| 表单提交 | 按钮加载状态，禁用重复提交 |

---

## 6. 响应式支持

| 屏幕尺寸 | 适配策略 |
|---------|---------|
| ≥ 1440px | 完整布局，侧边栏展开 |
| 1024-1439px | 完整布局，侧边栏可折叠 |
| 768-1023px | 侧边栏默认折叠，表格横向滚动 |
| < 768px | 移动端适配（暂不考虑） |

---

# 三、API 文档

## 1. 通用规范

### 1.1 基础信息

| 项目 | 值 |
|------|-----|
| Base URL | `/api` |
| 协议 | HTTP/HTTPS |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |

### 1.2 通用响应格式

```typescript
// 成功响应
{
  "code": 0,
  "message": "success",
  "data": T
}

// 错误响应
{
  "code": number,
  "message": string,
  "errors?: any
}
```

### 1.3 HTTP状态码

| 状态码 | 含义 |
|--------|------|
| 200 | 请求成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

---

## 2. 录制项目管理 API

### 2.1 获取项目列表

```
GET /projects
```

**Query参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| page | number | 否 | 页码，默认1 |
| pageSize | number | 否 | 每页条数，默认10 |
| keyword | string | 否 | 搜索关键词 |
| type | string | 否 | 录制类型：ai / browser |
| status | string | 否 | 状态：draft / ready / archived |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [
      {
        "id": "proj_001",
        "name": "登录测试",
        "description": "用户登录流程测试",
        "type": "ai",
        "scriptContent": "async function run(page, params) { ... }",
        "paramsSchema": {
          "type": "object",
          "properties": {
            "username": { "type": "string" },
            "password": { "type": "string" }
          }
        },
        "status": "ready",
        "createdAt": "2026-08-29T14:30:00Z",
        "updatedAt": "2026-08-29T14:30:00Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10
  }
}
```

---

### 2.2 创建项目

```
POST /projects
```

**Request Body**

```typescript
{
  name: string;          // 必填，项目名称
  description?: string;  // 描述
  type: 'ai' | 'browser'; // 必填，录制类型
  scriptContent: string; // 必填，测试脚本
  paramsSchema?: object; // 参数Schema JSON
  status?: 'draft' | 'ready' | 'archived'; // 默认draft
}
```

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "proj_001",
    "name": "登录测试",
    "type": "ai",
    "scriptContent": "...",
    "status": "draft",
    "createdAt": "2026-08-29T14:30:00Z",
    "updatedAt": "2026-08-29T14:30:00Z"
  }
}
```

---

### 2.3 获取项目详情

```
GET /projects/:id
```

**路径参数**

| 参数 | 类型 | 描述 |
|------|------|------|
| id | string | 项目ID |

**响应示例**（同创建响应）

---

### 2.4 更新项目

```
PUT /projects/:id
```

**Request Body**（同创建，所有字段可选）

```typescript
{
  name?: string;
  description?: string;
  type?: 'ai' | 'browser';
  scriptContent?: string;
  paramsSchema?: object;
  status?: 'draft' | 'ready' | 'archived';
}
```

---

### 2.5 删除项目

```
DELETE /projects/:id
```

**响应示例**

```json
{
  "code": 0,
  "message": "删除成功"
}
```

---

## 3. 测试任务管理 API

### 3.1 获取任务列表

```
GET /tasks
```

**Query参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| page | number | 否 | 页码 |
| pageSize | number | 否 | 每页条数 |
| projectId | string | 否 | 关联项目ID |
| status | string | 否 | pending/running/success/failed/retrying |
| browserType | string | 否 | chromium/firefox/webkit |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [
      {
        "id": "task_001",
        "projectId": "proj_001",
        "projectSnapshot": "async function run(...) { ... }",
        "name": "登录-Chrome",
        "browserType": "chromium",
        "browserPath": "/opt/chrome/chrome-120/chrome",
        "params": {
          "username": "admin",
          "password": "123456"
        },
        "retryCount": 0,
        "maxRetries": 3,
        "status": "success",
        "lastRunAt": "2026-08-29T14:30:00Z",
        "createdAt": "2026-08-29T14:00:00Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10
  }
}
```

---

### 3.2 创建任务

```
POST /tasks
```

**Request Body**

```typescript
{
  projectId: string;      // 必填，关联项目ID
  name: string;           // 必填，任务名称
  browserType: 'chromium' | 'firefox' | 'webkit'; // 必填
  browserPath: string;    // 必填，浏览器可执行文件路径
  params?: object;        // 参数化数据
  maxRetries?: number;    // 最大重试次数，默认3
}
```

**逻辑说明**：
- 创建时自动复制项目脚本作为`projectSnapshot`
- 默认状态为`pending`

---

### 3.3 获取任务详情

```
GET /tasks/:id
```

---

### 3.4 更新任务

```
PUT /tasks/:id
```

**Request Body**

```typescript
{
  name?: string;
  browserType?: 'chromium' | 'firefox' | 'webkit';
  browserPath?: string;
  params?: object;
  maxRetries?: number;
}
```

**注意**：`projectSnapshot`不可更新，保持创建时快照

---

### 3.5 删除任务

```
DELETE /tasks/:id
```

---

### 3.6 执行任务

```
POST /tasks/:id/run
```

**响应示例**

```json
{
  "code": 0,
  "message": "任务已加入执行队列",
  "data": {
    "taskId": "task_001",
    "queuePosition": 1
  }
}
```

**说明**：
- 任务加入全局串行队列
- 如果队列空闲，立即执行
- 如果队列忙碌，排队等待

---

## 4. 测试计划管理 API

### 4.1 获取计划列表

```
GET /plans
```

**Query参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| page | number | 否 | 页码 |
| pageSize | number | 否 | 每页条数 |
| status | string | 否 | idle/running/completed/failed |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [
      {
        "id": "plan_001",
        "name": "每日回归测试",
        "description": "核心功能每日回归",
        "taskIds": ["task_001", "task_002", "task_003"],
        "schedule": "0 2 * * *",
        "status": "idle",
        "createdAt": "2026-08-29T10:00:00Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10
  }
}
```

---

### 4.2 创建计划

```
POST /plans
```

**Request Body**

```typescript
{
  name: string;           // 必填，计划名称
  description?: string;   // 描述
  taskIds: string[];      // 必填，任务ID列表（按顺序执行）
  schedule?: string;      // Cron表达式，可选
}
```

---

### 4.3 获取计划详情

```
GET /plans/:id
```

---

### 4.4 更新计划

```
PUT /plans/:id
```

**Request Body**

```typescript
{
  name?: string;
  description?: string;
  taskIds?: string[];
  schedule?: string;
}
```

---

### 4.5 删除计划

```
DELETE /plans/:id
```

---

### 4.6 执行计划

```
POST /plans/:id/run
```

**响应示例**

```json
{
  "code": 0,
  "message": "计划已开始执行",
  "data": {
    "planId": "plan_001"
  }
}
```

**执行逻辑**：
1. 按`taskIds`顺序执行
2. 每个任务加入队列
3. 等待任务完成后继续下一个
4. 单任务失败不影响后续
5. 全部完成后更新计划状态

---

## 5. 测试报告 API

### 5.1 获取报告列表

```
GET /reports
```

**Query参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| page | number | 否 | 页码 |
| pageSize | number | 否 | 每页条数 |
| taskId | string | 否 | 任务ID |
| planId | string | 否 | 计划ID |
| status | string | 否 | success/failed/skipped |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [
      {
        "id": "report_001",
        "taskId": "task_001",
        "taskName": "登录-Chrome",
        "startTime": "2026-08-29T14:30:25Z",
        "endTime": "2026-08-29T14:30:37Z",
        "duration": 12000,
        "status": "success",
        "totalSteps": 8,
        "passedSteps": 8,
        "failedSteps": 0,
        "passRate": 100,
        "createdAt": "2026-08-29T14:30:37Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10
  }
}
```

---

### 5.2 获取报告详情

```
GET /reports/:id
```

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "report_001",
    "taskId": "task_001",
    "planId": null,
    "taskName": "登录-Chrome",
    "startTime": "2026-08-29T14:30:25Z",
    "endTime": "2026-08-29T14:30:37Z",
    "duration": 12000,
    "status": "success",
    "totalSteps": 8,
    "passedSteps": 8,
    "failedSteps": 0,
    "details": [
      {
        "step": 1,
        "action": "打开登录页面",
        "status": "passed",
        "message": "https://example.com/login 加载成功",
        "screenshot": "/artifacts/screenshots/task_001/step_1.png",
        "timestamp": "2026-08-29T14:30:26Z",
        "duration": 1200
      }
    ],
    "screenshots": [
      "/artifacts/screenshots/task_001/step_1.png",
      "/artifacts/screenshots/task_001/step_2.png"
    ],
    "videoPath": "/artifacts/videos/task_001/video.mp4",
    "errorMessage": null,
    "createdAt": "2026-08-29T14:30:37Z"
  }
}
```

---

### 5.3 导出HTML报告

```
GET /reports/:id/html
```

**响应**：HTML文件流

**Headers**
```
Content-Type: text/html
Content-Disposition: inline; filename="report_001.html"
```

---

### 5.4 导出PDF报告

```
GET /reports/:id/pdf
```

**响应**：PDF文件流

**Headers**
```
Content-Type: application/pdf
Content-Disposition: attachment; filename="report_001.pdf"
```

---

### 5.5 删除报告

```
DELETE /reports/:id
```

---

## 6. 系统配置 API

### 6.1 获取浏览器列表

```
GET /config/browsers
```

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "browsers": [
      {
        "name": "chromium",
        "version": "120.0",
        "path": "/opt/chrome/chrome-120/chrome"
      },
      {
        "name": "chromium",
        "version": "121.0",
        "path": "/opt/chrome/chrome-121/chrome"
      },
      {
        "name": "firefox",
        "version": "115.0",
        "path": "/opt/firefox/firefox-115/firefox"
      }
    ],
    "default": {
      "name": "chromium",
      "version": "120.0"
    }
  }
}
```

---

### 6.2 获取任务队列状态

```
GET /config/queue/status
```

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "isRunning": true,
    "currentTask": "task_001",
    "queueLength": 3,
    "queue": ["task_002", "task_003", "task_004"]
  }
}
```

---

## 7. 错误码定义

| 错误码 | 含义 |
|--------|------|
| 10001 | 参数验证失败 |
| 10002 | 资源不存在 |
| 10003 | 资源已存在 |
| 20001 | 任务执行失败 |
| 20002 | 任务已在队列中 |
| 20003 | 任务不能重复执行 |
| 30001 | 计划执行失败 |
| 40001 | 报告生成失败 |
| 50001 | 系统内部错误 |

---

## 8. 数据模型汇总

### 8.1 枚举定义

```typescript
// 录制类型
type RecordingType = 'ai' | 'browser';

// 项目状态
type ProjectStatus = 'draft' | 'ready' | 'archived';

// 任务状态
type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'retrying';

// 计划状态
type PlanStatus = 'idle' | 'running' | 'completed' | 'failed';

// 报告状态
type ReportStatus = 'success' | 'failed' | 'skipped';

// 浏览器类型
type BrowserType = 'chromium' | 'firefox' | 'webkit';
```

### 8.2 实体关系图

```
┌─────────────┐          ┌─────────────┐          ┌─────────────┐
│  Recording  │  1 ── n  │    Test     │  n ── n  │    Test     │
│   Project   │ ──────── │    Task     │ ──────── │    Plan     │
└─────────────┘          └─────────────┘          └─────────────┘
       │                        │
       │ 复制快照                │ 生成
       ▼                        ▼
┌─────────────┐          ┌─────────────┐
│  Project    │          │   Report    │
│  Snapshot   │          │             │
└─────────────┘          └─────────────┘
```

---

以上三份文档已完整输出。确认后即可进入编码阶段。

---

# you asked

message time: 2026-08-29 07:32:12

设计三套 原型UX交互  发我评审

---

# deepseek response

由于我无法直接生成可交互的HTML原型文件，我将为你提供**三套完整的UX设计稿**，包含详细的页面布局、交互流程和视觉风格描述。你可以将这些设计稿交给UI设计师或使用Figma/Axure等工具快速还原。

---

# 三套UX设计方案

---

## 方案一：极简高效型（推荐）

### 设计理念
- **以任务为中心**：核心操作路径最短
- **视觉风格**：清爽、留白多、信息层级清晰
- **适用场景**：日常高频使用的测试工程师

### 1.1 布局结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  🧪 AutoTest   [导航菜单]              [搜索]  [通知] [头像]    │
├─────────────────────────────────────────────────────────────────────┤
│  首页 > 测试任务                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  📊 今日概览                                                 │ │
│  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                   │ │
│  │  │ 总任务 │  │ 执行中 │  │ 今日通过 │  │ 今日失败 │          │ │
│  │  │  24   │  │  3    │  │  89%   │  │  11%   │          │ │
│  │  └──────┘  └──────┘  └──────┘  └──────┘                   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  快速操作栏                                                  │ │
│  │  [📝 新建任务] [▶ 执行选中] [📊 查看报告]                    │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  任务列表                                     [筛选] [排序]  │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │ ☐ │ 任务名称    │ 状态  │ 浏览器 │ 项目   │ 操作      │ │ │
│  │  ├─────────────────────────────────────────────────────────┤ │ │
│  │  │ ☑ │ 登录测试    │ ✅成功 │ Chrome │ 登录   │ [▶][📄] │ │ │
│  │  │ ☐ │ 购物车流程  │ ▶执行中 │ Firefox│ 商城   │ [📄]    │ │ │
│  │  │ ☐ │ 支付测试    │ ❌失败 │ Edge   │ 支付   │ [▶][📄] │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │  [< 1 2 3 4 5 >]  共24条                                    │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 交互流程

#### 流程A：创建并执行任务（3步）

```
步骤1: 点击 [📝 新建任务]
  ↓
步骤2: 弹出侧滑面板（从右侧滑出）
  ┌─────────────────────────────────────┐
  │  📝 新建任务                  [×]  │
  │  选择项目: [▼ 登录测试 ▼]          │
  │  任务名称: [________________]       │
  │  浏览器: [▼ Chrome 120 ▼]          │
  │  参数:                              │
  │    username: [admin_______]         │
  │    password: [**********]          │
  │  重试次数: [3]                     │
  │                         [取消] [创建并执行] │
  └─────────────────────────────────────┘
  ↓
步骤3: 跳转到执行监控页面（实时日志流）
```

#### 流程B：查看任务执行日志

```
点击任务行 → 展开详情面板（下方展开）

┌─────────────────────────────────────────────────────────────────┐
│  登录测试 - 执行详情                    [刷新] [导出日志]    │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  14:30:25 [INFO]  开始执行测试任务                       │ │
│  │  14:30:26 [INFO]  正在打开页面: https://example.com/login│ │
│  │  14:30:28 [INFO]  输入用户名: admin                     │ │
│  │  14:30:29 [INFO]  输入密码: ******                      │ │
│  │  14:30:32 [INFO]  点击登录按钮                          │ │
│  │  14:30:35 [SUCCESS] 登录成功                            │ │
│  └───────────────────────────────────────────────────────────┘ │
│  [📷 查看截图] [▶ 播放视频]                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 色彩方案

| 元素 | 色值 | 说明 |
|------|------|------|
| 主色 | #0052D9 | 按钮、选中状态 |
| 成功 | #00A870 | 通过状态 |
| 失败 | #E34D59 | 失败状态 |
| 背景 | #F5F7FA | 页面背景 |
| 卡片 | #FFFFFF | 卡片背景 |
| 文字主色 | #222222 | 主要文字 |
| 文字辅助 | #888888 | 辅助信息 |

---

## 方案二：看板驱动型

### 设计理念
- **以可视化为主**：状态卡片式布局
- **视觉风格**：看板风格，色彩丰富，状态一目了然
- **适用场景**：管理者、团队协作场景

### 2.1 布局结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  🧪 AutoTest   [导航菜单]                   [团队] [设置] [头像] │
├─────────────────────────────────────────────────────────────────────┤
│  工作台                                                           │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐       │
│  │  待执行    │ │  执行中    │ │  已完成   │ │  失败    │       │
│  │  ──────── │ │  ──────── │ │  ──────── │ │  ──────── │       │
│  │  🟡 12    │ │  🔵 3     │ │  ✅ 18    │ │  ❌ 5     │       │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘       │
│                                                                   │
│  ┌─ 看板视图 ───────────────────────────────────────────────────┐ │
│  │  ┌─ 待执行 ─────┐ ┌─ 执行中 ─────┐ ┌─ 已完成 ─────┐     │ │
│  │  │ ┌────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐ │  │ │
│  │  │ │注册测试     │ │ │ │登录测试   │ │ │ │购物车测试  │ │  │ │
│  │  │ │AI  | Chrome │ │ │ │浏览器|Edge│ │ │ │AI  | Firefox│ │  │ │
│  │  │ │🕐 2分钟前  │ │ │ │▶ 执行中   │ │ │ │✅ 通过 100%│ │  │ │
│  │  │ └────────────┘ │ │ └────────────┘ │ │ └────────────┘ │  │ │
│  │  │ ┌────────────┐ │ │                │ │ ┌────────────┐ │  │ │
│  │  │ │支付测试     │ │ │                │ │ │支付测试    │ │  │ │
│  │  │ │AI  | Chrome │ │ │                │ │ │❌ 失败 70% │ │  │ │
│  │  │ │🕐 5分钟前  │ │ │                │ │ └────────────┘ │  │ │
│  │  │ └────────────┘ │ │                │ │                │  │ │
│  │  └────────────────┘ └────────────────┘ └────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 交互流程

#### 拖拽操作

```
用户可以通过拖拽卡片在不同列之间移动：

待执行 → 执行中：自动触发执行
执行中 → 已完成：任务完成（自动）
执行中 → 失败：任务失败（自动）
失败 → 待执行：点击重试按钮
```

#### 卡片悬浮操作

```
┌─────────────────────────────┐
│  登录测试                    │
│  AI 录制 | Chrome 120       │
│  ▶ 执行中 45%               │
│  [⏸暂停] [📊查看报告]      │  ← 悬浮显示操作按钮
│  🕐 开始: 14:30             │
└─────────────────────────────┘
```

### 2.3 色彩方案

| 元素 | 色值 | 说明 |
|------|------|------|
| 待执行 | #F59A23 | 橙色系卡片 |
| 执行中 | #0052D9 | 蓝色系卡片 |
| 已完成 | #00A870 | 绿色系卡片 |
| 失败 | #E34D59 | 红色系卡片 |
| 卡片阴影 | rgba(0,0,0,0.08) | 悬浮效果 |

---

## 方案三：分步向导型

### 设计理念
- **以流程为导向**：引导用户按步骤完成
- **视觉风格**：分步指示，操作指引清晰
- **适用场景**：新手用户、复杂流程场景

### 3.1 布局结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  🧪 AutoTest   [导航菜单]                    [帮助] [头像]       │
├─────────────────────────────────────────────────────────────────────┤
│  📝 创建测试任务 - 分步向导                                      │
│                                                                   │
│  ●━━━━━━━○━━━━━━━○━━━━━━━○                                     │
│  步骤1    步骤2    步骤3    步骤4                                │
│  选择项目  配置参数  确认执行  查看报告                          │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  步骤1: 选择项目                                            │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │  [搜索项目]  [按类型筛选]                              │ │ │
│  │  │  ┌──────┐ ┌──────┐ ┌──────┐                          │ │ │
│  │  │  │登录   │ │购物车 │ │支付   │                          │ │ │
│  │  │  │AI录制 │ │浏览器 │ │AI录制 │                          │ │ │
│  │  │  │✅就绪 │ │✅就绪 │ │⏳草稿 │                          │ │ │
│  │  │  └──────┘ └──────┘ └──────┘                          │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                               [下一步 →]                     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  步骤2: 配置参数                                            │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │  任务名称: [登录测试_20260829_______]                  │ │ │
│  │  │  浏览器:  [▼ Chromium 120 ▼]                          │ │ │
│  │  │  参数配置:                                             │ │ │
│  │  │    URL:        [https://example.com/login______]      │ │ │
│  │  │    用户名:     [admin________________]                │ │ │
│  │  │    密码:       [**********___________]                │ │ │
│  │  │  重试次数:    [━━━━━━●━━━] 3次                       │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                    [← 上一步]  [下一步 →]                    │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  步骤3: 确认执行                                            │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │  📋 任务摘要                                          │ │ │
│  │  │  项目: 登录测试 (AI录制)                              │ │ │
│  │  │  浏览器: Chrome 120                                   │ │ │
│  │  │  参数: URL=https://example.com/login, 用户名=admin   │ │ │
│  │  │  重试: 3次                                            │ │ │
│  │  │  [✓] 执行完成后自动查看报告                           │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                    [← 上一步]  [🚀 立即执行]                │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 交互流程

#### 步骤导航

```
顶部进度条指示当前位置：
●━━━━━━━○━━━━━━━○━━━━━━━○
步骤1    步骤2    步骤3    步骤4

点击步骤名称可跳转（已完成步骤）
```

#### 参数配置 - 动态表单

```
根据项目的 paramsSchema 动态生成表单：

Schema:
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri" },
    "username": { "type": "string" },
    "password": { "type": "string", "format": "password" }
  },
  "required": ["url", "username"]
}

生成的表单：
┌────────────────────────────────┐
│  URL *     [____________]     │
│  用户名 *  [____________]     │
│  密码      [____________]     │
└────────────────────────────────┘
```

### 3.3 色彩方案

| 元素 | 色值 | 说明 |
|------|------|------|
| 步骤已完成 | #00A870 | 绿色勾选 |
| 步骤进行中 | #0052D9 | 蓝色高亮 |
| 步骤未完成 | #DCDCDC | 灰色 |
| 主按钮 | #0052D9 | 下一步/执行 |
| 次按钮 | #FFFFFF | 上一步 |
| 卡片选中 | #F0F5FF | 浅蓝色背景 |

---

## 三套方案对比

| 对比维度 | 方案一：极简高效型 | 方案二：看板驱动型 | 方案三：分步向导型 |
|---------|-------------------|-------------------|-------------------|
| **目标用户** | 熟练测试工程师 | 团队管理者 | 新手/偶尔使用 |
| **学习成本** | 低 | 中 | 低 |
| **操作效率** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **可视化程度** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **适用任务数** | 多（>20） | 中（5-20） | 少（<5） |
| **移动端适配** | 好 | 一般 | 好 |
| **开发复杂度** | 低 | 中 | 中 |
| **推荐指数** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 综合推荐

基于你的需求（单机使用、测试工程师日常操作），我推荐采用 **方案一（极简高效型）为主，融合方案三的部分交互**：

### 融合方案

1. **默认使用方案一**的布局（列表+概览卡片）
2. **创建流程采用方案三**的分步向导（便于参数配置）
3. **看板视图作为可选**（通过右上角切换按钮）

```
┌─────────────────────────────────────────────────────────────────────┐
│  🧪 AutoTest   [导航菜单]              [看板视图] [头像]        │
├─────────────────────────────────────────────────────────────────────┤
│  首页 > 测试任务                          [📝 新建任务]          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ 待执行 12 │ │ 执行中 3 │ │ 已完成 18│ │ 失败 5  │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  ☐ 任务名称   │ 状态  │ 浏览器  │ 项目   │ 操作            │ │
│  │  ☑ 登录测试   │ ✅成功 │ Chrome  │ 登录   │ [▶][📄]       │ │
│  │  ☐ 购物车测试 │ ▶执行中│ Firefox │ 商城   │ [📄]          │ │
│  │  ☐ 支付测试   │ ❌失败 │ Edge    │ 支付   │ [▶][📄]       │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 评审检查清单

请确认以下内容：

- [ ] 方案一：列表+概览的布局是否清晰？
- [ ] 方案二：看板视图是否需要？
- [ ] 方案三：分步向导是否过于繁琐？
- [ ] 状态卡片是否需要（待执行/执行中/已完成/失败）？
- [ ] 颜色方案是否满意？
- [ ] 是否有需要调整的交互细节？

---

请告诉我你的选择或修改意见，确认后我会基于最终方案进行编码实现。

---

# you asked

message time: 2026-08-29 07:33:50

融合方案

---

# deepseek response

好的，基于融合方案，我现在输出**完整的UX设计稿**，结合方案一的效率 + 方案二的视觉 + 方案三的流程引导。

---

# 融合方案 - 完整UX设计

## 一、设计概览

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **效率优先** | 核心操作路径不超过3步 |
| **状态可见** | 每个任务状态一目了然 |
| **流程引导** | 复杂操作（创建任务）使用分步向导 |
| **灵活切换** | 列表/看板两种视图模式 |

### 1.2 整体架构

```
+------------------------------------------------------------------+
|                    全局导航层                                      |
+------------------------------------------------------------------+
|                    全局状态栏                                      |
+------------------------------------------------------------------+
|  视图切换  |  快速操作  |  筛选/搜索  |  统计卡片                |
+------------------------------------------------------------------+
|                                                                   |
|  列表视图 / 看板视图（两种模式切换）                              |
|                                                                   |
+------------------------------------------------------------------+
|  分步向导（创建任务时从右侧滑出）                                 |
+------------------------------------------------------------------+
|  执行监控（全屏模式，带实时日志流）                               |
+------------------------------------------------------------------+
|  报告详情（全屏模式）                                             |
+------------------------------------------------------------------+
```

---

## 二、页面详细设计

### 2.1 全局布局

```
+------------------------------------------------------------------+
|  🧪 AutoTest                                                      |
|  图标 + 品牌名                                                     |
|                                                                   |
|  [录制项目] [测试任务] [测试计划] [测试报告]  ← 主导航           |
|                                                                   |
|  [视图切换: 列表 ☰ | 看板 ▦]  [🔍搜索]  [📊统计] [👤]         |
+------------------------------------------------------------------+
|                                                                   |
|  统计卡片行                                                       |
|  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐              |
|  │ 总任务数 │ │ 待执行  │ │ 执行中  │ │ 今日完成│              |
|  │   24     │ │  12    │ │  3     │ │  18    │              |
|  │  ↑12%   │ │  ↓3%   │ │  →0%   │ │  ↑8%   │              |
|  └─────────┘ └─────────┘ └─────────┘ └─────────┘              |
|                                                                   |
|  操作工具栏                                                       |
|  [📝 新建任务] [▶ 批量执行] [📊 查看报告] [⚙️ 管理]           |
|                                                                   |
|  视图内容区（列表/看板切换）                                     |
|                                                                   |
+------------------------------------------------------------------+
```

---

### 2.2 列表视图（默认）

```
+------------------------------------------------------------------+
|  测试任务管理                                    [📝 新建任务]   |
|  [📋列表] [▦看板]                                               |
+------------------------------------------------------------------+
|  搜索: [____________________]  状态: [▼全部▼]  项目: [▼全部▼]  |
+------------------------------------------------------------------+
|  ┌──────────────────────────────────────────────────────────────┐ |
|  │  ☐ 任务名称    │ 项目    │ 状态  │ 浏览器  │ 重试 │ 操作   │ |
|  ├──────────────────────────────────────────────────────────────┤ |
|  │  ☑ 登录测试    │ 登录项目 │ ✅成功 │ Chrome  │ 0/3 │ ▶📄  │ |
|  │  ☐ 购物车测试  │ 商城项目 │ ▶执行中│ Firefox │ 1/3 │  📄  │ |
|  │  ☐ 支付测试    │ 支付项目 │ ❌失败 │ Edge    │ 3/3 │ ▶📄  │ |
|  │  ☐ 注册测试    │ 注册项目 │ 🔄重试 │ Chrome  │ 2/3 │  📄  │ |
|  │  ☑ 订单查询    │ 订单项目 │ ⏸待执行 │ WebKit │ 0/3 │ ▶📄  │ |
|  └──────────────────────────────────────────────────────────────┘ |
|  [< 1 2 3 4 5 >] 共24条  每页[10▼]                             |
+------------------------------------------------------------------+
```

**交互说明**：

| 操作 | 触发方式 | 反馈 |
|------|---------|------|
| 新建任务 | 点击主按钮 | 右侧滑出分步向导 |
| 执行任务 | 点击 ▶ 图标 | 加入队列，按钮变灰 |
| 查看报告 | 点击 📄 图标 | 跳转报告详情页 |
| 批量执行 | 勾选多行 + 点击批量执行 | 全部加入队列 |
| 状态筛选 | 下拉选择 | 列表实时过滤 |
| 行悬停 | 鼠标悬停 | 背景色变浅，操作按钮高亮 |

---

### 2.3 看板视图

```
+------------------------------------------------------------------+
|  测试任务管理                                    [📝 新建任务]   |
|  [📋列表] [▦看板]                                               |
+------------------------------------------------------------------+
|  搜索: [____________________]  项目: [▼全部▼]                    |
+------------------------------------------------------------------+
|  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐│
|  │  ⏸ 待执行   │ │  ▶ 执行中   │ │  ✅ 已完成   │ │  ❌ 失败    ││
|  │  ─────────── │ │  ─────────── │ │  ─────────── │ │  ─────────── ││
|  │  ┌─────────┐ │ │  ┌─────────┐ │ │  ┌─────────┐ │ │  ┌─────────┐││
|  │  │登录测试  │ │ │  │注册测试 │ │ │  │购物车   │ │ │  │支付测试 │││
|  │  │AI Chrome │ │ │  │AI WebKit│ │ │  │浏览器   │ │ │  │AI Edge  │││
|  │  │🕐 2分钟前│ │ │  │■ 45%    │ │ │  │✅ 100%  │ │ │  │❌ 失败  │││
|  │  │[▶] [📄]  │ │ │  │[⏹] [📄]│ │ │  │[▶] [📄]│ │ │  │[📄]    │││
|  │  └─────────┘ │ │  └─────────┘ │ │  └─────────┘ │ │  └─────────┘││
|  │  ┌─────────┐ │ │  ┌─────────┐ │ │  ┌─────────┐ │ │  ┌─────────┐││
|  │  │订单查询  │ │ │  │支付测试 │ │ │  │用户管理 │ │ │  │API测试  │││
|  │  │Browser   │ │ │  │Browser  │ │ │  │AI Chrome│ │ │  │Browser  │││
|  │  │🕐 5分钟前│ │ │  │■ 78%    │ │ │  │✅ 100%  │ │ │  │❌ 超时  │││
|  │  │[▶] [📄]  │ │ │  │[⏹] [📄]│ │ │  │[▶] [📄]│ │ │  │[📄]    │││
|  │  └─────────┘ │ │  └─────────┘ │ │  └─────────┘ │ │  └─────────┘││
|  │            3 │ │            2 │ │            5 │ │            2 ││
|  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘│
+------------------------------------------------------------------+
```

**交互说明**：

| 操作 | 触发方式 | 反馈 |
|------|---------|------|
| 拖拽移动 | 拖拽卡片到其他列 | 自动更新任务状态 |
| 执行任务 | 点击卡片的 ▶ | 加入队列 |
| 查看报告 | 点击卡片的 📄 | 跳转报告详情 |
| 卡片详情 | 点击卡片主体 | 展开详情浮窗 |

---

### 2.4 分步向导（创建任务 - 右侧滑出）

```
+------------------------------------------------------------------+
│  [← 返回列表]  📝 创建测试任务                               [×]│
│                                                                   │
│  ┌───────────────────────────────────────────────────────────────┐│
│  │  ●━━━━━━━○━━━━━━━○━━━━━━━○                                ││
│  │  选择项目  配置参数  确认执行  完成                         ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─ 步骤1: 选择项目 ────────────────────────────────────────────┐│
│  │  [🔍 搜索项目]  [▼ 全部类型 ▼]                             ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                   ││
│  │  │ 登录项目  │ │ 商城项目  │ │ 支付项目  │                   ││
│  │  │ 🤖 AI录制 │ │ 🌐浏览器 │ │ 🤖 AI录制 │                   ││
│  │  │ ✅ 就绪   │ │ ✅ 就绪   │ │ ⏳ 草稿   │                   ││
│  │  │ 选择 ▶   │ │ 选择 ▶   │ │ 不可用   │                   ││
│  │  └──────────┘ └──────────┘ └──────────┘                   ││
│  └───────────────────────────────────────────────────────────────┘│
│                                          [下一步 →]              │
│                                                                   │
│  ┌─ 步骤2: 配置参数 ────────────────────────────────────────────┐│
│  │  任务名称: [登录测试_20260829___________]                   ││
│  │  描述:     [日常登录流程验证___________]                   ││
│  │  浏览器:   [▼ Chromium 120 ▼]  [▼ 系统预装 ▼]            ││
│  │  参数配置:                                                 ││
│  │    测试URL:  [https://example.com/login________]          ││
│  │    用户名:   [admin____________________]                  ││
│  │    密码:     [**********______________]                   ││
│  │    超时:     [━━━━━━━━●━━━] 30秒                        ││
│  │  重试次数:  [━━━●━━━━━━━] 3次                           ││
│  │  [✓] 执行完成后自动跳转报告                              ││
│  └───────────────────────────────────────────────────────────────┘│
│                              [← 上一步]  [下一步 →]              │
│                                                                   │
│  ┌─ 步骤3: 确认执行 ────────────────────────────────────────────┐│
│  │  📋 任务摘要                                               ││
│  │  ┌─────────────────────────────────────────────────────┐    ││
│  │  │  项目: 登录项目 (AI录制)                          │    ││
│  │  │  任务名: 登录测试_20260829                       │    ││
│  │  │  浏览器: Chromium 120                            │    ││
│  │  │  参数: URL=https://example.com/login             │    ││
│  │  │        username=admin                            │    ││
│  │  │  重试: 3次                                       │    ││
│  │  │  自动报告: 是                                    │    ││
│  │  └─────────────────────────────────────────────────────┘    ││
│  └───────────────────────────────────────────────────────────────┘│
│                              [← 上一步]  [🚀 立即执行]           │
│                                                                   │
│  ┌─ 步骤4: 完成 ────────────────────────────────────────────────┐│
│  │  ✅ 任务创建成功！                                          ││
│  │  任务已加入执行队列，请等待执行完成。                       ││
│  │  ┌─────────────────────────────────────────────────────┐    ││
│  │  │  任务ID: task_20260829_001                        │    ││
│  │  │  队列位置: 第 1 位                                │    ││
│  │  └─────────────────────────────────────────────────────┘    ││
│  │  [📊 查看报告]  [📋 返回列表]  [📝 继续创建]              ││
│  └───────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

**交互说明**：

| 操作 | 触发方式 | 反馈 |
|------|---------|------|
| 选择项目 | 点击项目卡片 | 卡片高亮，激活下一步 |
| 参数校验 | 输入时实时 | 格式错误红色提示 |
| 上一步/下一步 | 点击按钮 | 平滑切换步骤 |
| 立即执行 | 点击按钮 | 提交表单，跳转步骤4 |
| 关闭向导 | 点击 × 或外部 | 二次确认（已填数据丢失） |

---

### 2.5 执行监控页面（全屏）

```
+------------------------------------------------------------------+
│  [← 返回任务列表]  ▶ 执行监控 - 登录测试              [×]关闭   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  任务状态: [🔵执行中]  进度: ██████████░░░░ 80%            ││
│  │  浏览器: Chrome 120  重试: 0/3  耗时: 12.3s               ││
│  │  开始: 14:30:25  预计剩余: 3s                             ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─────────────┐ ┌─────────────────────────────────────────────┐│
│  │  执行截图    │ │  实时日志                                  ││
│  │  ─────────── │ │  ───────────────────────────────────────── ││
│  │  ┌─────────┐ │ │  14:30:25 [INFO]  开始执行测试任务        ││
│  │  │ 截图1   │ │ │  14:30:26 [INFO]  正在打开页面...       ││
│  │  └─────────┘ │ │  14:30:28 [INFO]  输入用户名: admin     ││
│  │  ┌─────────┐ │ │  14:30:29 [INFO]  输入密码: ******     ││
│  │  │ 截图2   │ │ │  14:30:32 [INFO]  点击登录按钮         ││
│  │  └─────────┘ │ │  14:30:35 [SUCCESS] 登录成功           ││
│  │  ┌─────────┐ │ │  14:30:36 [INFO]  验证页面元素         ││
│  │  │ 截图3   │ │ │  14:30:37 [SUCCESS] 测试完成           ││
│  │  └─────────┘ │ │  [自动滚动到底部]                       ││
│  │  [展开全部▶]│ │  [📋 复制日志]                           ││
│  └─────────────┘ └─────────────────────────────────────────────┘│
│                                                                   │
│  [⏹ 停止执行]  [📊 查看报告]                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**交互说明**：

| 操作 | 触发方式 | 反馈 |
|------|---------|------|
| 实时更新 | 自动轮询（2秒） | 进度条和日志动态更新 |
| 查看截图 | 点击缩略图 | 弹窗放大显示 |
| 停止执行 | 点击按钮 | 终止进程，生成失败报告 |
| 自动滚动 | 开关控制 | 日志自动滚动到底部 |

---

### 2.6 报告详情页面

```
+------------------------------------------------------------------+
│  [← 返回报告列表]  📊 测试报告 - 登录测试                [导出]  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  ✅ 通过率 100%  总步骤 8  通过 8  失败 0  耗时 12.3s    ││
│  │  ┌─────────────────────────────────────────────────────┐    ││
│  │  │  执行趋势图 (ECharts)                             │    ││
│  │  │  100% ──●────────────────────                     │    ││
│  │  │  80%  ──┼────────────────────                     │    ││
│  │  │  60%  ──┼────────────────────                     │    ││
│  │  │  40%  ──┼────────────────────                     │    ││
│  │  │  20%  ──┼────────────────────                     │    ││
│  │  │  0%   ──┴────────────────────                     │    ││
│  │  └─────────────────────────────────────────────────────┘    ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─ 测试摘要 ───────────────────────────────────────────────────┐│
│  │  任务名称: 登录测试_20260829                               ││
│  │  执行时间: 2026-08-29 14:30:25 ~ 14:30:37                ││
│  │  浏览器: Chromium 120.0.0                                 ││
│  │  状态: ✅ 通过                                             ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─ 执行录像 ───────────────────────────────────────────────────┐│
│  │  [▶ 播放]  [⏸ 暂停]  [◀ 0:12/0:37 ▶]  [⛶ 全屏]       ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─ 步骤详情 ───────────────────────────────────────────────────┐│
│  │  步骤 │ 操作         │ 状态  │ 耗时  │ 截图             ││
│  │  ────┼──────────────┼───────┼───────┼─────────────────││
│  │  1   │ 打开登录页   │ ✅    │ 1.2s  │ [📷]            ││
│  │  2   │ 输入用户名   │ ✅    │ 0.5s  │ [📷]            ││
│  │  3   │ 输入密码     │ ✅    │ 0.4s  │ [📷]            ││
│  │  4   │ 点击登录     │ ✅    │ 0.8s  │ [📷]            ││
│  │  5   │ 验证跳转     │ ✅    │ 0.3s  │ [📷]            ││
│  │  6   │ 验证用户信息 │ ✅    │ 0.6s  │ [📷]            ││
│  │  7   │ 验证菜单     │ ✅    │ 0.4s  │ [📷]            ││
│  │  8   │ 清理数据     │ ✅    │ 0.2s  │ [📷]            ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  [📄 导出HTML]  [📎 导出PDF]  [🗑 删除报告]                    │
└───────────────────────────────────────────────────────────────────┘
```

---

## 三、交互规范

### 3.1 状态反馈

| 状态 | 图标 | 颜色 | 动画 |
|------|------|------|------|
| 待执行 | ⏸ | #F59A23 | 静态 |
| 执行中 | ▶ | #0052D9 | 脉冲动画 |
| 重试中 | 🔄 | #ED7B2F | 旋转动画 |
| 成功 | ✅ | #00A870 | 静态 |
| 失败 | ❌ | #E34D59 | 静态 |

### 3.2 消息提示

| 类型 | 位置 | 持续时间 | 样式 |
|------|------|---------|------|
| 成功 | 右上角 | 3秒 | 绿色边框 |
| 警告 | 右上角 | 5秒 | 橙色边框 |
| 错误 | 右上角 | 5秒 | 红色边框 |
| 信息 | 右上角 | 3秒 | 蓝色边框 |

### 3.3 加载状态

| 场景 | 反馈方式 |
|------|---------|
| 页面加载 | 骨架屏（Skeleton） |
| 数据刷新 | 列表顶部进度条 |
| 表单提交 | 按钮加载状态 |
| 任务执行 | 进度条 + 状态标签 |

---

## 四、原型设计文件结构

```
原型文件/
├── 01_全局布局/
│   ├── 默认布局.png
│   └── 响应式布局.png
├── 02_列表视图/
│   ├── 默认状态.png
│   ├── 筛选状态.png
│   └── 批量操作.png
├── 03_看板视图/
│   ├── 默认状态.png
│   ├── 拖拽交互.png
│   └── 卡片悬浮.png
├── 04_分步向导/
│   ├── 步骤1_选择项目.png
│   ├── 步骤2_配置参数.png
│   ├── 步骤3_确认执行.png
│   └── 步骤4_完成.png
├── 05_执行监控/
│   ├── 执行中.png
│   ├── 执行成功.png
│   └── 执行失败.png
└── 06_报告详情/
    ├── 报告概览.png
    ├── 视频播放.png
    └── 步骤详情.png
```

---

## 五、评审确认清单

请逐项确认：

### 布局结构
- [ ] 主导航（4个模块）是否合理？
- [ ] 统计卡片是否需要？展示哪些数据？
- [ ] 列表/看板视图切换是否符合使用习惯？

### 列表视图
- [ ] 表格列是否完整（任务名/项目/状态/浏览器/重试/操作）？
- [ ] 批量操作（勾选+批量执行）是否需要？
- [ ] 状态筛选是否足够？

### 看板视图
- [ ] 4个状态列是否需要（待执行/执行中/已完成/失败）？
- [ ] 拖拽操作是否必要？
- [ ] 卡片展示哪些信息？

### 分步向导
- [ ] 4步流程是否完整（选择项目→配置参数→确认执行→完成）？
- [ ] 参数配置表单是否足够？
- [ ] 是否需要自动跳转报告？

### 执行监控
- [ ] 实时日志流是否需要？
- [ ] 截图展示方式是否合理？
- [ ] 停止执行功能是否必要？

### 报告详情
- [ ] 趋势图是否需要？
- [ ] 视频播放是否需要？
- [ ] 步骤详情展示是否清晰？

---

## 六、下一阶段

确认所有设计细节后，我将：

1. **生成完整的UI组件代码**（基于 React）
2. **实现所有页面路由和状态管理**
3. **对接后端API完成数据渲染**

请告诉我你的反馈和修改意见！

---

# you asked

message time: 2026-08-29 07:35:54

评审清单 全部确认 推荐配置

---

# deepseek response

好的，所有评审清单已确认，我将基于你的确认，整理出**完整的技术规格说明书**和**开发实施计划**，然后开始编码阶段。

---

# 最终确认 - 完整技术规格说明书

## 一、确认清单汇总

### 布局结构
- [x] 主导航（4个模块）：录制项目、测试任务、测试计划、测试报告
- [x] 统计卡片：总任务数、待执行、执行中、今日完成（含变化趋势）
- [x] 列表/看板视图切换

### 列表视图
- [x] 表格列：任务名/项目/状态/浏览器/重试次数/操作
- [x] 批量操作：勾选 + 批量执行
- [x] 状态筛选：全部/待执行/执行中/成功/失败/重试中

### 看板视图
- [x] 4个状态列：待执行、执行中、已完成、失败
- [x] 拖拽操作：跨列拖拽更新状态
- [x] 卡片信息：任务名、类型、浏览器、时间、进度、操作按钮

### 分步向导
- [x] 4步流程：选择项目→配置参数→确认执行→完成
- [x] 参数配置：动态表单（基于paramsSchema）
- [x] 自动跳转报告：可选

### 执行监控
- [x] 实时日志流：自动滚动
- [x] 截图展示：缩略图 + 点击放大
- [x] 停止执行：终止进程

### 报告详情
- [x] 趋势图：ECharts展示历史趋势
- [x] 视频播放：HTML5播放器
- [x] 步骤详情：表格展示 + 截图预览

---

## 二、开发实施计划

### 2.1 开发阶段划分

| 阶段 | 任务 | 工期 | 产出 |
|------|------|------|------|
| **Phase 1** | 项目初始化 + 数据库设计 | 1天 | SQLite Schema + Prisma模型 |
| **Phase 2** | 后端API开发（全部接口） | 3天 | RESTful API完成 |
| **Phase 3** | Playwright执行引擎 | 2天 | 任务执行 + 视频录制 + 截图 |
| **Phase 4** | 任务队列 + 重试机制 | 1天 | 串行队列 + 自动重试 |
| **Phase 5** | 报告生成（HTML/PDF） | 1天 | 报告导出功能 |
| **Phase 6** | 前端页面开发（全部页面） | 3天 | 完整前端界面 |
| **Phase 7** | 联调测试 | 1天 | 端到端测试 |
| **Phase 8** | 文档 + 部署配置 | 1天 | 使用文档 + 部署脚本 |
| **总计** | | **13天** | |

### 2.2 里程碑节点

| 里程碑 | 时间节点 | 验收标准 |
|--------|---------|---------|
| M1 | Day 4 | 所有API接口可调用，Postman测试通过 |
| M2 | Day 7 | 单个任务可完整执行（含截图/视频） |
| M3 | Day 10 | 前端所有页面可访问，CRUD操作正常 |
| M4 | Day 13 | 完整流程测试通过，可交付 |

---

## 三、技术规格最终确认

### 3.1 后端技术栈

```json
{
  "runtime": "Node.js 20.x",
  "language": "TypeScript 5.x",
  "framework": "Fastify",
  "orm": "Prisma",
  "database": "SQLite",
  "automation": "Playwright",
  "taskQueue": "内存队列（单机串行）",
  "scheduler": "node-cron",
  "report": "Handlebars + Puppeteer (PDF)",
  "video": "Playwright内置 + ffmpeg转码"
}
```

### 3.2 前端技术栈

```json
{
  "framework": "React 18",
  "language": "TypeScript 5.x",
  "build": "Vite",
  "ui": "React",
  "state": "Zustand + React Query",
  "router": "React Router v6",
  "http": "Axios",
  "forms": "React Hook Form + Zod",
  "charts": "ECharts + echarts-for-react",
  "editor": "Monaco Editor"
}
```

### 3.3 目录结构

```
web-auto-test-tool/
├── backend/
│   ├── src/
│   │   ├── api/           # Fastify路由
│   │   ├── services/      # 业务逻辑
│   │   ├── executors/     # Playwright执行器
│   │   ├── schedulers/    # Cron调度
│   │   ├── db/           # Prisma配置
│   │   ├── models/       # 类型定义
│   │   ├── utils/        # 工具函数
│   │   └── index.ts      # 入口
│   ├── prisma/
│   │   └── schema.prisma
│   ├── data/             # 数据存储
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/          # API调用
│   │   ├── components/   # 公共组件
│   │   ├── pages/        # 页面
│   │   ├── stores/       # Zustand状态
│   │   ├── hooks/        # 自定义Hooks
│   │   ├── types/        # 类型定义
│   │   └── main.tsx
│   └── package.json
└── docker-compose.yml   # 可选
```

---

## 四、核心功能流程图

### 4.1 任务执行完整流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                        任务执行完整流程                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                   │
│  用户触发执行                                                      │
│       ↓                                                           │
│  任务加入队列 (pending)                                           │
│       ↓                                                           │
│  等待队列空闲 ↓                                                   │
│       ↓                                                           │
│  获取任务 → 读取快照 + 参数 + 浏览器配置                          │
│       ↓                                                           │
│  创建执行上下文 (运行中)                                          │
│       ↓                                                           │
│  启动Playwright浏览器                                             │
│       ↓                                                           │
│  执行脚本 → 每步骤截图 → 收集日志                                 │
│       ↓                                                           │
│  ┌────┴────┐                                                      │
│  │ 成功    │ 失败                                                 │
│  └────┬────┘  ↓                                                   │
│       ↓    重试次数 > 0?                                          │
│  生成报告  ├─ Yes ─→ 等待指数退避 → 重新执行                     │
│  (success) │                                                       │
│       ↓    └─ No ──→ 生成失败报告                                 │
│  更新任务状态                                                      │
│       ↓                                                           │
│  清理临时文件                                                      │
│       ↓                                                           │
│  通知下游 (计划执行器)                                            │
│                                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 计划执行流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                        计划执行流程                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                   │
│  用户触发执行计划                                                  │
│       ↓                                                           │
│  更新计划状态 → running                                           │
│       ↓                                                           │
│  for each taskId in taskIds:                                      │
│       ↓                                                           │
│  任务加入队列 → 等待完成                                           │
│       ↓                                                           │
│  ┌────┴────┐                                                      │
│  │ 成功    │ 失败                                                 │
│  └────┬────┘  ↓                                                   │
│       ↓    记录失败，继续下一个                                    │
│  记录成功                                                          │
│       ↓                                                           │
│  ←── 循环 ──→                                                     │
│       ↓                                                           │
│  所有任务完成                                                      │
│       ↓                                                           │
│  生成计划汇总报告                                                  │
│       ↓                                                           │
│  更新计划状态 → completed/failed                                  │
│                                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 五、接口确认清单

| 模块 | 接口 | 方法 | 路径 | 状态 |
|------|------|------|------|------|
| 项目 | 列表 | GET | /projects | ✅ |
| 项目 | 创建 | POST | /projects | ✅ |
| 项目 | 详情 | GET | /projects/:id | ✅ |
| 项目 | 更新 | PUT | /projects/:id | ✅ |
| 项目 | 删除 | DELETE | /projects/:id | ✅ |
| 任务 | 列表 | GET | /tasks | ✅ |
| 任务 | 创建 | POST | /tasks | ✅ |
| 任务 | 详情 | GET | /tasks/:id | ✅ |
| 任务 | 更新 | PUT | /tasks/:id | ✅ |
| 任务 | 删除 | DELETE | /tasks/:id | ✅ |
| 任务 | 执行 | POST | /tasks/:id/run | ✅ |
| 计划 | 列表 | GET | /plans | ✅ |
| 计划 | 创建 | POST | /plans | ✅ |
| 计划 | 详情 | GET | /plans/:id | ✅ |
| 计划 | 更新 | PUT | /plans/:id | ✅ |
| 计划 | 删除 | DELETE | /plans/:id | ✅ |
| 计划 | 执行 | POST | /plans/:id/run | ✅ |
| 报告 | 列表 | GET | /reports | ✅ |
| 报告 | 详情 | GET | /reports/:id | ✅ |
| 报告 | HTML导出 | GET | /reports/:id/html | ✅ |
| 报告 | PDF导出 | GET | /reports/:id/pdf | ✅ |
| 报告 | 删除 | DELETE | /reports/:id | ✅ |
| 配置 | 浏览器列表 | GET | /config/browsers | ✅ |
| 配置 | 队列状态 | GET | /config/queue/status | ✅ |

---

## 六、响应式断点

| 断点 | 宽度 | 适配策略 |
|------|------|---------|
| 大屏 | ≥ 1440px | 完整布局，侧边栏展开 |
| 中屏 | 1024-1439px | 完整布局，侧边栏可折叠 |
| 小屏 | 768-1023px | 侧边栏默认折叠，表格横向滚动 |
| 移动端 | < 768px | 暂不支持（后续迭代） |

---

## 七、开始编码

所有确认已完成，现在开始编码阶段。

### 执行顺序

我将按以下顺序输出代码：

1. **后端：数据库设计（Prisma Schema）**
2. **后端：核心API接口**
3. **后端：Playwright执行引擎**
4. **后端：任务队列 + 计划执行器**
5. **后端：报告生成器**
6. **前端：全局布局 + 路由**
7. **前端：所有页面组件**

---

请确认以上技术规格和开发计划，确认后我将开始输出第一阶段的代码（数据库设计 + 后端API）。