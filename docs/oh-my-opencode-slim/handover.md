# Workflow / Chat / Gate 恢复完成状态

> 最后更新：2026-05-24

## 已完成

### R1：Stage Runtime Tool 协议

- 恢复 `stage_complete(summary, context)` / `stage_ask_user(summary, question, options?)` tool 注册
- 恢复 `OMO_STAGE_RESULT_PATH` / IPC result file 通道
- 恢复"缺失 stage tool 时明确报错"
- WorkflowManager 只读结构化结果，不再 parse 文本 JSON
- 初始 spawn 加 auto-retry

### R2：Transition Approval / Continue 边界

- 恢复 `transition_approval` 事件
- 恢复 `continueWorkflow()` / `continue_workflow` tool
- 恢复 `transitionPending` / `pendingEvents` 语义
- 恢复默认不自动跨阶段
- 恢复 `workflow_complete` 事件

### R3：非污染通知与 Chat 行为

- `waiting_user` → `notify` + `setStatus`（UI 通知，用户去 chat 回复）
- `transition_approval` → `sendMessage({customType: 'workflow_event'}, {deliverAs: 'followUp', triggerTurn: true})` → 触发主 agent
- `error` → 同上，触发主 agent
- `workflow_complete` → 同上
- 不再 `autoOpenChat`
- completed 状态不会被 process close 覆盖成 dead
- `reject_transition` tool → 拒绝完成申请，回到 waiting_user

### R4：Behavior Reminders / Hard Gate

- hard gate 保持移除
- `[Behavior Reminders]` 不再通过 context 注入
- `compliance_check` 改为主会话 UI 通知 + 状态栏

### P3：Agent 工具权限 / 提示词解耦

- 6 个 stage agent prompt 移除 `# Stage Completion` 章节（无工具名硬编码）
- `buildStageTask` 不包含工具名
- `agents-default.json`：
  - implementer/batch 移除 write/edit 权限
  - coordinator 加 `next: []` 禁止 `switch_mode` 切到 fallback
  - `switch_mode` 检查当前模式的 `next` 列表

## 通知路由

| 事件 | 路径 | 谁看到 |
|------|------|--------|
| `running` | chat 注册 + hub 状态更新 | chat 列表 |
| `waiting_user` | `notify` → UI toast | 用户（去 chat） |
| `transition_approval` | `sendMessage({customType})` + `triggerTurn` | 主 agent 自动响应 |
| `error` | `sendMessage({customType})` + `triggerTurn` | 主 agent 自动响应 |
| `workflow_complete` | `sendMessage({customType})` + `triggerTurn` | 主 agent 自动响应 |
| abort | 不触发 error 通知 | 主 agent 已知 |

## Auto-Retry（不调 tool）

- 第一次不调 tool → `sendPrompt("[System] ...")` 提醒子代理 → 检查回复
- 如果提醒后子代理调了 tool → 计数重置
- 如果提醒后仍然不调 → 计数++ → >= 2 时触发 error 通知
- `consecutiveToolMisses` 跨 `sendUserMessage` 调用追踪

## 工具列表

| Agent | 类型 | 工具 |
|-------|------|------|
| coordinator | mode | workflow 控制工具 + ask_user_question |
| thinker-clarify | subagent | stage_complete, stage_ask_user, read, grep, find, ls, omo_subagent |
| thinker-analysis | subagent | 同上 + context_mode_ctx_search, codebase_memory_*, omo_council |
| designer | subagent | 同上 + write, edit, omo_council |
| worker | subagent | stage_complete, stage_ask_user, todo, omo_subagent, read, grep, find, ls |
| implementer | subagent | stage_complete, stage_ask_user, read, todo, omo_subagent |
| batch | subagent | stage_complete, stage_ask_user, read, omo_subagent |
| fallback | mode | 空（全部可用） |

## 测试结果

- `bun test src/adapters/` → 84 pass, 0 fail
- `bun run typecheck` → PASS
- `bun run build:plugin` → PASS
- 人工 E2E：research-only 完整链路（clarify → analysis）通过

## Checkpoint

- `9453d4c` docs: add workflow/chat recovery baseline
- `2a28919` fix(pi): restore workflow stage protocol and approval boundary
- `cdb15c6` fix(workflow): complete P0/P1 recovery - notification routing, prompt decoupling, auto-retry, rejection flow
- `1f522a4` fix(workflow): P3 - restrict switch_mode, remove write/edit from implementer/batch

## 待处理

- P4：清理 recovery 临时文件，合并回 handover
- 剩余 P3 检查：thinker-analysis 的 context_mode_ctx_search 是否需要
