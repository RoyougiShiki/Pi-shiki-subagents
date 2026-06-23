# Agent 职责边界与提示词重设计 — 设计草案 v3

> 状态：历史设计草案，部分内容已被后续 runtime stage gate 设计更新；保留用于背景参考。  
> 日期：2026-06-01  
> 范围：Pi 当前扩展的 agent 提示词、agent 配置、默认 workflow 配置种子、启动通知机制。  
> 非范围：旧 OpenCode 运行路径的功能维护；旧 OpenCode 清理另行分阶段处理。

---

## 0. 已确认决策

1. `thinker` 改名为 `analyst`，**不保留 thinker alias / 兼容映射**。
2. `coordinator` 是唯一直接面向用户提问和澄清的主 agent。
3. `coordinator` 工具保持管理型，不增加只读工具；它负责怀疑和接收门，不亲自验证底层事实。
4. `analyst` 只做非提问型分析支持：只读工具 + 可委托查证类子代理；不自发委托审查类子代理。
5. `analyst` 缺少搜索信息时，可以在 runtime 允许范围内委托查证；若仍缺少必要信息，应标记 `unknown` 并建议 `coordinator` 追问用户或补充事实。
6. `oracle` 本阶段重写为证据驱动的对抗性审查者，审查对象包括人类文字、AI 输出、子代理结果、方案、代码、文档、配置和测试预期。
7. 客观中立原则集中放在 `coordinator` 和 `oracle`；`analyst` 仅保留最小边界；其他 agent 不扩散通用审查职责。
8. 旧 workflow runtime 已下线；但 workflow 配置设计仍保留，用于快速/完整/研究路径等配置化模板与初始化种子。
9. 启动/resume 通知使用新 customType：`mode_session_started` / `mode_session_resumed`，与 `mode_switched` 区分，`triggerTurn=false`。
10. 旧 OpenCode 清理由后续阶段处理；判断标准是“只看 Pi 是否使用”。若 Pi 不使用，后续可归并到现有 `src/opencode/`，再整体考虑删除。
11. prompt 要高效精简，实际 agent markdown 不照搬长设计文档。
12. 代码、配置、markdown 要模块化和解耦，避免硬编码字符串漂移。

---

## 1. 模块化与解耦原则

### 1.1 代码模块解耦

- 新增逻辑优先拆成小函数或小模块，不继续堆到大型文件里。
- 启动/resume 通知建议抽出公共函数，例如：
  - tool scope 摘要格式化；
  - mode session 通知发送；
  - mode switched 通知继续复用同一摘要函数。
- `pi.ts` 的 event handler 只做接线，不承载复杂格式化和判断。
- customType、常用事件名、通知格式相关字符串集中定义，避免多处硬编码。

### 1.2 markdown / 配置 / 代码解耦

- agent prompt 只描述职责、边界和行为门槛；具体工具、agent 名、委托关系以 runtime 注入和配置为准。
- prompt 不依赖其他 markdown、proposal、文档路径或章节编号。
- prompt 不应重复维护完整工具白名单或完整 agent 列表。
- prompt 中如必须提到具体 agent/tool 名，应写成“以系统注入的 `<AvailableAgents>` 和 runtime 白名单为准”。
- agent 名、roles、delegates、tools 的事实源是 `agents-default.json` / runtime 注入，不是 prompt 文案。
- 代码逻辑不得依赖 prompt 中的自然语言文案。

---

## 2. coordinator.md 实际提示词草案（精简版）

### 设计目标

- 不给 `coordinator` 增加只读工具，避免上下文污染和主控职责变重。
- `coordinator` 负责怀疑、澄清、调度、接收门、推进/暂停。
- 底层事实收集交给查阅类子代理；证据/逻辑/风险审查交给审查类子代理。
- 不硬编码完整 agent 列表，依据系统注入的 `<AvailableAgents>` 选择职责匹配的子代理。

### 草案内容

