# 04 — Tools、Permissions 与 Orchestration

本文记录 cc-haha 中工具调用、权限、hooks、并发/串行调度的核心机制，以及如何迁移到 Pi 扩展。

## 1. 关键源码

```txt
/tmp/pi-github-repos/cc-haha@main
```

| 机制 | 文件 | 关键函数 |
|---|---|---|
| 工具编排 | `src/services/tools/toolOrchestration.ts` | `runTools`, `partitionToolCalls` |
| 工具执行 | `src/services/tools/toolExecution.ts` | `runToolUse` |
| 流式工具执行 | `src/services/tools/StreamingToolExecutor.ts` | `StreamingToolExecutor` |
| 权限决策 | `src/hooks/useCanUseTool.tsx` | `useCanUseTool` |
| 权限规则 | `src/utils/permissions/permissions.ts` | `hasPermissionsToUseTool` |
| permission context | `src/hooks/toolPermission/PermissionContext.ts` | `createPermissionContext` |
| coordinator permission | `src/hooks/toolPermission/handlers/coordinatorHandler.ts` | `handleCoordinatorPermission` |
| interactive permission | `src/hooks/toolPermission/handlers/interactiveHandler.ts` | `handleInteractivePermission` |

## 2. Tool Orchestration

源文件：

```txt
src/services/tools/toolOrchestration.ts
```

核心函数：

```txt
runTools line 19
partitionToolCalls line 91
runToolsSerially line 118
runToolsConcurrently line 152
```

### 2.1 并发安全模型

cc-haha 不简单地并发所有工具，而是按 `isConcurrencySafe(input)` 分批：

```txt
consecutive concurrency-safe tools -> 并发执行
non-safe tool -> 单独串行执行
```

这很重要，因为：

- 多个 Read/Grep 可以并发
- Edit/Write/Bash 可能有副作用，必须谨慎
- 某些 Bash 命令即使看似只读，也可能有副作用

### 2.2 对 Pi 的迁移

建议工具定义增加元数据：

```ts
interface ToolPolicyMeta {
  category: 'read' | 'search' | 'write' | 'shell' | 'network' | 'agent' | 'ui'
  sideEffect: 'none' | 'filesystem' | 'process' | 'network' | 'external'
  concurrency: 'safe' | 'unsafe' | 'dynamic'
  requiresApproval?: boolean
  dangerousPatterns?: string[]
  maxResultSizeChars?: number
}
```

然后由 harness 决定：

```txt
read/search 并发
write/edit 串行
dangerous shell 默认 ask
external side effects 默认 ask
```

## 3. Tool Execution

源文件：

```txt
src/services/tools/toolExecution.ts
```

核心路径：

```txt
runToolUse
  ↓
find tool by name
  ↓
validate input schema
  ↓
start telemetry / progress
  ↓
canUseTool permission decision
  ↓
runPreToolUseHooks
  ↓
tool.call
  ↓
processToolResultBlock
  ↓
runPostToolUseHooks
  ↓
yield tool_result
```

### 3.1 关键思想

工具执行不是“直接调用函数”，而是一个可拦截 pipeline：

```txt
schema validation
permission gate
pre hook
execution
result transform
post hook
evidence record
context update
```

### 3.2 对 Pi 的迁移

Pi 扩展可以实现：

```txt
tool_pipeline:
  beforeToolCall:
    - schema validate
    - scope audit
    - permission decision
    - denied fingerprint check
  afterToolCall:
    - result budget
    - evidence record
    - failure record
    - diff record
    - post hook
```

## 4. Permission System

源文件：

```txt
src/hooks/useCanUseTool.tsx
```

核心类型：

```ts
export type CanUseToolFn = (
  tool,
  input,
  toolUseContext,
  assistantMessage,
  toolUseID,
  forceDecision?
) => Promise<PermissionDecision>
```

权限结果三类：

```txt
allow
ask
deny
```

### 4.1 allow

直接允许，可能来源：

- permission mode
- user settings
- project settings
- classifier
- previous approval

### 4.2 deny

直接拒绝，并记录：

- tool name
- input
- reason
- classifier/source

### 4.3 ask

进入审批流程：

1. coordinator automated checks
2. swarm worker forwarding
3. speculative classifier grace period
4. interactive dialog

这说明 cc-haha 的权限系统不是简单弹窗，而是多层自动判断。

