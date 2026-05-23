# P2 `/chat` 状态可观测性 UX 设计方案

## 0. 已确认的 UX 方向

`/chat` 的对象是子代理 / pool agent 会话，不是 workflow 本身。因此 P2 第一版不做专门 workflow 状态命令，也不做 full panel。

已确认采用：**分组列表 + 底部短状态行**。

列表按 scope 分组，默认行只显示 agent 名、状态、耗时：

```text
Workflow
  thinker-analysis · working · 05:12
  thinker-analysis · waiting · 00:40

Pool
  fixer-1 · idle · 02:10
```

进入或选中某个 chat 后，底部显示同样极简状态：

```text
thinker-analysis · working · workflow
```

其中：

- `working` / `waiting` 等是子代理自身状态，普通 pool agent 和 workflow stage agent 都可用。
- `workflow` / `pool` / `standalone` 只是 scope，不展开 workflow/stage 细节。
- 完整 workflow/stage/poolId 放到二级详情，不放在默认行里。

## 1. 目标

让用户在 `/chat` 中一眼判断：

- 当前正在和哪个子代理聊天；
- 这个子代理是在 working、idle、waiting、failed、dead 还是 completed；
- 它属于 `Workflow`、`Pool` 还是 `Standalone` 分组；
- 同名 agent 同时存在时，能通过分组、状态、耗时做初步区分；
- 失败/超时时是否建议切换 fallback。

本轮先确认 UX，不急于实现。

## 2. 设计原则

1. **agent 为主语**：`/chat` 行描述当前 chat 对象，而不是整体 workflow。
2. **分组优先于长路径**：默认用 `Workflow` / `Pool` / `Standalone` 分组区分来源，不在每行展开完整 workflow path。
3. **短行优先**：默认行控制为 `<name> · <state> · <elapsed>`；底部状态为 `<name> · <state> · <scope>`。
4. **状态适用于所有子代理**：`working`/`idle` 等是 agent 状态，不是 workflow 专属状态。
5. **TUI 解耦**：状态派生、分组、格式化必须放在纯数据/纯函数层，不绑定 Pi TUI 组件；Pi overlay 只消费 view model，为后续 Tauri UI 复用做准备。
6. **二级详情承载完整信息**：workflow 名、stage 名、poolId、model 等只在详情里显示。
7. **异常给出口**：failed/dead/timeout 时可显示 `fallback?`，但不自动切换。
8. **不混入 P3/P4**：不设计 nested subagent E2E/pool exec 语义；不设计 QualityGate/TransitionGuard。

## 2. 用户场景

### S1：用户觉得“等太久了”

用户输入：`/workflow status` 或主会话调用 `workflow_status`。

期望输出：

```text
Workflow: standard-dev  ● running  05:12
Stage: thinker-analysis  ● running  04:58
Agent: thinker-analysis
Last event: stage started 04:58 ago
Waiting for: stage agent result
Next: wait, open chat, or abort
Hint: If this remains unchanged beyond timeout, switch fallback.
```

### S2：stage 正在等待用户补充

```text
Workflow: standard-dev  ◐ waiting for user
Stage: thinker-clarify
Question: 请选择实现范围...
Next: reply in this chat or use send_stage_message
```

### S3：阶段完成，等待主会话批准继续

```text
Workflow: standard-dev  ◐ approval required
Completed stage: thinker-analysis
Suggested next: designer
Next: continue_workflow or abort_workflow
```

### S4：workflow 失败或超时

```text
Workflow: standard-dev  ✗ failed
Stage: thinker-clarify
Error: Agent timed out after 300000ms with no response
Next: retry_stage, abort_workflow, or switch fallback
Fallback: recommended if workflow control path appears unhealthy.
```

### S5：调试用户想看 pool/subagent 详情

详情模式展示 poolId、model、startedAt、messageCount、lastResponse 摘要、process status，但默认不展示完整 message/log。

## 3. 状态模型

建议把对外状态收敛为 `WorkflowViewStatus`，由现有 manager status/event/pool info 聚合：

```ts
type WorkflowViewStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'approval_required'
  | 'choice_required'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'unknown';
```

建议额外派生字段：

```ts
interface WorkflowStatusView {
  status: WorkflowViewStatus;
  workflow?: string;
  stage?: {
    id: string;
    agent: string;
    status: 'starting' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'unknown';
    startedAt?: number;
    elapsedMs?: number;
    lastEventAt?: number;
  };
  waitingFor?: 'stage_result' | 'user_input' | 'transition_approval' | 'choice' | 'none' | 'unknown';
  lastEvent?: string;
  lastError?: string;
  suggestedActions: Array<'wait' | 'open_chat' | 'send_stage_message' | 'continue_workflow' | 'select_branch' | 'retry_stage' | 'abort_workflow' | 'switch_fallback'>;
  detail?: {
    poolId?: string;
    model?: string;
    poolStatus?: string;
    messageCount?: number;
    lastResponsePreview?: string;
  };
}
```

## 4. 信息架构

### 默认视图：一屏状态卡

默认只显示：

