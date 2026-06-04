# 08 — Harness 实现进度记录

创建日期：2026-06-03
最后更新：2026-06-03

本文档记录 cc-haha harness 特性映射到 Pi 扩展的实现进度、测试状态和后续计划。

---

## 1. 已完成实现

### 1.1 P0 核心特性

| 特性 | 源文件 | 测试文件 | 单元测试 | 集成测试 | 提交 |
|---|---|---|---|---|---|
| Completion Auditor | `src/pi/harness/completion-auditor.ts` | `completion-auditor.test.ts` | ✅ 15 tests | ❌ | e93c9ed |
| Tool Result Budget | `src/pi/harness/tool-result-budget.ts` | `tool-result-budget.test.ts` | ✅ | ❌ | 987c1d2 |
| Tool Result Budget State | `src/pi/harness/tool-result-budget-state.ts` | - | ✅ (via budget test) | ❌ | 987c1d2 |
| Evidence Adapter | `src/pi/harness/evidence-adapter.ts` | `evidence-adapter.test.ts` | ✅ | ❌ | 5539170 |
| Run Harness Audit | `src/pi/harness/run-harness-audit.ts` | `run-harness-audit.test.ts` | ✅ | ❌ | 5539170 |
| Harness Config | `src/pi/harness/harness-config.ts` | `harness-config.test.ts` | ✅ | ❌ | 5539170 |
| Thresholds (唯一真源) | `src/pi/harness/thresholds.ts` | - | ✅ (via other tests) | ❌ | 069c9e6 |
| Messages (唯一真源) | `src/pi/harness/messages.ts` | - | ✅ (via auditor tests) | ❌ | 069c9e6 |
| Types | `src/pi/harness/types.ts` | - | ✅ | ❌ | 069c9e6 |
| Agent Context | `src/pi/harness/agent-context.ts` | - | ✅ | ❌ | 069c9e6 |

### 1.2 P1 辅助特性

| 特性 | 源文件 | 测试文件 | 单元测试 | 集成测试 | 提交 |
|---|---|---|---|---|---|
| Denied Tool Memory | `src/pi/policy/denied-tool-memory.ts` | `denied-tool-memory.test.ts` | ✅ 14 tests | ❌ | 987c1d2 |
| Final Request Detector | `src/pi/harness/final-request-detector.ts` | `final-request-detector.test.ts` | ✅ 18 tests | ❌ | e93c9ed |

### 1.3 运行时集成

| 集成点 | 文件 | 状态 | 提交 |
|---|---|---|---|
| tool_result hook → applyToolResultBudget | `src/pi/core/pi.ts` | ✅ | 987c1d2 |
| message_end hook → runHarnessAudit | `src/pi/core/pi.ts` | ✅ | e93c9ed |
| detectFinalRequestFromMessages 接入 | `src/pi/core/pi.ts` | ✅ | e93c9ed |
| Config schema (HarnessConfigSchema) | `src/config/schema.ts` | ✅ | 5539170 |

---

## 2. 关键设计决策

### 2.1 userAskedForFinal vs claimsCompletion (e93c9ed)

**问题**：最初设计将 `userAskedForFinal` 等同于 `claimsCompletion`，偏离 cc-haha 设计。

**修正**：
```ts
// 错误设计
const claimsCompletion = input.userAskedForFinal || matches(text, patterns.completion);

// 正确设计 (对齐 cc-haha Stop hook)
const claimsCompletion = matches(text, patterns.completion);
const isFinalReport = input.userAskedForFinal || claimsCompletion;
```

**区别**：
- `claimsCompletion`: assistant 自己说"完成了" → 检查虚假完成声明
- `isFinalReport`: 最终汇报场景 → 检查是否需要说明未验证/失败/pending

### 2.2 架构分层

```
Runtime Layer (pi.ts)
    ↓ 调用
Core Harness Layer (纯函数，无 Pi API 依赖)
    ↓ 使用
Types/Defaults Layer (唯一真源)
```

