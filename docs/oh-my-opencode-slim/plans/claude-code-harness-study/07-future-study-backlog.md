# 07 — 后续学习 Backlog

本文保留所有尚未深入学习、暂时不迁移、但未来可能有价值的 cc-haha / Claude Code 类 harness 特性。原则：不因为当前 Claude-specific 就丢弃；先标注能力边界，未来可抽象为多模型兼容机制。

## 1. 已完成第一轮学习的模块

- `src/query.ts`
- `src/query/deps.ts`
- `src/constants/prompts.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/hooks/useCanUseTool.tsx`
- `src/query/stopHooks.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/microCompact.ts`
- `src/services/compact/compact.ts`
- `src/utils/toolResultStorage.ts`
- `src/services/api/claude.ts` 初步阅读

## 2. 需要继续深入的 cc-haha 模块

### 2.1 AgentTool / Subagent / Fork

路径：

```txt
src/tools/AgentTool/
src/coordinator/
src/tasks/
```

待研究问题：

- AgentTool 如何创建 worker
- worker 上下文如何隔离
- worker 结果如何回传主线程
- forked agent 如何减少主上下文污染
- coordinator prompt 如何约束 worker 不越权
- verifier agent 是否有现成设计

对 Pi 潜在价值：

```txt
research/fixer/verifier 三角色拆分
子代理结果结构化回传
主 agent 不直接读取所有 worker 大输出
```

### 2.2 QueryEngine / REPL / processUserInput

路径：

```txt
src/QueryEngine.ts
src/screens/REPL.tsx
src/utils/processUserInput/
src/cli/print.ts
```

待研究问题：

- 用户输入如何进入 query loop
- slash command 如何处理
- local commands / queued commands 如何进入附件
- headless / SDK / REPL 模式差异

对 Pi 潜在价值：

```txt
Pi Workbench 输入协议设计
slash command 与 UI command palette 合流
终端模式和 WebUI 模式共享 runtime
```

### 2.3 API 层完整研究

路径：

```txt
src/services/api/claude.ts
src/services/api/withRetry.ts
src/services/api/errors.ts
src/utils/api.ts
```

待研究问题：

- tool schema 如何转 Anthropic API schema
- thinking config 如何发送
- prompt cache block 如何构建
- retry/fallback 细节
- structured outputs 处理
- refusals/error synthetic assistant message 如何构造

当前判断：高度 Claude-specific，但不能丢弃。

未来抽象：

```ts
interface ModelProviderCapabilities {
  toolCalling: 'native' | 'json' | 'text'
  promptCache?: boolean
  cacheEditing?: boolean
  reasoningTrace?: 'thinking_blocks' | 'reasoning_content' | 'none'
  structuredOutput?: boolean
  maxOutputTokens?: number
  contextWindow?: number
}
```

### 2.4 Prompt Cache / Cache Editing

路径：

```txt
src/services/compact/cachedMicrocompact.ts
src/services/api/promptCacheBreakDetection.ts
src/utils/api.ts
```

待研究问题：

- static/dynamic prompt boundary 如何避免 cache bust
- cache_edits 如何删除旧 tool results
- prompt cache break 如何检测
- 这些机制对非 Claude 模型如何泛化

未来可能抽象为：

```txt
context_cache_layer
```

即使没有原生 prompt cache，也可用于：

- 本地 session cache
- semantic recall
- prefix stability analysis
- tool result retention policy

### 2.5 Context Collapse

路径可能在：

```txt
src/services/contextCollapse/
```

待研究问题：

- collapse 与 autocompact 的区别
- collapse 是否保留更细粒度上下文
- staged collapses 如何 drain
- prompt-too-long 恢复时如何使用

对 Pi 潜在价值：

```txt
比单次 summary 更好的长会话记忆策略
分段归档 + 按需恢复
```

### 2.6 Session Memory

路径：

```txt
src/services/SessionMemory/
src/services/extractMemories/
src/memdir/
```

待研究问题：

- memory 如何提取
- memory 如何注入 prompt
- memory 如何去重
- memory 与 compact 如何协同

对 Pi 潜在价值：

```txt
project memory
session recall
历史 bug/fix 记忆
长期偏好/约束记忆
```

### 2.7 Skills 系统

路径：

```txt
src/skills/
src/tools/SkillTool/
src/services/skillSearch/
```

待研究问题：

- skills 如何发现
- skills 如何按任务注入
- skill discovery 如何避免污染上下文
- skill invocation 与 slash command 如何关联

对 Pi 潜在价值：

```txt
Pi skills / workflow prompts
按任务自动发现技能
避免所有技能常驻 system prompt
```

### 2.8 Tool Search / Deferred Tools

参考来源：

```txt
https://github.com/bcefghj/ClaudeCode-Source-Analysis
HitCC/docs/02-execution/01-tools-hooks-and-permissions/01-tool-execution-core.md
```

路径：

```txt
src/tools/ToolSearchTool/
src/utils/toolSearch.ts
```

待研究问题：

- ToolSearch 如何返回 tool reference，而不是普通搜索结果
- request builder 如何根据 reference 注入 deferred tool schema
- 大量 MCP/扩展工具时如何避免工具描述常驻上下文
- 工具发现结果如何缓存、失效、审计

对 Pi 潜在价值：

```txt
减少 system prompt 工具描述长度
多 MCP 场景下动态工具发现
按 capability 暴露工具，而不是硬编码工具名
```

