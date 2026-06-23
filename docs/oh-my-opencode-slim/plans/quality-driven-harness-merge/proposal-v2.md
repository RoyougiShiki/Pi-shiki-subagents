# Quality-Driven Harness Merge v2 — Harness 审计 + 三仓库吸收

> **状态**：设计定稿（待评审确认后执行）
> **日期**：2026-06-13
> **范围**：`oh-my-opencode-slim` 的 Pi 扩展 harness 层、policy 层、agent/prompt 层、workflow 配置
> **前序文档**：本文件覆盖并取代同目录 `proposal.md` v1 的设计方向（v1 的"新增 grill mode""5-stage workflow""omo-skill-matcher 启动 hook""保留 analyst 做 grill"等结论，经评审后全部修正，详见 §1 变更说明）
> **研究依据**：cc-haha 源码核对 + Pi runtime 能力查证 + grill-me / grill-with-docs / grill-me-codex / superpowers 四仓库原文研读

---

## 0. 一句话结论

好的 harness 不是让模型更聪明，而是让每一步更难跑偏。本方案做两件事：

1. **修地基**：删除/降级项目原创但脆弱的正则检测层（cc-haha 根本没有这些）和全局可变证据状态（多会话污染源），消除一个真实的内存泄漏缺陷，精简约 30KB 代码。
2. **加能力**：把 grill-me（对齐机制）+ grill-me-codex（有界对抗循环）+ superpowers（Iron Law / Red Flags）的高价值行为，从"依赖模型自觉触发 skill"迁移到"走 mode/workflow stage 就必然命中"，零新增 mode、零新增 skill 系统。

全程遵循：高价值、低复杂度、轻量、不污染提示词。

---

## 1. 与 v1 proposal 的差异说明（为什么覆盖）

v1 proposal 基于三仓库的**表面机制**设计，有几处方向性结论在深入研究和讨论后被修正：

| v1 结论 | v2 修正 | 修正依据 |
|---|---|---|
| 新增 `grill` mode | **不新增 mode**，grill 三规则注入 standard-dev/quick-fix prompt | 用户要求"mode 不要太多"；grill 是机制（怎么问）不是流程入口，无需独立 mode |
| standard-dev 改 5-stage（analysis→grill→plan→implement→review） | **保持 3-stage**（analysis→plan→implement），grill 规则注入 analysis 阶段，oracle 对抗循环内嵌 implement 阶段 | 新增 stage 增加人工审批节点；grill/oracle 可内嵌现有 stage |
| 保留 analyst 做 grill stage 主代理 | **删除 analyst**，analysis 阶段由主控自做 | analyst 子代理存在上下文断层；主控拿完整对话上下文做对齐更优；查证由 search 覆盖 |
| 新增 `omo-skill-matcher` 启动 hook + `<AvailableSkills>` 注入块 | **不做** skill matcher，不新增注入块 | 用户要求"不污染提示词"；Iron Law / grill 规则直接写进 agent prompt + 塞进现有 `<ModeWorkflows>` 块 |
| 保留 research-only 独立 mode | **合并** research-only 为 standard-dev 只读用法 | 减少重复定义；mode 数从 4→3 |
| 未涉及 harness 层健康度审计 | **新增 H1–H7** harness 层优化 | cc-haha 源码核对发现正则检测层是项目原创（cc-haha 没有），且全局 evidence-tracker 是污染源 |

---

## 2. Harness 层健康度审计结论（H1–H7）

> 这一层是方案的地基，必须在加新能力之前清理干净，否则 grill/oracle 会叠在不稳定的地基上。

### 研究发现

1. **cc-haha 核对**：`completion-auditor.ts` / `final-request-detector.ts` / `verification-nudge.ts` / `evidence-tracker.ts` 这四个文件在 cc-haha 仓库（NanmiCoder/cc-haha，Claude Code 泄露源码）里**一个都不存在**。它们是项目作者原创的，注释里挂了"cc-haha 设计"的牌子。Claude Code 的完成检查靠**结构化 Stop hook decision + continuation loop + 8 次连续阻止硬上限 + prompt 层"faithfully report"约束 + 独立 verifier 的结构化 VERDICT**，整个链条不靠正则扫模型自然语言输出。

