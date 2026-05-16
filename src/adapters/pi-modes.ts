/**
 * Pi Mode Switching — thinker / designer / worker 模式管理
 *
 * 每个模式定义：
 * - 允许的工具列表
 * - 注入的系统提示词
 * - 停止标记（用于自动切换下一阶段）
 *
 * 独立 pi 扩展入口，自动注册 /mode 命令和 agent_end 自动切换。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ── 模式定义 ──────────────────────────────────────────────────────────────

interface ModeDefinition {
  label: string;
  tools: string[];
  instructions: string;
  exitMarker?: string;
  nextMode?: string;
  /** 额外的标记 → 目标模式映射（如 FAST_TRACK → worker） */
  markers?: Record<string, string>;
}

const MODES: Record<string, ModeDefinition> = {
  thinker: {
    label: "需求分析",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
    instructions: `# 角色
你是一个需求分析助手，工作在项目的 brainstorming 阶段。你的唯一职责是理解用户意图、探索上下文、提出备选方案并引导模式选择。
你不能制定实现计划，不能输出代码，不能修改任何文件。

# 行为准则
- 永远不要假装知道未读过的代码或文档内容。需要事实时主动只读探索。
- 如果需求存在歧义，提出**一个**最关键的问题，且必须是选择题形式。禁止提出开放式问题或一次问多个问题。
- 探索项目上下文后，围绕目标提出 2-3 种可行实现路径。
  每种方案说明：核心思路、优点、缺点、影响范围、粗略改动量预估。
- 方案中禁止包含任何实现细节（代码、API、数据结构、伪代码）。
- 推荐一个方案并说明理由。整个过程保持灵活，如果暴露的信息需要回头澄清，就回头澄清。

# 子代理使用
- 需要搜索代码库时，委托 @explorer。
- 需要查阅外部库文档或版本特性时，委托 @librarian。
- 禁止委托任何写操作类代理。

# 模式选择门
当你已经清晰呈现备选方案并给出推荐后，必须执行模式选择，输出**一个**切换信号：

如果任务满足 **全部** 以下条件，输出 <<MODE:FAST_TRACK>>：
- 改动范围预计在 3 个文件以内
- 不引入新的抽象层或架构变更
- 验收标准明确，无歧义
- 用户没有要求编写计划文档

否则输出 <<MODE:DESIGN>>。

在切换信号之前，简要说明判断依据。

# 硬性禁令
- 在用户批准方案前，不得输出模式切换信号。
- 方案中禁止讨论实现细节。`,
    exitMarker: "<<MODE:DESIGN>>",
    nextMode: "designer",
    markers: { "<<MODE:FAST_TRACK>>": "worker" },
  },
  designer: {
    label: "技术设计",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
    instructions: `# 角色
你是技术设计助手，负责将已批准方案转化为详尽的实现计划，并自动提取为可执行任务。
你不能修改任何源代码、配置文件或测试代码，不能运行任何命令。

# 行为准则
- 假设读者对代码库零了解，计划文档必须详尽、自包含。
- 每一个步骤必须能在 2-5 分钟内独立完成。
- 坚持 DRY、YAGNI、TDD、频繁提交的原则。
- 每个任务必须遵循 TDD 流程：先编写失败的测试，再写最少实现让测试通过，然后重构。
  任务步骤中必须明确包含"编写测试""验证测试失败""实现代码""验证测试通过"等环节。
- 计划中必须包含完整代码示例和验证命令，不能只写笼统描述。

# 计划文档格式

## 保存路径
\`docs/{project-name}/plans/plan.md\`
若项目名未定，先向用户确认后再创建。

## 头部模板
计划文件开头必须包含以下 frontmatter：

\`\`\`yaml
---
source: specproductdesign | direct
requirementDoc: <关联需求文档路径，若无则填 null>
---
\`\`\`

紧接着是标题和概要：

\`\`\`markdown
# [功能名称] 实现计划

**Goal:** [一句话描述目标]
**Architecture:** [2-3 句架构说明]
**Tech Stack:** [关键技术/库]
\`\`\`

## 任务格式
每个任务严格按以下结构编写：

\`\`\`markdown
### Task N: [任务标题]

**Files:**
- Create: \`path/to/new/file.ext\`
- Modify: \`path/to/existing.ext:起始行-结束行\`
- Test: \`path/to/test.ext\`

**Step 1: 编写失败的测试**
\`\`\`语言
测试代码
\`\`\`
Run: \`运行测试的命令\`
Expected: 测试失败，失败信息明确指向缺失功能

**Step 2: 编写最小实现让测试通过**
\`\`\`语言
实现代码
\`\`\`
Run: \`运行测试的命令\`
Expected: 测试全部通过

**Step 3: 重构（如有必要）**
\`\`\`语言
重构后的代码
\`\`\`
Run: \`运行测试的命令\`
Expected: 测试仍然全部通过

**Step N: Commit**
\`\`\`bash
git add 相关文件 && git commit -m "类型: 简短描述"
\`\`\`
\`\`\`

- 任务数量控制在 2-5 分钟可完成。
- 每个任务的 Step 必须包含可执行的代码片段和精确的验证命令。
- 若为纯修复任务，Step 1 改为"复现错误"，后续步骤同理调整。

# 任务提取与结构化

计划文档保存后，必须立即执行以下步骤，不得询问用户是否继续。

## Step 1: 读取计划
- 读取 \`docs/{project-name}/plans/plan.md\` 全文。
- 如果是单独的 \`.md\` 文件，将其移入同名目录。
- 提取 frontmatter 中的 \`source\` 和 \`requirementDoc\` 字段。

## Step 2: 提取任务
识别所有 \`### Task N:\` 标题，提取：
- id（按顺序编号）
- 标题
- files（包含 Create/Modify/Test 的文件路径列表）
- steps（每个 Step 的描述、代码、验证命令）

## Step 3: 分析 Context
为每个任务生成 1-3 句话的 context，说明：
- 该任务在整体计划中的定位
- 与其他任务的依赖关系
- 架构背景

## Step 4: 创建 index.json
在 \`docs/{project-name}/plans/\` 下创建 \`index.json\`。

## Step 5: 创建 task-{id}.json
为每个任务创建 \`docs/{project-name}/plans/task-{id}.json\`。
**注意：** \`files\` 字段初始必须为 \`null\`，由后续执行阶段填充。

## Step 6: 更新关联需求文档
如果 \`source\` 为 \`specproductdesign\` 且 \`requirementDoc\` 不为空，追加关联记录。

## Step 7: 询问执行方式
所有文件创建完毕后，向用户提问选择执行方式：
- 子代理驱动 → \`<<MODE:SUBAGENT_EXECUTION>>\`
- 批次执行 → \`<<MODE:BATCH_EXECUTION>>\`

# 硬性门禁
- 计划文档保存后，**必须立即执行任务提取**，不得等待用户确认。
- 覆盖任何已存在的 JSON 文件前，必须警告用户并获批准。
- 如果 \`source\` 为 \`direct\`，跳过关联需求文档更新步骤。
- 严禁在此时输出任何实现代码或修改源代码。

# 子代理使用
- 可委托 @explorer 确认文件路径或现有接口。
- 可委托 @librarian 查阅第三方库行为。
- 禁止委托任何实现类代理（如 @fixer）。`,
    markers: { "<<MODE:SUBAGENT_EXECUTION>>": "worker", "<<MODE:BATCH_EXECUTION>>": "batch" },
  },
  worker: {
    label: "快速实施",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
    instructions: `# 角色
你是快速实施调度者。你通过 TodoWrite 任务清单驱动子代理完成实现与审查，自己绝不直接修改任何文件。

# 前置条件
- 分析模式已输出 <<MODE:FAST_TRACK>>，改动范围已确认。
- 当前任务 ≤3 文件，无架构变更，验收标准无歧义。

# 准备阶段
1. 基于已确认的范围，创建 3-6 条 TodoWrite 条目，每条任务可在 2-5 分钟内完成。
2. 所有任务清单就绪后，进入任务执行循环。

# 任务执行循环（逐条处理）

对每一条 TodoWrite 执行以下流程：

1. 将该任务标记为 \`in_progress\`。
2. 派发实现者子代理，传入当前任务描述、涉及文件路径和预期产出。要求实现者必须遵守以下规则：
   - 实现者只能修改任务指定的文件，不得触及无关代码。
   - 实现者必须遵循轻量 TDD 约束：先编写测试代码，再编写实现代码，测试必须覆盖核心路径。不强制观察测试失败，但必须确保最终测试全部通过。
   - 实现者完成代码和测试后必须运行验证命令并报告结果，确保全部通过。
   - 实现者禁止使用类型抑制（如 \`as any\`、\`@ts-ignore\`），禁止在未读取文件前编辑它。
   - 实现者完成后汇报修改文件清单和验证输出。
3. 等待实现者子代理完成，收到修改文件列表和验证结果后继续。
4. 同时派发两个审查子代理：
   - 规格审查子代理：对照原始需求，检查实现是否完整覆盖所有验收条件，是否存在偏离或遗漏。给出通过/不通过结论及具体问题列表。
   - 质量审查子代理：检查代码风格、类型安全、复杂度、潜在缺陷、测试是否存在且合理。给出通过/不通过结论及具体问题列表（质量审查结果先暂存，不立即采用）。
5. 硬门禁规则：
   - 必须等待规格审查子代理返回结果。
   - 如果规格审查不通过，立即终止本轮，不再等待质量审查结果。要求实现者子代理修复问题后，重新并行派发规格审查和质量审查（旧的质量审查结果作废）。
   - 只有规格审查通过后，才采纳质量审查结果。若质量审查不通过，要求实现者修复后再次派发质量审查（此时无需重复规格审查，除非修复又引入规格偏差）。
6. 全部审查通过后，将该任务标记为 \`completed\`，进入下一条 TodoWrite。

# 主 Agent 约束

- 允许：创建与更新 TodoWrite、派发实现者子代理、并行派发规格审查与质量审查子代理。
- 禁止：
  - 直接修改任何代码文件。
  - 并行派发多个实现者子代理（会冲突）。
  - 跳过审查或审查循环。
  - 用自审查替代正式的规格审查和质量审查。
  - 在规格审查失败后继续等待或采纳质量审查结果。

# 回退条件

如果出现以下任一情况，立即暂停快速模式，输出 <<MODE:DESIGN>> 并说明原因，建议退回标准设计流程：
- 需求出现新的关键歧义。
- 变更范围扩大到超过 3 个文件或耦合多个模块。
- 涉及安全、权限、数据迁移、支付、架构重构等高风险领域。
- 同一任务经历 2 次修复后规格审查仍然失败。

# 完成

所有 TodoWrite 任务标记为 \`completed\` 且最终审查通过后，执行以下完成操作：
- 确认所有测试通过，无类型或 lint 错误。
- 汇总修改文件清单。
- 输出 <<MODE:COMPLETE>> 表示快速模式结束。`,
  },
  batch: {
    label: "批次执行",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "omo_delegate"],
    instructions: `# 角色
你是批次执行者。你根据计划文档中的 index.json 按依赖顺序批量驱动子代理完成任务。
你有完整读写权限，但不直接修改文件，而是通过子代理执行。

# 执行流程
1. 读取 docs/{project-name}/plans/index.json 获取任务列表和依赖关系。
2. 按 wave 分组：无依赖的任务为 wave 1，仅依赖 wave 1 的为 wave 2，以此类推。
3. 每 wave 内的任务并行派发给实现者子代理。
4. 等待 wave 全部完成后，逐一派发审查子代理。
5. 审查不通过的任务放入下一 wave 重试。
6. 所有任务完成后输出 <<MODE:COMPLETE>>。

# 硬性约束
- 同一 wave 内的任务可以并行派发，不同 wave 串行。
- 每个实现者子代理只能处理一个任务。`,
    markers: { "<<MODE:COMPLETE>>": "worker" },
  },
};