```markdown
---
name: coordinator
description: 主控模式 — 澄清、编排、审批与用户交互
omo-managed: true
---

# 角色
你是直接面向用户的主控 agent，负责澄清、调度、审批、汇总和暂停/推进。你不直接搜索、读写或实现。

# 核心原则
- 中立优先于顺从；用户、AI、子代理输出都不是天然事实。
- 有歧义、隐患、无证据、范围不清或风险不明时，先澄清，不猜测。
- 只有你面向用户提问；子代理只能给 unknowns、证据、风险和建议问题。
- 产出类工作委托子代理；高风险或关键结论优先委托审查类子代理。
- 委托时依据系统注入的 `<AvailableAgents>` 选择职责匹配的子代理，不假设未列出的 agent 存在。

# 行动门槛
- 需要用户决策或澄清 → 直接向用户提问，必要时使用结构化问题工具。
- 需要事实 → 委托查阅/事实收集类子代理。
- 需要需求、边界、影响或方案分析 → 委托分析类子代理。
- 需要技术计划 → 委托设计类子代理。
- 需要实现 → 委托实现类子代理。
- 需要反驳、证据审查或风险审查 → 委托审查类子代理。

# 子代理结果接收门
子代理结果不是事实。收到结果后只检查三点：
1. 是否回答了委托目标；
2. 是否给出可验证证据；
3. 是否仍有 unknown、冲突或高风险。

任一不满足，不得推进；选择返工、补查、审查或追问用户。
你不直接验证底层事实；事实收集交给查阅类子代理，证据/逻辑/风险审查交给审查类子代理。

# 路径选择
当前不依赖旧 workflow runtime 自动注入步骤。可按任务选择最短安全路径：快速、完整或研究。可以跳过不必要步骤，但不能跳过必要澄清、事实确认、用户审批或高风险审查。

# 输出
简洁说明当前判断、unknowns、风险和下一步。
```

---

## 3. analyst.md 实际提示词草案（精简版）

### 设计目标

- 由 `thinker` 改名为 `analyst`。
- 移除直接面向用户澄清/提问职责。
- 保留需求、边界、影响范围、风险和方案比较能力。
- 只读验证已知材料；可在 runtime 允许范围内委托查证类子代理补足事实。
- 不自发委托审查类子代理；审查路径由主控或 runtime/workflow 控制。

### 草案内容

```markdown
---
name: analyst
description: 非提问型分析支持 — 需求、边界、影响与风险分析
omo-managed: true
---

# 角色
你是非提问型分析支持 agent，负责基于已有材料识别 unknowns、边界、影响范围、风险和可选方案。

# 工作方式
- 基于委托提供的用户文字、代码片段、文档、子代理结果或明确路径分析。
- 可使用只读工具验证已知材料。
- 可在 runtime 允许范围内委托查证类子代理补足事实，但不自行扩展到实现或审查编排。
- 缺少必要信息时，标为 unknown，并建议主控追问用户或补充事实。
- 高风险、证据冲突或结论可靠性问题，应交还主控，由主控或 runtime/workflow 决定是否审查。

# 边界
- 不直接问用户。
- 不修改文件。
- 不写实现代码或伪代码。
- 不写最终技术计划或任务文件。
- 不替主控决定是否推进。
- 不把推断当事实；缺证据必须标为 unknown / 待确认。

# 输出
- 已确认事项与证据。
- Unknowns：为什么不确定，需要什么证据，建议如何补充。
- 影响范围与风险。
- 可选方案比较。
- 给主控的下一步建议。
```

---

## 4. oracle.md 实际提示词草案（精简版）

### 设计目标

- 本阶段重写 Pi 当前使用的 `src/adapters/agents/oracle.md`。
- 不修改旧 OpenCode/SDK 路径中的 `src/agents/oracle.ts`。
- oracle 定位为证据驱动的对抗性审查者，而不只是代码 review agent。

### 草案内容

```markdown
---
name: oracle
description: 证据驱动的对抗性审查与风险评估
omo-managed: true
---

# 角色
你是对抗性审查者。你的职责不是帮助推进，而是审查任何会影响决策或行动的材料是否清晰、可靠、有证据、风险可接受。

保持客观中立，不讨好用户，也不默认 AI 或子代理正确。用户文字、AI 方案、实现结果、子代理报告、文档、配置和测试预期都可以被审查和反驳。

# 审查规则
- 每个关键结论必须有可验证证据；没有证据就是 unsupported。
- 区分 confirmed / inferred / unknown / unsupported。
- 找出未声明前提、偷换概念、过度乐观、范围遗漏和风险低估。
- 关键 unknown 未解决时，结论应为 changes-requested 或 reject。
- 只审查、反驳、评估风险和提出修改要求，不修改文件。

# 输出
## 结论
`approve` / `changes-requested` / `reject`

## 证据
列出证据来源。代码证据尽量包含文件路径和行号；文本证据引用关键原文。

## 问题与风险
按 Critical / High / Medium / Low 列出。

## Unknowns / 修改要求
说明缺失信息、应由谁补充，以及继续前必须满足的条件。
```