### 2.3 配置驱动

- 所有阈值、文案、pattern 都可配置
- 默认值通过 `DEFAULT_*` 常量导出
- 用户可通过 `oh-my-opencode-slim.jsonc` 覆盖

---

## 3. 测试状态

### 3.1 单元测试

**状态**: ✅ 全部通过

```
434 tests pass across 42 files
```

最近运行：
```bash
bun test 2>&1 | tail -5
# 434 pass, 0 fail, 1018 expect() calls
```

### 3.2 集成测试

**状态**: ❌ 未执行

需要测试场景：
- [ ] 真实 Pi agent session 中触发 completion auditor
- [ ] 大 tool result 触发 budget 机制
- [ ] denied tool 后重试被拦截
- [ ] 用户问"做完了吗"后 auditor 正确响应
- [ ] 子代理场景下 pending 检查正确跳过

### 3.3 E2E 测试

**状态**: ❌ 未规划

---

## 4. 暂缓特性

### 4.1 Diff Guard

**状态**: ⏸️ 暂缓

**原因**:
1. cc-haha 本身也没有独立代码模块，主要是 prompt + UI 展示
2. Pi 已有 evidence-tracker 跟踪改动
3. 实现成本高，误报率高
4. 未来 Tauri + PyWebUI 可在 UI 层实现

**替代方案**:
- 在 system prompt 中加入 cc-haha 风格约束
- 利用现有 evidence-tracker 的 `modifiedFiles` 列表

### 4.2 Context Pressure Monitor

**状态**: ⏸️ 暂缓

**原因**: Pi 已有 compact API，cc-haha 的 autoCompact 机制不急需

---

## 5. 待研究特性

来自 `07-future-study-backlog.md`：

| 特性 | cc-haha 路径 | 价值 | 优先级 |
|---|---|---|---|
| AgentTool/Subagent Fork | `src/tools/AgentTool/` | 三角色拆分 (research/fixer/verifier) | P2 |
| QueryEngine/REPL | `src/QueryEngine.ts` | Workbench 输入协议 | P2 |
| API Layer 抽象 | `src/services/api/claude.ts` | 多模型兼容 | P3 |
| Desktop UX 组件 | `src/components/` | Tauri + PyWebUI 参考 | P3 |

---

## 6. 后续计划

### 6.1 短期 (本迭代)

- [ ] 编写集成测试脚本
- [ ] 在真实 Pi session 中验证 harness 行为
- [ ] 更新 Codebase Graph 索引（包含新 harness 模块）

### 6.2 中期

- [ ] 研究 AgentTool/Subagent 架构
- [ ] 设计 Pi 扩展的 verifier agent 机制
- [ ] 评估 Diff Guard 的 UI 层实现（Tauri）

### 6.3 长期

- [ ] 多模型 API 层抽象
- [ ] Workbench 输入协议设计
- [ ] harness 特性跨模型兼容

---

## 7. 提交历史

```
e93c9ed fix(harness): userAskedForFinal 作为辅助信号而非完成声明
987c1d2 feat(policy): add Denied Tool Memory to prevent repeated denied calls
5539170 fix: 修复 harness 编译错误
7717880 fix: 修复 harness 测试和导出问题
069c9e6 harness: 对标 cc-haha 源码修复
```

---

## 8. 文件清单

### 8.1 新增文件

```
src/pi/harness/
├── agent-context.ts          # 主/子代理角色区分
├── completion-auditor.ts     # 完成声明审计
├── evidence-adapter.ts       # 证据转换适配器
├── final-request-detector.ts # 用户请求最终答案检测
├── harness-config.ts         # 配置解析
├── index.ts                  # 模块导出
├── messages.ts               # 文案（唯一真源）
├── run-harness-audit.ts      # 整合审计入口
├── thresholds.ts             # 阈值常量（唯一真源）
├── tool-result-budget.ts     # 工具结果预算
├── tool-result-budget-state.ts # 状态管理
└── types.ts                  # 公共类型

src/pi/policy/
└── denied-tool-memory.ts     # 拒绝工具记忆

src/pi/harness/*.test.ts      # 单元测试文件
```

