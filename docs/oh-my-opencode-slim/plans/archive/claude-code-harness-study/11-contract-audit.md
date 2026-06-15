# 11 — Harness Contract Audit

创建日期：2026-06-04

本文用于记录 cc-haha 关键机制与当前 Pi harness 实现之间的**行为契约对齐**。目标不是逐行复刻 cc-haha，而是用低复杂度、可测试、可维护的方式确认关键输入/输出/副作用没有遗漏。

## 1. Audit 方法

每个模块只审 5 个问题：

```txt
1. 输入是什么？
2. 输出是什么？
3. 哪些字段返回给模型 / transcript / UI？
4. 哪些字段只给内部 evidence / auditor / verifier 使用？
5. 异常、边界、fallback 行为是什么？
```

产物必须是 typed contract 和测试计划，不把上游源码行号、压缩函数名、prompt 原文或 markdown 段落变成运行时依赖。

## 2. Contract Audit 表

| # | 模块 | cc-haha 行为契约 | Pi 当前行为 | Gap | 处理方式 | 测试/验收 |
|---|---|---|---|---|---|---|
| 1 | `BashTool/commandSemantics.ts` → `src/pi/policy/command-semantics.ts` + `src/pi/core/pi.ts` tool_result hook | command semantic 同时影响内部错误判断与模型可见消息；如 `grep` exit 1 是 `No matches found`，不是 tool failure | 已实现 `isError/message`，并已在 tool_result hook 返回语义化文本给模型 | ✅ 已修：之前只影响内部 evidence，没有改写模型可见消息 | P0 hotfix 已完成；后续纳入 `tool-result-normalizer`，避免 runtime 散落适配 | ✅ `grep` exit 1：模型看到 `No matches found`；✅ `grep` exit 2：保留错误输出；✅ `diff` exit 1：保留实际差异信息 |
| 2 | `utils/hooks.ts` Stop/PostToolUse schema → `src/pi/core/pi.ts` hooks | **PostToolUse**: `tool_name/tool_input/tool_response/tool_use_id/transcript_path`。**Stop**: `transcript_path/last_assistant_message/stop_hook_active`。所有 hook 都有 `transcript_path` 可重建 evidence | `tool_result` hook 有 `toolName/input/content/isError`。`message_end` hook 无 `transcript_path`。缺完整 `rawResponse` 结构 | ❌ PostToolUse 缺完整 `tool_response`。❌ 所有 hook 缺 `transcript_path`。❌ 无法从 transcript 恢复 evidence | P1 放入 `evidence-session-store` + `tool-result-normalizer`。Transcript recovery 作为 reload 兜底 | 需要覆盖 rawInput/rawResponse、reload 后 recovery、Stop final audit |
| 3 | `utils/toolResultStorage.ts` → `src/pi/harness/tool-result-budget.ts` | `<persisted-output>` 格式：`Output too large (X). Full output saved to: path`。Preview 前 2000 bytes。`reconstructContentReplacementState` 从 transcript 重建。GrowthBook override: `tengu_satin_quoll` | Tool Result Budget 已生效，preview + persist 正常。缺 `reconstructContentReplacementState`。缺 GrowthBook override | ⚠️ 缺 transcript 重建。⚠️ 缺 GrowthBook override (P2) | P1 设计 `StructuredToolResult` + transcript block。P2 GrowthBook override。Transcript 重建放入 `evidence-session-store` | 大输出保存、preview、rawRef 可读、evidence 引用 rawRef |
| 4 | `AgentTool/verificationAgent.ts` → `verifier-verdict-parser.ts` | VERDICT 格式: `VERDICT: PASS|FAIL|PARTIAL`。只读边界: 不能修改项目文件。必须有 `Command run` / `Output observed`。禁止工具: edit/write/bash write | Parser 纯函数已完成，能解析 VERDICT + Command run + Output observed。Runtime 未接入 | ✅ Parser 已完成。❌ Runtime 未接入 | P3 接 runtime。需要 `evidence-session-store` 落盘 verdict。Verifier 只读边界由 subagent tool scope 控制 | PASS/FAIL/PARTIAL 解析；无 verdict 不误判；verifier evidence 落盘 |
| 5 | `TodoWriteTool/TaskUpdateTool` → `verification-nudge.ts` | 触发条件: `!agentId && allDone && todos.length >= 3 && !todos.some(t => /verif/i.test(t.content))`。输出: tool result 追加 nudge 消息，提醒 spawn verification agent | Nudge 检测逻辑已完成，条件一致。Runtime 未接入 | ✅ 检测逻辑已完成。❌ Runtime 未接入 | P3 接 todo/task runtime。在 tool_result hook 检查 todo result，追加 nudge | 关闭 3+ task 无验证触发；已有 verifier step 不触发 |
| 6 | `constants/prompts.ts` → `src/pi/harness/messages.ts` / future `prompt-contracts.ts` | cc-haha 有多层提示词：主 system prompt 原则、tool result 动态 nudge、verifier agent 专用 prompt。提示词与 runtime harness 共同约束模型行为 | Pi 有 messages/defaults，部分原则已体现在 harness 逻辑中；但尚未明确 prompt 分层、唯一真源、去重规则和冲突检查 | ⚠️ 缺 prompt contract governance：直接复制/散落提示词可能造成重复、冲突、职责混乱 | P1：建立 Prompt Contract Audit，不复制上游原文；提示词必须分层、短、可配置、唯一真源；runtime 只选择提示，不硬编码长文案 | 检查每条提示进入哪个通道；是否和 mode/agent prompt/auditor message 重复；是否可配置关闭 |

