# 10 — Claude Code Source Analysis 校准补充

创建日期：2026-06-04

本文基于 `bcefghj/ClaudeCode-Source-Analysis` 的公开逆向分析，对本目录已有 cc-haha 学习文档做二次校准。本文只记录可迁移的 harness 机制，不复制上游实现，也不把压缩函数名、文档段落或可编辑数据文件当成 Pi 运行时依赖。

分析仓库地址：

```txt
https://github.com/bcefghj/ClaudeCode-Source-Analysis
```

主要参考目录：

```txt
HitCC/docs/
HitCC/recovery_tools/
```

## 1. 使用原则

该仓库适合作为第二来源，用来校准本地理解，但不能直接等同于实现规格：

- 只吸收稳定的工程模式：状态边界、事件语义、证据结构、权限分层、上下文分层。
- 不照搬上游压缩名、文件布局、prompt 文案或临时逆向结论。
- 对确认度分级：`confirmed` 可写入设计，`inferred` 只进 backlog，`unknown` 不进入实现。
- 本项目实现必须继续保持低复杂度、纯函数优先、runtime 编排解耦、配置唯一真源。

## 2. 需要修正的本地理解

| 主题 | 校准后理解 | 对本地设计的影响 |
|---|---|---|
| Stop hook | Stop 是完成前拦截点，不是强验证本体；强验证应由独立 verifier verdict 提供 | 文档和实现都避免把 Stop 直接写成“验证器” |
| Compact 时序 | compact 内部会触发 compact session 事件，但 compact 后的 instructions reload 应视为下一次 fresh request 的输入准备 | 不在同一阶段假设 instructions 立即重载 |
| `transition` | 只作为分支标记/调试信息理解，不作为 Pi 的核心控制流输入 | Pi 状态机用显式 decision/result 类型，不依赖字符串 marker |
| Tombstone | 是 live output 一致性信号，用于清理/修正半截输出，不是普通提示 | Workbench/UI 可消费；SDK/runtime 可选择吞掉或记录 |
| ToolSearch | 是 deferred tool registry discovery，返回工具引用，不是普通内容搜索 | 未来工具发现应基于 registry capability，而不是硬编码工具名 |
| Tool result | 分内部结构化结果与 transcript-facing block 两层 | 需要 normalization layer 和 pairing fixer |
| Permission mode | 是复合状态机，不是简单 enum；plan/auto/危险规则剥离存在耦合 | `permissionModeManager` 应独立于单次 permission decision |
| Hook surface | 已知事件面比第一轮假设更大 | 本项目 hook API 暂保持 experimental，不提前冻结 |
| Subagent | 至少区分 implicit fork、typed subagent、teammate；fork 不应可重入 | Pi 子代理设计应显式声明隔离级别和可重入策略 |

## 3. 低复杂度迁移边界

为了避免把研究文档变成难维护的“大而全复刻”，Pi 只迁移可拆分模块：

```txt
raw event / tool output
  ↓
normalizer 纯函数
  ↓
state/evidence store
  ↓
policy decision 纯函数
  ↓
runtime hook 编排
  ↓
UI / transcript / model message adapter
```

约束：

1. **不硬编码跨文档字符串**：实现不依赖“第几节”“某段文案”“某个 markdown 表格”。
2. **不依赖可编辑文档数据**：文档只说明设计；运行时配置来自 typed config/defaults。
3. **不硬编码工具/agent 名**：使用 tool group、capability、agent role 配置。
4. **不把逆向压缩名写进核心代码**：如需记录，只放 glossary/backlog。
5. **模块间只传 typed data**：不要让 runtime 到处传原始 transcript 字符串再各自 regex。

## 4. 推荐新增/强化的模块

### 4.1 Tool Result Normalizer

目标：把工具原始输出转换为两类产物：

```txt
StructuredToolResult：给 evidence/verifier/auditor 使用
TranscriptToolResultBlock：给模型上下文/UI 使用
```

最小字段：

