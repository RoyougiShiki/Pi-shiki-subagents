# 交接文档：模式切换 → 链式子代理 Workflow

## 当前状态

已完成 9/10 个任务，仅剩 Task 10（codemap 更新）未做。编译通过，零错误。

## 已完成

| # | 任务 | 状态 |
|---|------|------|
| 1 | 删除 multiplexer 模块 | ✅ |
| 2 | workflow 类型定义 + PluginConfig 集成 | ✅ |
| 3 | 创建 WorkflowManager | ✅ |
| 4 | 创建 coordinator agent prompt | ✅ |
| 5 | workflow 工具和命令 | ✅ |
| 6 | Chat overlay auto-open | ✅ |
| 7 | agents-default.json 更新 | ✅ |
| 8 | pi-modes.ts 简化 | ✅ |
| 9 | pi.ts 集成 | ✅ |
| 10 | 更新 codemap | ⏳ |

## 已删除
- src/multiplexer/、docs/multiplexer-integration.md、dist/multiplexer/
- schema.ts 中 multiplexer/tmux 字段
- loader.ts 中 migrateTmuxToMultiplexer
- index.ts 中 multiplexer 类型导出
- opencode.ts 中 multiplexer 引用
- src/cli/ 中 tmux 残留

## 新增文件
- src/core/workflow-types.ts — WorkflowNode/ChoiceNode/StageOutput
- src/adapters/workflow-manager.ts — WorkflowManager
- src/adapters/workflow-commands.ts — start_workflow/list_workflows/select_branch
- src/adapters/agents/coordinator.md — coordinator prompt

## 修改文件
- schema.ts — 新增 WorkflowsConfigSchema
- agents-default.json — coordinator 新增，mode→subagent
- pi-modes.ts — 删 next/blocked，默认 coordinator
- pi.ts — 集成 WorkflowManager，删 mode 注入
- pi-chat-bridge.ts — 加 autoOpenChat
- 5 个 .md 提示词 — 删 switch_mode，加 Pipeline 契约

## 待评估：旧 orchestrator/gate 系统

src/agents/orchestrator.ts（buildOrchestratorPrompt）和 src/core/workflow-templates.ts（四个 gate 指令）当前未被调用也未删除。

需要决定：
- IntentGate → 精简版移到 coordinator.md？
- Communication 原则 → 精简版移到 coordinator.md？
- Workflow 1-6 → 被 WorkflowManager 取代，删？
- Constraints → coordinator 不写代码，删？
- Agent descriptions → 保留参考？