2. **Pi runtime 能力查证**：Pi 原生有 per-result 截断（50KB/2000行）+ bash 全文落盘 + compaction；但**没有** per-message 总量预算和 seen-id 冻结（prompt cache 稳定性）。项目的 `tool-result-budget.ts` 补的正是 Pi 缺的这两层，属高价值，保留。

3. **全局证据污染**：`evidence-tracker.ts` 用模块级全局数组 `let _evidences`，多会话/subagent 互相污染，且 `runHarnessAudit` 实际读的是 `evidence-session-store`（会话隔离），全局 tracker 是"被写入但不被读取"的死通路 + 内存泄漏源。

### H1–H7 分类

| 编号 | 模块 | 类别 | 结论 | 理由 |
|---|---|---|---|---|
| **H1** | `policy/evidence-tracker.ts` | 直接删减 | 删除文件 + 移除 `register-harness-hooks.ts` 的调用 | 全局可变死代码；问题被 session-store 取代；多会话污染 + 内存泄漏 |
| **H2** | `policy/runtime-audit.ts` | 修改删减 | 降级为单函数 `logDecision()`，删全局状态 | 本身有可观测价值但当前复杂度不值；降级后保留价值、去复杂度 |
| **H3** | `harness/final-request-detector.ts` | 直接删减 | 删除 | 靠正则+长度魔数检测用户意图；方向错误（审计不该由用户语气触发） |
| **H4** | `harness/verification-nudge.ts` + `verification-nudge-runtime.ts` | 直接删减 | 删除 | 价值被 `verification-evidence-policy.ts` 更可靠覆盖（基于真实工具调用 vs task 文本正则） |
| **H5** | `harness/completion-auditor.ts` | 修改后增加 | 改造：去正则 claim 检测，保留 evidence-kind 判断 + 硬阻止（`blockOnUnverifiedModification`） | cc-haha 不扫模型输出；改为"有修改+无验证+message_end 触发"，比正则更可靠；保留用户要的硬阻止 |
| **H6** | `harness/tool-result-budget.ts` | 修改删减 | 保留核心（per-message 预算+seenId 冻结）；read 已在 SKIP_PERSIST 跳过；grep/bash 落盘经查证为增量能力一并保留 | Pi 缺 per-message 预算和 seenId 冻结是核心价值；原计划裁 grep/bash 落盘基于"Pi 有 bash 全文落盘"的前提，实际查证 Pi 无落盘能力（per-result 超限即截断丢弃），故全保留（详见 §A5 修订） |
| **H7** | `harness/run-harness-audit.ts` 的 block continuation | 修改后增加 | 补连续阻止次数上限（对齐 cc-haha 的 8 次硬上限） | 防止硬阻止导致无限阻塞循环；本项目当前缺这层保护 |

---

## 3. 三仓库吸收清单（#1–#18）

> 全部遵循"走 mode/workflow stage 必然命中，不依赖模型自觉触发 skill"原则。

### 3.1 修改后增加（#1–#6）

**#1 analysis stage 主控化**
- **来源**：用户决策（analyst 上下文断层问题）
- **改动**：`workflow-defaults.ts` 中 standard-dev / quick-fix 的 analysis stage，主代理从委托 analyst 改为主控自身承担，allowedSubagents 只留 `search`
- **能力**：消除对齐阶段上下文断层，主控拿完整对话上下文做 grill 对齐

**#2 grill 三规则注入主控 prompt**
- **来源**：grill-me（一次一问 / 推荐答案 / 能查代码就不问人）
- **改动**：standard-dev.md + quick-fix.md 的对齐段落加三条规则，不新开 stage/mode/skill
- **能力**：把 grill 对齐机制内化为默认行为，零新结构

