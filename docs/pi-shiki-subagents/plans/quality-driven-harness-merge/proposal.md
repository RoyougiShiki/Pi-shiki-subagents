# Quality-Driven Harness Merge — 借 grill-me / grill-with-docs / grill-me-codex / superpowers 改造 pi-shiki-subagents

> **状态**：设计草案 v1（待评审）
> **日期**：2026-06-13
> **作者**：基于 `docs/pi-shiki-subagents/plans/` 既有研究 + 三套外部 harness 模式综合
> **范围**：`pi-shiki-subagents` 现有 Pi 扩展、mode / workflow / tool-scope / skill 子系统
> **不打算复刻**：Claude Code 完整 transcript / permission / teammate runtime（沿用 `claude-code-harness-study/12-harness-closeout.md` 的收口边界）

---

## 0. 一句话结论

把"模型变得更聪明"的问题转成"每一步更难跑偏"的问题。具体落点：

- **加一个 `grill` workflow 阶段**（基于 Matt Pocock 的 `grill-me` / `grill-with-docs`），把 `analyst` 阶段从"读材料 → 写分析"升级为"读材料 → 反方审讯 + 沉淀 CONTEXT/ADR"。
- **把 `oracle` 阶段从单点审查升级为对抗循环**（基于 `chaseai-yt/grill-me-codex` 的 Act 2 思路），但**用 omo_subagent spawn `oracle` 子代理**代替外部 `codex exec`，避免引入跨 CLI 沙箱风险。
- **借 `obra/superpowers` 的 bootstrap + Red Flags**，把"什么时候用哪个 skill"从 prompt 文案升级为运行时的 skill-matcher hook，对接到 `using-superpowers` 风格的 skill frontmatter。
- **保留现有四件套不动**：`tool-scope-manager` / `clarification-policy` / `evidence-tracker` / `verification-evidence-policy` / `subagent-contract-policy` / `workflow-stage-policy`。本草案**只**新增/修改 mode、workflow stage、agent prompt、skill frontmatter 解析与注入方式。

---

## 1. 参考仓库与"借什么"