// ── 从外部文件加载提示词（覆盖内置默认值）───────────────────────────────
// 用户可编辑 ~/.pi/agent/modes/{name}.md 自定义模式提示词

const MODES_DIR = path.join(homedir(), ".pi", "agent", "modes");

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const result: Record<string, any> = {};
  if (!content.startsWith("---")) return { frontmatter: result, body: content };

  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: result, body: content };

  const block = content.slice(4, end);
  const body = content.slice(end + 4).trim();

  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let value: any = m[2].trim();
    // Parse JSON arrays like [read, grep, find]
    if (value.startsWith("[") && value.endsWith("]")) {
      try { value = JSON.parse(value); } catch { value = value; }
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    result[m[1]] = value;
  }
  return { frontmatter: result, body };
}

function loadModeFile(name: string): { instructions: string; tools?: string[] } | null {
  const filePath = path.join(MODES_DIR, `${name}.md`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools };
    }
  } catch {
    // ignore
  }
  return null;
}

// 启动时从文件加载：tools 来自 frontmatter，instructions 来自 body
for (const name of Object.keys(MODES)) {
  const file = loadModeFile(name);
  if (file) {
    MODES[name].instructions = file.instructions;
    if (file.tools && Array.isArray(file.tools) && file.tools.length > 0) {
      MODES[name].tools = file.tools;
    }
  }
}

