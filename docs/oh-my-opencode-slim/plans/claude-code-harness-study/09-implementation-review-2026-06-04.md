# Harness Implementation Review - 2026-06-04

## 1. 对照 cc-haha 源码的风险/问题表

| # | 模块 | 问题/风险描述 | cc-haha 对应 | 当前状态 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `evidence-adapter.ts` | **已修**: 普通 bash 成功误判为 verification | `verificationAgent` + prompt contract | ✅ 已修 | done | Phase 1.5 第一轮修复 |
| 2 | `run-harness-audit.ts` | **已修**: 重复未验证 warning;已承认"尚未验证"仍警告 | Stop hook 只提供上下文,不粗暴判断 | ✅ 已修 | done | Phase 1.5 第二轮修复 |
| 3 | `evidence-tracker.ts` | 全局状态 `_evidences`,reload/session 边界不清 | cc-haha hook 每轮拿到 transcript_path,可重建 | ⚠️ 风险 | P1 | 需确认 reset 时机和 session 生存期 |
| 4 | `commandSemantics` | **已修**: `message` 字段已返回给模型；不只影响内部 isError 判断 | `src/tools/BashTool/commandSemantics.ts` | ✅ 已修 | done | P0 hotfix；后续收编到 `tool-result-normalizer` |
| 5 | `TodoWriteTool/TaskUpdateTool` nudge | **纯函数完成**: 关闭 3+ task/todo 且无 verification step 时提醒 | TodoWriteTool/TaskUpdateTool 输出 `verificationNudgeNeeded` | ⚠️ 未接 runtime | P1.5 | 纯函数已完成,未接入 todo tool |
| 6 | `verifier verdict parser` | **纯函数完成**: 识别 `VERDICT: PASS|FAIL|PARTIAL` | `verificationAgent` prompt + tool contract | ⚠️ 未接 runtime | P1.5 | 纯函数已完成,未接入 runtime |
| 7 | `tool-result-budget.ts` | threshold 静态配置,无 GrowthBook 动态覆盖 | `PERSIST_THRESHOLD_OVERRIDE_FLAG` | ⚠️ 低风险 | P2 | 当前阈值来自 config,不支持运行时 flag |
| 8 | `final-request-detector.ts` | 纯 pattern 检测用户是否请求最终答案 | cc-haha Stop hook 不做"用户意图"判断 | ⚠️ 合理偏差 | P2 | 我们用 pattern,cc-haha 不在此层判断 |
| 9 | `denied-tool-memory.ts` | 会话级 memory,reload 后丢失 | cc-haha permission memory + session 持久化 | ⚠️ 风险 | P1 | 需对照 cc-haha permission memory 机制 |
| 10 | `completion-auditor.ts` pattern | 过度依赖自然语言 pattern 检测"完成/未验证" | cc-haha 也用 prompt contract,但有 verifier verdict | ⚠️ 中风险 | P1.5 | pattern 可配置,但不是最终解 |
| 11 | `PostToolUse hook` | **部分修**: 缺完整 `tool_input/tool_response` 语义 | `PostToolUseHookInput` 包含完整输入输出 | ⚠️ 部分修 | P1 | 已加 exitCode,仍缺 rawInput/rawResponse/affectedFiles |
| 12 | `Stop hook` transcript | **缺失**: 无法从 transcript 重建 evidence | Stop hook 输入包含 `transcript_path` | ❌ 缺失 | P1 | reload 后 evidence memory 清空,无 transcript 恢复 |
| 13 | `verification-evidence-policy.ts` | **已修**: 通用 guard 在 finalText 承认后仍警告 | Stop hook 不做粗暴 verification 判断 | ✅ 已修 | done | 通过 `acknowledgesMissingValidation` 调用 |
| 14 | `pi.ts` integration | `message_end` 只 notify,不 block;无 tool_result hook 完整集成 | Stop hook 可以 block/message_edit | ⚠️ 当前设计 | P2 | 我们选择 P0 只 notify,不改消息 |

---

## 2. 优先级分类

### P1: 设计对齐(必须立即做)

- #1 command-semantics message 字段(模型看到语义化文本) ✅ 已修
- #2 contract-level audit cc-haha 关键模块(发现其他遗漏；不做无限逐行复刻)

### P2: 核心功能完善(对齐后做)

- #3 evidence-tracker 全局状态 + session 边界
- #9 denied-tool-memory reload 后丢失
- #11 PostToolUse 保留完整 tool_input/tool_response
- #12 Stop hook transcript 恢复 evidence

### P3: Runtime 接入(对齐后做)

- #5 TodoWrite/TaskUpdate verification nudge
- #6 verifier verdict parser runtime
- #10 减少 pattern 过度依赖(引入 verdict)

### P4: 可延后

- #7 GrowthBook threshold override
- #8 final-request-detector pattern 合理偏差
- #14 message_end 只 notify 设计

---

## 3. 详细分析

### 3.1 evidence-tracker 全局状态 (#3)