## 5. Permission Mode

cc-haha Desktop 文档中有四种模式：

| 模式 | 含义 |
|---|---|
| default / ask | 每个敏感操作询问 |
| acceptEdits | 自动接受编辑 |
| plan | 只计划不执行 |
| bypassPermissions | 全部自动，需二次确认 |

对 Pi 的迁移：

```txt
permission.mode:
  - ask
  - accept_edits
  - plan
  - bypass
```

建议一开始实现：

- `ask`
- `accept_edits`
- `plan`

`bypass` 先只允许本地开发并加明显警告。

## 6. Hooks

cc-haha 工具执行与 stop 阶段都有 hooks：

- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStop`
- `TaskCompleted`
- `TeammateIdle`

Hooks 的价值：

```txt
把 harness 规则从 prompt 中拿出来，变成可执行检查。
```

Pi 当前已有 policy 模块，建议继续沿这个方向做。

## 7. Stop Hook 与 Permission Hook 的关系

- Permission hook：防止危险动作发生
- Stop hook：防止错误总结发生

两者都与防幻觉有关：

```txt
permission hook 防止模型“做错事”
stop hook 防止模型“说错话”
```

Pi 扩展应该同时做。

## 8. 与当前项目的映射

当前项目已有相关模块：

```txt
src/pi/policy/tool-call-gates.ts
src/pi/policy/tool-scope-manager.ts
src/pi/policy/verification-evidence-policy.ts
src/pi/policy/evidence-tracker.ts
src/pi/policy/subagent-contract-policy.ts
src/pi/policy/task-contract-policy.ts
```

codebase graph 已确认：

- `tool-scope-manager.setToolScope`
- `tool-scope-manager.getToolScope`
- `tool-scope-manager.isToolAllowed`
- `tool-scope-manager.auditPayloadTools`
- `verification-evidence-policy.checkVerificationEvidence`
- `evidence-tracker.verifyCompletion`

说明当前项目已经具备落地 cc-haha 思路的基础。

## 9. Pi 中建议补齐的能力

### 9.1 Tool denied memory

记录被拒绝的工具调用：

```ts
interface DeniedToolCall {
  toolName: string
  normalizedInputHash: string
  reason: string
  timestamp: number
}
```

如果模型重复调用，拦截并注入：

```txt
[guard] 该工具调用刚刚被拒绝，请调整方案，不要重复相同调用。
```

### 9.2 Dangerous command classifier

先不用模型 classifier，可用规则：

```txt
rm -rf
sudo
chmod -R
chown -R
git reset --hard
git clean -fd
git push --force
docker system prune
kubectl delete
terraform apply/destroy
```

### 9.3 Tool result evidence

每个工具结果都应该可转成 evidence：

```txt
Bash exitCode=0 -> command_success
Bash exitCode!=0 -> command_failure
Edit/Write -> modification
Read/Grep -> context_read
Subagent result -> delegated_evidence
```

### 9.4 Concurrency policy

Pi subagent 或工具执行时：

```txt
read/search: parallel
edit/write/bash: serial unless explicitly safe
external effect: ask
```

## 10. 不丢弃的 Claude-specific 特性

这些现在不直接迁移，但未来可抽象：

| 特性 | 未来抽象 |
|---|---|
| speculative classifier | `permissionClassifier` provider |
| prompt cache aware tool result clearing | `contextCacheCapability` |
| streaming tool execution | `streamingToolExecutor` |
| thinking-aware retry | `reasoningTraceCapability` |
| coordinator/swarm permission forwarding | `delegatedPermissionChannel` |

## 11. 第二轮源码复核：Verification Agent / Task Nudge 是编排重点

### 11.1 Verification Agent 的工具权限边界

相关文件：

- `src/tools/AgentTool/built-in/verificationAgent.ts`

源码事实：

```txt
verification agent:
- disallowedTools: Agent, ExitPlanMode, Edit, Write, NotebookEdit
- 允许 read/search/bash/web 等验证行为
- 可在 /tmp 写临时脚本，但禁止修改项目目录
- 必须输出 VERDICT: PASS | FAIL | PARTIAL
```

Pi 映射：

```txt
verifier/oracle 子代理应有明确工具边界：
- 禁止 write/edit
- 允许 read/search/bash/context/codebase-memory
- 允许临时目录脚本（如后续支持，需要独立策略）
- 输出结构必须可解析
```

### 11.2 Task/Todo 完成时的 verification nudge

相关文件：

- `src/tools/TodoWriteTool/TodoWriteTool.ts`
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts`

