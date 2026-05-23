---
source: analysis
requirementDoc: null
---

# 窄范围 Stage 协议清理计划

## 来源

来自 analysis 阶段对生产代码中 Stage 协议状态的审计结论。参见 analysis 阶段的完整证据链。

## 范围

只清理以下 5 项，不从 `needs_clarification` 开始展开新的 changeHandling / opencode / hooks 设计：

1. **`readStageOutput()` 去掉 `clarify` alias** — 只保留 `needs_clarification`
2. **移除 `queuedStageResult()` 的 `response` JSON fallback** — 测试夹具不再从普通文本 JSON 解析 StageOutput
3. **同步测试语义命名与夹具** — 所有 `type: 'clarify'` → `type: 'needs_clarification'`，测试名称反映当前语义
4. **清理 subagent-pool.ts 未消费的 `stageResult`** — 去掉 `PoolEntry.stageResult` 字段及 `agent_end` 中对应解析逻辑
5. **修正 `pi.ts` 顶部 declaration gates 注释** — 反映当前 No declaration hard gates 现状

## 不在此计划内的内容

- `changeHandling` 产品化
- `opencode` 集成变更
- hooks 目录变更
- 模型 fallback 调整
- council deprecated compatibility
- `compliance_check` 行为删除

## 每项验证方式

| 任务 | 验证 |
|------|------|
| Task 1 | `readStageOutput` 不再处理 `type: "clarify"`；有匹配用例 |
| Task 2 | `queuedStageResult` 不再调用 `JSON.parse(next.response)`；JSON 回退测试通过显式 `stageResult` 或 `skipStageResult` |
| Task 3 | 所有测试的 `stageResult.type` 使用 `needs_clarification` 而非 `clarify`；测试名称不含旧语义 alias |
| Task 4 | `PoolEntry` 无 `stageResult` 字段；`list()` 返回值不含 `stageResult`；`agent_end` 分支不设置该字段 |
| Task 5 | `pi.ts` 顶部注释不出现 "Declaration gates are enforced" |
| Task 6 | `bun test src/adapters/workflow-manager.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts` 全部通过；`bun run typecheck` 通过；`bun run build:plugin` 通过 |

## 关键决策

- 不要因 `needs_clarification` 被保留而展开新的 changeHandling 协议设计
- `subagent-pool.ts` 的 `toolCalls`、`lastResponse`、timeout 后 `agent_end`、`tool_execution_end` 释放 pending 等逻辑保持不动
- `pi.ts` 注释只修正定位说明，不移除 `compliance_check` 功能

## 风险

- 若 `queuedStageResult` 移除 JSON fallback 后存在隐藏依赖，测试失败说明需要同步测试语义，不是恢复 fallback
- 删除 `clarify` alias 后 `needs_clarification` 仍然有效，旧 changeHandling 测试用显式 `type: 'needs_clarification'` 表达
- 误删 `agent_end` 分支中 `toolCalls` 或 `pendingResolve` 会破坏 subagent lifecycle — 删除区要精确

## 传给实施阶段的最小上下文

- 按窄范围执行即可，无需继续提问
- 保持协议边界：stage result 只来自 runtime stage tool 写 IPC result file；普通文本 JSON 不再作为 fallback
- 若 workflow 在维护迭代中无法正常工作，提示用户切换 fallback，由主会话/助手继续

## 实施记录

- 最终源码变更仅限 `src/adapters/pi.ts` 顶部 Architecture 注释；未修改运行时代码。
- Task 1-4 经 oracle 复核为当前 HEAD 天然满足/no-op：未发现 `readStageOutput`/`queuedStageResult`/`JSON.parse(next.response)`/`stageResult` 残留/`type: 'clarify'` 测试夹具。
- Task 5 已完成：注释改为 `Constitution/orchestrator prompt is injected via before_agent_start`，并说明 legacy declaration gate checks (tool_call blocking) 与 compliance_check 仍作为 adapter quality gates 保留。
- 验证结果：指定 4 个 adapter 测试 PASS（fixer 报告 46 pass, 0 fail）；`bun run typecheck` PASS；`bun run build:plugin` PASS；oracle 额外完整 `bun test` PASS（1068 tests）。
- oracle 最终规格与质量审查：PASS。