迁移约束：ToolSearch 在 Pi 中应抽象为 registry discovery；不要依赖上游文档片段、压缩符号名或固定工具列表。

### 2.9 LSP 机制（明确不作为当前迁移目标）

cc-haha 中存在 LSP 相关工具/服务路径，例如：

```txt
src/tools/LSPTool/
src/services/lsp/
```

当前判断：**不优先迁移 LSP 机制**。

原因：当前工作区已经通过扩展工具实现了“agent 对话结束触发 hook 编译/检查”，如果编译错误会反馈给模型继续处理。这个机制比常驻 LSP 更符合当前 Pi 扩展方向：

- 证据更明确：来自真实编译/测试输出
- 更贴近 completion auditor / stop hook
- 不需要维护语言服务器生命周期
- 对多语言/多项目更通用
- 更容易接入 tool-result-budget 和 evidence-tracker

后续原则：

```txt
优先保留 compile/test hook 作为验证源。
不迁移 cc-haha LSP 作为 P0/P1 能力。
除非未来需要 IDE 级补全/诊断/跳转，再单独评估 LSP。
```

### 2.10 Desktop / H5 / IM Remote

路径：

```txt
desktop/
src/server/
adapters/
```

待研究问题：

- desktop server sidecar 协议
- WebSocket 消息格式
- permission request 如何远程审批
- H5 token 如何保证安全
- IM 消息如何和 session 映射

对 Pi 潜在价值：

```txt
Pi Workbench remote mode
手机审批工具调用
IM 远程控制 session
```

### 2.11 Verification Agent / Evidence Contract（二轮后优先级上调）

第二轮已重点阅读：

```txt
src/tools/AgentTool/built-in/verificationAgent.ts
src/constants/prompts.ts
src/tools/TodoWriteTool/TodoWriteTool.ts
src/tools/TaskUpdateTool/TaskUpdateTool.ts
src/utils/hooks.ts
src/entrypoints/sdk/coreSchemas.ts
```

已确认的设计精髓：

```txt
- Stop hook 框架只提供 last_assistant_message / transcript_path，不直接等同工具成功与验证完成。
- PostToolUse hook 提供 tool_input / tool_response，保留语义判断空间。
- 强验证来自独立 verification agent，输出必须包含 Command run / Output observed / VERDICT。
- Reading code is not verification。
- 实现者自己的检查、caveat、自我声明不能替代 verifier。
- Todo/Task 关闭 3+ 项且无 verification step 时，tool result 注入提醒。
```

后续待研究问题：

- verification agent 结果在 AgentTool 父线程中如何回传和展示
- 是否有解析 `VERDICT: PASS|FAIL|PARTIAL` 的调用方或主要依赖 prompt contract
- verifier 与 Plan/ExitPlanMode/VerifyPlanExecution 的关系
- verifier skill / custom verifier 如何发现和调用
- 如何把 verifier verdict 映射到 Pi 的 evidence tracker 和 completion auditor

对 Pi 的优先价值：

```txt
把 verifier_agent 从原 P2 上调到 Phase 1.5 / Phase 2。
先修 evidence 判定：普通 bash 不算 verification。
再设计 verifier verdict parser 与结构化输出格式。
```

## 3. 当前不直接迁移但保留的 Claude-specific 特性

| 特性 | 当前不迁移原因 | 未来可能泛化方向 |
|---|---|---|
| thinking blocks | Claude API 特定 | reasoning trace abstraction |
| thinking signatures | Claude 特定校验 | provider-specific protected trace |
| prompt cache | Claude/Anthropic 支持好 | local prefix cache / provider capability |
| cache editing | Claude-specific beta | logical context deletion / local compaction |
| Anthropic beta headers | API 私有 | provider capabilities map |
| task budget beta | Anthropic API | generic work budget / continuation |
| fast mode headers | Claude-specific | latency/cost routing policy |
| advisor model | Anthropic 内部风格 | secondary critique model |

## 4. 下一步建议

### 4.1 研究任务

1. 深入 `AgentTool` 与 forked agent
2. 深入 `toolResultStorage.applyToolResultBudget`
3. 深入 `verification` / `stop hook` 相关 hooks
4. 深入 `SessionMemory` 与 memory prefetch
5. 深入 `ToolSearchTool`，评估是否适合 Pi MCP 工具过多场景

### 4.2 实现任务

优先实现：

```txt
P0:
  completion_auditor
  tool_result_budget

Phase 1.5:
  修正 evidence-adapter：普通 bash 不算 verification
  verifier verdict parser / evidence type
  verifier 输出格式设计（Command run / Output observed / VERDICT）

P1:
  verifier_agent runtime 接入
  todo/task 缺 verification step 结构化提醒
  diff_guard
  denied_tool_memory
  context_pressure_monitor

P2:
  model_router
  session_recall
```

### 4.3 UI 任务

暂缓完整桌面端，先设计 Workbench MVP：

```txt
session list/search
current session stream
tool call timeline
diff/evidence side panel
resume/fork controls
```

## 5. 重要原则

1. 不照搬 cc-haha 源码。
2. 不因为 Claude-specific 就删除学习成果。
3. 将 Claude-specific 机制抽象为 provider capabilities。
4. 优先迁移模型无关的 harness 控制点。
5. UI 服务于可观测性和可控性，不直接承担 agent core。
6. 当前项目不拆分，等 Pi Workbench 需求稳定后再考虑独立 repo。