源码事实：主线程关闭 3+ 个 task/todo，且没有 verification step 时，tool result 追加提醒：最终总结前 spawn verification agent，不能 self-assign PARTIAL。

Pi 映射：

```txt
todo/task update hook:
  if main agent closes all tasks
  and task count >= threshold
  and no verification task/verifier verdict:
    inject structured reminder into tool result or UI warning
```

注意：threshold、提醒文案、verification step 识别 pattern 都应来自唯一真源；runtime 层不硬编码。

### 11.3 PostToolUse 的证据输入应保留完整语义

cc-haha `PostToolUseHookInput` 包含完整 `tool_input` / `tool_response`。这说明 Pi evidence tracker 也应保留：

```txt
- toolName
- toolCallId
- normalized input
- raw/summary response
- success/failure
- command text / exit code（如果是 shell）
- affected files（如果是 edit/write）
```

否则后续无法判断“这个输出是否真是 verification”。

### 11.4 修正本文件第 9.3 的简化说法

本文件早期写法：

```txt
Bash exitCode=0 -> command_success
```

只能表示 command success，不应直接升级为 verification。verification 至少需要满足以下之一：

```txt
- 明确测试/构建/类型检查/验证命令成功，且命令与任务相关
- verifier agent 给出 VERDICT: PASS/PARTIAL/FAIL
- 自定义 verifier skill/tool 给出结构化证据
```

普通 `git status`、`grep`、`echo`、`ls` 成功不是 verification。

## 12. 第三来源校准：Permission Mode / ToolSearch / Hook Surface

`ClaudeCode-Source-Analysis` 对本文件的工具与权限设计有三点补充。

### 12.1 Permission mode 是复合状态机

不要把 permission mode 只建模成简单 enum。建议拆成两层：

```txt
PermissionModeState
  - 当前模式：ask / plan / accept_edits / auto / bypass
  - 进入模式前状态：prePlanMode / previousMode
  - 临时风险变换：strippedDangerousRules

PermissionDecision
  - allow / ask / deny
  - reason / source / risk
```

这样后续才能支持：

- plan 与 auto 的耦合；
- auto 期间临时剥离危险 allow rules；
- 退出 auto 后恢复；
- classifier 失败时降级 ask/deny。

实现约束：危险规则、tool group、模式开关都来自 typed config；runtime 不散落 `rm -rf`、`bash`、`PowerShell` 等硬编码判断。

### 12.2 ToolSearch 是 deferred tool registry discovery

ToolSearch 不应理解为普通内容搜索。更适合 Pi 的抽象是：

```txt
ToolRegistry.search(query/capability)
  -> tool references
next request/tool assembly
  -> inject selected tool schemas
```

收益：MCP/扩展工具很多时，不必把所有工具 schema 常驻上下文。

实现约束：返回 tool reference / capability，不返回可编辑文档片段；工具 schema 注入由 request builder 统一处理。

### 12.3 Hook surface 暂不冻结

上游分析显示 hook event 面比第一轮假设更大。Pi 当前应继续把 hook API 标记为 experimental：

- 内部 policy 先用 typed event；
- 外部扩展 API 先小范围暴露；
- 不为了“对齐数量”一次性增加大量空 hook；
- 等 runtime 真实需要时再添加事件。

### 12.4 Subagent 分类

后续 subagent 文档应区分：

| 类型 | 语义 | Pi 建议 |
|---|---|---|
| implicit fork | 共享部分父上下文，适合临时分支探索 | 限制可重入，避免 fork 内再 fork |
| typed subagent | 按角色 fresh start，如 verifier/search/fixer | 明确工具边界和输出 contract |
| teammate | 更长期协作/任务队列/mailbox | 放入后续 Workbench/多 agent 设计 |

当前优先实现 typed verifier，而不是完整 teammate runtime。

第二轮 cc-haha 源码阅读后，本文件需要补充：tools/permissions/orchestration 与 completion verification 的关系不是“Bash 成功即可”，而是围绕独立 verifier 与 task/todo 节点做结构化编排。
