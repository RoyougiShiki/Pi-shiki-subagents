# Harness Implementation Review — 2026-06-04

## 1. 对照 cc-haha 源码的风险/问题表

| # | 模块 | 问题/风险描述 | cc-haha 对应 | 当前状态 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `evidence-adapter.ts` | **已修**: 普通 bash 成功误判为 verification | `verificationAgent` + prompt contract | ✅ 已修 | done | Phase 1.5 第一轮修复 |
| 2 | `run-harness-audit.ts` | **已修**: 重复未验证 warning；已承认“尚未验证”仍警告 | Stop hook 只提供上下文，不粗暴判断 | ✅ 已修 | done | Phase 1.5 第二轮修复 |
| 3 | `evidence-tracker.ts` | 全局状态 `_evidences`，reload/session 边界不清 | cc-haha hook 每轮拿到 transcript_path，可重建 | ⚠️ 风险 | P1 | 需确认 reset 时机和 session 生存期 |
| 4 | `commandSemantics` | **缺失**: 不同命令退出码语义（grep 返回 1 ≠ 错误） | `src/tools/BashTool/commandSemantics.ts` | ❌ 缺失 | P1 | 当前把所有非 0 退出码当成 failure |
| 5 | `TodoWriteTool/TaskUpdateTool` nudge | **缺失**: 关闭 3+ task/todo 且无 verification step 时提醒 | TodoWriteTool/TaskUpdateTool 输出 `verificationNudgeNeeded` | ❌ 缺失 | P1.5 | 当前 todo/task 工具没有这个输出字段 |
| 6 | `verifier verdict parser` | **缺失**: 无法识别 `VERDICT: PASS|FAIL|PARTIAL` | `verificationAgent` prompt + tool contract | ❌ 缺失 | P1.5 | 纯函数 parser 可做，不接 runtime |
| 7 | `tool-result-budget.ts` | threshold 静态配置，无 GrowthBook 动态覆盖 | `PERSIST_THRESHOLD_OVERRIDE_FLAG` | ⚠️ 低风险 | P2 | 当前阈值来自 config，不支持运行时 flag |
| 8 | `final-request-detector.ts` | 纯 pattern 检测用户是否请求最终答案 | cc-haha Stop hook 不做“用户意图”判断 | ⚠️ 合理偏差 | P2 | 我们用 pattern，cc-haha 不在此层判断 |
| 9 | `denied-tool-memory.ts` | 会话级 memory，reload 后丢失 | cc-haha permission memory + session 持久化 | ⚠️ 风险 | P1 | 需对照 cc-haha permission memory 机制 |
| 10 | `completion-auditor.ts` pattern | 过度依赖自然语言 pattern 检测“完成/未验证” | cc-haha 也用 prompt contract，但有 verifier verdict | ⚠️ 中风险 | P1.5 | pattern 可配置，但不是最终解 |
| 11 | `PostToolUse hook` | **缺失**: 未保留完整 `tool_input/tool_response` 语义 | `PostToolUseHookInput` 包含完整输入输出 | ❌ 缺失 | P1 | 当前 evidence 只记 toolName/args/success |
| 12 | `Stop hook` transcript | **缺失**: 无法从 transcript 重建 evidence | Stop hook 输入包含 `transcript_path` | ❌ 缺失 | P1 | reload 后 evidence memory 清空，无 transcript 恢复 |
| 13 | `verification-evidence-policy.ts` | 通用 guard 在 finalText 承认后仍警告（已修） | Stop hook 不做粗暴 verification 判断 | ✅ 已修 | done | 通过 `acknowledgesMissingValidation` 调用 |
| 14 | `pi.ts` integration | `message_end` 只 notify，不 block；无 tool_result hook 完整集成 | Stop hook 可以 block/message_edit | ⚠️ 当前设计 | P2 | 我们选择 P0 只 notify，不改消息 |

---

## 2. 优先级分类

### P0: Done (已修)

- #1 普通 bash 不再误判为 verification
- #2 重复 warning 去重 + 承认未验证后不再警告
- #13 verification-evidence-policy 配合 completion auditor

### P1: 需要尽快修

- #3 evidence-tracker 全局状态 + session 边界
- #4 commandSemantics（grep/rg/find 退出码语义）
- #9 denied-tool-memory reload 后丢失
- #11 PostToolUse 保留完整 tool_input/tool_response
- #12 Stop hook transcript 恢复 evidence

### P1.5: 纯函数可先做，runtime 后续

- #5 TodoWrite/TaskUpdate verification nudge（输出字段）
- #6 verifier verdict parser（纯函数）
- #10 减少 pattern 过度依赖（引入 verdict）

### P2: 可延后

- #7 GrowthBook threshold override
- #8 final-request-detector pattern 合理偏差
- #14 message_end 只 notify 设计

---

## 3. 详细分析

### 3.1 evidence-tracker 全局状态 (#3)

**当前实现**：

```ts
let _evidences: ToolEvidence[] = [];

export function resetEvidence(): void {
  _evidences = [];
}
```

**问题**：

- 全局变量，reload 后清空
- 无法从 transcript 恢复
- session 边界不清晰

**cc-haha 对应**：

- Stop hook 输入包含 `transcript_path`
- 可以从 transcript 重建历史 evidence
- 每轮 hook 可以拿到完整上下文

**建议修正方向**：

1. 不要只靠全局内存
2. 提供 `reconstructEvidencesFromTranscript` 纯函数
3. 明确 session 生存期和 reset时机
4. 在 `pi.ts` 里正确处理 reload 边界

---

### 3.2 commandSemantics (#4)

**当前实现**：

- 所有非 0 退出码当成 `tool_failure`
- `grep` 返回 1（no matches）被当成失败

**cc-haha 对应**：