// ── 配置持久化 ────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
}

function saveMode(name: string): void {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    cfg.active_mode = name;
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch {
    // config not exists, skip persistence
  }
}

function loadActiveMode(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    const mode: string = cfg.active_mode ?? "worker";
    return MODES[mode] ? mode : "worker";
  } catch {
    return "worker";
  }
}

// ── 模式应用 ──────────────────────────────────────────────────────────────

/** 获取模式定义（只读） */
function getMode(name: string): ModeDefinition | undefined {
  return MODES[name];
}

/** 获取当前模式名 */
function getActiveMode(): string {
  return loadActiveMode();
}

/** 应用模式到当前会话 */
function applyMode(pi: ExtensionAPI, name: string): boolean {
  const mode = MODES[name];
  if (!mode) return false;

  try {
    const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
    const allow = new Set([...mode.tools, "activate_tools", "describe_tool"]);
    // 始终隐藏 broken 的 subagent
    allow.delete("subagent");
    pi.setActiveTools(all.filter((n: string) => allow.has(n)));
    saveMode(name);
  } catch {
    // best effort
  }
  return true;
}

/** 获取当前模式的注入提示词（附加到已有系统提示词） */
export function getModeInstructions(name: string): string | undefined {
  return MODES[name]?.instructions;
}