1. workflow 名称 + 总状态 + elapsed；
2. 当前 stage + agent + stage 状态；
3. waitingFor；
4. 最近事件/错误；
5. 下一步建议。

### 详情视图：调试信息

用户显式请求时显示：

- stageId；
- poolId；
- pool status；
- configured model / effective model if available；
- messageCount；
- last response preview；
- last event raw type；
- timeout threshold。

### 原始 JSON 视图

保留给开发调试，但不作为默认 UX。

## 5. 命令 / 入口建议

### 最小可用 UX（MVP）

1. 改善 `workflow_status` 工具返回文案：由 raw JSON 改为状态卡 + details 保留结构化数据。
2. 扩展 `/workflow status` 命令：展示同样状态卡。
3. 在关键事件自动通知：
   - stage started；
   - waiting_user；
   - approval_required；
   - completed；
   - failed/timeout。
4. 对 running 超过阈值的状态卡显示 fallback hint。

### 后续增强

1. `/workflow status --detail`：显示 pool/model/process 详情。
2. `/workflow status --json`：显示原始结构。
3. `/chat` 顶部 header 或状态条展示当前 workflow stage badge。
4. `/subagents` 或 pool list 与 workflow stage 关联展示。

## 6. `/chat` 展示建议

### Chat 标题 / Header badge

```text
[workflow: standard-dev] [stage: thinker-analysis] [running 04:58]
```

状态变体：

```text
[workflow: standard-dev] [waiting user: thinker-clarify]
[workflow: standard-dev] [approval required: designer next]
[workflow: standard-dev] [failed: timeout]
```

### Chat 内系统状态消息

只在状态变化时插入短消息，避免刷屏：

```text
Workflow stage started: thinker-analysis
Workflow waiting for user input: thinker-clarify
Workflow stage completed: thinker-analysis; approval required before designer
Workflow failed: timeout; fallback recommended
```

## 7. Fallback UX

触发 fallback 建议的条件：

- stage agent timeout；
- workflow_status 显示 running 但 lastEvent 长时间不变；
- send_stage_message 报 “not waiting for user input”，但用户确实处于补充语境；
- workflow 内部异常导致无法继续；
- status 聚合结果为 `unknown` 或不一致。

文案建议：

```text
Workflow control path may be unhealthy. You can switch fallback and let the main assistant continue directly.
```

中文：

```text
workflow 控制链路可能异常。建议切换 fallback，由主会话直接继续处理。
```

## 8. 模型可观测性

### 当前可确认事实

从本地配置读取结果看：

- Pi native config：`/home/h/.pi/agent/oh-my-opencode-slim.json`
- OpenCode user config：`/home/h/.config/opencode/oh-my-opencode-slim.json`
- 当前 preset：`opencode-zen`
- `oracle`：root/preset 配置为 `dmxapi/gpt-5.5`
- `designer`、`fixer`：preset 配置为 `opencode-go/deepseek-v4-flash`
- `thinker-clarify`、`thinker-analysis`、`implementer`、`worker`：当前未见显式 model，按现有 pool spawn 语义会使用 agentCfg.model 或 default/main ctx model。

### UX 建议

状态详情中区分：

```text
Configured model: opencode-go/deepseek-v4-flash
Effective model: unknown until process/session reports model
Source: preset opencode-zen
```

原因：配置模型与实际 runtime 生效模型不是同一个观测层。仅从 config 能确认“应该传入什么”；要确认“实际使用什么”，需要从子进程 session/message_end 事件或 pool entry 中记录 effective model。

### 实施建议

MVP 可先展示 `configuredModel`。后续增强：在 `subagent-pool` 解析 `session.model` 或 `message_end.message.model/api`，记录为 `effectiveModel`，并在 detail view 中展示二者是否一致。

## 9. 本次 workflow 超时问题记录

本轮尝试启动 P2 `standard-dev` 时发生：

```text
Agent "wf-standard-dev-1-clarify-1779536415927" timed out after 300000ms with no response
```

记录为后续 root cause analysis 输入。初步不在本 P2 UX 设计中定位原因，但 UX 方案必须覆盖这种用户感知：超时后应明确提示失败 stage、timeout、可选 retry/abort/fallback。

后续排查建议：

1. 查 stage agent 实际模型是否为空或落到异常 default；
2. 查 pool rpc 子进程是否启动成功、有无 stderr；
3. 查 stage prompt 是否仍要求旧 JSON 输出导致卡死；
4. 查 timeout 后 manager/pool 状态是否一致；
5. 查 `/chat`/hub 是否注册但没有输出。

## 10. 非目标

本轮不做：

- nested subagent E2E / pool exec 语义；
- QualityGate / TransitionGuard；
- OpenCode legacy 清理；
- declaration-gate 重构；
- JSON repair / fallback 大范围重构；
- 完整 TUI 新面板设计。

## 11. 与恢复工作的关系（后续修改也必须记录）

P2 已完成的 pool 场景可观测性不能视为封闭不变；如果后续为了恢复 workflow 正确语义而修改：