## 3. Prompt Contract Audit

cc-haha 的 harness 不是纯 runtime 机制，也包含固定/动态提示词。Pi 迁移时必须把提示词作为受控 contract，而不是直接复制或散落在 runtime 中。

### 3.1 提示词分层

| 层 | cc-haha 来源 | Pi 迁移原则 | 不应做 |
|---|---|---|---|
| 主 system prompt 原则 | `constants/prompts.ts` | 只保留短、稳定、全局原则；与 Pi mode/agent prompt 做冲突检查 | 不复制大段原文；不重复 Pi 已有模式规则 |
| tool result 动态提醒 | `TodoWriteTool.ts` nudge、tool budget message、command semantics message | 只在当前工具结果直接相关时短提醒；由 messages/prompt contract 统一生成 | 不在多个 hook 重复提醒；没有 verifier runtime 时不要强要求 spawn verifier |
| verifier agent prompt | `verificationAgent.ts` | 只给 verifier 子代理；包含只读边界和 VERDICT 格式 | 绝不注入主模型，避免 implementer/verifier 职责冲突 |
| auditor message | Stop/completion audit | 只说明当前具体缺口（失败、未验证、pending） | 不输出泛泛原则教育；不和 nudge 重复 |

### 3.2 提示词治理规则

1. **唯一真源**：提示词文本集中在 `messages.ts` 或未来 `prompt-contracts.ts`；`pi.ts` 只选择提示，不硬编码长文案。
2. **分层注入**：主模型、tool result、verifier 子代理、auditor message 使用不同提示通道。
3. **避免冲突**：verifier 的只读/VERDICT prompt 只能给 verifier 子代理，不能给主实现模型。
4. **避免重复**：如果已有具体 warning（verifier FAIL / tool failure），不再输出 generic nudge。
5. **可配置**：关键提示应可通过 harness config 关闭/替换，适配不同模式和语言。
6. **短文本优先**：提示词应作为行为契约摘要，不复制 cc-haha 长 prompt 原文。

### 3.3 去重优先级

```txt
verifier FAIL
  > explicit tool failure
  > unverified modification
  > verification nudge
  > generic reminder
```

如果高优先级提示已经出现，低优先级提示应被 suppress 或降级为 telemetry。

## 4. 下一步

1. 继续 P0.5 contract audit，不做无限逐行复刻。
2. 每发现一个 gap，按 `fix now / fix in Sprint / ignore` 分类。
3. 进入 P1 Sprint 1 时，把 #1 的 hotfix 收编到 `tool-result-normalizer`：

```txt
raw tool output
  -> command semantics
  -> StructuredToolResult（内部 evidence）
  -> TranscriptToolResultBlock（模型可见消息）
```

