/**
 * Prompt 模板管理器（内置 ui_locator_heal / ui_ai_act / ui_agent_plan 三条模板与渲染器）。
 * 1:1 对照 smartbrowser/src/smartbrowser/prompts.py。
 *
 * 差异（C 类，与 Python 版一致）：
 * - DB 查询分支替换为可注入的 setDbTemplateFetcher（默认 null → 纯代码最新版）
 * - 无 ensure_initialized（不写库）
 *
 * 验收硬要求：三条模板中文文案逐字保留（ACCEPTANCE.md 2.2）。
 */

export interface PromptTemplateMeta {
  name: string;
  scene_type: string;
  description: string;
  system_prompt: string;
  user_prompt_template: string;
  examples: unknown[];
}

export interface ResolvedTemplate extends PromptTemplateMeta {
  code: string;
  version: number;
  is_default: boolean;
}

/** 可注入的 DB 模板查询 hook：async (code) => template | null */
export type DbTemplateFetcher = (code: string) => Promise<Record<string, unknown> | null>;

export class PromptManager {
  /** 预置模板（系统默认）——文案与 prompts.py DEFAULT_TEMPLATES 逐字一致 */
  static readonly DEFAULT_TEMPLATES: Record<string, PromptTemplateMeta> = {
    ui_locator_heal: {
      name: "UI 定位器自愈",
      scene_type: "ui_case",
      description: "步骤执行失败时基于 snapshot 推荐新 locator",
      system_prompt:
        "你是 Playwright 定位专家。根据页面 snapshot 和失败信息，" +
        "推荐一个更可能成功的 locator。严格输出 JSON，不要 Markdown。", // eslint-disable-line quotes
      user_prompt_template: `步骤方法：{{method}}
失败定位器：{{failed_locator}}
业务意图（intent，优先）：{{step_intent}}
操作名称（desc）：{{step_desc}}
错误信息：{{error_message}}
页面 URL：{{page_url}}
Snapshot 类型：{{snapshot_type}}

页面 snapshot：
{{accessibility_snapshot}}

输出 JSON：
{
  "locator": "新定位器",
  "confidence": "high|medium|low",
  "reason": "简要说明"
}

定位器规则（必须是字符串，禁止 Playwright 函数写法）：
- 正确：get_by_placeholder=密码、get_by_role=row, 0302、#loginBtn
- 错误：get_by_placeholder("密码")、page.get_by_role(...)、get_by_role='row'（role/name 禁止加引号）、get_by_role=button, name="登入"（禁止写 name= 前缀，应写 get_by_role=button, 登入）、row=0302（必须用 get_by_role=row, 0302）
- 优先 data-testid、#id、name、get_by_role=、get_by_placeholder=、get_by_label=
- get_by_text= 对 **真实 input/textarea 的 placeholder 属性**无效；此时改用 get_by_placeholder=
- **严禁**把组件展示层文案（如「请选择 / Please select」）当成 placeholder 改写成 get_by_placeholder=
- 严禁返回与失败定位器完全相同的字符串
- **错误含 intercepts pointer events 时（R1）**：禁止继续推荐与失败定位器等价的「纯文案 / 展示占位节点」；应推荐能完成点击的控件（报错中的拦截者，或其 combobox / button / listbox 祖先）
- **placeholder vs 展示文案（R2）**：
  - 对：\`<input placeholder="请输入">\` → get_by_placeholder=请输入；错：get_by_text=请输入
  - 对：TreeSelect/Select 展示 \`<span>请选择</span>\` 且错误含 intercepts pointer events → get_by_role=combobox（可加 label/nth）或可点祖先；错：get_by_placeholder=请选择、get_by_text=请选择 置顶（拼接邻近文案）
- **错误含 element is not visible 时**：禁止继续用 (//xpath)[1] 等纯序号定位；改用可见结构特征（如含操作按钮的行、唯一 id、title 等）
- **业务意图 step_intent 是操作目标（R4）**：新定位器必须能完成 intent 描述的操作；优先对齐表单项 label 再用 combobox，禁止改成邻近开关文案（如「置顶」）
- 页面上有多个相似文案时，选与 step_intent **完全匹配** 或 **更长更具体** 的那个，禁止用更短子串替代（例：失败 get_by_text=基础设置 时禁止改成 get_by_text=设置）
- 常见短词（设置、登录、确定等）易重复，优先用带区域/结构信息的定位（侧栏菜单、顶栏导航、父级 class 等），必要时配合 index
- **弹窗/浮层内元素（R3）**：优先 \`弹窗容器 >> get_by_text=\` 或 \`get_by_role=dialog >> ...\`；禁止裸 \`get_by_text=请选择\` 全页搜索
- **文本含 $ 或反斜杠时禁止** \`tag:has-text("...")\`（Playwright CSS 会报 BADSTRING），必须用 \`get_by_text=\` 或 \`父级 >> get_by_text=\`
- 只输出 JSON 对象`,
      examples: [],
    },
    ui_ai_act: {
      name: "UI AI Act 兜底",
      scene_type: "ui_case",
      description: "定位器自愈失败后，基于 snapshot 规划一步可执行操作",
      system_prompt:
        "你是 UI 自动化专家。某步骤已失败且换 locator 仍无法完成，" +
        "请根据页面 snapshot 与业务意图，规划**一步**可立即执行的 Playwright 步骤。" +
        "严格输出 JSON，不要 Markdown。",
      user_prompt_template: `原步骤方法：{{method}}
失败定位器：{{failed_locator}}
业务意图（intent）：{{step_intent}}
操作名称（desc）：{{step_desc}}
错误信息：{{error_message}}
页面 URL：{{page_url}}
原步骤 params（JSON）：{{original_params}}
Snapshot 类型：{{snapshot_type}}

页面 snapshot：
{{accessibility_snapshot}}

输出 JSON：
{
  "confidence": "high|medium|low",
  "reason": "简要说明",
  "step": {
    "method": "与原步骤相同或更合适的英文方法名",
    "desc": "一步操作描述",
    "params": { "locator": "..." }
  }
}

规则：
1. 只输出**一步**，method 仅限：click_ele, fill_value, double_click_ele, clear_value, hover, select_option, type_value, drag_and_drop, wait_for_element, press_key
2. params.locator 必须是字符串；优先 data-testid、#id、get_by_role=、get_by_placeholder=（仅真实 input/textarea 的 placeholder 属性）
3. 必须完成业务意图 intent 描述的操作，禁止点到相似但错误的元素；优先对齐表单项 label，勿点邻近「置顶」等无关控件
4. 拖拽类保留 start_selector/end_selector；输入类保留 value（可沿用原 params）
5. **错误含 intercepts pointer events**：禁止对展示文案「请选择」使用 get_by_placeholder=；应规划点击 combobox/button 或拦截者祖先
6. **placeholder vs 展示文案**：
   - 对：真实 \`<input placeholder="请输入">\` → get_by_placeholder=请输入
   - 错：\`<span>请选择</span>\` / 选择器展示占位 → get_by_placeholder=请选择
7. 弹窗内操作优先 \`get_by_role=dialog >> ...\`；禁止裸全页 get_by_text=请选择
8. locator 须为平台字符串规范（禁止 get_by_placeholder("x") 函数写法）
9. 只输出 JSON 对象`,
      examples: [],
    },
    ui_agent_plan: {
      name: "UI Agent 单步规划",
      scene_type: "ui_case",
      description: "基于无障碍树 snapshot 规划下一步 UI 操作（MCP 思路）",
      system_prompt:
        "你是一位 UI 自动化 Agent。根据页面无障碍树 snapshot 和用户目标，" +
        "每次只规划**下一步**操作。你必须严格输出 JSON 对象，不要 Markdown 代码块。" +
        "定位器必须来自 snapshot 中当前可见、可交互的元素，严禁编造或对 hidden 元素做 wait。" +
        "定位优先级：data-testid > #id > get_by_role > name/label/placeholder > get_by_text（末选）。" +
        "用户目标可能包含**多个子任务**（例如『登录成功后再遍历点击每个子菜单』），" +
        "必须按顺序逐项执行完毕，绝不可在只完成部分子任务时就判定结束。" +
        "当用户意图只是**了解/询问当前页面**（例如『这页面有什么』『这按钮能点吗』" +
        "『有哪些输入框』『下一步该做什么』）时，不要规划任何操作，" +
        "改为输出 type=qa，并基于 snapshot 用中文向用户说明当前页面的可操作模块、按钮、输入框、链接。",
      user_prompt_template: `用户目标：{{description}}
当前页面 URL：{{current_url}}
当前是第 {{step_index}} 步规划
Snapshot 类型：{{snapshot_type}}

{% if has_stuck_hint %}
【本轮必读】{{stuck_hint}}
{% endif %}

{% if executed_steps %}
已执行步骤（JSON）：
{{executed_steps}}
{% endif %}

页面无障碍树 / 元素 snapshot：
{{accessibility_snapshot}}

请输出单个 JSON 对象（不是数组）：
{
  "done": false,
  "message": "若 done=true 时说明完成原因",
  "step": {
    "keyword": "中文动作名",
    "method": "英文方法名",
    "desc": "步骤描述",
    "params": {},
    "children": []
  }
}
若用户意图是了解/询问当前页面，则输出：
{
  "type": "qa",
  "answer": "用中文说明当前页面可操作的模块、按钮、输入框、链接"
}

规则：
0. 当用户意图是**了解/询问当前页面**（如『这页面有什么』『这能点吗』『有哪些输入框』）时，
   只输出 type=qa + answer（不输出 step/done），answer 需具体列出 snapshot 中可见可交互的元素。
1. 仅当用户目标中的**全部子任务**都已依次完成（不可遗漏任何一项），才设 done=true，step 可省略；
   若目标含多个子项（例如『登录成功后需遍历点击每个子菜单』），必须逐项执行并核验，
   只完成其中一部分（如仅登录）**不算**完成。
2. 若还有任一子任务未完成，设 done=false，step 仅包含**一步**
3. method 仅限：open_url, fill_value, click_ele, hover, select_option, type_value, clear_value,
   wait_for_time, wait_for_element, wait_for_load, press_key, scroll_to_height
   （页面滚动仅用 scroll_to_height + params.height；严禁 scroll / scroll_down / scroll_up / scroll_to）
4. params.locator 必须是**字符串**（禁止 JSON 对象）。**点击按钮/链接**时按优先级选用（snapshot 里有什么用什么）：
   - 有 id → \`#btn-login\` 或 \`//button[@id='btn-login']\`
   - 有 data-testid → \`[data-testid=xxx]\`
   - 否则 → \`get_by_role=button, <按钮完整可见名称>\`（名称与 snapshot 一致，含空格）
   - **仅当**无 id/role 且文本唯一时，才用 \`get_by_text=\`；禁止用「登录」「提交」等短词（易误点说明文字）
5. **输入框**：\`#id\` > \`get_by_label=\` > \`get_by_placeholder=\`；禁止对 placeholder 用 get_by_text=
6. **优先 click_ele / hover 完成导航**；同一按钮已成功点击且 snapshot 已换屏后，不得再次 click 同一 locator
7. **禁止**与已执行步骤相同的 method+locator；若结构未变说明点错，必须换 #id 或 get_by_role
8. **禁止**滥用 wait_for_element 等待 hidden 节点；应直接 click 可见父级
9. 用户描述「点击 XX 按钮」时，locator 必须对应 snapshot 里该 button 的 id 或 role+name，不要编造
10. **父级分组菜单**：当 stuck_hint 指明「某词是父级分组/入口菜单项，请直接点击其下子项」时，必须点击该子项，禁止再点父级分组；子项可用「父级 >> 子级」链式定位或 get_by_role=menuitem, 子项名
11. 只输出 JSON 对象`,
      examples: [],
    },
  };