- `workflow` scope 状态来源；
- workflow stage completed / dead 显示；
- workflow stage 是否进入 `/chat` 列表；
- 底部状态文案；
- workflow stage raw JSON / tool noise 抑制；

都必须继续记录在本目录，而不是只写到恢复文档中。避免出现“P2 已完成，但后续恢复把 P2 改动改坏却没有记录”的情况。

## 12. Chat overlay 维护边界

当前代码里 `/chat` 使用自维护 overlay（`pi-chat-bridge.ts`）实现：消息渲染、滚动、输入框、自动打开都由插件维护。为了降低长期维护成本，P2 不应继续把它扩展成复杂 chat UI。

已确认的低维护方向：

1. **不做 full panel**：不新增复杂面板、tab、timeline 或 workflow tree。
2. **尽量复用现有 overlay**：只在现有 `/chat` 选择列表和底部 help/status 文本处增加极简状态。
3. **主会话 TUI 复用优先但低优先级**：此前已多次尝试寻找直接复用 Pi 主会话 TUI 的方式，尚未确认可行入口；后续可继续研究，但不阻塞 P2 MVP。
4. **避免污染主 agent 上下文**：即使未来能复用主会话 TUI，也必须保证子代理聊天消息不进入主 agent conversation context；显示层复用可以，语义/上下文隔离不能破坏。
5. **二级详情延后**：完整 workflow/stage/poolId/model 信息不进入 P2；若需要，优先用现有 select/notify/工具结果展示，不做新 overlay 子系统。
6. **自动打开谨慎**：`autoOpenChat` 只保留当前能力，不扩大自动弹出策略，避免与主会话 TUI 行为冲突。

当前可落地的最小实现点：

- 新增或复用一个 TUI 无关的 chat status view model / formatter；
- `/chat` 选择列表按 `Workflow` / `Pool` / `Standalone` 分组或用分组标题分隔；
- 每行格式：`<name> · <state> · <elapsed>`；
- 进入 chat 后底部 help/status 行显示：`<name> · <state> · <scope>`；
- Pi overlay 只负责渲染这些字符串，不承载业务判断；
- 不维护额外复杂状态面板。

低优先级研究项：

- 继续查 Pi SDK 是否有可复用主会话 chat/session 组件或只读 transcript renderer；
- 若存在，评估能否只复用显示层，不把 subagent 消息写入主会话上下文；
- 若无法保证上下文隔离，则继续保留当前轻量 overlay。

## 13. 实施任务拆分（待确认后再进入实现）

1. **状态聚合设计落地**
   - 新增/扩展 manager 状态视图方法，例如 `statusView()`。
   - 记录 stage startedAt / lastEventAt / terminal state。

2. **改善 workflow_status 输出**
   - 默认输出状态卡。
   - details 保留结构化状态。
   - 可选保留 raw JSON 模式。

3. **新增 `/workflow status`**
   - 当前 `/workflow` 只支持 list/start；补 status 子命令。
   - 后续支持 `--detail` / `--json`。

4. **chat bridge 状态提示**
   - 在 `bindWorkflowChatBridge` 中对关键 event 发送短状态通知或更新 meeting metadata。
   - 避免重复刷屏。

5. **pool/model 详情增强**
   - pool list/status 增加 `configuredModel` 与可选 `effectiveModel`。
   - 从 session/message_end 事件尝试记录 effective model。

6. **超时/fallback 文案**
   - timeout/error 状态卡给出 retry/abort/fallback 建议。
   - 不自动切 fallback，只建议用户确认。

## 14. 验证方式

### 单测

- `workflow-manager.test.ts`：状态视图覆盖 running / waiting_user / choice / complete / failed / aborted。
- `workflow-commands.test.ts` 或现有命令测试：`workflow_status` 输出状态卡，details 仍结构化。
- `workflow-chat-binding.test.ts`：关键事件触发状态通知，不重复注册/刷屏。
- `subagent-pool.test.ts`：configured/effective model 记录。

### 人工 E2E

执行：

1. start_workflow；
2. 观察 `/workflow status` running；
3. stage_ask_user 后观察 waiting_user；
4. continue_workflow 前观察 approval_required；
5. 模拟 timeout/error，确认 fallback 建议；
6. `/chat` 中能看到简短状态变化。

### 验证命令建议

```bash
bun test src/adapters/workflow-manager.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts
bun run typecheck
bun run build:plugin
```

若涉及真实 E2E，需额外记录人工步骤与实际结果，不用 typecheck 冒充 E2E。

## 15. 推荐确认项

请确认以下 UX 决策：

1. MVP 是否先做 `workflow_status` / `/workflow status` 状态卡，而不是先做复杂 TUI 面板？推荐：是。
2. `/chat` 是否只显示状态 badge + 状态变化短消息，不展示完整内部日志？推荐：是。
3. 模型可观测性是否先展示 configured model，后续再补 effective model？推荐：是，但实现时预留字段。
4. timeout/error 是否明确给 fallback 建议，但不自动切换？推荐：是。
5. 本轮实现边界是否停止在 P2 可观测性，不混入 P3/P4？推荐：是。