| 仓库 | 借什么 | 不借什么 | 本项目落点 |
|---|---|---|---|
| [mattpocock/skills](https://github.com/mattpocock/skills) → [`skills/productivity/grill-me/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md) | 一次一问、每个问题都给推荐答案、能查代码就不问人 | 自由对话式（不强制结构化 UI） | `standard-dev` 的 `analysis` 阶段 prompt 模板 + 新 `grill` mode 提示词骨架 |
| [mattpocock/skills](https://github.com/mattpocock/skills) → [`skills/engineering/grill-with-docs/`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md) | CONTEXT.md / ADR 沉淀 + 三个 ADR 触发条件 | "用 AskUserQuestion 弹窗"的强 UI 依赖 | 新建 `docs/pi-shiki-subagents/context/CONTEXT.md` + `docs/pi-shiki-subagents/adr/` 目录约定，绑定到 `grill` mode 输出 |
| [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex) → [`SKILL.md`](https://github.com/chaseai-yt/grill-me-codex/blob/main/skills/grill-me-codex/SKILL.md) | 两幕拆分（对齐 + 跨模型审查）、`VERDICT: APPROVED\|REVISE` 终止协议、Claude 是最终裁判、`MAX_ROUNDS` 必终止 | 跨 CLI（`codex exec`）+ 跨进程（Codex CLI 沙箱 `sandbox_mode="read-only"` 风险） | `standard-dev` 的 `implement` 阶段内嵌"审查循环"，但**用 omo_subagent spawn `oracle`** 而不是外部 CLI，把沙箱边界收回到本项目 Pi runtime |
| [obra/superpowers](https://github.com/obra/superpowers) → [`skills/using-superpowers/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md) | "1% 适用就强制匹配 skill" + Red Flags 反向表 + 决策图 + 优先级（用户 > skill > default） | 14 个具体 skill 的逐字内容 | 新建一个 `omo-skill-matcher` 启动 hook，解析 `~/.pi/agents/*.md` 的 `name:` / `description:` frontmatter，注入 `<AvailableSkills>` 提示，prompt 模板沿用 `using-superpowers` 的 Red Flags 表 |
| [obra/superpowers](https://github.com/obra/superpowers) → [`skills/verification-before-completion/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md) | "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" 铁律 + 24 条 failure memories | 重新设计 verifier | 已有 `verification-evidence-policy.ts` 完整吸收这条 |
| [obra/superpowers](https://github.com/obra/superpowers) → [`skills/test-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md) | "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" + Red-Green-Refactor + Rationalization 表 | TDD 流程本身 | 把它写进 `fixer` / `dispatcher` 的 prompt + `standard-dev` 的 `implement` 阶段停止条件 |
| [obra/superpowers](https://github.com/obra/superpowers) → [`skills/dispatching-parallel-agents/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md) | "独立问题域识别 → 范围/上下文/约束/输出四要素 prompt → 并行 dispatch → review" | 并行模型本身的实现 | 它正是 `dispatcher` 当前的行为（按任务类型 spawn `fixer` / `oracle`），草案只补 prompt 模板 |
| [obra/superpowers](https://github.com/obra/superpowers) → [`skills/brainstorming/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md) | HARD-GATE 不得在用户批准前写代码 + spec → 自审 → 用户审 → writing-plans | 把 9 步 checklist 整套抄过来 | `standard-dev` 的 `analysis → plan` 阶段直接对应；`grill` mode 是 brainstorming 的硬化版 |
| [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex) `README.md` "Why a second model" | 同模型自审 = 同概率分布循环放大 → 必须异源 | — | 写进本项目 `oracle` 角色边界："oracle 必须独立上下文、必须从原始材料开始、不得直接信任 dispatcher 的 intermediate summary" |

---

## 2. 推荐的模式（按价值排序）

### 2.1 P0：把 `standard-dev` 升到 "Act 1 + Act 2" 两幕结构

**参考**：`chaseai-yt/grill-me-codex` 的两幕拆分。**价值**：单点收益最大——直接把"建错东西"和"建得对但会爆"两个失败模式分别堵住，且不引入外部 CLI。

**当前实现**（`src/adapters/agents/standard-dev.md` + `docs/configuration.md`）：
- `analysis` (analyst) → `plan` (designer) → `implement` (dispatcher+fixer/oracle)
- `oracle` 已经被设计为"证据驱动的对抗性审查者"（[src/adapters/agents/oracle.md](src/adapters/agents/oracle.md)）。
- 已有 `workflow-stage-policy` 阻止跳 stage（[docs/pi-shiki-subagents/plans/lightweight-runtime-stage-gate-design/proposal.md](docs/pi-shiki-subagents/plans/lightweight-runtime-stage-gate-design/proposal.md)）。

**改造方向**（**不是新建 mode，而是在 `standard-dev` 内**增 stage）：

```text
standard-dev workflow:
  stage 1: analysis   (analyst, allowedSubagents: [search])
  stage 2: grill      (analyst,   allowedSubagents: [search, oracle])   # 新增
  stage 3: plan       (designer,  allowedSubagents: [search, oracle])
  stage 4: implement  (dispatcher,allowedSubagents: [fixer, oracle])
  stage 5: review     (oracle,    allowedSubagents: [search])           # 新增：oracle-led 收口审查
```

**新增 stage 2 (grill) 和 stage 5 (review) 的语义**：

- **stage 2 = Act 1 反方审讯**（基于 [mattpocock/grill-me](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)）：
  - `analyst` 在 stage 1 写完 "已确认/未知/风险" 后，stage 2 切换为"反方"，对**自己刚写的分析**做一次"反方审讯"：逐条决策问"为什么是 X 不是 Y"、"代码真的支持吗"、"CONTEXT.md 里有没有冲突术语"。
  - **每个问题都必须先尝试从代码库 / `docs/` / 已有 ADR 中查证**，查不到再问用户。
  - **可 spawn `oracle` 做对抗预审**——这是 grill + oracle 的第一次耦合。
  - 收敛后输出三件套：精炼后的 unknowns、`<decision-tree-resolved=true>` 标志、新增/更新的 `CONTEXT.md` 条目与 ADR 草案。
- **stage 5 = Act 2 收口审查**（基于 [chaseai-yt/grill-me-codex Act 2](https://github.com/chaseai-yt/grill-me-codex/blob/main/skills/grill-me-codex/SKILL.md)）：
  - `oracle` 作为 stage 主子代理，对 `dispatcher` 提交的"已实现+测试通过"做独立审查。
  - 输出 `VERDICT: APPROVED \| REVISE`（直接对齐 `grill-me-codex` 的协议，便于后续 `codex-review` 子 skill 直接套用）。
  - REVISE 时：把返工要求交给 `dispatcher` 让其**继续同一 fixer 会话**（与现有"实现阶段不通过则继续同一实现会话返工"行为完全一致）。
  - `MAX_REVIEW_ROUNDS`（默认 3，可配置）必终止；超上限视为"disagreement"挂起，让用户裁决，**不假装 APPROVED**。

**为什么 `grill` 不做成独立 mode**：
- grill 的目标是"把 analysis 输出对齐到能进 plan 的程度"，与 analysis 是同一角色（analyst）但不同姿势。
- 独立 mode 会让用户多一次手动切换，破坏"按阶段推进"的连贯性。
- 在 stage 层做更轻量，与 `lightweight-runtime-stage-gate-design/proposal.md` 的"不引入复杂 workflow engine"原则一致。

### 2.2 P0：新建 `omo-skill-matcher` 启动 hook（superpowers 风格 bootstrap）

**参考**：[obra/superpowers using-superpowers](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md) 的决策图 + Red Flags 表 + "1% 适用就强制匹配"。

**价值**：把"什么时候用哪个 skill"的判断从"模型自己读 prompt"升级为"runtime 显式注入 `<AvailableSkills>` 摘要"，降低在长 context 中"忘了有 skill 可用"的概率（直接对位 [obra/superpowers Red Flags](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md) 里的 "This is just a simple question"、"Let me explore the codebase first" 等逃避路径）。

**当前状态**：
- Pi 已经会把 `src/adapters/agents/*.md` 同步到 `~/.pi/agents/`，但**没有**在 `mode_session_started` / 通知里聚合 skill 列表。
- `docs/pi-shiki-subagents/plans/agent-boundary-redesign/proposal.md` §8 已经设计了 `mode_session_started` / `mode_session_resumed` customType，但**没**做 skill 摘要注入。

**改造方向**：

1. 启动 hook（在 `src/pi/core/pi.ts` 已有的启动事件链上接一步）读 `~/.pi/agents/*.md` 的 frontmatter（`name:`、`description:`），生成 `<AvailableSkills>` 块：
   ```text
   <AvailableSkills>
   - grill-me: interview user relentlessly about a plan until shared understanding...
   - grill-with-docs: grilling session that challenges plan against CONTEXT/ADR...
   - verification-before-completion: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE...
   - tdd: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST...
   ...
   </AvailableSkills>
   ```
2. 注入到 `mode_session_started` / `mode_session_resumed` 通知 + 主代理 system prompt 头部。
3. 在主代理 prompt 顶部（不重写全文，**只**加一段）补 Red Flags 反向表（直接抄 superpowers 的 12 条；MIT 允许标注来源即可）。
4. 子代理 dispatch 时的 system prompt 也带这个 `<AvailableSkills>`，**且**子代理的 SKILL frontmatter 里加 `<SUBAGENT-STOP>` 标签（对齐 [using-superpowers 的 SUBAGENT-STOP 用法](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md)），跳过 using-superpowers 自身。

**注意**：`using-superpowers` 那张"优先级（用户 > skill > default）"清单**不能**直接抄进本项目 prompt——本项目已经有 `agent-boundary-redesign/proposal.md` §0 的"中立优先于顺从"作为用户指令的硬约束，priority 顺序需沿用本项目既有口径：用户指令 > workflow stage gate > mode 边界 > skill 提示词 > 模型默认。

### 2.3 P1：把 `oracle` 从"审查者"硬化成"独立验证者"

**参考**：[chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex) `README.md` "Why a second model" + [obra/superpowers verification-before-completion](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md) 的 "fresh evidence only"。

**当前实现**：[src/adapters/agents/oracle.md](src/adapters/agents/oracle.md) 已经规定了 `approve` / `changes-requested` / `reject` + 证据 + Critical/High/Medium/Low 风险分级。

**改造方向**（prompt 层 + 工具层）：

1. **工具层**：`oracle` 的 tool-scope 必须**禁止** dispatcher / fixer 的写工具与 `omo_subagent`（防止审查者被"协助实现"诱惑跑偏）。当前 `agents-default.json` 已经按 role 分组，本条只需要在 `oracle` 的 `roles` / `tools` 上加一道"非 oracle 子代理禁止 spawn"——和 `lightweight-runtime-stage-gate-design/proposal.md` §"Phase 3: Runtime hook" 走同一条路。
2. **Prompt 层**：在 oracle prompt 顶部加一句（沿用 `grill-me-codex` 的措辞）：
   > "You are an independent reviewer. The implementing agent's intermediate summary is **evidence, not truth**. You must re-read the actual files and tests. Reading code is not verification; running the test command and reading its exit code is."
3. **持久化**：`evidence-tracker.ts` 已有 `.evidence-summary.json`、`verification-evidence-policy.ts` 已有 `.verifier-verdicts.json`。新增 `.review-ledger.json`，记录每次 oracle 审查的 `round`、`verdict`、`changes_requested` 列表、`responded_by` 哪个 fixer session。沿用 `claude-code-harness-study/12-harness-closeout.md` §3.1 的"companion JSON，not full transcript"原则，**只**保存 verdict 摘要，不存全量 transcript。

### 2.4 P1：CONTEXT.md / ADR 落点约定

**参考**：[mattpocock/grill-with-docs](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md) 的 `CONTEXT-FORMAT.md` / `ADR-FORMAT.md`。

**当前实现**：项目内**没有** CONTEXT/ADR 约定，文档都是 plan / study 性质。

**改造方向**：

1. 在仓库内新建 `docs/pi-shiki-subagents/context/CONTEXT.md`（初始为空） + `docs/pi-shiki-subagents/adr/`（初始为空），**只**由 `grill` stage 的 analyst 写入。
2. `CONTEXT.md` 严格遵循"纯术语表，不含实现"（与 [CONTEXT-FORMAT.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/CONTEXT-FORMAT.md) §"Rules" 一致）。
3. ADR 沿用三条件触发（hard to reverse / surprising without context / real trade-off），可参考原 `ADR-FORMAT.md` 但编号用 4 位（`0001-foo.md`）保留扩展空间。
4. 写入权限：仅 `grill` stage 内的 analyst（`designer` 也可写但**不**强制）；`dispatcher` / `fixer` 全部 read-only。
5. `grill` stage 退出条件新增："至少一条决策已沉淀到 CONTEXT.md **或** 显式记录 `no-glossary-impact`"。

### 2.5 P2：把 `dispatching-parallel-agents` 模板装进 `dispatcher` prompt

**参考**：[obra/superpowers dispatching-parallel-agents](https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md) 的"独立问题域识别 → 范围/上下文/约束/输出四要素 prompt → 并行 dispatch → review"。

**当前实现**：[src/adapters/agents/dispatcher.md](src/adapters/agents/dispatcher.md) 已是 dispatcher 主代理。

**改造方向**（prompt 模板增量）：
- 在 dispatcher prompt 增加"独立问题域识别"提示：派发 fixer 前先判断"多个错误 / 多个文件 / 多个子系统是否独立"，独立就**并行** spawn 多个 fixer session（已有 subagent pool 支持文件 backed session，参考 [docs/configuration.md §"Subagent Pool Sessions"](docs/configuration.md)）。
- spawn 时给 fixer 的指令模板套 superpowers 的四要素结构（"Scope / Context / Constraints / Expected output"），让 fixer 输出"what changed and why"的精炼总结而不是大段中间过程。

### 2.6 P2：TDD Red-Green-Refactor 装进 `fixer` prompt

**参考**：[obra/superpowers test-driven-development](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md)。

**改造方向**：在 `fixer.md` 顶部加 TDD 纪律（"先写失败测试 → 跑确认失败 → 最小实现 → 跑确认通过 → 重构 → commit"），并在 dispatch 时把这段纪律注入 fixer 的 system prompt（与 `omo-skill-matcher` 协同）。

**风险**：`TDD` 对纯文档 / 配置 / 一次性脚本类任务过度约束。处理方式：在 `fixer` 的 tool-scope 旁加一段"非代码任务豁免 TDD 的判定条件"——但豁免条件**不**写到 prompt，而是写到 `subagent-contract-policy.ts` 的纯函数模块里，由 runtime 决定。

---

## 3. 项目需要调整的方向和思路

### 3.1 调整 mode（数量与语义）

**推荐**：

| Mode | Pipeline? | Workflow | 用途 | 是否改 |
|---|---|---|---|---|
| `standard-dev` | ✅ | `standard-dev`（5 stage：analysis → grill → plan → implement → review） | 高质量实现路径 | **改**（加 grill + review stage） |
| `quick-fix` | ✅ | `quick-fix` | 小修 | 不改 |
| `research-only` | ✅ | `research-only` | 纯证据收集 | 不改 |
| `grill` | ✅（**新增**） | `grill`（单 stage：analyst 主导 + search + oracle 辅助） | 用户只想做"反方对齐 + 沉淀 CONTEXT/ADR"，不下沉到实现 | **新增** |
| `fallback` | ❌ | — | 救援模式 | 不改 |
| 其他子代理模式 | ❌ | — | oracle / search / fixer / dispatcher / observer / analyst / designer | 不改 |

**新增 `grill` mode 的理由**：
- 用户说"我想先理清楚 / 我想先压一下方案 / 给我做 brainstorming"时，**不应该**被强制走完整个 `standard-dev`。
- `research-only` 是"读材料 + 出结论"，但**不**带反方审讯；`grill` 是 `research-only` + Socratic 审讯 + 沉淀。
- 与 superpowers 的 `brainstorming` 单独成 skill 同源；放在本项目作为 mode 是"显式用户入口"。
- `grill` mode 的 `requiresUserCommand: true` 设为 true，避免模型主动切进去搞"我先 grill 一下"。

### 3.2 调整 workflow

- `standard-dev` workflow 改为 5 stage（如 §2.1）。
- 新增 `grill` workflow（单 stage）：`{ id: "grill", agent: "analyst", allowedSubagents: ["search", "oracle"] }`。
- **不**新增"自动 stage 推进"——继续遵守 `lightweight-runtime-stage-gate-design/proposal.md` V1 限制（`stageIndex=0` 保持 + 用户切换 stage 触发）。
- `workflow-stage-policy` 不需要改 schema，只需在配置层加 stage 即可——这正是它"config-driven 不 hardcode stage 名"设计的胜利。

### 3.3 调整工具权限（tool-scope）

新增/调整的工具组（沿用 `_tool_groups` 命名）：

```jsonc
{
  "_tool_groups": {
    // 已有
    "review": ["read", "grep", "find"],
    "implementation": ["read", "write", "edit", "bash"],

    // 新增
    "grill": ["read", "grep", "find"],                    // analyst 在 grill stage 的 read-only
    "oracle_independent": ["read", "grep", "find", "bash", "codebase-memory"],  // 禁止 write/edit/omo_subagent
    "context_writer": ["read", "write", "edit"]            // 限定路径：docs/pi-shiki-subagents/context/ + docs/pi-shiki-subagents/adr/
  }
}
```

注意：路径级限制本项目目前没有，需要在 `tool-scope-manager.ts` 加"按工具组的路径白名单"扩展，**或**把"只能在 `docs/pi-shiki-subagents/{context,adr}/` 下 write"做成 `subagent-contract-policy` 的额外约束——后者更轻量。

### 3.4 调整 skill 范式

**目标**：所有 `src/adapters/agents/*.md` 沿用统一的 frontmatter 约定，方便 `omo-skill-matcher` 解析：

```yaml
---
name: <kebab-case>
description: <one-line trigger description — must include "Use when…">
omo-managed: true
omo-skill-stage: [standard-dev.grill|standard-dev.review|any|...]
omo-skill-tools: [read, grep, find, ...]   # 可选；缺省走 agent 定义
omo-skill-subagent-stop: true|false          # 默认 false；oracle/search 类可设 true
---
```

新增 skill 目录约定：`src/adapters/skills/*.md`（独立于 agents 目录，**只**作为可被发现、可被注入的 skill 模板；不在 `~/.pi/agents/` 同步）。这样：

- `agents/*.md` = 角色 prompt（已有）
- `skills/*.md` = 流程方法提示（新增）—— 直接对应 superpowers 的 skills / Claude Code 的 skills 范式

### 3.5 运行时注入的提示词结构（最终态）

主代理 system prompt 注入顺序（自顶向下）：

```text
<SystemDefaults>...</SystemDefaults>
<UserProjectContext>...</UserProjectContext>
<ModeInfo>mode: standard-dev, workflow: standard-dev, stage: grill</ModeInfo>
<ModeWorkflows>...</ModeWorkflows>      # 已有
<AvailableAgents>...</AvailableAgents>  # 已有
<AvailableSkills>...</AvailableSkills>  # 新增：来自 omo-skill-matcher
<CONTEXTExcerpt>...</CONTEXTExcerpt>    # 新增：来自 docs/pi-shiki-subagents/context/CONTEXT.md 摘要
<RecentADRs>...</RecentADRs>            # 新增：最近 5 条 ADR 标题
<RedFlags>...</RedFlags>                # 新增：抄 superpowers 的反向表，标注来源
<RolePrompt>...</RolePrompt>            # 已有：来自 agents/<name>.md
```

**设计原则**：每段都是"被结构化注入的 context 块"，**不**让模型去文件里 grep skill 名字（这是 superpowers 的关键差异——它用 `Skill` 工具显式加载，本项目用注入避免 tool 调用次数）。

---

## 4. 价值评估：哪些高 / 哪些低

### 4.1 价值高的改动（按 ROI）

| 改动 | ROI | 理由 |
|---|---|---|
| §2.1 `standard-dev` 加 grill + review stage | **极高** | 单点收益最大；不动外部依赖；oracle 已存在；workflow-stage-policy 天然适配 |
| §2.2 `omo-skill-matcher` 启动 hook | **高** | 把"用 skill"从 prompt 文案升为运行时事实；后续加新 skill 不需要改 prompt |
| §2.3 `oracle` 硬化为独立验证者 | **高** | 复用现有 oracle role；"fresh evidence only" 与现有 `verification-evidence-policy` 是同一思想的不同表述 |
| §2.4 CONTEXT.md / ADR 落点 | **中高** | 项目自身也会受益（避免每次重新对齐术语）；用户与 agent 共享词汇表 |
| §2.5 dispatcher 并行模板 | **中** | 加速多错误修复，但有"并行 fixer 可能相互冲突"风险——只对**完全独立**问题域生效 |
| §2.6 TDD 装入 fixer | **中** | 与项目已有"verification before completion"方向一致；但 TDD 在某些任务上需要豁免 |

### 4.2 价值低的改动（**不**建议做）

| 改动 | 为什么不建议 |
|---|---|
| 完整复刻 `chaseai-yt/grill-me-codex` 的"跨 CLI 调 `codex exec`" | 引入 `danger-full-access` 沙箱继承风险（已记录在 `codex-review/SKILL.md`）；本项目 omo_subagent 已经能做"独立验证者"，多此一举 |
| 完整复刻 `obra/superpowers` 14 个 skill | superpowers 的 skill 是 Claude Code 工具名假设；本项目是 Pi 扩展，工具名不直接对应；逐字移植会引入混淆 |
| 复刻 `using-superpowers` 的 `Skill` 工具调用 | 本项目没有 Claude Code 的 `Skill` 工具；用 `<AvailableSkills>` 注入 + frontmatter 描述触发是更轻的等价物 |
| 恢复 `WorkflowManager` | `lightweight-runtime-stage-gate-design/proposal.md` V1 已明确"不恢复"；提案 §0 已确认 |
| 把 `coordinator` 改回 `coordinator` | `agent-boundary-redesign/proposal.md` §0 已确认 `analyst` 改名无 alias；不翻案 |
| 在每次 edit/write/命令上加细粒度审批 | README §"Control Model" 已明确移除；本草案不挑战这条 |
| 自动 stage 推进（`pool_completed` → next stage） | `lightweight-runtime-stage-gate-design/proposal.md` §"Known V1 limitations" 明确不做 |
| 引入 `codex exec` 作为外部审查者 | 同上 + 沙箱安全 |
| 把 CONTEXT.md / ADR 写成"必须先有才能 plan" | 阻塞性过强；新项目没有 CONTEXT.md 时 grill 应该是"创建第一个术语" |
| 对所有 mode 强制 grill stage | `quick-fix` 路径应保持短小；只在 `standard-dev` / `grill` 注入 |

### 4.3 中性 / 待观察

- **多语言支持**：现有 prompt 是中文；grill 系列 prompt 原文是英文。建议**保留中文 prompt 主线**，但 Red Flags 反向表可保留英文（与 superpowers 原版一致，便于跨项目复用）。
- **视觉化 brainstorm UI**：[obra/superpowers brainstorming `visual-companion.md`](https://github.com/obra/superpowers/blob/main/skills/brainstorming/visual-companion.md) 提供 browser companion；本项目目前没有 WebUI 能力，**不**做。
- **git worktree 隔离**：[obra/superpowers using-git-worktrees](https://github.com/obra/superpowers) 提供 worktree-based plan execution；本项目 `subagent-pool` 用文件 backed session 而非 worktree，**不**改造。

---

## 5. 实施计划（增量 + 风险标记）

### 阶段 1：P0 最小闭环（建议 PR #1）

1. 新建 `docs/pi-shiki-subagents/context/CONTEXT.md`（空文件 + 注释说明）。
2. 新建 `docs/pi-shiki-subagents/adr/README.md`（约定格式）。
3. 修改 `src/config/workflow-defaults.ts` 中 `standard-dev` workflow，加 `grill` + `review` stage。
4. 修改 `src/adapters/agents/standard-dev.md`：把 5 stage 写进"工作路径"。
5. 新建 `src/adapters/agents/grill.md`（`grill` mode 的 prompt，主体抄 [mattpocock/grill-me](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md) + 沉淀指令）。
6. 修改 `src/adapters/agents/oracle.md`：加"独立验证者"开头段（§2.3）。
7. 新建 `src/pi/policy/review-ledger.ts`（最小 schema + write/read），接入 `omo_subagent` spawn 后的 oracle 审查。
8. `workflow-stage-policy` 测试加 stage 5 边界用例。
9. `bun test` / `bun run typecheck` / `bun run build` / `bun run verify:release` 全绿。

**风险**：grill stage 加进来后，`stageIndex=0` 的 V1 限制仍然成立——用户不会自动从 analysis 跳到 grill。需要**用户**触发 stage 切换。**修复**：在 `mode_session_started` 通知里加一句"当前 stage: X，下一 stage: Y，输入 `/stage next` 切换"。命令解析走 `lightweight-runtime-stage-gate-design/proposal.md` 留的"V2 stage 切换"扩展点。

### 阶段 2：P0 skill matcher（建议 PR #2）

1. 新建 `src/pi/skill/matcher.ts`：解析 `~/.pi/agents/*.md` + `src/adapters/skills/*.md` 的 frontmatter。
2. 修改 `src/pi/core/pi.ts` 启动事件链：注入 `<AvailableSkills>` + Red Flags。
3. 新建 `src/adapters/skills/verification-before-completion.md`、`test-driven-development.md`（先放 2 个最关键的，验证注入机制工作；其他后续按需）。
4. 给已有 agent md 加 frontmatter 字段 `omo-skill-stage: ...` / `omo-skill-subagent-stop: true` 等。

**风险**：注入 `<AvailableSkills>` 会增加每轮 token 消耗。需要限制注入数量（top-N by description 关键词匹配，或仅注入与当前 mode / workflow 相关的 skill）。

### 阶段 3：P1 oracle 硬化（建议 PR #3）

1. 在 `agents-default.json` 给 `oracle` 加 `tools: ["@oracle_independent"]`，禁止 `omo_subagent`。
2. `tool-scope-manager` 加 `oracle_independent` tool group 实现。
3. `subagent-contract-policy` 加"oracle 不得被 dispatcher 同会话 spawn 后立即 spawn 子代理"——防止审查者跑去拉帮手。

### 阶段 4：P1 CONTEXT/ADR 写入支持（建议 PR #4）

1. 给 `analyst` 的 `grill` stage 注入 `context_writer` tool group（含路径白名单）。
2. `tool-scope-manager` 加"路径白名单"扩展（仅对 `context_writer` 生效）。
3. `analyst.md` 加 CONTEXT/ADR 写入示例。
4. 给 `grill` stage 退出条件加"context writer 至少调用一次 **或** 显式跳过"。

### 阶段 5：P2 dispatcher 并行 + fixer TDD（建议 PR #5+）

按需合并，不强求一次到位。

---

## 6. 不在本次草案范围（明确排除）

- 完整 `WorkflowManager` 复活（`lightweight-runtime-stage-gate-design/proposal.md` V1 限制）。
- 跨 CLI 沙箱调用（`codex exec` / `codex exec resume` 沙箱继承问题）。
- 完整 transcript reconstruction（`claude-code-harness-study/12-harness-closeout.md` §3.1 排除）。
- permission mode 平台化（[obra/superpowers `permission mode` 复合状态机](https://github.com/obra/superpowers) 同名参考；本项目无等价需求）。
- per-edit / per-write 审批门（README §"Control Model" 已移除）。
- 自动 stage 推进（V1 限制）。
- teammate runtime / 长期 mailbox 协作（`claude-code-harness-study/04-tools-permissions-and-orchestration.md` §12.4 明确不在当前范围）。

---

## 7. 验收标准

每完成一个阶段，应同时满足：

1. `bun test` / `bun run typecheck` / `bun run build` / `bun run verify:release` 全绿。
2. 新增 / 修改的 policy 模块有"输入 → 期望 → 不期望"三段式单元测试（沿用 `lightweight-runtime-stage-gate-design/proposal.md` §"Testing Strategy"）。
3. 新增的 prompt / skill / ADR 模板**不**硬编码 agent 名（沿用 `lightweight-runtime-stage-gate-design/proposal.md` §"Design Principles" §1）。
4. 任何"看起来很 clever"的扩展（自动 stage 推进、跨 CLI、teammate runtime）**必须**先写一份"为什么不属于本次"的设计注释再写入，避免 scope creep。
5. CONTEXT.md / ADR 写入路径**不**与项目 README / LICENSE / package.json 冲突；写入失败不能影响主流程（遵循 `evidence-tracker.ts` 的"持久化失败 fail soft"风格）。

---

## 8. 一句话总结

> 用 grill-me（对齐）+ grill-with-docs（沉淀）+ grill-me-codex（两幕对抗） + superpowers（bootstrap / Red Flags / TDD / verification）四套已经被验证的设计模式，对 `pi-shiki-subagents` 现有 `standard-dev` workflow 做 5-stage 化、补 `grill` mode 与 `omo-skill-matcher` 启动 hook、硬化 `oracle` 独立验证者角色；不引入外部 CLI 沙箱、不复活 WorkflowManager、不加细粒度审批；最高价值集中在阶段 1–2，最低风险前提是每一步都沿用现有 `workflow-stage-policy` / `evidence-tracker` / `verification-evidence-policy` 的"config-driven + 纯函数 + companion JSON"风格。

---

## 附录 A：与三套参考仓库的对位速查

| 关注点 | mattpocock/grill-me | mattpocock/grill-with-docs | chaseai-yt/grill-me-codex | obra/superpowers | 本项目落点 |
|---|---|---|---|---|---|
| 反方审讯 prompt | ✅ | ✅ | ✅ | ❌ | `grill` stage analyst prompt |
| 一次一问 + 推荐答案 | ✅ | ✅ | ✅ | ❌ | 同上 |
| CONTEXT.md 沉淀 | ❌ | ✅ | ❌ | ❌ | `docs/pi-shiki-subagents/context/CONTEXT.md` |
| ADR 沉淀 | ❌ | ✅ | ❌ | ❌ | `docs/pi-shiki-subagents/adr/` |
| 两幕拆分 | ❌ | ❌ | ✅ | ❌ | `standard-dev` 5 stage（analysis+grill=Act 1, implement+review=Act 2） |
| 跨模型对抗 | ❌ | ❌ | ✅（Codex） | ❌ | `oracle` 独立上下文（不跨 CLI） |
| `VERDICT: APPROVED\|REVISE` 协议 | ❌ | ❌ | ✅ | ❌ | oracle 审查收口 |
| `MAX_ROUNDS` 必终止 | ❌ | ❌ | ✅ | ❌ | `MAX_REVIEW_ROUNDS` 默认 3 |
| Skill bootstrap | ❌ | ❌ | ❌ | ✅ | `omo-skill-matcher` 启动 hook |
| Red Flags 反向表 | ❌ | ❌ | ❌ | ✅ | 主代理 prompt 顶部 |
| `using-superpowers` 优先级 | ❌ | ❌ | ❌ | ✅ | 沿用本项目"用户 > workflow > mode > skill > default" |
| 1% 适用原则 | ❌ | ❌ | ❌ | ✅ | `<AvailableSkills>` 注入 + frontmatter 描述触发 |
| TDD 铁律 | ❌ | ❌ | ❌ | ✅ | `fixer` prompt + 豁免由 runtime 决定 |
| verification 铁律 | ❌ | ❌ | ❌ | ✅ | 已有 `verification-evidence-policy.ts` |
| `dispatching-parallel-agents` 模板 | ❌ | ❌ | ❌ | ✅ | `dispatcher` prompt 增量 |
| `brainstorming` 9 步 checklist | ❌ | ❌ | ❌ | ✅ | `analysis → grill → plan` 简化版 |
| `visual-companion` WebUI | ❌ | ❌ | ❌ | ✅ | 不做（本项目无 WebUI） |
| `using-git-worktrees` | ❌ | ❌ | ❌ | ✅ | 不做（用 subagent pool session） |
| `writing-skills` 元方法 | ❌ | ❌ | ❌ | ✅ | 阶段 2 引入新 frontmatter 时附带 |

---

## 附录 B：本次草案未决项（待评审）

1. **`grill` mode 是否需要 `requiresUserCommand: true`**：当前倾向是 true（避免模型主动切进去），但用户也可以从 `standard-dev` 流程里走 grill stage 间接到达。
2. **`MAX_REVIEW_ROUNDS` 默认值**：3 还是 5？倾向 3（superpowers 用 5 是因为跨模型容错性更高；本项目 omo_subagent 同 model 上下文容错性更好，可以更短）。
3. **CONTEXT.md 是否纳入 git**：倾向纳入（版本控制术语表演化），但需要加 `.gitattributes` 标记 CONTRIBUTING 流程。
4. **Red Flags 反向表是否翻译为中文**：倾向保留英文（与 superpowers 一致，便于用户对照），但加中文简注。
5. **`<AvailableSkills>` 注入数量上限**：建议 top-5 by description keyword match；超过则只列名字 + 描述前 80 字符。
6. **`omo-skill-subagent-stop` 默认值**：所有现有 agent 默认 false；新增 skill 时按需显式 true。
7. **CONTEXT.md 写入冲突**：两个并行 grill session 同时写怎么办？建议"只允许一个 grill session 持有 writer 锁"，由 `review-ledger.ts` 跟踪持有者。
8. **是否引入"plan 文档"目录** `docs/pi-shiki-subagents/plans/` 已存在但用途不同（历史研究快照）；新计划走 `docs/pi-shiki-subagents/plans/quality-driven-harness-merge/` 自身目录，无须再开。