  /** 可注入 DB 模板查询 hook；默认 null 表示无用户自定义模板（走纯代码模板） */
  private static _get_db_template: DbTemplateFetcher | null = null;

  static setDbTemplateFetcher(fetcher: DbTemplateFetcher | null): void {
    PromptManager._get_db_template = fetcher;
  }

  private static resolveDefaultTemplate(code: string): PromptTemplateMeta | null {
    if (!(code in PromptManager.DEFAULT_TEMPLATES)) return null;
    const data = PromptManager.DEFAULT_TEMPLATES[code];
    if (!data) return null;
    return { ...data };
  }

  /**
   * 获取指定模板的完整内容。
   * 用户自定义模板优先；默认模板始终使用代码中的最新版本（确保代码更新即时生效）。
   */
  static async getTemplate(code: string): Promise<ResolvedTemplate> {
    let dbTemplate: Record<string, unknown> | null = null;
    const dbFetcher = PromptManager._get_db_template;
    if (dbFetcher !== null) {
      dbTemplate = await dbFetcher(code);
    }

    // 如果存在用户自定义模板（非默认），使用自定义版本
    if (dbTemplate && !dbTemplate["is_default"]) {
      return {
        code: (dbTemplate["code"] as string) || code,
        name: (dbTemplate["name"] as string) || "",
        scene_type: (dbTemplate["scene_type"] as string) || "",
        description: (dbTemplate["description"] as string) || "",
        system_prompt: (dbTemplate["system_prompt"] as string) || "",
        user_prompt_template: (dbTemplate["user_prompt_template"] as string) || "",
        examples: (dbTemplate["examples"] as unknown[]) || [],
        version: (dbTemplate["version"] as number) || 1,
        is_default: false,
      };
    }

    const def = PromptManager.resolveDefaultTemplate(code);
    if (!def) throw new Error(`未知的 Prompt 模板编码: ${code}`);

    return {
      code,
      name: def.name,
      scene_type: def.scene_type,
      description: def.description,
      system_prompt: def.system_prompt,
      user_prompt_template: def.user_prompt_template,
      examples: def.examples,
      version: 1,
      is_default: true,
    };
  }

