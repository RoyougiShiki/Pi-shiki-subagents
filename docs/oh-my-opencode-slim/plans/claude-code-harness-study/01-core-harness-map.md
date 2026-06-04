# 01 — cc-haha 核心 Harness 地图

本文记录 cc-haha / Claude Code 类 harness 的核心代码路径、主循环结构和关键控制点。

## 1. 核心源码位置

cc-haha 本地源码路径：

```txt
/tmp/pi-github-repos/cc-haha@main
```

第一轮重点阅读文件：

| 机制 | 文件 | 关键位置 |
|---|---|---|
| 主 agent loop | `src/query.ts` | `query` line 221, `queryLoop` line 243 |
| 依赖注入 | `src/query/deps.ts` | `productionDeps` |
| system prompt 构造 | `src/constants/prompts.ts` | `getSystemPrompt` line 444 |
| 工具编排 | `src/services/tools/toolOrchestration.ts` | `runTools` line 19 |
| 工具执行 | `src/services/tools/toolExecution.ts` | `runToolUse` line 337 |
| 权限决策 | `src/hooks/useCanUseTool.tsx` | `CanUseToolFn` line 27, `useCanUseTool` line 28 |
| stop hooks | `src/query/stopHooks.ts` | `handleStopHooks` line 81 |
| autocompact | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded` line 241 |
| microcompact | `src/services/compact/microCompact.ts` | `microcompactMessages` line 253 |
| 大工具输出治理 | `src/utils/toolResultStorage.ts` | `applyToolResultBudget` line 924 |
| API 调用 | `src/services/api/claude.ts` | `queryModelWithStreaming` line 755 |

## 2. 主循环结构

`src/query.ts` 是整个 harness 的核心。它不是简单地：

```txt
user prompt -> model -> answer
```

而是一个递归/迭代的 agent loop：

```txt
messages + systemPrompt + userContext + tools
  ↓
前置上下文处理
  - memory prefetch
  - skill prefetch
  - tool result budget
  - snip / microcompact / context collapse
  - autocompact
  ↓
callModel / streaming
  ↓
收集 assistant message
  ↓
如果出现 tool_use
  ↓
执行工具
  - streaming tool executor 或 runTools
  - permission gate
  - pre/post tool hooks
  - tool result persistence / budget
  ↓
收集 tool_result + attachments + memory + skill discovery
  ↓
构造下一轮 messages
  ↓
继续 loop
  ↓
如果没有 tool_use
  ↓
recover / stop hooks / token budget / completed
```

## 3. QueryParams 的核心输入

`query.ts` 中 `QueryParams` 包括：

- `messages`
- `systemPrompt`
- `userContext`
- `systemContext`
- `canUseTool`
- `toolUseContext`
- `fallbackModel`
- `querySource`
- `maxTurns`
- `taskBudget`
- `deps`

其中最值得迁移思想的是 `deps`：

```ts
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}
```

这说明 cc-haha 把主循环的关键副作用抽成依赖，便于测试、替换和恢复。

对 Pi 的启发：

```txt
Pi 扩展中也应把以下能力抽象为可替换模块：
- modelCaller
- toolExecutor
- permissionDecider
- contextManager
- completionAuditor
- evidenceTracker
```

## 4. 主循环中的关键保护点

### 4.1 tool result pairing 保护

当模型已经发出 `tool_use`，但模型调用/流式过程异常中断时，cc-haha 会补 synthetic `tool_result`，避免后续 API 因 tool_use 没有配对 tool_result 而失败。

相关位置：

- `src/query.ts`
  - `yieldMissingToolResultBlocks`
  - streaming error catch
  - abort handling

对 Pi 的启发：

```txt
任何 agent harness 都应该保证：
每个 tool_use 最终都有 tool_result / synthetic_error_result。
```

否则会产生：

- 会话状态损坏
- 模型下一轮上下文不一致
- UI 显示 orphan tool call
- 恢复会话失败

### 4.2 fallback model 保护

`query.ts` 支持 `FallbackTriggeredError`：

1. 当前模型高负载或失败
2. tombstone 已产生的 orphan assistant messages
3. 清空当前 assistant/tool buffers
4. 切到 fallback model
5. 重新调用

重点不是 fallback 本身，而是“清理半截状态”。

对 Pi 的启发：

```txt
如果模型调用失败并重试，必须清理：
- partial assistant messages
- partial tool uses
- pending tool results
- streaming executor 状态
```

### 4.3 输出超限恢复

cc-haha 对 `max_output_tokens` 有两层恢复：

1. 可选地提高 max output tokens 后重试
2. 注入 meta user message，让模型从中断处继续

恢复提示大意：

```txt
Output token limit hit. Resume directly — no apology, no recap.
Pick up mid-thought. Break remaining work into smaller pieces.
```

对 Pi 的启发：

```txt
如果模型输出被截断，继续提示必须明确：
- 不道歉
- 不总结前文
- 从中断处继续
- 将剩余工作拆小
```

### 4.4 prompt-too-long 恢复

cc-haha 不是直接报错，而是：

1. withholding recoverable error
2. context collapse drain
3. reactive compact
4. retry
5. 如果仍失败再向用户暴露错误

对 Pi 的启发：

```txt
context 爆掉时，不应立刻失败；应有恢复链：
- 清理旧工具结果
- 总结历史
- 压缩附件/媒体
- 回退到只保留关键上下文
```

## 5. Tool execution 路径

模型输出 tool_use 后：

```txt
query.ts
  ↓