**当前实现**:

```ts
let _evidences: ToolEvidence[] = [];

export function resetEvidence(): void {
  _evidences = [];
}
```

**问题**:

- 全局变量,reload 后清空
- 无法从 transcript 恢复
- session 边界不清晰

**cc-haha 对应**:

- Stop hook 输入包含 `transcript_path`
- 可以从 transcript 重建历史 evidence
- 每轮 hook 可以拿到完整上下文

**建议修正方向**:

1. 不要只靠全局内存
2. 提供 `reconstructEvidencesFromTranscript` 纯函数
3. 明确 session 生存期和 reset时机
4. 在 `pi.ts` 里正确处理 reload 边界

---

### 3.2 commandSemantics (#4) - **发现遗漏**

**已做部分**:

- ✅ 纯函数模块: `src/pi/policy/command-semantics.ts`
- ✅ `interpretCommandSemantic(commandText, exitCode)` → `{ isError, semantic, message }`
- ✅ 默认语义表: grep/rg exit 1 = no_matches, find exit 1 = partial_success, diff exit 1 = files_differ
- ✅ Runtime 集成: evidence-adapter 调用 semantics 判断
- ✅ 测试: 12 tests pass

**遗漏部分**:

- ❌ **message 字段没有返回给模型**

**cc-haha 对应**:

```ts
// grep: 0=matches found, 1=no matches, 2+=error
['grep', (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? 'No matches found' : undefined,
})],
```

**问题**:

- 我们在 evidence-adapter 里判断 `isError`,但模型看到的是 Pi 原始输出 "Command exited with code 1"
- harness 只做内部标记,没有修改返回给模型的消息
- 模型可能仍误判 "出错了",而不是理解 "没找到"

**修正方案**:

在 `pi.ts` 的 tool_result hook 里修改返回给模型的消息:

```ts
if (toolName === "bash" && exitCode !== undefined) {
  const semantic = interpretCommandSemantic(commandText, exitCode);
  if (!semantic.isError && semantic.message) {
    // 替换返回给模型的消息
    return { content: [{ type: "text", text: semantic.message }] };
  }
}
```

**影响**:

- 这个遗漏直接影响模型对命令结果的理解
- 不修复则 command-semantics 的设计目的(帮助模型正确理解语义)无法实现

---

### 3.3 TodoWrite/TaskUpdate verification nudge (#5)

**当前实现**:

- todo/task 工具没有 `verificationNudgeNeeded` 输出
- completion auditor 检查 pending task,但不检查"关闭多个任务且无 verification step"

**cc-haha 对应**:

- TodoWriteTool 输出包含 `verificationNudgeNeeded`
- TaskUpdateTool 调用 `executeTaskCompletedHooks`
- 当关闭 3+ 项且无 verification step 时,tool result 注入提醒

**建议修正方向**:

1. 纯函数:`detectVerificationNudgeNeeded(oldTodos, newTodos)`
2. 在 todo/task 工具返回里增加 `verificationNudgeNeeded`
3. tool_result hook 检查该字段,决定是否追加提醒
4. threshold/pattern 来自配置

---

### 3.4 verifier verdict parser (#6)

**当前实现**:

- 无

**cc-haha 对应**:

```txt
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

且要求包含:

```txt
Command run:
Output observed:
Result: PASS/FAIL
```

**建议修正方向**:

1. 新增 `src/pi/harness/verifier-verdict-parser.ts`
2. 纯函数:

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
4. 暂不接 runtime,只做 parser

---

### 3.5 PostToolUse hook 保留完整输入输出 (#11)

**当前实现**:

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

**问题**:

- 没有保留完整 `tool_response` 结构
- 没有保留 command text / exit code(bash)
- 没有保留 affected files(edit/write)
- 无法判断"这个输出是否真是 verification"

**cc-haha 对应**:

```ts
PostToolUseHookInput {
  tool_name
  tool_input
  tool_response
  tool_use_id
}
```

**建议修正方向**:

1. 扩展 ToolEvidence 结构:

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

**当前实现**:

- 会话级内存存储
- reload 后丢失

**问题**:

- 用户拒绝某个工具后,reload 后可能再次被调用
- 不符合 cc-haha permission memory 设计

**cc-haha 对应**:

- permission memory 持久化
- session format 保存 denied history

**建议修正方向**:

1. 对照 cc-haha permission memory 源码
2. 考虑持久化到 session entry
3. reload 后恢复 denied memory
4. 或在 system prompt 里注入 denied history

---

## 5. 2026-06-04 Session Review: 实际价值验证问题

### 5.1 问题:用户反馈 harness 效果不明显

**用户观察**:

> "废了这么大劲,做了不少时间了,但是到目前为止,我似乎还没看到这个harness到底有哪些用?"

**实际效果**:

| 功能 | 已生效 | 用户感知 |
|---|---|---|
| Completion Auditor | ✅ | "修改后未验证" warning |
| Tool Result Budget | ✅ | 后台行为,不显式提醒 |
| message_end 触发时机 | ✅ | 不再每轮中间步骤弹警告 |
| command-semantics | ✅ | grep 返回 1 不报警 |
| verifier-verdict parser | ❌ 未接 runtime | 无效果 |
| verification-nudge | ❌ 未接 runtime | 无效果 |

**为什么效果不明显**:

1. 用户可能很少遇到 "assistant 虚假声称完成" 的场景
2. warning 可能显得啰嗦("我知道啊")
3. command-semantics 效果隐蔽(用户没意识到 grep 没找到不报警是功能)

### 5.2 用户担心:潜在 Bug 风险

**已知风险**:

| 风险 | 影响 |
|---|---|
| reload 后 evidence 丢失 | 无法跨 session 追踪 |
| pattern 匹配可能不完整 | 某些"完成"说法没被识别 |
| command-semantics 只覆盖 6 个命令 | 其他命令退出码仍可能误判 |
| verification-nudge 没接入 runtime | 关闭多任务不会提醒 |
| verifier parser 没被调用 | 没有独立验证能力 |

**未知风险**:

- 没测到的边界情况
- 和其他模块的交互问题
- 性能问题(每轮 message_end 都跑正则)

### 5.3 实际场景验证不足

**当前测试覆盖**:

- ✅ 构造场景:写文件 + 普通 bash → warning
- ✅ 构造场景:写文件 + 承认未验证 → 无 warning
- ✅ 构造场景:grep 返回 1 → 无 warning

**缺失验证**:

- ❌ 真实场景:assistant 会不会真的虚假声称完成?
- ❌ 真实场景:warning 会不会太频繁/太啰嗦?
- ❌ 真实场景:有没有漏报(该提醒没提醒)?
- ❌ 真实场景:有没有误报(不该提醒却提醒)?

### 5.4 下一步建议:暂停功能开发,进入观察期

**不建议继续堆功能,原因**:

1. 当前 harness 是"防止最明显错误"的半成品
2. 真正有价值的 verifier runtime、verification nudge runtime、evidence 持久化都没接入
3. 需要真实场景验证当前功能是否有用

**建议观察期**:

1. 接下来几次对话中,自然使用
2. 观察 harness 是否触发,是否合理
3. 如果发现问题,回来修
4. 如果一直没触发,说明当前场景不需要

**可选测试策略**:

- 边界测试用例覆盖:
  - assistant 说"搞定了"但没验证
  - assistant 说"测试通过"但没跑测试
  - reload 后声称完成
  - grep 返回 2(真错误)
  - 关闭 3 个 todo

**结论**:

- 已完成功能够用,如果真实场景证明不够再补
- 不要继续堆功能,先验证当前功能是否有价值

---

## 6. Commits in 2026-06-04 Session

| Commit | Description |
|---|---|
| `5274359` | fix(harness): align completion auditor with cc-haha Stop hook semantics |
| `7c7ea31` | feat(policy): add command-semantics module for exit code interpretation |
| `faf8d03` | feat(harness): add verifier verdict parser |
| `fdb6d0b` | feat(harness): add verification nudge detector for task completion |
| `11daf66` | feat(harness): integrate command semantics into runtime evidence pipeline |

---

## 7. 当前状态总结 (2026-06-04)

### 已完成并验证

| # | 模块 | 状态 |
|---|---|---|
| 1 | evidence-adapter: 普通 bash ≠ verification | ✅ |
| 2 | run-harness-audit: 重复 warning 去重 + 承认未验证 | ✅ |
| 13 | message_end: 只在最终汇报时审计 | ✅ |
| 4 | command-semantics + runtime 集成 | ✅ |

### 纯函数已完成,未接 runtime

| # | 模块 | 状态 |
|---|---|---|
| 6 | verifier-verdict-parser | ✅ 代码完成,未调用 |
| 5 | verification-nudge | ✅ 代码完成,未调用 |

### P1 未完成

| # | 模块 | 问题 |
|---|---|---|
| 3 | evidence-tracker session 边界 | 全局状态,reload 后丢失 |
| 9 | denied-tool-memory 持久化 | reload 后丢失 |
| 11 | PostToolUse 保留完整 tool_response | evidence 缺完整输入输出语义 |
| 12 | Stop hook transcript 恢复 | 无法从 transcript 重建 evidence |

### 观察期

- 暂停功能开发
- 等待真实场景验证
- 如发现问题再修

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

当前 harness 实现已经修掉最危险的"普通 bash = verification"误判,但仍有若干与 cc-haha 对齐的缺口:

- evidence memory session 边界不清
- 命令退出码语义缺失(grep 返回 1)
- PostToolUse 证据不完整
- verifier verdict parser 缺失
- todo/task verification nudge 缺失
- denied-tool-memory 持久性问题

建议下一步先修 #3 和 #4(纯函数模块),再做 #6 verifier parser,暂不接 verifier runtime。