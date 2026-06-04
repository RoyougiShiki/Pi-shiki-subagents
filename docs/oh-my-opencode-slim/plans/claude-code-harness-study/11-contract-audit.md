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
| 6 | `constants/prompts.ts` → `src/pi/harness/messages.ts` | Verification contract: 非平凡实现必须独立验证。Denied tool: 不重复相同调用。Truthfulness: 不声称未验证的事 | Pi 有 messages/defaults，部分原则已体现在 harness 逻辑中。不应逐行复制上游 prompt | ⚠️ 只审原则，不复制文案 | Ignore / acceptable divergence。保持 message 唯一真源，不同语言/配置可替换 | message 唯一真源；不同语言/配置可替换 |

## 3. 下一步

1. 继续 P0.5 contract audit，不做无限逐行复刻。
2. 每发现一个 gap，按 `fix now / fix in Sprint / ignore` 分类。
3. 进入 P1 Sprint 1 时，把 #1 的 hotfix 收编到 `tool-result-normalizer`：

```txt
raw tool output
  -> command semantics
  -> StructuredToolResult（内部 evidence）
  -> TranscriptToolResultBlock（模型可见消息）
```

## 4. Gap 优先级排序

| 优先级 | Gap | 处理方式 |
|---|---|---|
| **P1** | PostToolUse 缺完整 `tool_response` | 放入 `tool-result-normalizer` |
| **P1** | 所有 hook 缺 `transcript_path` | 放入 `evidence-session-store` |
| **P1** | 无法从 transcript 恢复 evidence | 放入 `evidence-session-store` |
| **P1** | 缺 tool result transcript 重建 | 放入 `evidence-session-store` |
| **P2** | 缺 GrowthBook override | 延后 |
| **P3** | verifier-verdict runtime 未接入 | Phase 1.5 |
| **P3** | verification-nudge runtime 未接入 | Phase 1.5 |
| **Ignore** | prompts.ts 文案差异 | 只审原则，不复制文案 |

## 5. Sprint 1 设计方向

根据 contract audit 发现的 gap，Sprint 1 应包含：

### 5.1 tool-result-normalizer

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

### 5.2 evidence-session-store

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

### 5.3 PostToolUse rawInput/rawResponse

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

### 5.4 reload 后 evidence 恢复

流程：

```
reload / session start
  ↓ read transcript_path
  ↓ reconstructEvidencesFromTranscript
  ↓ populate EvidenceSessionStore
  ↓ completion auditor 可跨 turn 判断
```

## 6. 当前结论

Step 2A 快速浏览已完成。发现 6 个 gap：

- P1: 3 个（hooks transcript_path、tool_response、transcript recovery）
- P2: 1 个（GrowthBook override）
- P3: 2 个（verifier runtime、verification nudge runtime）
- Ignore: 1 个（prompts.ts 文案）

下一步：Step 2B 深入 top 2~3 个 gap（hooks transcript_path、tool_response、transcript recovery）。