```ts
interface StructuredToolResult {
  toolUseId: string
  toolName: string
  rawInput: unknown
  rawResponse: unknown
  success: boolean
  semantic?: string
  commandText?: string
  exitCode?: number
  affectedFiles?: string[]
  persistedRawRef?: string
  summary?: string
}
```

收益：解决 PostToolUse 证据缺完整 `tool_input/tool_response`、普通 bash 误判、tool result budget 与 verification 混层的问题。

### 4.2 Tool Result Pairing Fixer

目标：保证每个 `tool_use` 都有对应 `tool_result`，并处理：

- missing result：补 synthetic error result；
- orphan result：标记为 invalid 或归档，不继续污染下一轮；
- duplicate result：保留第一条或按策略折叠；
- streaming abort/fallback：清理半截 assistant/tool buffer。

该模块只做结构修复，不做验证判断。

### 4.3 Evidence Session Store

目标：替换纯全局内存 evidence，支持 reload/resume 后恢复。

建议边界：

```txt
recordEvidence(event)
reconstructEvidence(sessionTranscript | storedEvents)
getEvidenceSnapshot(sessionId)
resetEvidence(sessionBoundary)
```

优先从 typed event/store 恢复；transcript 恢复只作为兼容路径，避免把 transcript 文案变成唯一真源。

### 4.4 Permission Mode Manager

目标：把“当前处于什么权限模式”与“这次工具调用是否允许”拆开。

```txt
mode state: ask / plan / accept_edits / auto / bypass
policy decision: allow / ask / deny
risk transform: strip dangerous allow rules / restore rules / downgrade to ask
```

危险规则、tool group、自动模式开关都来自 config，不在 runtime 中散落字符串。

### 4.5 Verifier Runtime Adapter

目标：把已完成的 verifier verdict parser / verification nudge 接入运行时，但保持 verifier 可替换。

```txt
main agent completion claim
  ↓
needsVerificationDecision 纯函数
  ↓
spawn verifier role（只读/运行检查权限）
  ↓
parseVerifierVerdict
  ↓
record structured verdict evidence
  ↓
completion auditor 消费 verdict
```

注意：verifier agent 名称、可用工具、输出模板都应配置化；核心只依赖 `role=verifier` 和 verdict schema。

## 5. 文档修订落点

后续维护时按以下位置同步，而不是在多个文件重复长段解释：

- `01-core-harness-map.md`：主循环、tombstone、transition、compact 时序、tool pairing。
- `02-anti-hallucination-instruction-following.md`：Stop hook 与 verifier 的职责边界。
- `03-context-and-tool-result-management.md`：tool result 两层模型、normalizer、pairing fixer。
- `04-tools-permissions-and-orchestration.md`：复合 permission mode、ToolSearch/deferred tools、hook surface。
- `05-pi-extension-mapping.md`：实施优先级，先 P1 reliability / Phase 1.5 runtime wiring，再扩新功能。
- `08/09`：实现进度和 review 只记录状态，不承载规范真源。

## 6. 更新后的优先级

```txt
P0 文档校准：修正 Stop / compact / tombstone / ToolSearch / permission / tool_result 语义。
P1 可靠性：evidence persistence、PostToolUse full semantics、transcript recovery、denied-tool-memory persistence。
P1.5 接线：verifier verdict parser、verification nudge、completion auditor 消费 verdict。
P2 结构化：tool-result normalizer、pairing fixer、permission mode manager。
P3 扩展：model router、session recall、Workbench UI、deferred tool registry discovery。
```

不要在 P1/P1.5 未稳定前继续扩大 hook API 或 Workbench UI 范围。

## 7. 参考来源

- `https://github.com/bcefghj/ClaudeCode-Source-Analysis`
- 重点目录：`HitCC/docs/01-runtime`、`HitCC/docs/02-execution`、`HitCC/docs/03-ecosystem`、`HitCC/docs/04-rewrite`

这些来源用于研究校准；实现仍以本项目 typed config、policy 模块和测试为准。