```ts
// grep: 0=matches found, 1=no matches, 2+=error
['grep', (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? 'No matches found' : undefined,
})],
```

**建议修正方向**：

1. 新增 `src/pi/policy/command-semantics.ts`
2. 纯函数：`(command, exitCode, stdout, stderr) -> { isError, semantic }`
3. 默认语义表：
   - `grep` / `rg`: exitCode 1 = no matches (not error)
   - `find`: exitCode 1 = partial success
   - `test`: exitCode != 0 = failure
4. 在 evidence-adapter 里调用 semantics 判断
5. 可配置 override

---

### 3.3 TodoWrite/TaskUpdate verification nudge (#5)

**当前实现**：

- todo/task 工具没有 `verificationNudgeNeeded` 输出
- completion auditor 检查 pending task，但不检查“关闭多个任务且无 verification step”

**cc-haha 对应**：

- TodoWriteTool 输出包含 `verificationNudgeNeeded`
- TaskUpdateTool 调用 `executeTaskCompletedHooks`
- 当关闭 3+ 项且无 verification step 时，tool result 注入提醒

**建议修正方向**：

1. 纯函数：`detectVerificationNudgeNeeded(oldTodos, newTodos)`
2. 在 todo/task 工具返回里增加 `verificationNudgeNeeded`
3. tool_result hook 检查该字段，决定是否追加提醒
4. threshold/pattern 来自配置

---

### 3.4 verifier verdict parser (#6)

**当前实现**：

- 无

**cc-haha 对应**：

```txt
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

且要求包含：

```txt
Command run:
Output observed:
Result: PASS/FAIL
```

**建议修正方向**：

1. 新增 `src/pi/harness/verifier-verdict-parser.ts`
2. 纯函数：

```ts
interface VerifierVerdict {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  commandBlocks: Array<{
    command: string;
    outputObserved: string;
    result: 'PASS' | 'FAIL';
  }>;
  hasCommandRun: boolean;
  hasOutputObserved: boolean;
}

function parseVerifierVerdict(text: string): VerifierVerdict | null
```

3. 测试覆盖 PASS/FAIL/PARTIAL/格式错误
4. 暂不接 runtime，只做 parser

---

### 3.5 PostToolUse hook 保留完整输入输出 (#11)

**当前实现**：

```ts
interface ToolEvidence {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  timestamp: number;
  success: boolean;
}
```

**问题**：

- 没有保留完整 `tool_response` 结构
- 没有保留 command text / exit code（bash）
- 没有保留 affected files（edit/write）
- 无法判断“这个输出是否真是 verification”

**cc-haha 对应**：

```ts
PostToolUseHookInput {
  tool_name
  tool_input
  tool_response
  tool_use_id
}
```

**建议修正方向**：

1. 扩展 ToolEvidence 结构：

```ts
interface ToolEvidence {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  rawInput?: unknown;       // 完整 tool_input
  rawResponse?: unknown;    // 完整 tool_response
  result?: unknown;
  timestamp: number;
  success: boolean;
  // 语义化字段
  commandText?: string;     // bash 命令
  exitCode?: number;        // bash 退出码
  affectedFiles?: string[]; // edit/write 文件列表
  outputSummary?: string;   // 输出摘要
}
```

2. 在 tool_result hook 填充这些字段
3. evidence-adapter 用这些字段判断 verification semantics

---

### 3.6 denied-tool-memory session 持久性 (#9)

**当前实现**：

- 会话级内存存储
- reload 后丢失

**问题**：

- 用户拒绝某个工具后，reload 后可能再次被调用
- 不符合 cc-haha permission memory 设计

**cc-haha 对应**：

- permission memory 持久化
- session format 保存 denied history

**建议修正方向**：

1. 对照 cc-haha permission memory 源码
2. 考虑持久化到 session entry
3. reload 后恢复 denied memory
4. 或在 system prompt 里注入 denied history

---

## 4. 下一步建议

### 立即做 (本次迭代)

1. **#3 evidence-tracker session 边界**
   - 明确 reset时机
   - 提供 transcript 恢复函数（纯函数）

2. **#4 commandSemantics**
   - 纯函数模块
   - grep/rg/find/test 语义表
   - 可配置

### 下一个迭代

3. **#6 verifier verdict parser**
   - 纯函数
   - 不接 runtime

4. **#5 verification nudge**
   - todo/task 输出字段
   - tool_result hook 检查

5. **#11 PostToolUse 完整证据**
   - 扩展 ToolEvidence 结构
   - 填充语义化字段

### 延后

6. #9 denied-tool-memory 持久化
7. #12 transcript 恢复 evidence
8. #7 GrowthBook threshold override

---

## 5. 与架构要求的对照

| 架构要求 | 当前状态 | 需要修正 |
|---|---|---|
| 唯一真源 | ✅ threshold/pattern/message 集中 | commandSemantics 缺失 |
| 纯函数优先 | ✅ 大部分模块是纯函数 | evidence-tracker 全局状态 |
| runtime 解耦 | ✅ pi.ts 只编排 | commandSemantics 需集成 |
| 不硬编码 agent/tool 名 | ✅ 通过 config/tool groups | verifier parser 不应硬编码格式 |
| 无旧兼容残留 | ✅ 已清理 bash=verification | 无 |

---

## 6. 结论

当前 harness 实现已经修掉最危险的“普通 bash = verification”误判，但仍有若干与 cc-haha 对齐的缺口：

- evidence memory session 边界不清
- 命令退出码语义缺失（grep 返回 1）
- PostToolUse 证据不完整
- verifier verdict parser 缺失
- todo/task verification nudge 缺失
- denied-tool-memory 持久性问题

建议下一步先修 #3 和 #4（纯函数模块），再做 #6 verifier parser，暂不接 verifier runtime。