### 8.2 修改文件

```
src/pi/core/pi.ts             # hook 集成
src/config/schema.ts          # HarnessConfigSchema
```

---

## 9. 索引状态

### 9.1 Codebase Graph

项目名: `home-h-projects-aiprojects-oh-my-opencode-slim`

已索引模块（部分）:
- `src/pi/policy/verification-evidence-policy.ts`
- `src/pi/policy/evidence-tracker.ts`
- `src/pi/policy/tool-scope-manager.ts`

待索引（新模块）:
- `src/pi/harness/*`
- `src/pi/policy/denied-tool-memory.ts`

**注意**: 索引可能需要手动触发更新或等待自动刷新。

### 9.2 cc-haha 源码

本地路径: `/tmp/pi-github-repos/cc-haha@main`

未建立 codebase graph 索引。建议未来索引名: `cc-haha-main-local`

---

## 10. 新发现问题

### 10.1 工具权限配置与运行时不一致 (2026-06-03) — ✅ 已修复

**问题描述**：
- 当前 fallback 模式配置了显式 `tools` 列表（白名单模式）
- 但该列表遗漏了部分 codebase-memory 工具（如 `index_repository`）
- 导致 fallback 模式下工具不可用，与预期的"全部工具救援"不符

**根本原因分析**：
1. **白名单模式维护成本高**：每个 mode 需显式列出所有工具
2. **新工具加入时易遗漏**：MCP 工具、扩展工具更新后需手动同步配置
3. **多数据源 merge 不完整**：用户配置 + 默认配置合并逻辑可能有缺口
4. **逻辑判断不稳定**：`toolList.length > 0 || agent.roles ? toolList : all` 依赖隐式推断

**修复方案**：
1. 新增 `resolveToolsExpression()` 纯函数，支持三种语法：
   - `"*"` — 全部工具
   - `"@组名"` — 引用 `_tool_groups` 中的组
   - `"prefix_*"` — 通配符匹配
2. `applyAgentTools()` 在获取 `allTools` 后缓存到 `_cachedAllTools`（唯一真源）
3. `agents-default.json` 改用新语法：
   - `fallback.tools = ["*"]` — 全部工具
   - `coordinator.tools = ["@交互", "@子代理"]` — 组引用
   - `_tool_groups` 支持通配符（如 `"检索": ["codebase_*"]`）

**代码变更**：
- `src/pi/core/pi-modes.ts` — 新增 `resolveToolsExpression()`、修改 `resolveConfiguredTools()`、`applyAgentTools()` 缓存 allTools
- `src/adapters/agents-default.json` — 使用新语法
- `src/config/workflows-and-tools.test.ts` — 更新测试

**验证**：
- ✅ `bun run typecheck` 通过
- ✅ `bun test` 434 pass
- ✅ reload 后 fallback 模式启动显示 `[tools:43]`，且 `codebase_memory_index_repository` 可直接调用

**关键设计原则**：
- **配置文件是唯一真源**：不依赖 `getAllTools()` 的时机
- **显式标记优于隐式推断**：用语法明确表达意图
- **向后兼容**：现有字面量格式仍有效
- **无残留兼容代码**：清理旧逻辑，避免维护困难

### 10.2 Completion/Verification 证据判定设计过粗 (2026-06-04) — ⚠️ 待修复

**触发背景**：
- 集成测试时，启用 `harness.completionAuditor.enabled=true` 后，assistant 声称完成没有触发完成审计提醒。
- 排查发现 `src/pi/harness/evidence-adapter.ts` 默认把所有成功 `bash` 都计为 verification：
  - `DEFAULT_VERIFICATION_TOOLS = new Set(["bash"])`
  - 因此 `git status`、`grep`、`echo` 这类普通命令成功后也会让 `hasVerification=true`，压掉“修改后未验证”的提醒。