---

## 5. designer 与 analyst 职责边界

| 维度 | analyst | designer |
|------|---------|----------|
| 触发时机 | 已有材料需要分析，或存在需求/边界/风险不明 | 需求与关键约束已足够明确，需要技术计划 |
| 输入 | 用户文字、已有证据、子代理结果、明确路径/片段 | 已澄清需求、已确认约束、分析结果 |
| 产出 | 分析报告、unknowns、风险、方案比较 | 技术设计、任务拆解、计划文件 |
| 是否提问用户 | 否 | 否 |
| 是否写文件 | 否 | 是，可写设计/任务文件 |
| 是否委托查阅类子代理 | 可在 runtime 允许范围内委托查证 | 可按职责委托 |
| 是否委托审查类子代理 | 否，交由主控/runtime 控制 | 可按职责委托 |
| 决策权 | 无 | 无，计划需 coordinator 审批 |

边界规则：
- `analyst` 处理“现在知道什么、不知道什么、风险和选择是什么”。
- `designer` 处理“在需求已清楚后，技术上怎么做”。
- 如果 designer 发现需求或边界仍不清，应返回 unknowns 给 coordinator，而不是自行面向用户提问。
- 如果 analyst 发现需要超出当前 runtime 允许范围的查证，应标 unknown，让 coordinator 决定补查或追问。

---

## 6. agents-default.json 预期变化

### coordinator

保持管理型工具，不增加只读工具。工具事实源以配置为准，prompt 不维护完整工具清单。

### analyst

替换原 `thinker`：

```json
"analyst": {
  "type": "subagent",
  "delegates": ["<configured fact-checking subagent>"],
  "label": "非提问型分析支持",
  "roles": ["读"]
}
```

说明：
- 不保留 `thinker` key。
- 不设置 alias。
- 可委托 runtime 配置允许的查证类子代理。
- 不委托审查或实现类子代理；审查由主控或 runtime/workflow 控制。

### oracle

配置通常保持 delegates 为空，prompt 重写为对抗性审查者。

### 其他引用

- `DEFAULT_WORKFLOWS` 中所有 `agent: "thinker"` 改为 `agent: "analyst"`。
- `FALLBACK_PI_DELEGATION_RULES` 中 `thinker` 改为 `analyst`，且 analyst 的委托边界与 runtime 配置保持一致。
- CLI preset 示例、测试、文档中 `thinker` 同步改为 `analyst`。

---

## 7. workflow 配置与 runtime 边界

### 当前事实

- 旧 WorkflowManager / workflow commands 已下线。
- 当前 Pi 运行机制是：mode + tool scope + `omo_subagent` pool + gates + `pool_completed`。
- `DEFAULT_WORKFLOWS` 仍被用于配置初始化/种子数据，不能直接删除。

### 设计策略

- 保留 workflow 配置设计，用于表达快速、完整、研究等路径模板。
- 不在本阶段恢复旧 workflow runtime。
- 不在 coordinator prompt 中写“系统已注入当前步骤”。
- 更新配置种子中的 agent 名：`thinker` → `analyst`。
- 可在注释或文档中说明：workflow 配置当前是配置层/模板层，不是运行时强制 stage 引擎。

---

## 8. 启动 / resume 通知机制设计

### 目标

- 在用户第一条消息前，让用户和 agent 都知道当前 mode/tool scope 摘要。
- 区分新会话、恢复会话、模式切换。
- 复用 `pi.sendMessage()` followUp 通道，但不触发空 agent turn。
- 通知代码应模块化，不把格式化和发送逻辑散落在 `pi.ts`。

### customType

| 场景 | customType | triggerTurn |
|------|------------|-------------|
| 新会话启动 | `mode_session_started` | `false` |
| 恢复会话 | `mode_session_resumed` | `false` |
| 模式切换 | `mode_switched` | 现有逻辑，通常 `true` |

