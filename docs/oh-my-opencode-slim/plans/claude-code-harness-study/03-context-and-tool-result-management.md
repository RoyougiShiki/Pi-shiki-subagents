# 03 — Context 与 Tool Result 管理

本文记录 cc-haha 中上下文治理、大工具输出治理、压缩和恢复机制。这部分对减少幻觉非常重要，因为很多幻觉来自上下文污染、日志过长、历史信息失真或 prompt-too-long 后的错误恢复。

## 1. 相关源码

本地源码：

```txt
/tmp/pi-github-repos/NanmiCoder/cc-haha@main
```

关键文件：

| 机制 | 文件 | 关键函数 |
|---|---|---|
| 主循环调用 context 管理 | `src/query.ts` | `applyToolResultBudget`, `microcompact`, `autocompact` |
| autocompact | `src/services/compact/autoCompact.ts` | `shouldAutoCompact`, `autoCompactIfNeeded` |
| microcompact | `src/services/compact/microCompact.ts` | `microcompactMessages`, `cachedMicrocompactPath`, `maybeTimeBasedMicrocompact` |
| full compact | `src/services/compact/compact.ts` | `compactConversation`, `stripImagesFromMessages`, `stripReinjectedAttachments` |
| tool result storage | `src/utils/toolResultStorage.ts` | `persistToolResult`, `processToolResultBlock`, `applyToolResultBudget` |
| token budget | `src/query/tokenBudget.ts` | `checkTokenBudget` |

## 2. Context 管理分层

cc-haha 至少有以下层：

```txt
1. Tool result budget
2. Time-based microcompact
3. Cached microcompact / cache editing
4. Snip compact
5. Context collapse
6. Auto compact
7. Reactive compact
8. Max output token recovery
9. Token budget continuation
```

不是所有都要迁移，但要理解每一层解决的问题。

## 3. Tool Result Budget

源文件：

```txt
src/utils/toolResultStorage.ts
```

核心机制：

```txt
工具结果过大
  ↓
保存完整结果到 session/tool-results/{toolUseId}.txt/json
  ↓
上下文中只保留 preview + filepath
  ↓
模型需要完整内容时再 Read 文件
```

这解决两个问题：

1. 大日志污染上下文，导致模型忽略真正任务
2. 截断后模型误以为看到了完整输出

### 3.1 关键函数

- `persistToolResult` line 137
- `buildLargeToolResultMessage` line 189
- `processToolResultBlock` line 205
- `maybePersistLargeToolResult` line 272
- `applyToolResultBudget` line 924

### 3.2 对 Pi 的建议

优先实现：

```txt
tool_result_budget
```

规则：

```txt
if tool_result.length > threshold:
  save raw output to .pi/tool-results/{sessionId}/{toolUseId}.txt
  inject preview into context
  include file path for explicit recall
```

建议阈值：

| 输出类型 | 初始阈值 |
|---|---:|
| Bash 普通输出 | 20 KB |
| Test log | 40 KB |
| Grep/Search | 30 KB |
| Read file | 按工具自身 limit |
| JSON 输出 | 50 KB |

上下文中保留：

```txt
<persisted-output>
Output too large (123 KB). Full output saved to: ...
Preview:
...
</persisted-output>
```

## 4. Microcompact

源文件：

```txt
src/services/compact/microCompact.ts
```

### 4.1 Time-based microcompact

逻辑：如果距离上次 assistant message 已经过了较长时间，说明 prompt cache 可能冷了，旧工具结果不再值得保留，就清理旧结果。

核心函数：

- `evaluateTimeBasedTrigger`
- `maybeTimeBasedMicrocompact`

行为：

```txt
保留最近 N 个 compactable tool result
旧 tool_result 替换为 [Old tool result content cleared]
```

compactable tools 包括：

- FileRead
- shell tools
- Grep / Glob
- WebSearch / WebFetch
- FileEdit / FileWrite

### 4.2 对 Pi 的迁移

Pi 可实现简化版：