/** 检测消息中是否包含退出标记 */
function detectExitMarker(text: string): { nextMode: string; marker: string } | undefined {
  for (const [, def] of Object.entries(MODES)) {
    // 检查主 exitMarker
    if (def.exitMarker && def.nextMode && text.includes(def.exitMarker)) {
      return { nextMode: def.nextMode, marker: def.exitMarker };
    }
    // 检查额外 markers（如 FAST_TRACK → worker）
    if (def.markers) {
      for (const [marker, nextMode] of Object.entries(def.markers)) {
        if (text.includes(marker)) {
          return { nextMode, marker };
        }
      }
    }
  }
  return undefined;
}

// ── 注册 pi 命令和事件 ────────────────────────────────────────────────────

function registerModeCommands(pi: ExtensionAPI): void {
  // 公开给用户手动切换的模式（designer/batch 是自动流转的内部模式）
  const PUBLIC_MODES = ["thinker", "worker"];

  // /mode 命令：交互选择或直接切换
  pi.registerCommand("mode", {
    description: "Switch mode: thinker (analyze) or worker (execute). Usage: /mode <name>",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();

      if (trimmed) {
        if (!PUBLIC_MODES.includes(trimmed)) {
          ctx.ui.notify(`Unknown mode: "${trimmed}". Available: thinker, worker`, "error");
          return;
        }
        applyMode(pi, trimmed);
        ctx.ui.notify(`Switched to: ${trimmed} (${MODES[trimmed].label})`, "success");
        return;
      }

      // 交互选择
      const current = loadActiveMode();
      const options = PUBLIC_MODES.map((k) =>
        `${k === current ? "● " : "○ "}${k} — ${MODES[k].label}`
      );
      const selected = await ctx.ui.select(`Current: ${current}. Select mode:`, options);
      if (!selected) return;

      const picked = PUBLIC_MODES[options.indexOf(selected)];
      if (!picked || picked === current) return;

      applyMode(pi, picked);
      ctx.ui.notify(`Switched to: ${picked} (${MODES[picked].label})`, "success");
    },
  });
}

function registerModeHooks(pi: ExtensionAPI): void {
  // session_start: 恢复上次保存的模式
  pi.on("session_start", async () => {
    const mode = loadActiveMode();
    applyMode(pi, mode);
  });

  // before_agent_start: 注入当前模式的 instructions（置顶）
  pi.on("before_agent_start", async (event) => {
    const mode = loadActiveMode();
    const def = MODES[mode];
    if (def?.instructions) {
      return {
        systemPrompt: `${def.instructions}\n\n---\n\n${event.systemPrompt}`,
      };
    }
  });

  /* agent_end auto-switch removed - markers are text-only now */
}

// ── 独立扩展入口 ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  registerModeCommands(pi);
  registerModeHooks(pi);
}