**#3 oracle 有界对抗循环（分档）**
- **来源**：grill-me-codex Act 2（VERDICT 协议 + MAX_ROUNDS + 死锁上报）
- **改动**：implement stage 内嵌对抗循环，用 omo_subagent spawn oracle（不跨 CLI）；standard-dev `MAX_REVIEW_ROUNDS=3`，quick-fix `MAX_REVIEW_ROUNDS=1`
- **能力**：实现后审查从单点升级为必终止对抗，分档控制重量

**#4 CONTEXT.md / ADR 沉淀绑 plan stage**
- **来源**：grill-with-docs（CONTEXT.md 术语表 + ADR 三条件 AND 门）
- **改动**：只在 standard-dev 的 plan stage 触发惰性写入（`docs/.../context/CONTEXT.md` + `docs/.../adr/`），三条件 AND 门，fail-soft；quick-fix 无 plan stage 故不沉淀
- **能力**：跨会话知识沉淀自动跟随 plan，无需独立开关

**#5 Iron Law 写进 fixer/dispatcher/oracle prompt**
- **来源**：superpowers（TDD 铁律 + verification 铁律 + spirit-over-letter 收口）
- **改动**：TDD 铁律→fixer/dispatcher；spirit-over-letter 收口语→三个 prompt 末尾；非独立 skill
- **能力**：纪律铁律随 stage 必然命中，不依赖模型自觉触发

**#6 优先级声明 + WHAT≠HOW 注入 `<ModeWorkflows>`**
- **来源**：superpowers（user > skill > default + WHAT≠HOW）
- **改动**：pi.ts buildConstitutionPrompt 的现有 `<ModeWorkflows>` 块补一段，不加新注入块
- **能力**：防"用户让我做 X"被读成"可跳 workflow"，零新结构

### 3.2 直接增加（#7–#10）

**#7 "先查代码再问人"规则**
- **来源**：grill-me 原文一句
- **改动**：standard-dev.md + quick-fix.md 加一句话
- **能力**：减少打扰，省 token

**#8 PLAN 模板作为 plan stage 输出**
- **来源**：grill-me-codex（Goal/Approach/Key decisions & tradeoffs/Risks/Out of scope）
- **改动**：standard-dev 的 plan 阶段产出固定模板，复用现有 outputSchema，不引入文件 IPC
- **能力**：结构化交接物，给 oracle 对抗循环明确攻击面

**#9 review-log 可观测产物**
- **来源**：grill-me-codex（PLAN-REVIEW-LOG.md 作为可审计交付物）
- **改动**：对抗循环每轮 verdict + 主控采纳/拒绝理由落盘，fail-soft；仅 standard-dev（3 轮才有日志价值）
- **能力**：对抗过程可审计

**#10 dispatcher 四要素派发模板**
- **来源**：superpowers dispatching-parallel-agents（Scope/Context/Constraints/Output）
- **改动**：dispatcher.md 补四要素模板 + "subagent 不继承主 session 上下文"约束
- **能力**：并行任务构造模板化，降低模糊性

### 3.3 修改删减（#11–#14）

**#11 quick-fix prompt 瘦身**
- **改动**：引用 standard-dev 共享段（grill 规则、子代理复用、输出格式），仅声明差异（无 plan stage、MAX_REVIEW_ROUNDS=1）
- **能力**：消除两主控 prompt 重复条文

**#12 research-only 合并为 standard-dev 只读用法**
- **改动**：删除独立 research-only mode + prompt；默认只读研究通过 standard-dev 的 analysis/plan 停止点或用户自定义只读 workflow 表达，不再新增内置用户可见 mode；mode 数 4→3
- **能力**：mode 减一，消除双重定义

**#13 agent prompt 去除工具/委托重复描述**
- **改动**：`agents/*.md` 中描述工具范围、委托对象的段落删除，权限完全交给 `agents-default.json` runtime config
- **能力**：消除 prompt 与 config 双事实源，防漂移