## 5. Gap 优先级排序

| 优先级 | Gap | 处理方式 |
|---|---|---|
| **P1** | PostToolUse 缺完整 `tool_response` | 放入 `tool-result-normalizer` |
| **P1** | 所有 hook 缺 `transcript_path` | 放入 `evidence-session-store` |
| **P1** | 无法从 transcript 恢复 evidence | 放入 `evidence-session-store` |
| **P1** | 缺 tool result transcript 重建 | 放入 `evidence-session-store` |
| **P1** | Completion Auditor evidence scope 过宽：咨询/建议型回复也可能消费历史修改证据并提示“修改后未验证” | 放入 `evidence-session-store` + scoped audit decision |
| **P1** | Prompt contract governance 缺失：提示词分层、唯一真源、去重/冲突规则未明确 | 建立 `messages.ts` / future `prompt-contracts.ts` 治理规则 |
| **P2** | 缺 GrowthBook override | 延后 |
| **P3** | verifier-verdict runtime 未接入 | Phase 1.5 |
| **P3** | verification-nudge runtime 未接入 | Phase 1.5 |
| **Ignore** | prompts.ts 原文差异 | 只审原则，不复制文案 |

## 6. Sprint 1 设计方向

根据 contract audit 发现的 gap，Sprint 1 应包含：

### 6.1 tool-result-normalizer

统一处理 raw tool result 的两个投影：

```
raw tool output
  ↓ interpretCommandSemantic (已实现)
  ↓ StructuredToolResult
     ├── internal: evidence / auditor / verifier
     └── model-facing: transcript message / UI message
```

关键设计：
- 输入：`raw tool_output` (bash/grep/diff 等)
- 输出：`StructuredToolResult` + `TranscriptToolResultBlock`
- 把 command-semantics 收编进 normalizer，避免 runtime 散落适配

### 6.2 evidence-session-store

解决 transcript 恢复和 session 边界问题：

```ts
interface EvidenceSessionStore {
  recordEvidence(event: StructuredToolResult): void;
  getEvidenceSnapshot(sessionId: string): StructuredToolResult[];
  reconstructEvidencesFromTranscript(transcriptPath: string): StructuredToolResult[];
  resetEvidence(boundary: 'session' | 'turn' | 'reload'): void;
}
```

关键设计：
- 优先保存结构化 evidence event
- transcript 解析只作为 reload 兜底
- 不让 markdown/transcript 文案成为唯一真源

### 6.3 PostToolUse rawInput/rawResponse

扩展 ToolEvidence 结构：

```ts
interface ToolEvidence {
  toolName: string;
  toolCallId: string;
  rawInput: unknown;       // 完整 tool_input
  rawResponse: unknown;    // 完整 tool_response
  timestamp: number;
  success: boolean;
  exitCode?: number;
  affectedFiles?: string[];
  semantic?: string;
}
```

### 6.4 reload 后 evidence 恢复

流程：

```
reload / session start
  ↓ read transcript_path
  ↓ reconstructEvidencesFromTranscript
  ↓ populate EvidenceSessionStore
  ↓ completion auditor 可跨 turn 判断
```

### 6.5 scoped completion audit

2026-06-04 观察到一次误报型提醒：assistant 当前 turn 只做读取/状态检查/建议回复，没有执行 edit/write，但 message_end 仍提示“检测到修改证据，但没有验证证据”。

判断：这不是 command-semantics 类的模型可见消息 bug，而是 evidence 作用域过宽。auditor 消费了历史 modification evidence，但没有足够区分：

```txt
- 当前 turn 是否发生 edit/write
- 当前回复是否是实现总结，还是咨询/建议
- 当前 git working tree 是否仍有未验证 diff
- 历史 modification evidence 是否属于当前任务/当前 session boundary
- 之前是否已有外部实现者/子代理完成验证
```

Sprint 1 中 completion auditor 应改为消费 scoped snapshot，而不是全局 evidence 列表：

```ts
interface CompletionAuditScope {
  sessionId: string
  turnId?: string
  taskId?: string
  currentTurnModified: boolean
  hasCurrentWorkingTreeDiff?: boolean
  evidenceWindow: 'current_turn' | 'current_task' | 'current_session'
}
```