  /** 渲染 Prompt，返回 [system_prompt, user_prompt]（对齐 PromptManager.render） */
  static async render(code: string, context: Record<string, unknown>): Promise<[string, string]> {
    try {
      const templateData = await PromptManager.getTemplate(code);
      const system = templateData.system_prompt;
      const userTemplateText = templateData.user_prompt_template;
      const keys = Object.keys(context)
        .map((k) => `'${k}'`)
        .join(", ");
      console.warn(
        `[render] code=${code}, template_length=${userTemplateText.length}, context_keys=[${keys}]`,
      );
      if (!userTemplateText) {
        throw new Error(`模板 ${code} 的 user_prompt_template 为空`);
      }
      const user = renderJinja(userTemplateText, context);
      console.warn(`[render] 渲染成功, user_prompt_length=${user.length}`);
      return [system, user];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`渲染模板失败: ${msg}`);
    }
  }

  /** 从 Jinja2 模板中提取 {{变量名}} 变量列表（去重并保持顺序） */
  static extractVariables(templateText: string): string[] {
    const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(templateText)) !== null) {
      matches.push(m[1]!);
    }
    return Array.from(new Set(matches));
  }
}

// ============================================================
// mini-Jinja 渲染器（覆盖三条模板用到的语法：{{ var }} 与 {% if %}/{% endif %}）
// 空白语义对齐 Jinja2 默认（无 trim_blocks/lstrip_blocks）：标签本身不产生输出，
// 标签后的换行保留、标签前内容保留。
// ============================================================

function jinjaValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Python 端 context 传入的多为预序列化字符串；对象兜底用 JSON
  return JSON.stringify(v);
}

function evalExpr(expr: string, context: Record<string, unknown>): unknown {
  const key = expr.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`不支持的 Jinja2 表达式: ${expr}`);
  }
  return context[key];
}

export function renderJinja(template: string, context: Record<string, unknown>): string {
  const tokenRe = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;
  const out: string[] = [];
  const stack: boolean[] = []; // 每层 if 的 active 状态
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  const active = (): boolean => stack.every(Boolean);

  while ((m = tokenRe.exec(template)) !== null) {
    // 非活跃 if 块内的纯文本同样抑制（对齐 Jinja2 语义）
    if (active()) out.push(template.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
    const tok = m[0];

    if (tok.startsWith("{{")) {
      if (active()) {
        out.push(jinjaValue(evalExpr(tok.slice(2, -2), context)));
      }
      continue;
    }

    // {% ... %}
    const inner = tok.slice(2, -2).trim();
    const ifMatch = /^if\s+([\s\S]+)$/.exec(inner);
    if (ifMatch) {
      const val = active() ? evalExpr(ifMatch[1]!, context) : undefined;
      stack.push(active() && Boolean(val));
    } else if (inner === "endif") {
      if (stack.length === 0) throw new Error("不匹配的 {% endif %}");
      stack.pop();
    } else {
      throw new Error(`不支持的 Jinja2 标签: ${inner}`);
    }
  }
  if (active()) out.push(template.slice(lastIndex));
  if (stack.length) throw new Error("Jinja2 模板存在未闭合的 {% if %}");
  return out.join("");
}