StreamingToolExecutor 或 runTools
  ↓
toolOrchestration.ts
  ↓
toolExecution.ts / runToolUse
  ↓
canUseTool / permission
  ↓
runPreToolUseHooks
  ↓
tool.call
  ↓
processToolResultBlock
  ↓
runPostToolUseHooks
  ↓
tool_result message
```

### 5.1 并发/串行策略

`toolOrchestration.ts` 中的核心逻辑：

- 读类/并发安全工具可以批量并发
- 写类/不安全工具必须串行
- 每个工具可以声明 `isConcurrencySafe(input)`

对 Pi 的启发：

```txt
工具定义需要包含：
- readonly / write / dangerous 分类
- concurrencySafe 判定
- scope 影响范围
- result size policy
```

### 5.2 Context modifier

工具执行可以返回 `contextModifier`，用于更新 `ToolUseContext`。

对 Pi 的启发：

```txt
工具执行不应只返回字符串结果；还应能更新 harness 状态：
- 最近读过哪些文件
- 最近修改了哪些文件
- 当前 task 状态
- verification evidence
- diff evidence
```

## 6. Attachments / Memory / Skill Discovery

cc-haha 在工具执行后、下一轮模型调用前注入：

- queued command attachments
- file change attachments
- memory prefetch attachments
- skill discovery attachments

这些不是普通用户消息，而是 harness 注入的结构化上下文。

对 Pi 的启发：

```txt
Pi 扩展可以建立 hidden/context attachments 层：
- changed_files
- verification_evidence
- failed_tools
- relevant_memory
- session_recall
- available_skills
```

## 7. 最小可迁移 Loop 模型

不需要复制 cc-haha 全部代码。Pi 可以先实现简化版：

```txt
before_model_call:
  - trim large tool results
  - attach relevant memory
  - attach current diff summary

after_model_stream:
  - collect tool_use
  - guarantee tool_result pairing

after_tool_result:
  - persist large outputs
  - record evidence
  - record changed files

before_final_answer:
  - stop hook / completion auditor
  - if blocking error, inject meta message and continue
```

## 8. 第二轮源码复核：Verification 不是简单 Bash 成功

第二轮对 cc-haha 源码补充阅读后，需要修正第一轮理解：completion / verification 相关机制不能只从 Stop hook 大纲推导。

### 8.1 Stop hook 的实际职责

相关文件：

- `src/utils/hooks.ts`
- `src/query/stopHooks.ts`
- `src/entrypoints/sdk/coreSchemas.ts`

源码事实：

```txt
StopHookInput / SubagentStopHookInput 包含：
- hook_event_name: Stop | SubagentStop
- stop_hook_active
- last_assistant_message
- transcript_path
- agent_transcript_path（子代理）
```

Stop hook 本体是通用 hook 框架：它把最后助手消息和 transcript 路径交给 hook，而不是内置“某个工具成功就是已验证”的判断。

### 8.2 PostToolUse 提供完整输入/输出

相关文件：

- `src/utils/hooks.ts`
- `src/entrypoints/sdk/coreSchemas.ts`

`PostToolUseHookInput` 包含：

```txt
- tool_name
- tool_input
- tool_response
- tool_use_id
```

这意味着 verification 判定应该基于工具输入/输出语义和任务上下文，而不是只看工具名。

### 8.3 独立 verification agent 才是核心验证设计

相关文件：

- `src/tools/AgentTool/built-in/verificationAgent.ts`
- `src/constants/prompts.ts`
- `src/tools/TodoWriteTool/TodoWriteTool.ts`
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts`

cc-haha 的关键设计不是“Bash 成功 = verified”，而是：

```txt
非平凡实现完成前，需要 independent adversarial verification。
实现者自己的检查、caveat、自我声明不能替代 verifier。
verifier 必须给出 VERDICT: PASS | FAIL | PARTIAL。
PASS 检查必须有 Command run 与 Output observed。
Reading code is not verification。
```

Todo/Task 完成路径还有结构化 nudge：当主线程关闭 3+ 个 task/todo 且没有 verification step 时，tool result 会提醒最终总结前 spawn verification agent，且不能 self-assign PARTIAL。

### 8.4 对 Pi 迁移的修正

第一版 Pi harness 的风险点：

```txt
DEFAULT_VERIFICATION_TOOLS = ["bash"]
```

该设计会把 `git status`、`grep`、`echo` 等普通 bash 成功误判为 verification，属于只学到机制大纲、没有学到 cc-haha 细节精髓的幼稚设计。

后续 Pi 设计必须遵守：

1. 普通工具成功不等于 verification。
2. verification evidence 应是结构化、可复跑、与任务相关的证据。
3. 独立 verifier verdict 应作为更强证据类型。
4. todo/task 关闭提醒应参考 cc-haha 的结构化 nudge。
5. 所有判定规则应在纯函数模块中实现，默认 pattern/message/阈值来自唯一真源，runtime 层只编排，不硬编码。
