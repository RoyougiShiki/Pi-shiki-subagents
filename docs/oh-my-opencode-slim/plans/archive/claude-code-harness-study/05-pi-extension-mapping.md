# 05 — 映射到当前 Pi 扩展的落地设计

本文把 cc-haha harness 学习成果映射到当前项目 `oh-my-opencode-slim` 的 Pi 扩展实现路径。

当前项目路径：

```txt
/home/h/projects/aiprojects/oh-my-opencode-slim
```

Codebase graph 项目名：

```txt
home-h-projects-aiprojects-oh-my-opencode-slim
```

## 1. 当前项目已有基础

第一轮 codebase graph 查询确认，当前项目已经有不少与 cc-haha harness 对应的 policy 模块。

### 1.1 Verification Evidence

文件：

```txt
src/pi/policy/verification-evidence-policy.ts
```

核心函数：

```txt
checkVerificationEvidence
```

当前逻辑已覆盖：

- 子代理 pending 时提示不要提前总结
- 工具失败后没有验证时提示不要宣称完成
- 已修改但未验证时提示最终总结明确“尚未验证”

这与 cc-haha 的 stop hook / false-claim mitigation 高度同向。

### 1.2 Evidence Tracker

文件：

```txt
src/pi/policy/evidence-tracker.ts
```

核心函数：

```txt
recordEvidence
getWriteEvidences
verifyCompletion
```

当前逻辑主要关注：

- write/edit 证据
- bash 命令执行证据
- completion claim 是否有证据

建议后续扩展 evidence 类型。

### 1.3 Tool Scope

文件：

```txt
src/pi/policy/tool-scope-manager.ts
```

相关函数：

- `setToolScope`
- `getToolScope`
- `isToolAllowed`
- `auditPayloadTools`

这可用于迁移 cc-haha 的 permission gate / tool discipline / dangerous action guard。

## 2. 推荐落地包：Pi Harness Enhancement Pack

建议新增或扩展为一组模块：

```txt
src/pi/policy/completion-auditor.ts
src/pi/policy/tool-result-budget.ts
src/pi/policy/diff-guard.ts
src/pi/policy/context-pressure.ts
src/pi/policy/denied-tool-memory.ts
src/pi/policy/model-routing-policy.ts
```

不一定一次性全部实现，建议分阶段。

## 3. P0：Completion Auditor

### 3.1 目标

防止模型在最终回复中：

- 虚假声称完成
- 虚假声称测试通过
- 忽略失败工具输出
- 子代理未完成就总结
- 修改后不说明未验证

### 3.2 输入

```ts
interface CompletionAuditInput {
  finalText: string
  evidenceState: VerificationEvidenceState
  recentToolResults: ToolResultEvidence[]
  changedFiles: string[]
  pendingSubagents: string[]
  todos?: TodoState[]
  userAskedForFinal?: boolean
}
```

### 3.3 输出

```ts
interface CompletionAuditDecision {
  action: 'allow' | 'warn' | 'block'
  reason: string
  injectedMessage?: string
}
```

### 3.4 规则

```txt
if finalText claims tests passed and no test_success evidence:
  block

if has tool_failure and finalText says complete without mentioning failure:
  block

if changedFiles.length > 0 and no verification evidence:
  warn/block depending on config

if pendingSubagents.length > 0:
  block

if finalText claims all done and todos have in_progress:
  block
```

### 3.5 与 cc-haha 对应

对应：

```txt
src/query/stopHooks.ts
src/constants/prompts.ts false-claims mitigation
```

## 4. P0：Tool Result Budget

### 4.1 目标

避免大日志/大搜索结果污染上下文。

### 4.2 数据结构

```ts
interface PersistedToolResultRef {
  toolUseId: string
  toolName: string
  sessionId: string
  filepath: string
  originalSize: number
  preview: string
  hasMore: boolean
  createdAt: number
}
```

### 4.3 行为

```txt
工具结果超过阈值：
  1. 保存完整输出到磁盘
  2. 上下文只保留 preview
  3. 记录 rawRef 到 evidence tracker
```

建议路径：

```txt
~/.pi/agent/sessions/{sessionId}/tool-results/{toolUseId}.txt
```

或当前项目扩展专用路径：

```txt
~/.pi/oh-my-opencode-slim/tool-results/{sessionId}/{toolUseId}.txt
```

### 4.4 与 cc-haha 对应

对应：

```txt
src/utils/toolResultStorage.ts
```