```txt
old_tool_result_cleaner:
  if session idle gap > threshold:
    keep last N tool results
    replace older bulky results with marker
```

建议 marker：

```txt
[old tool result cleared; full output available at {path if persisted}]
```

## 5. Auto Compact

源文件：

```txt
src/services/compact/autoCompact.ts
```

核心逻辑：

1. 根据模型 context window 计算有效窗口
2. 保留 summary 输出预算
3. 达到阈值触发 compact
4. 先尝试 session memory compact
5. 再尝试 full compact
6. 失败有熔断，避免无限浪费 API 调用

关键常量：

```txt
AUTOCOMPACT_BUFFER_TOKENS = 13_000
WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

### 5.1 对 Pi 的迁移

Pi 不一定要一开始做完整自动总结，但应先做：

```txt
context_pressure_monitor
```

输入：

- 当前消息估算 token
- 当前模型 context window
- tool result 总大小
- 已持久化输出数量

输出：

- warning
- auto cleanup
- force summary

### 5.2 简化实现

```txt
if estimatedContext > 70%:
  warn / show UI warning

if estimatedContext > 85%:
  clear old tool results
  summarize old sessions

if estimatedContext > 95%:
  block next call and require compact/recall
```

## 6. Reactive Compact

cc-haha 在 prompt-too-long 发生后，并不立即失败，而是：

1. withholding error
2. 尝试 context collapse drain
3. 尝试 reactive compact
4. retry
5. 失败后才返回错误

对 Pi 的迁移：

```txt
如果模型/API 报 context too long：
  1. 不立刻终止
  2. 清旧工具结果
  3. 生成压缩摘要
  4. 重新发起请求
  5. 仍失败才向用户报告
```

## 7. Compact Conversation

源文件：

```txt
src/services/compact/compact.ts
```

重要细节：

### 7.1 stripImagesFromMessages

压缩前移除图片/文档内容，用 `[image]` / `[document]` 替代。

理由：图片对总结用处有限，但会导致 compaction 自身爆上下文。

Pi 可迁移：

```txt
summary input 中不要直接包含大媒体 / 大二进制 / 大日志。
用 marker + metadata 替代。
```

### 7.2 stripReinjectedAttachments

会在下一轮重新注入的附件，不应该进入摘要，避免污染。

Pi 可迁移：

```txt
不要把 transient hints、skill discovery、UI-only attachment 写进长期 memory summary。
```

## 8. Token Budget Continuation

源文件：

```txt
src/query/tokenBudget.ts
```

功能：用户要求“花 N tokens 深入研究”时，系统会在模型过早停止时自动注入 continuation nudge。

这不一定是当前 Pi 的优先功能，但未来可泛化为：

```txt
work_budget
```

用途：

- 强制模型充分探索
- 防止大任务过早结束
- 可用于 benchmark / research 模式

## 9. 与幻觉的关系

上下文管理直接影响幻觉：

| 问题 | 产生的幻觉 |
|---|---|
| 大日志塞满上下文 | 模型忽略用户指令或关键文件 |
| 工具结果被截断 | 模型以为完整看过结果 |
| 旧结果过多 | 模型引用过期信息 |
| prompt-too-long 后失败恢复差 | 模型丢失任务状态 |
| compact summary 失真 | 模型基于错误摘要继续 |

所以 Pi 中应把 context 管理视为防幻觉核心，而不是性能优化。

## 10. Pi 迁移优先级

| 优先级 | 机制 | 原因 |
|---|---|---|
| P0 | large tool result persistence | 实现简单，收益大 |
| P0 | completion-time evidence summary | 防止虚假完成 |
| P1 | old tool result cleaner | 长会话稳定性 |
| P1 | context pressure monitor | 防止临界失败 |
| P2 | auto summary compact | 较复杂，但长期必要 |
| P2 | reactive compact retry | 需要与模型调用层深度结合 |
| P3 | cache editing | Claude-specific，未来抽象 provider capability |