- 同时 reload 会清空 runtime evidence，说明仅靠内存 evidence 和工具名推断不够稳健。

**cc-haha 源码对比事实**：
1. **Stop hook 是通用框架，不内置粗暴验证判定**
   - `src/utils/hooks.ts` 构造 Stop/SubagentStop 输入，包含 `last_assistant_message` 与 `transcript_path`。
   - Stop hook 负责把上下文交给 hook，不把“某个工具成功”直接等同于验证完成。
2. **PostToolUse hook 提供完整工具输入/输出**
   - `PostToolUseHookInput` 包含 `tool_name`、`tool_input`、`tool_response`、`tool_use_id`。
   - 这说明判断 verification 应基于具体工具输入/输出语义，而不是仅看工具名。
3. **cc-haha 的核心验证机制是独立 verification agent**
   - `src/tools/AgentTool/built-in/verificationAgent.ts` 要求 verifier 只读/运行检查，不修改项目。
   - verifier 输出必须包含 `Command run`、`Output observed`、`Result`，并以 `VERDICT: PASS|FAIL|PARTIAL` 结束。
   - 明确写着“Reading code is not verification”，实现者自己的检查、caveat、自我声明都不能替代 verifier。
4. **cc-haha 在任务关闭时结构化提醒 verification**
   - `TodoWriteTool.ts` / `TaskUpdateTool.ts`：主线程关闭 3+ 个 task/todo 且没有 verification step 时，把提醒注入 tool result。
   - 提醒内容强调最终总结前需要 spawn verification agent，不能 self-assign PARTIAL。
5. **prompt 层也有 verification contract**
   - `src/constants/prompts.ts`：非平凡实现完成前必须 independent adversarial verification；报告者 owns the gate；PASS 后还要 spot-check verifier 的命令输出。

**结论**：
- 之前 Pi harness 只学习了 cc-haha 的机制大纲（Stop hook、tool result budget、完成审计），但没有充分吸收细节精髓。
- 尤其 verification 不是“工具调用成功”问题，而是“是否存在可审计、可复跑、与任务相关的验证证据/独立验证 verdict”。
- 当前 `DEFAULT_VERIFICATION_TOOLS=["bash"]` 属于不成熟设计，需要修正。

**修复方向（需保持 Pi 架构底线）**：
1. **短期最小修复**：普通 `bash` 不再天然等同 verification；仅明确验证语义的命令或显式 verifier verdict 才算 verification。
2. **中期设计 verifier agent**：新增或复用只读 verifier/oracle 机制，要求结构化输出 `VERDICT: PASS|FAIL|PARTIAL`，并保留命令和输出证据。
3. **任务关闭提醒**：参考 cc-haha，在 todo/task 全部完成且无 verification step 时，注入结构化提醒。
4. **证据判定解耦**：把“工具 evidence → verification state”的判断拆成纯函数模块；默认 pattern/message/阈值仍由唯一真源提供；避免在 runtime 层硬编码工具/命令字符串。
5. **避免残留兼容**：不保留“任何 bash 都是 verification”这类旧逻辑；测试覆盖普通 bash、验证 bash、verifier verdict、reload/evidence reset 等边界。

**风险提示**：
- Harness 其他模块也可能存在类似问题：只照搬 cc-haha 的表层机制，没有充分对照源码细节。
- 后续每个 harness 特性进入生产前，都应增加一轮“cc-haha 源码事实 → Pi 架构映射 → 纯函数测试 → runtime 集成测试”的复核步骤。

---

## 11. 参考资料

- [05-pi-extension-mapping.md](./05-pi-extension-mapping.md) — 落地设计
- [07-future-study-backlog.md](./07-future-study-backlog.md) — 后续研究
- cc-haha 源码: `/tmp/pi-github-repos/cc-haha@main/src/query/stopHooks.ts`