## 5. P1：Diff Guard

### 5.1 目标

防止模型做无关改动或大范围重构。

### 5.2 输入

```ts
interface DiffGuardInput {
  userRequest: string
  changedFiles: string[]
  changedLineCount?: number
  newFiles: string[]
  deletedFiles: string[]
  dependencyFilesChanged: string[]
}
```

### 5.3 规则

```txt
if newFiles.length > 0 and user did not request new file:
  warn

if dependencyFilesChanged.length > 0:
  ask or warn

if changedFiles include unrelated directories:
  warn

if changedLineCount is high for simple bugfix:
  warn
```

### 5.4 与 cc-haha 对应

对应：

- prompt 中“不做额外功能/重构”
- desktop UX 中 changed files / diff panel
- permission risk model

## 6. P1：Denied Tool Memory

### 6.1 目标

模型调用被拒后，不应重复相同调用。

### 6.2 数据结构

```ts
interface DeniedToolCallRecord {
  toolName: string
  normalizedInputHash: string
  displayInput: string
  reason: string
  timestamp: number
  expiresAt?: number
}
```

### 6.3 规则

```txt
if same toolName + same normalizedInputHash appears shortly after denial:
  block and inject guard message
```

### 6.4 与 cc-haha 对应

对应：

```txt
src/constants/prompts.ts: user denied tool call rule
src/hooks/useCanUseTool.tsx: deny branch
```

## 7. P1：Context Pressure Monitor

### 7.1 目标

在 context 临界前提前治理，而不是等模型失败。

### 7.2 输入

```ts
interface ContextPressureInput {
  estimatedTokens: number
  modelContextWindow: number
  toolResultBytes: number
  messageCount: number
  persistedResultCount: number
}
```

### 7.3 输出

```ts
interface ContextPressureDecision {
  level: 'ok' | 'warning' | 'critical' | 'blocking'
  recommendedActions: Array<'persist_outputs' | 'clear_old_results' | 'summarize' | 'ask_compact'>
}
```

### 7.4 与 cc-haha 对应

对应：

```txt
src/services/compact/autoCompact.ts
src/services/compact/microCompact.ts
```

## 8. P2：Model Router

根据你的实测，模型差异远大于 harness 差异：

```txt
同模型：cc-haha 29 vs Pi 28.4
更好模型 + Pi：39
```

因此 Pi 应优先支持模型路由。

### 8.1 策略

```txt
simple_qa -> cheap/fast model
code_edit -> strong coding model
long_context -> long context model
verification -> independent verifier model
planning -> reasoning model
```

### 8.2 数据结构

```ts
interface ModelRouteDecision {
  model: string
  reason: string
  role: 'main' | 'planner' | 'verifier' | 'summarizer' | 'researcher'
}
```

## 9. P2：Verifier Agent

cc-haha 的 worker/coordinator 复杂，不建议一开始完整迁移。

但 verifier agent 很值得做。

### 9.1 输入

```txt
- 原始用户请求
- 修改文件列表
- diff summary
- 主 agent 声称完成的内容
- 测试命令与结果
```

### 9.2 输出

```txt
PASS / FAIL / PARTIAL
```

### 9.3 规则

主 agent 不能自我宣称 verifier PASS。
必须由独立 verifier 产生 verdict。

## 10. 实施顺序

建议顺序：

```txt
Phase 1:
  1. completion_auditor
  2. tool_result_budget

Phase 2:
  3. diff_guard
  4. denied_tool_memory
  5. context_pressure_monitor

Phase 3:
  6. model_router
  7. verifier_agent
  8. session_recall / memory

Phase 4:
  9. Pi Workbench UI
  10. permission approval UI
  11. diff panel / session search
```

## 11. 当前项目可直接对接点

建议优先阅读/修改：

```txt
src/pi/policy/verification-evidence-policy.ts
src/pi/policy/evidence-tracker.ts
src/pi/policy/tool-call-gates.ts
src/pi/policy/tool-scope-manager.ts
src/pi/policy/runtime-audit.ts
src/pi/core/pi.ts
src/pi/subagent/pi-chat-bridge.ts
```

## 12. 第二轮源码复核后的设计修正

### 12.1 Completion Auditor 不能只依赖 `bash_success`

本文件第 3 节 P0 Completion Auditor 的方向仍成立，但 evidence 判定需要修正：

```txt
普通 bash 成功 ≠ verification evidence
```

