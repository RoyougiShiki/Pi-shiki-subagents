# 04 — Tools、Permissions 与 Orchestration

本文记录 cc-haha 中工具调用、权限、hooks、并发/串行调度的核心机制，以及如何迁移到 Pi 扩展。

## 1. 关键源码

```txt
/tmp/pi-github-repos/NanmiCoder/cc-haha@main
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

