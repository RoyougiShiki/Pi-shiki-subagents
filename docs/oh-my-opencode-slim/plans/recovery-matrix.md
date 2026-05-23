# Workflow / Chat / Gate 恢复矩阵

> 依据：
> - 用户对旧正确行为的确认
> - 上一个 2026-05-23 主 Pi session：`2026-05-23T07-20-05-394Z_019e53b4-9a11-7095-a1f1-95efdb983a30.jsonl`
> - 当前源码/当前表现与之对照

## 1. 总体恢复顺序

1. workflow runtime tool 协议
2. transition approval / continueWorkflow 边界
3. 非污染主会话通知
4. `/chat` workflow 场景
5. water-level / behavior reminders

## 2. 恢复矩阵

| 领域 | 曾经正确状态 | 当前状态 | 优先级 | 恢复目标 |
|---|---|---|---|---|
| Stage 协议 | 子代理调用 `stage_complete` / `stage_ask_user` | 仍依赖文本 StageOutput JSON | P0 | 恢复 runtime tool 协议 |
| Stage 传输通道 | 通过 `OMO_STAGE_RESULT_PATH` / IPC result file | 当前未见 IPC 路径 | P0 | 恢复结构化 stage result 通道 |
| WorkflowManager | 只读结构化结果，缺失工具调用时报错 | 当前 parse/repair 普通 JSON 文本 | P0 | 移除文本 JSON 正常协议 |
| Stage 完成边界 | 子代理只能申请完成 | 当前会直接 complete 并推进 | P1 | 恢复申请完成 → 用户批准 → continue |
| Workflow 运行模式 | `start_workflow`/`continue_workflow` 异步返回 | 当前需复核，表现已漂移 | P1 | 恢复异步运行 + pending events |
| Transition approval | 主会话通知主 agent，用户授权继续 | 当前丢失/漂移 | P1 | 恢复 transition approval 通知与边界 |
| needs_user | 阶段内提问，不混同授权 | 当前与普通 chat/JSON 泄漏混杂 | P1 | 恢复 stage 内提问语义 |
| 主会话通知 | 主 agent 可见但不污染 context | 当前需复核，sendMessage 曾有污染顾虑 | P2 | 恢复非污染通知通道 |
| Chat overlay | 不强制 auto-open | 当前仍会 auto-open | P2 | 禁止 workflow stage 自动弹 overlay |
| Chat 内容 | 不展示 raw JSON / tool noise | 当前会显示 StageOutput JSON | P2 | 过滤/抑制内部结构化结果泄漏 |
| `/chat` 状态 | 主动进入查看，轻量状态可观测 | pool 场景已修，workflow 场景失败 | P2 | 在恢复协议后重做 workflow 场景验收 |
| Completed 状态 | completed/done 可区分于 dead | 当前 completed stage 可能显示 dead | P2 | 恢复用户可理解的完成状态 |
| hard gate | 已移除 | 当前工作区已补删并提交 | P3 | 保持移除状态，防止回归 |
| water-level / behavior reminders | 非阻断、通知式、主 agent 可见 | 当前仅 baseline 记录 | P3 | 在通知机制恢复后补实现 |

## 3. 上一主 session 已确认的实现痕迹

### 3.1 runtime tool 协议

上一主 session 明确记录过：

- `stage_complete(summary, context)`
- `stage_ask_user(summary, question, options?)`
- `OMO_STAGE_RESULT_PATH`
- `WorkflowManager` 只读 result file
- 子代理未调用工具时应报错：
  - `Stage did not call stage_complete or stage_ask_user`

### 3.2 approval / continue 边界

上一主 session 明确记录过：

- 默认 workflow 不自动跨阶段
- stage complete 后停在 `transition_approval`
- 用户明确同意后主 agent 才调用 `continue_workflow`
- `transition_approval` 主动推送到主会话
- `transition_approval` 不进入子代理 overlay

### 3.3 非污染通知

上一主 session 明确记录/讨论过：

- `pi.sendMessage({ triggerTurn: true })` 曾用于主动通知主会话
- 但该方案存在“进入主 agent 上下文”的污染顾虑
- 所以恢复时必须确认“主会话可见”与“上下文污染”分离

### 3.4 JSON / tool 噪音抑制

上一主 session 明确讨论过：

- 不让模型输出 JSON
- 不把工具调用日志传给用户
- 不把 raw message 传给其他子代理
- `suppressAgentEndMessages` 曾被提到用于挡 raw JSON 泄漏

## 4. 当前执行策略

### Step A：恢复 P0 协议

目标：

- stage_complete / stage_ask_user
- OMO_STAGE_RESULT_PATH
- WorkflowManager 只读结构化结果
- 缺失 tool 报错

当前进展（本轮已完成）：