最低限度：如果当前 turn 没有 edit/write，且当前回复只是建议/评估，不应因为旧 modification evidence 触发高强度 warning；如仍需提醒，应降级为 observation 或仅记录 telemetry。

### 6.6 prompt contract governance

Sprint 1 不应新增散落提示词。新增/修改提示词时必须先确认：

```ts
interface PromptContract {
  id: string;
  channel: 'system' | 'tool_result' | 'verifier_agent' | 'auditor_message';
  priority: number;
  messageKey: string;
  suppresses?: string[];
  configurable: boolean;
}
```

最低限度：verification nudge runtime 接入前，不能直接照搬 cc-haha 中“spawn verification agent”的长提示；如果 verifier runtime 未接入，应降级为“建议进行验证/说明未验证”的短提醒，或保持 disabled。

## 8. Step 2B 深入结论：Evidence / Tool Result Recovery

### 8.1 Pi hook payload 实际可用字段

**tool_result hook**:

| 字段 | 可用 | 说明 |
|---|---|---|
| `toolCallId` | ✅ | string |
| `input` | ✅ | Record<string, unknown> — 即 rawInput |
| `content` | ⚠️ 部分 | (TextContent | ImageContent)[] — 模型可见部分，不是完整 rawResponse |
| `isError` | ✅ | boolean |
| `details` | ⚠️ 工具特定 | BashToolDetails 不含 exitCode，需从 content 解析 |
| `exitCode` | ❌ 不直接提供 | 需从 content 文本解析 "Command exited with code X" |

**message_end hook**:

| 字段 | 可用 | 说明 |
|---|---|---|
| `message` | ✅ | AgentMessage |
| `transcript_path` | ❌ | Pi 无此概念 |
| `sessionId` | ❌ 不在 event 里 | 需从 `ctx.sessionManager.getSessionId()` 获取 |

**ExtensionContext ctx**:

| 字段 | 可用 | 说明 |
|---|---|---|
| `ctx.sessionManager` | ✅ | ReadonlySessionManager |
| `ctx.sessionManager.getSessionId()` | ✅ | string |
| `ctx.sessionManager.getSessionFile()` | ✅ | string | session 文件路径 |
| `ctx.sessionManager.getEntries()` | ✅ | SessionEntry[] | 可遍历历史 entries |

### 8.2 Session artifact 情况

Pi 没有 cc-haha 的 `transcript_path` 概念，但有等效机制：

- `sessionManager.getSessionFile()`: session 文件路径（JSON 格式）
- `sessionManager.getEntries()`: 遍历所有 SessionEntry
- `SessionMessageEntry.message`: 包含完整 AgentMessage

可以从 session entries 恢复历史消息，但需要：

1. 解析 AgentMessage 结构
2. 识别 tool_result 相关的消息
3. 提取 toolCallId / input / content

不建议直接依赖 session 文件格式（可能变化），更好的抽象：

```ts
interface SessionArtifactRef {
  kind: 'session_file' | 'entries';
  sessionId: string;
  path?: string; // sessionManager.getSessionFile()
}
```

### 8.3 Tool result budget rawRef

Tool result budget 持久化后，消息格式：

```txt
<persisted-output>
Output too large (X chars). Full output saved to: ~/.pi/tool-results/session-.../tool-call-...txt
Preview (first 2000 chars):
...
</persisted-output>
```

filepath 可被 evidence 引用：

- ✅ reload 后文件仍在
- ✅ 可通过 filepath 读取完整输出
- ⚠️ 需要建立 evidence → filepath 关联

### 8.4 缺失字段

| 缺失 | 影响 | 补偿方案 |
|---|---|---|
| `exitCode` | 无法精确判断 bash 语义 | 从 content 解析（已实现） |
| `transcript_path` | 无法直接传给 hook | 用 `sessionManager.getSessionFile()` 替代 |
| 完整 rawResponse | 无法保存完整 bash stdout/stderr | 用 tool result budget filepath 作为 rawRef |

### 8.5 Sprint 1 最小接口

**ToolResultNormalizeInput**:

```ts
interface ToolResultNormalizeInput {
  toolName: string;
  toolCallId: string;
  rawInput: Record<string, unknown>; // event.input
  modelFacingContent: (TextContent | ImageContent)[]; // event.content
  isError: boolean;
  exitCode?: number; // 从 content 解析
  sessionId: string; // ctx.sessionManager.getSessionId()
  sessionArtifactRef?: SessionArtifactRef;
}
```

**EvidenceSessionStore**:

```ts
interface EvidenceSessionStore {
  recordEvidence(input: ToolResultNormalizeInput): void;
  getEvidenceSnapshot(sessionId: string): ToolEvidence[];
  reconstructFromSessionEntries(entries: SessionEntry[]): ToolEvidence[]; // 兜底
  resetEvidence(boundary: 'session' | 'turn'): void;
}
```

**关键设计**:

- rawInput 直接从 `event.input` 拿
- exitCode 从 content 解析（已实现）
- session artifact 用 `sessionManager.getSessionFile()` + `getEntries()`
- transcript recovery 作为 reload 兜底，不依赖特定文件格式

### 8.6 Gap 分类结论

| Gap | Sprint 1 状态 |
|---|---|
| PostToolUse 缺完整 tool_response | ⚠️ 部分可用：content 是模型可见部分，rawRef 通过 tool result budget 补 |
| hook 缺 transcript_path | ✅ 有替代：sessionManager.getSessionFile() |
| 无法从 transcript 恢复 evidence | ✅ 可从 session entries 恢复 |
| tool result transcript 重建缺失 | ⚠️ 放入 Sprint 1：reconstructFromSessionEntries |
| Completion Auditor evidence scope 过宽 | ✅ 放入 Sprint 1：scoped audit |
| Prompt contract governance | ✅ 已建立治理规则 |

### 8.7 不做的事

- ❌ 不强行制造 Pi 不提供的字段
- ❌ 不依赖 session 文件格式的具体细节
- ❌ 不为对齐 cc-haha 而硬造脆弱依赖
- ❌ 不在 Sprint 1 接 verifier runtime
- ❌ 不在 Sprint 1 接 verification nudge runtime

## 9. Step 2B 最终结论

Step 2B 完成。已确认 Pi runtime 数据来源：

**核心发现**：

1. **rawInput 可用**：`event.input` 直接提供
2. **rawResponse 部分可用**：`event.content` 是模型可见部分，完整输出需通过 tool result budget filepath
3. **exitCode 需解析**：从 content 文本解析（已实现）
4. **session artifact 有替代**：`sessionManager.getSessionFile()` + `getEntries()`
5. **rawRef 可用**：tool result budget filepath 可被 evidence 引用

**Sprint 1 可以开始**：

- 接口已明确
- 数据来源已确认
- 不需要强行制造 Pi 不提供的字段
- 用 sessionManager 替代 transcript_path

**下一步**：进入 Sprint 1，实现 tool-result-normalizer + evidence-session-store。


Step 2A 快速浏览已完成。发现 6 个 gap：

- P1: 3 个（hooks transcript_path、tool_response、transcript recovery）
- P2: 1 个（GrowthBook override）
- P3: 2 个（verifier runtime、verification nudge runtime）
- Ignore: 1 个（prompts.ts 文案）

下一步：Step 2B 深入 top 2~3 个 gap（hooks transcript_path、tool_response、transcript recovery）。


## 9. Step 2B 最终结论

Step 2B 完成。已确认 Pi runtime 数据来源：

**核心发现**：

1. **rawInput 可用**： 直接提供
2. **rawResponse 部分可用**： 是模型可见部分，完整输出需通过 tool result budget filepath
3. **exitCode 需解析**：从 content 文本解析（已实现）
4. **session artifact 有替代**： + 
5. **rawRef 可用**：tool result budget filepath 可被 evidence 引用

**Sprint 1 可以开始**：

- 接口已明确
- 数据来源已确认
- 不需要强行制造 Pi 不提供的字段
- 用 sessionManager 替代 transcript_path

**下一步**：进入 Sprint 1，实现 tool-result-normalizer + evidence-session-store。