**#14 `<AvailableAgents>` 去除"非阶段可委托"后缀**
- **改动**：pi.ts buildPromptAgentDefinitions 移除 `→ 非阶段可委托: x, y` 后缀，交给 stage gate 运行时校验
- **能力**：减少注入块信息重叠，提示词更干净

### 3.4 直接删减（#15–#18）

**#15 删除 analyst agent**
- **改动**：删除 `src/adapters/agents/analyst.md` + agents-default.json 条目 + workflow-defaults.ts 引用
- **能力**：移除上下文断层中间层，查证由 search 覆盖

**#16 删除 observer agent**
- **改动**：删除 `src/adapters/agents/observer.md` + agents-default.json 条目
- **能力**：移除低频重叠 agent；后续以工具形式给不识图模型用

**#17 删除 tool-description-trimmer**
- **改动**：删除 `src/pi/prompt/tool-description-trimmer.ts` + test
- **能力**：移除对工具描述做隐式改写的中间层，提示词更透明

**#18 历史 plans 归档**
- **改动**：`platform-adapter-cleanup` / `claude-code-harness-study` / `whole-module-complexity-audit` 三个目录移到 `plans/archive/`，保留 `quality-driven-harness-merge` 和活跃项
- **能力**：现行规范与历史快照分离

---

## 4. 最终形态总览

### Mode（3 个，原 4 个）

| Mode | Workflow | 变化 |
|---|---|---|
| `standard-dev` | analysis（主控+grill）→ plan（PLAN 模板 + CONTEXT/ADR 沉淀）→ implement（oracle 3 轮对抗） | analysis 主控化；grill 规则注入；oracle 循环；吸收 research-only 只读用法 |
| `quick-fix` | analysis（主控+grill，小范围）→ implement（oracle 1 轮对抗） | grill 规则注入；oracle 单轮对抗；prompt 瘦身 |
| `fallback` | — | 不动，全能力救援 |

### Agent（删 3 个：analyst、observer、designer）

- 主控：standard-dev、quick-fix、fallback
- 子代理：search、oracle、fixer、dispatcher、council

### 不新增

- 不新增 mode（净减 1）
- 不新增 skill 系统（grill/Iron Law 全走 prompt + stage gate）
- 不新增外部 CLI 依赖（oracle 用 omo_subagent）
- 不新增提示词注入块（grill/优先级塞进现有 prompt 和 `<ModeWorkflows>`）

---

## 5. 实施计划（两批，按依赖顺序）

### 第一批：修地基（PR #1）

> 先清理 harness 证据层和 agent 层，为新能力提供稳定地基。

| 顺序 | 编号 | 改动 | 涉及文件 |
|---|---|---|---|
| 1 | H1 | 删除 evidence-tracker.ts，移除 register-harness-hooks.ts:262 调用 | `src/pi/policy/evidence-tracker.ts`（删）、`src/pi/harness/register-harness-hooks.ts`（改）、`src/pi/harness/index.ts`（改 re-export）、`src/pi/harness/run-harness-audit.ts`（改 import） |
| 2 | H2 | runtime-audit.ts 降级为单函数 logDecision，删全局状态 | `src/pi/policy/runtime-audit.ts`（重写）、相关 test（改） |
| 3 | H3 | 删除 final-request-detector.ts | `src/pi/harness/final-request-detector.ts` + test（删）、`src/pi/harness/register-harness-hooks.ts`（移除 import + 调用）、`src/pi/harness/index.ts`（改 re-export） |
| 4 | H4 | 删除 verification-nudge.ts + verification-nudge-runtime.ts | `src/pi/harness/verification-nudge*.ts`（删 4 文件）、`src/pi/harness/register-harness-hooks.ts`（移除调用）、`src/pi/harness/index.ts`（改 re-export） |
| 5 | H5 | completion-auditor.ts 去正则 claim 检测，保留 evidence-kind 判断 + 硬阻止 | `src/pi/harness/completion-auditor.ts`（改）、`src/pi/harness/run-harness-audit.ts`（改，userAskedForFinal 恒 false）、相关 test（改） |
| 6 | H7 | run-harness-audit.ts 补连续阻止次数上限 | `src/pi/harness/run-harness-audit.ts`（改）、`src/pi/harness/register-harness-hooks.ts`（改 message_end handler） |
| 7 | #15 | 删除 analyst agent | `src/adapters/agents/analyst.md`（删）、`src/adapters/agents-default.json`（改）、`src/config/workflow-defaults.ts`（改 analysis stage 主代理） |
| 8 | #16 | 删除 observer agent | `src/adapters/agents/observer.md`（删）、`src/adapters/agents-default.json`（改） |
| 9 | #17 | 删除 tool-description-trimmer | `src/pi/prompt/tool-description-trimmer.ts` + test（删）、调用点（改） |
| 10 | H6 | tool-result-budget 裁 read/grep/bash 落盘重叠部分 | `src/pi/harness/tool-result-budget.ts`（改） |
| 11 | #18 | 历史 plans 归档 | `docs/oh-my-opencode-slim/plans/` 目录移动 |