cc-haha 源码显示：

- Stop hook 只提供 `last_assistant_message` / `transcript_path`，不内置粗暴验证判定。
- PostToolUse hook 保留完整 `tool_input` / `tool_response`，允许按语义判断。
- 强验证来自独立 verification agent 的 `VERDICT: PASS|FAIL|PARTIAL`。

因此 Pi 的 `CompletionAuditInput` 应扩展/明确：

```ts
interface CompletionAuditInput {
  finalText: string
  evidenceState: VerificationEvidenceState
  verificationVerdicts?: VerificationVerdict[]
  recentToolResults: ToolResultEvidence[]
  changedFiles: string[]
  pendingSubagents: string[]
  todos?: TodoState[]
  userAskedForFinal?: boolean
}

interface VerificationVerdict {
  source: 'verifier_agent' | 'verification_tool' | 'manual_user'
  verdict: 'PASS' | 'FAIL' | 'PARTIAL'
  commandBlocks?: Array<{
    command: string
    outputObserved: string
    result: 'PASS' | 'FAIL'
  }>
  timestamp: number
}
```

### 12.2 Verifier Agent 优先级应上调

本文件原先把 Verifier Agent 放在 P2。第二轮源码显示 cc-haha 的 verification 精髓在 verifier agent、task nudge 与 prompt contract，而不是简单 evidence tracker。

建议调整：

```txt
Phase 1.5:
  - 修正 evidence-adapter：普通 bash 不算 verification
  - 定义 VerificationVerdict 类型和 parser（纯函数）
  - 设计 verifier/oracle 输出格式（Command run / Output observed / VERDICT）

Phase 2:
  - verifier agent runtime 接入
  - todo/task 完成时缺 verification step 的结构化提醒
```

### 12.3 架构底线

实现时必须继续保持：

- **唯一真源**：verification pattern、verdict 文案、threshold 不散落在 runtime。
- **纯函数优先**：`evidence -> verification state`、`verifier output -> verdict`、`todo state -> nudge decision` 都应是纯函数。
- **runtime 解耦**：`pi.ts` 只负责 hook 编排与 UI notify，不承载判定逻辑。
- **不硬编码 agent/tool 名**：通过 config/defaults/tool groups/agent definitions 提供。
- **无旧兼容残留**：移除“任何 bash 都是 verification”这类错误兜底，不做多套并存逻辑。

## 13. 第三来源校准后的实施顺序

`ClaudeCode-Source-Analysis` 确认了本地大方向，但也说明当前不宜继续扩大功能面。建议调整为：

```txt
Phase 0: 文档/设计校准
  - Stop hook 与 verifier 边界
  - compact timing
  - tombstone 语义
  - ToolSearch/deferred tools
  - tool_result 两层模型
  - permission mode 复合状态机

Phase 1: 可靠性修复
  - evidence tracker session/reload 边界
  - PostToolUse full rawInput/rawResponse
  - transcript/session evidence recovery
  - denied-tool-memory persistence

Phase 1.5: 已有纯函数接入 runtime
  - verifier verdict parser
  - verification nudge
  - completion auditor 消费 verifier verdict

Phase 2: 结构化底座
  - tool-result-normalizer
  - tool-result-pairing-fixer
  - permission-mode-manager
  - context-pressure per-layer snapshot

Phase 3: 扩展能力
  - model router
  - session recall
  - deferred tool registry discovery
  - Workbench UI
```

### 13.1 架构约束

后续实现必须继续遵守：

- **低复杂度**：每个模块只解决一个问题；不要做 Claude Code 1:1 复刻。
- **纯函数优先**：normalizer、auditor、verdict parser、nudge decision、permission decision 都可单测。
- **runtime 解耦**：`pi.ts` 只编排 hook/event，不承载业务判断。
- **唯一真源**：threshold、pattern、messages、tool groups、agent roles 全部来自 typed defaults/config。
- **不硬编码研究文档**：实现不依赖 markdown 段落、上游压缩名、仓库路径或可编辑数据文件。
- **可替换 verifier**：核心依赖 verdict schema，不依赖固定 agent 名。

### 13.2 暂缓项

在 P1/P1.5 未稳定前，暂缓：

- Workbench 大 UI；
- 大量 hook API 外放；
- 完整 teammate/mailbox runtime；
- Claude-specific prompt cache/cache editing 深度复刻；
- 基于自然语言 pattern 继续堆 auditor 规则。