- 已恢复 `stage_complete` / `stage_ask_user` tool 注册。
- 已恢复 `writeWorkflowStageResult()` 与 `OMO_STAGE_RESULT_PATH` 写文件链路。
- 已恢复 `buildSubagentEnv(... stageResultPath)` 透传环境变量。
- 已将 `WorkflowManager` 从文本 JSON parse/repair 切回“只读 stage result file”。
- 已恢复“缺失 stage tool 时明确报错”：`Stage did not call stage_complete or stage_ask_user`。
- 已把 stage agent 默认工具集补回 `stage_complete` / `stage_ask_user`。
- 当前验证：
  - `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
  - `bun run typecheck` PASS
  - `bun run build:plugin` PASS

### Step B：恢复 P1 边界

目标：

- transition approval
- continueWorkflow
- pending event / inbox
- 异步 workflow

当前进展（本轮已完成）：

- 已恢复 `transition_approval` 事件。
- 已恢复 `continueWorkflow()` / `continue_workflow`。
- 已恢复 `transitionPending` / `pendingEvents` / `status().transition`。
- 已恢复“stage complete 后默认不自动跨阶段”。
- 已恢复 `workflow_complete` 事件。
- 已将 coordinator 工具列表补回 `continue_workflow`。
- 当前验证：
  - `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
  - `bun run typecheck` PASS
  - `bun run build:plugin` PASS

### Step C：恢复 P2 通知与 chat

目标：

- 非污染主会话通知
- 禁止 auto-open overlay
- 抑制 StageOutput JSON / tool 噪音
- workflow `/chat` 场景重验

当前进展（本轮已完成基础恢复）：

- 已移除 workflow stage `message` → `autoOpenChat` 自动弹出。
- 已将 `waiting_user` / `transition_approval` / `workflow_complete` / `error` 改为主会话 `notify` + `setStatus` 路径。
- 已修正 workflow chat `done` 状态不会在 process close 后被覆盖成 `dead`。
- 由于 R1 已恢复 stage tool 协议，workflow stage 正常路径不再依赖 raw StageOutput JSON 文本。
- 当前验证：
  - `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
  - `bun run typecheck` PASS
  - `bun run build:plugin` PASS

仍待人工/真实验收：

- workflow stage `/chat` 真实场景是否不再强制 auto-open；
- workflow stage 完成/提问时主会话通知是否符合旧设计；
- raw JSON/tool noise 是否彻底不再对用户可见。

### Step D：恢复 P3 行为提醒

目标：

- hard gate 保持移除
- water-level / behavior reminders 走通知，不拦截

当前进展（本轮已完成最小收口）：

- 已移除会污染模型上下文的 `[Behavior Reminders]` context 注入。
- 已将可选 `compliance_check` 的提醒路径改为主会话 UI 通知 + 状态栏，而不再 `sendUserMessage(... followUp)` 进入主 agent 对话。
- 当前验证：
  - `bun test src/adapters/pi.test.ts src/adapters/workflow-manager.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/subagent-pool.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
  - `bun run typecheck` PASS
  - `bun run build:plugin` PASS

仍待后续增强：

- 真正的 water-level 检测阈值/信号源；
- 行为规范提示与完成许可通知的统一 UI 机制；
- 主 agent 可见但不污染上下文的最终通知通道确认。

## 5. 当前已保护提交

- `d218f33 fix(pi): stabilize chat observability and remove hard gates`
- `9453d4c docs: add workflow/chat recovery baseline`

## 6. 恢复任务清单（先收束，再实施）

### R0：保护与记录

- [ ] 所有恢复过程中的修改，持续追加记录到现有计划/恢复文档，避免再次只存在会话记忆。
- [ ] P2 已完成部分（pool 场景状态、底部状态、hard gate 移除）若后续发生兼容性修改，也必须在 `chat-observability-ux` 目录追加记录，不另起遗失性总结。
- [ ] 恢复完成后，将本次恢复专用临时文件清理或合并回正式 handover：
  - `docs/oh-my-opencode-slim/plans/recovery-baseline.md`
  - `docs/oh-my-opencode-slim/plans/recovery-matrix.md`
  - 后续如新增 recovery 临时清单，也在完成时删除/并入正式文档。

### R1：恢复 stage runtime tool 协议

- [ ] 恢复 `stage_complete` / `stage_ask_user`。
- [ ] 恢复 `OMO_STAGE_RESULT_PATH` / IPC result file 通道。
- [ ] 恢复“缺失 stage tool 时明确报错”。
- [ ] 去除 workflow 正常路径对文本 StageOutput JSON 的依赖。

### R2：恢复 workflow 审批边界

- [ ] 恢复 `transition_approval`。
- [ ] 恢复 `continue_workflow` 边界。
- [ ] 恢复默认不自动跨阶段。
- [ ] 恢复 pending event / inbox 语义。

### R3：恢复非污染通知与 chat 行为

- [ ] 恢复主会话通知提问/申请完成。
- [ ] 禁止 workflow stage auto-open overlay。
- [ ] 恢复 raw JSON/tool noise 抑制。
- [ ] 修正 completed stage 被显示为 dead 的问题。

### R4：恢复 water-level / behavior reminders

- [ ] 保持 hard gate 移除。
- [ ] 恢复非阻断行为提醒/水位检测方向。
- [ ] 通知方式复用主会话 UI 机制，不污染主 agent 上下文。

## 7. 当前仍需特别注意

- `docs/oh-my-opencode-slim/handover.md` 仍处于 deleted 状态，尚未处理。
- 旧 `workflow-pool-handover.md` 当前磁盘版本缺失 context-mode 记忆里的稳定状态尾部，后续需重建或补回。
