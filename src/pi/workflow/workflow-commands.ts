import { Type } from "typebox";
import { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "./workflow-manager";
import { WorkflowsConfig } from "../../core/workflow-types";

export function registerWorkflowCommands(
  pi: ExtensionAPI,
  workflowsConfig: WorkflowsConfig,
  manager: WorkflowManager,
): void {

  // ── start_workflow ──
  pi.registerTool({
    name: "start_workflow",
    label: "Start Workflow",
    description: "启动指定名称的 workflow",
    parameters: Type.Object({
      name: Type.String({ description: "Workflow 名称" }),
      input: Type.Optional(Type.String({ description: "初始任务输入（可选）" })),
    }),
    async execute(_toolCallId, params) {
      if (manager.isRunning()) return {
        content: [{ type: "text", text: "已有 workflow 正在运行" }],
        isError: true, details: manager.status(),
      };
      const wf = workflowsConfig.list.find(w => w.name === params.name);
      if (!wf) return {
        content: [{ type: "text", text: `Workflow "${params.name}" 未找到。可用: ${workflowsConfig.list.map(w => w.name).join(", ")}` }],
        isError: true, details: {},
      };
      const stagesDesc = wf.stages.map(s => (s as any).agent || "(choice)").join(" → ");
      manager.runWorkflow(wf, params.input ?? "").catch((err) => {
        console.error(`[workflow] ${wf.name} failed:`, err);
      });
      return {
        content: [{ type: "text", text: `已启动: ${wf.name} (${stagesDesc})` }],
        details: { workflow: wf.name },
      };
    },
  });

  // ── list_workflows ──
  pi.registerTool({
    name: "list_workflows",
    label: "List Workflows",
    description: "查看所有可用 workflow",
    parameters: Type.Object({}),
    async execute() {
      const list = workflowsConfig.list.map(w => {
        const stages = w.stages.map(s => (s as any).agent || "(choice)").join(" → ");
        return `  • ${w.name}: ${w.description}\n    阶段: ${stages}`;
      }).join("\n");
      return {
        content: [{ type: "text", text: `可用 Workflows:\n${list}` }],
        details: { workflows: workflowsConfig.list },
      };
    },
  });

  // ── workflow_status ──
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "查看当前 workflow 运行状态",
    parameters: Type.Object({}),
    async execute() {
      const status = manager.status();
      const pending = status.pendingEvents[0];
      const text = pending?.type === 'transition_approval'
        ? `Workflow stage completed. User approval is required before continuing.\n\nCompleted stage: ${pending.agent}\nSuggested next stage: ${pending.nextStage ?? '(unknown)'}`
        : pending?.type === 'waiting_user'
          ? `Workflow stage is waiting for user input.\n\nStage: ${pending.agent}`
          : JSON.stringify(status, null, 2);
      return {
        content: [{ type: "text", text }],
        details: status,
      };
    },
  });

  // ── continue_workflow ──
  pi.registerTool({
    name: "continue_workflow",
    label: "Continue Workflow",
    description: "在用户同意后继续当前 workflow 到下一阶段",
    parameters: Type.Object({}),
    async execute() {
      const ok = manager.continueWorkflow();
      if (!ok) return {
        content: [{ type: "text", text: "当前没有等待继续的 workflow" }],
        isError: true, details: {},
      };
      return {
        content: [{ type: "text", text: "Workflow continuing asynchronously. Use workflow_status to observe the next pending event." }],
        details: { continued: true },
      };
    },
  });

  // ── send_stage_message ──
  pi.registerTool({
    name: "send_stage_message",
    label: "Send Stage Message",
    description: "向当前运行中的 workflow stage 发送用户补充消息",
    parameters: Type.Object({
      message: Type.String({ description: "要发送给当前 stage 的消息" }),
    }),
    async execute(_toolCallId, params) {
      const result = await manager.sendUserMessage(params.message);
      if (result.error) return {
        content: [{ type: "text", text: result.error }],
        isError: true, details: result,
      };
      return { content: [{ type: "text", text: result.response }], details: result };
    },
  });

  // ── reject_transition ──
  pi.registerTool({
    name: "reject_transition",
    label: "Reject Transition",
    description: "拒绝当前 stage 的完成申请，回到等待用户输入状态",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "可选的拒绝原因或下一步指示，会发送给子代理" })),
    }),
    async execute(_toolCallId, params) {
      const ok = manager.rejectTransition(params.message);
      if (!ok) return {
        content: [{ type: "text", text: "当前没有等待拒绝的完成申请" }],
        isError: true, details: {},
      };
      return {
        content: [{ type: "text", text: "Transition rejected, stage returned to waiting for user input." }],
        details: { rejected: true },
      };
    },
  });

  // ── abort_workflow ──
  pi.registerTool({
    name: "abort_workflow",
    label: "Abort Workflow",
    description: "中止当前 workflow 并停止当前 stage agent",
    parameters: Type.Object({}),
    async execute() {
      manager.abort();
      return { content: [{ type: "text", text: "Workflow aborted" }], details: {} };
    },
  });

  // ── retry_stage ──
  pi.registerTool({
    name: "retry_stage",
    label: "Retry Stage",
    description: "重试当前 workflow stage",
    parameters: Type.Object({
      input: Type.Optional(Type.String({ description: "可选：覆盖重试输入" })),
    }),
    async execute(_toolCallId, params) {
      const result = await manager.retryStage(params.input);
      if (!result.ok) return {
        content: [{ type: "text", text: result.error ?? "Retry failed" }],
        isError: true, details: result,
      };
      return { content: [{ type: "text", text: "Stage retry started" }], details: result };
    },
  });

  // ── /workflow 命令 ──
  pi.registerCommand("workflow", {
    description: "列出可用 workflow。用法: /workflow list",
    handler: async (args, ctx) => {
      const [cmd] = args.trim().split(/\s+/);
      if (cmd === "list") {
        const list = workflowsConfig.list.map(w => {
          const stages = w.stages.map(s => (s as any).agent).join(" → ");
          return `  • ${w.name}: ${w.description}\n    阶段: ${stages}`;
        }).join("\n");
        ctx.ui.notify(`可用 Workflows:\n${list}`, "info");
      }
    },
  });
}
