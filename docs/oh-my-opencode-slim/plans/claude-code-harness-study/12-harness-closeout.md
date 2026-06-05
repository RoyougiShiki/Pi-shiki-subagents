# 12 — Harness Closeout / Known Limitations

创建日期：2026-06-05

本文用于给 cc-haha / Claude Code harness 对齐阶段收口。结论：当前 Pi harness 已完成 P0/P0.4 级可靠性闭环，后续不再继续复刻 Claude Code runtime/transcript 系统；除非出现真实失败案例，否则 harness 进入维护模式。

## 1. 收口结论

当前 harness 定位为：

```txt
轻量 anti-hallucination / instruction-following guardrail
```

不是：

```txt
完整任务证明系统
完整 transcript reconstruction 系统
完整 Claude Code runtime 复刻
子代理生命周期数据库
权限模式平台
```

当前已覆盖最关键行为契约：

- 工具结果语义会同时影响内部 evidence 和模型可见消息。
- 大输出 replacement state 可在 reload 后恢复。
- verifier verdict 可持久化和恢复。
- minimal evidence summary 可持久化和恢复。
- 旧 verifier PASS / 旧验证证据不能验证后续新修改。
- 多任务完成但缺少验证时有 model-visible nudge。
- completion audit 具备基本 temporal validity。
- simple pipeline command semantics 按最后 pipeline stage 解释，且不确定时保守 fallback。

因此，harness 收口标准已满足。

## 2. 已完成的关键项

| 领域 | 当前状态 |
|---|---|
| Command semantics | `grep`/`rg`/`find`/`diff`/`test` 等非零语义已接入 normalizer、evidence、runtime hook |
| Simple pipeline semantics | `cat file \| grep pattern` 按最后 stage `grep` 解释；`&&`/`\|\|`/`;`/`&`/malformed pipeline 保守 fallback |
| Tool result budget | 大输出 replacement 和 state 可持久化恢复 |
| Verifier verdict | `VERDICT: PASS\|FAIL\|PARTIAL` 可解析、接入 runtime、持久化恢复 |
| Evidence recovery | 持久化 minimal summary，而不是完整 evidence/transcript |
| Temporal validity | verification/test/lint/typecheck/verdict 必须晚于相关 modification 才能计入 |
| Verification nudge | 多个任务完成且缺少 verifier 时产生 model-visible 提醒 |
| Preset/subagent model | active preset 和 subagent model resolution 已修复 |

## 3. 轻量实现边界

### 3.1 Companion JSON，而不是完整 transcript system

当前持久化策略是有意保持轻量：

```txt
{storageBaseDir}/{sessionId}/.budget-state.json
{storageBaseDir}/{sessionId}/.verifier-verdicts.json
{storageBaseDir}/{sessionId}/.evidence-summary.json
```

只保存行为契约恢复需要的最小字段，不保存完整 tool result、完整 transcript、完整 raw response 或完整 evidence graph。

### 3.2 Evidence summary，而不是 evidence replay

当前 reload 后恢复的是 summary：

- evidence kind 集合；
- 修改/失败计数；
- 最近 modification / verification / failure / test / lint / typecheck 时间戳。

不重放完整历史工具结果。这样可以支持 completion audit 的关键判断，同时避免与 Pi session 文件格式强耦合。

### 3.3 Pipeline semantics 是保守 heuristic

支持范围：

```bash
cat file.txt | grep pattern
printf foo | rg missing
cat old.txt | diff - new.txt
echo path | test -f missing_file
```

不支持或保守 fallback：

```bash
cmd || grep pattern
cmd && grep pattern
set -o pipefail; cat file | grep pattern
sleep 1 & cat file | grep pattern
| grep pattern
cat file |
cat file | | grep pattern
```

该逻辑只用于 evidence/model-facing exit-code interpretation，不能用于权限或安全决策。

## 4. Known limitations

以下限制是当前阶段接受的设计边界，不作为继续深挖 harness 的 blocker。

### 4.1 单 active runtime 假设

同一个 session 的 companion JSON 写入只保证当前 Pi runtime 内通过队列串行化。多个独立 Pi 进程同时写同一 session companion files 的场景不在当前范围。

### 4.2 Timestamp 精度可能保守误警告

temporal validity 使用时间戳比较。若修改和验证发生在极近时间内，严格顺序判断可能产生保守 warning。当前选择是宁可误提醒，也不把 stale verification 当成有效验证。

### 4.3 不追踪外部修改

通过 Pi 工具之外发生的文件修改、测试运行或验证行为，不保证被 harness 自动识别。必要时用户/模型应显式说明验证情况或重新运行相关检查。

### 4.4 不保存完整 raw response

完整 stdout/stderr 或 tool response 不作为常规 evidence 持久化内容。大输出可通过 tool result budget rawRef 保留，但 completion audit 只消费结构化摘要。

### 4.5 不实现完整 permission memory persistence

`denied-tool-memory` reload 后持久化仍是 backlog。除非出现真实 permission UX 问题，否则不作为 harness 收口 blocker。

### 4.6 不复刻 cc-haha prompt/runtime 系统

cc-haha 的 prompt layering、permission manager、transcript reconstruction、task runtime、remote/session UI 等只作为行为参考。Pi 侧只迁移可测试、低复杂度、与当前 runtime 契合的 guardrail。

## 5. 旧文档 gap 归档

| 旧 gap | 当前处理 |
|---|---|
| PostToolUse 缺完整 `tool_response` | 部分实现：使用 Pi hook 可得字段 + normalizer + rawRef；不追求完整 raw response |
| hook 缺 `transcript_path` | 用 `sessionManager.getSessionId()` / `getSessionFile()` 和 companion state 替代 |
| transcript recovery | 不做完整 transcript replay；用 minimal summary persistence 覆盖 P0 行为 |
| verifier runtime 未接入 | 已接入并持久化 verdict |
| verification nudge runtime 未接入 | 已接入 tool_result/message-visible nudge |
| command semantics 未改写模型消息 | 已通过 tool-result-normalizer/runtime hook 修复 |
| pipeline command semantics | 已实现 simple pipeline last-stage heuristic |
| GrowthBook override | 延后；当前 typed config 足够 |
| denied-tool-memory persistence | 延后；等待真实问题 |
| permission mode manager | backlog；不作为当前 harness 范围 |
| prompt contract governance | 保持 `messages.ts` 集中、短文本、runtime 选择；不单独扩展系统 |

## 6. 后续优先级

harness 当前进入维护模式。建议后续路线：

```txt
1. Chain search / research capability MVP
2. Subagent detail TUI / observability
3. Tauri / desktop shell
```

只有在出现真实 harness 失败案例时，才回到本目录补具体 bugfix。避免为了“更像 Claude Code”继续扩大状态系统、transcript 系统或权限系统。

## 7. 维护规则

后续如果要修改 harness，应先按以下标准判断：

1. 是否有真实失败或明确行为契约缺口？
2. 是否可以用纯函数 + 小范围 runtime wiring 解决？
3. 是否避免新增长期状态或跨进程同步？
4. 是否有 regression tests 覆盖 false positive 和 false negative？
5. 是否不依赖 cc-haha 内部文件名、压缩名、prompt 原文或可编辑文档内容？

若答案不满足，应放入 backlog，而不是继续扩大 harness。
