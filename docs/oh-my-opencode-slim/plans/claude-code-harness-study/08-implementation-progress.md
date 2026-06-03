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

## 10. 参考资料

- [05-pi-extension-mapping.md](./05-pi-extension-mapping.md) — 落地设计
- [07-future-study-backlog.md](./07-future-study-backlog.md) — 后续研究
- cc-haha 源码: `/tmp/pi-github-repos/cc-haha@main/src/query/stopHooks.ts`