**第一批验收**：`bun test` / `bun run typecheck` / `bun run build` / `bun run verify:release` 全绿；删除的模块的 test 同步删除或改写。

### 第二批：加新能力（PR #2）

> 在干净地基上落地 grill/oracle 循环/iron law。

| 顺序 | 编号 | 改动 | 涉及文件 |
|---|---|---|---|
| 1 | #1 | analysis stage 主控化 | `src/config/workflow-defaults.ts`（standard-dev + quick-fix 的 analysis stage）、`src/adapters/agents-default.json`（analysis stage 主代理指向 mode agent） |
| 2 | #2 + #7 | grill 三规则 + "先查代码再问人"注入主控 prompt | `src/adapters/agents/standard-dev.md`、`src/adapters/agents/quick-fix.md` |
| 3 | #13 + #14 | agent prompt 去重 + `<AvailableAgents>` 去后缀 | `src/adapters/agents/*.md`（批量）、`src/pi/core/pi.ts`（buildPromptAgentDefinitions） |
| 4 | #11 + #12 | quick-fix prompt 瘦身 + research-only 合并 | `src/adapters/agents/quick-fix.md`、`src/adapters/agents/research-only.md`（删）、`src/adapters/agents-default.json`、`src/config/workflow-defaults.ts`（删 research-only workflow） |
| 5 | #3 | oracle 有界对抗循环 | `src/adapters/agents/oracle.md`（VERDICT 协议）、`src/adapters/agents/dispatcher.md`（循环调度）、`src/config/workflow-defaults.ts`（MAX_REVIEW_ROUNDS 配置）、`src/pi/harness/verifier-verdict-parser.ts`（复用 VERDICT 解析） |
| 6 | #8 + #9 | PLAN 模板 + review-log 产物 | `src/adapters/agents/standard-dev.md`（PLAN 模板）、后续可新增 review-ledger 写入逻辑（fail-soft） |
| 7 | #4 | CONTEXT.md / ADR 沉淀绑 plan stage | `src/adapters/agents/standard-dev.md`（plan 阶段列出沉淀项，进入实现后由有写权限路径落地） |
| 8 | #5 | Iron Law 写进 fixer/dispatcher/oracle prompt | `src/adapters/agents/fixer.md`、`src/adapters/agents/dispatcher.md`、`src/adapters/agents/oracle.md` |
| 9 | #10 | dispatcher 四要素派发模板 | `src/adapters/agents/dispatcher.md` |
| 10 | #6 | 优先级声明 + WHAT≠HOW 注入 `<ModeWorkflows>` | `src/pi/core/pi.ts`（buildConstitutionPrompt 的 `<ModeWorkflows>` 块） |

**第二批验收**：同上全绿；新增/修改的 policy 模块有"输入→期望→不期望"三段式单元测试；新增 prompt 不硬编码 agent 名；CONTEXT.md/ADR 写入失败不影响主流程。

---

## 6. 不在本次范围（明确排除）