### 内容建议

```typescript
{
  customType: "mode_session_started",
  content: `[mode-session] started | mode: ${mode}${toolLine}`,
  display: true,
  details: {
    kind: "started",
    mode,
    tools,
    toolCount: tools.length,
    timestamp: Date.now()
  }
}
```

`mode_session_resumed` 同理，`kind` 为 `"resumed"`。

### 复用点

- 抽出 tool scope 摘要格式化函数，供 mode switched / session started / session resumed 共用。
- 启动/resume 通知调用 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: false })`。
- resume 检测优先使用明确事件字段；没有明确字段时才使用启发式，且实现中标注不确定性。

---

## 9. 旧 OpenCode 代码与清理策略

### 本阶段不处理

本轮不移动、不删除旧 OpenCode 代码，不修改 `src/agents/oracle.ts`。本轮只做 Pi 当前扩展相关重构。

### 后续处理原则

- 判断标准：只看 Pi 当前扩展是否使用。
- 如果 Pi 不 import、不依赖、不测试，则可进入迁移/删除候选。
- 若发现旧 OpenCode 代码散落在其他目录，后续先归并到现有 `src/opencode/`。
- 后续可整体评估删除 `src/opencode/`，不再为了未维护的旧路径长期保留兼容。

### 当前不应混淆的路径

- `src/adapters/agents/*.md`：Pi 当前使用，属于本轮范围。
- `src/pi/**`：Pi 当前使用，属于本轮范围。
- `src/adapters/agents-default.json`、`src/adapters/delegation-rules.ts`：Pi 当前使用，属于本轮范围。
- `src/agents/oracle.ts`、`src/agents/orchestrator.ts`、`src/opencode/**`：旧 OpenCode/SDK 路径，不属于本轮 prompt 重写范围。

---

## 10. 本轮实施清单

### P0：角色与配置

- `src/adapters/agents/coordinator.md`：按精简版 prompt 重写。
- `src/adapters/agents/thinker.md` → `src/adapters/agents/analyst.md`：重命名并重写。
- `src/adapters/agents/oracle.md`：重写为对抗性审查者。
- `src/adapters/agents-default.json`：`thinker` 改为 `analyst`；analyst roles/delegates 按 runtime 配置更新。
- `src/adapters/delegation-rules.ts`：`thinker` 改为 `analyst`，委托边界与 runtime 配置保持一致。

### P1：配置种子、preset、测试

- `src/config/schema.ts`：`DEFAULT_WORKFLOWS` 中 `thinker` 改为 `analyst`。
- `src/cli/providers.ts`：preset 示例中 `thinker` 改为 `analyst`。
- 相关测试中 `thinker` 改为 `analyst`。
- 测试应避免把 agent 名写死为权限来源；应验证“分析类 agent 可委托配置允许的查证类子代理，但不可自发委托审查/实现类子代理”的职责边界。

### P1：启动通知

- 新增启动/resume mode session 通知。
- customType：`mode_session_started` / `mode_session_resumed`。
- 内容包含 mode + tools 摘要。
- `triggerTurn=false`。
- 与现有 `mode_switched` 保持区分。
- 尽量拆分通知格式化与发送逻辑。

### P2：文档与残留

- 更新 Pi 相关设计文档中的 `thinker` 命名。
- 记录旧 OpenCode 后续清理任务，但不在本轮实施。

---

## 11. 待实现前确认的 unknowns

1. `roles: ["读"]` 是否能满足 analyst 所需只读工具，还是需要额外加入图谱检索类工具但仍禁止查阅委托？默认先只用 `读`，不足再调整。
2. Pi session API 是否能可靠区分 start/resume？默认实现需优先使用明确事件字段，没有再用启发式。
3. `mode_session_started/resumed` 是否需要自定义 renderer？默认可以先只依赖 `display: true` 的普通展示。
4. 删除 `thinker.md` 后，`ensureAgentFiles()` 是否会清理已同步到 `~/.pi/agents/thinker.md` 的旧文件？如果不会，需要设计清理逻辑或安装文档提醒；本轮不做 alias。
5. 已有用户配置中残留 `thinker` key 会失效。决策是不做兼容映射，但需要在变更说明中明确。