- 不新增 grill mode（grill 规则内嵌现有 stage）
- 不新增 skill 系统 / omo-skill-matcher（Iron Law / grill 走 prompt）
- 不新增 `<AvailableSkills>` 注入块（不污染提示词）
- 不跨 CLI 调 codex exec（沙箱风险；oracle 用 omo_subagent）
- 不恢复 WorkflowManager / 自动 stage 推进（沿用 lightweight-runtime-stage-gate V1）
- 不在 edit/write/命令上加细粒度审批（README 已明确移除）
- 不改 fallback 权限（全能力救援，不动）
- 不删 council/meeting（保留）
- 不做 brainstorming 9 步 checklist（与 analysis→plan stage 重复）
- 不做 visual companion / git worktree（无 WebUI / 用 subagent pool session）

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| H5 改造后 completion-auditor 测试大面积红 | 第二批前先跑测试，红的 test 随 claim 检测分支一起删 |
| H1 删 evidence-tracker 后有隐藏 import | typecheck 会暴露；第一批先跑 typecheck 再跑 test |
| oracle 对抗循环增加延迟 | 分档：quick-fix 1 轮、standard-dev 3 轮；MAX_REVIEW_ROUNDS 可配置 |
| CONTEXT.md 写入冲突（并行 grill session） | fail-soft；第一批不涉及，第二批实现时加 writer 锁（review-ledger 跟踪） |
| 两批改动跨度大 | 严格分两个 PR；第一批纯删除/降级（行为不变或更安全），第二批纯增加（可独立 revert） |

**回滚策略**：每个编号独立提交；第二批可整体 revert 不影响第一批的清理收益；第一批的删除项有 git 历史可恢复。

---

## 8. 验收标准

每完成一个阶段，应同时满足：

1. `bun test` / `bun run typecheck` / `bun run build` / `bun run verify:release` 全绿。
2. 新增/修改的 policy 模块有"输入→期望→不期望"三段式单元测试。
3. 新增 prompt / skill / ADR 模板不硬编码 agent 名。
4. CONTEXT.md / ADR 写入失败不影响主流程（fail-soft）。
5. H5 改造后，硬阻止（`blockOnUnverifiedModification`）能力保留，且有连续次数上限（H7）防无限阻塞。

---

## 附录 A：决策记录（为什么这么做）

### A1 为什么删除 analyst（#15）

analyst 作为子代理只拿到主控转述的 task 文本，看不到用户原话和对话细微语境——"传话游戏"。主控自己持有完整对话上下文，做需求对齐（grill）更有效。查证职责由 search 覆盖。analysis 阶段从"外包 analyst"改为"主控自做 + search 辅助"。

### A2 为什么保留 standard-dev + quick-fix 两个 mode（不合并）

差异轴是"是否需要 plan stage"，不是"流程长短"。有些任务不需要 plan（改 typo），强制走 plan 是仪式主义；有些任务不经过 plan 会出事（跨模块改动）。文档沉淀作为 plan 的自然衍生物，而非独立开关。oracle 对抗循环用 MAX_REVIEW_ROUNDS 分档（quick-fix=1, standard-dev=3），保证 quick-fix 轻量但仍有质量门。

### A3 为什么 grill 规则注入 prompt 而非新开 stage/mode

grill 的核心是三条机制规则（一次一问/推荐答案/能查代码就不问人），极轻。新开 stage 增加人工审批节点，新开 mode 增加"用户该选哪个"的认知负担。注入 analysis 阶段的 prompt 零新结构，且走 analysis stage 就必然命中（不依赖模型自觉触发 skill）。

### A4 为什么 completion-auditor 去正则而非删除（H5）

硬阻止（有修改无验证时 block）本身是高价值能力（对应 harness 三要素的"检验器"），用户要求保留。去掉的是"用正则判断模型是否声称完成"这层——改为"有修改+无验证+message_end 就触发"，比正则更严格可靠（模型即使不说"完成"，只要消息结束且有未验证修改就拦截）。补 cc-haha 的连续阻止次数上限防无限阻塞。

### A5 为什么 tool-result-budget 保留（H6）

Pi runtime 查证确认：Pi 有 per-result 截断但**没有** per-message 总量预算（10 个并发工具各 50KB=500KB 全进 context，Pi 不拦）和 seen-id 冻结（prompt cache 稳定性）。项目补的正是这两层，属高价值。

**修订（2026-06-15，基于 Pi hook 类型定义实际查证）**：原计划"只裁与 Pi 重叠的 read/grep/bash 落盘部分"基于一个错误前提——以为 Pi 有 bash 全文落盘。实际查 Pi 的 `ExtensionAPI.on` 类型定义（`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`）：Pi 对超长工具结果的处理是 **per-result 截断（50K/2000 行）+ 截断后丢弃**，**没有"落盘供后续读取"的机制**。`message_end` 的 result 只能替换 assistant 消息，不能持久化工具输出。

因此项目的 read/grep/bash 落盘不是"与 Pi 重叠"，而是 **Pi 缺失的增量能力**：
- read：已在 `SKIP_PERSIST_TOOL_NAMES` 跳过（Pi 的 maxTokens 控制足够），符合原计划
- grep/bash：落盘阈值（grep 30K / bash 50K），超阈值写文件 + 留 preview + 模型可后续 read 恢复全文。若裁掉，超长输出会从"可恢复"退化为"Pi 截断后永久丢失"

**结论**：H6 核查完毕，无需代码改动。per-message 预算 + seenId 冻结保留（原计划）；read 跳过（原计划）；grep/bash 落盘保留（修订：增量能力不裁）。

### A6 为什么 runtime-audit 降级而非删除（H2）

本身有可观测价值（"理解 loop 内部机理"的基础设施），符合用户"保留有价值内容"的要求。降级为单函数 `logDecision()` 去掉全局状态复杂度，符合用户"低复杂度、轻量"的要求。兼顾两者。

---

## 附录 B：与四套参考仓库的对位速查

| 关注点 | grill-me | grill-with-docs | grill-me-codex | superpowers | 本项目落点 |
|---|---|---|---|---|---|
| 一次一问+推荐答案 | ✅ | ✅ | ✅ | ❌ | 主控 prompt 对齐段（#2） |
| 能查代码就不问人 | ✅ | ✅ | ✅ | ❌ | 主控 prompt（#7） |
| CONTEXT.md 沉淀 | ❌ | ✅ | ❌ | ❌ | plan stage 产物（#4） |
| ADR 三条件 AND 门 | ❌ | ✅ | ❌ | ❌ | plan stage 产物（#4） |
| 两幕拆分 | ❌ | ❌ | ✅ | ❌ | standard-dev 3-stage 已覆盖 |
| 有界对抗循环 | ❌ | ❌ | ✅ | ❌ | implement stage 内嵌（#3） |
| VERDICT 协议 | ❌ | ❌ | ✅ | ❌ | oracle prompt（#3） |
| MAX_ROUNDS 必终止 | ❌ | ❌ | ✅ | ❌ | MAX_REVIEW_ROUNDS 分档（#3） |
| TDD 铁律 | ❌ | ❌ | ❌ | ✅ | fixer prompt（#5） |
| verification 铁律 | ❌ | ❌ | ❌ | ✅ | 已有 verification-evidence-policy |
| spirit-over-letter | ❌ | ❌ | ❌ | ✅ | 三个 prompt 末尾（#5） |
| dispatch 四要素 | ❌ | ❌ | ❌ | ✅ | dispatcher prompt（#10） |
| WHAT≠HOW | ❌ | ❌ | ❌ | ✅ | `<ModeWorkflows>` 注入（#6） |
| 跨 CLI 对抗 | ❌ | ❌ | ✅ | ❌ | 不做（沙箱风险） |
| skill 自动触发 | ❌ | ❌ | ❌ | ✅ | 不做（不依赖模型自觉） |
| brainstorming 9 步 | ❌ | ❌ | ❌ | ✅ | 不做（与 stage 重复） |
