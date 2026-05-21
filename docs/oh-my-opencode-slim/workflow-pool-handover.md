# Workflow Pool / Agent 职责隔离迁移交接文档

> 继续实施前请先完整阅读本文件，并按其中的优先级与验收要求推进。

## 0. 当前总判断

本轮目标是把 OMO slim 的 Pi workflow 从“形式化调用 agent”修正为真正的职责隔离系统：

- workflow 是流程权威
- coordinator 只做状态机和用户交互
- agent prompt 只定义角色/边界/输出契约，不重复 workflow 流程
- stage agent 使用真实 agent prompt
- workflow stage 使用 pool/rpc 持久会话，而不是 one-shot single
- stage 运行期可多轮；完成后默认只传 StageOutput 给下一阶段
- tools/delegates/model 等运行配置以 OMO slim JSON 为权威，不写进 md frontmatter
- delegation 最多两层
- oracle/fixer/explorer/librarian/observer 是叶子，不继续委托

**到当前这轮结束时，核心代码改造与主验收目标已基本完成。**

已完成并有测试/审查支撑的主线包括：

1. runtime config 搜索路径、model/thinking/blocked/runtime agent merge
2. 真实 pool stage、StageOutput repair/failed/needs_user、workflow status 可观察错误
3. delegation matrix、最大两层深度、`allowedSubagents`
4. workflow 控制工具、default workflows、工具权限收紧、prompt/frontmatter 精简
5. chat overlay / hub 与 workflow stage 绑定
6. pool timeout lifecycle
7. context-mode 本机环境恢复可用

**但仍不要把当前状态误判为“所有尾项完全清零”。** 仍需明确记录的未闭环项：

1. **旧用户 `~/.pi/agents/*.md` 自动同步机制未解决**：本地已有旧 agent md 时，可能继续跑旧 prompt。
2. **缺少完整真实交互 E2E 验收**：虽然单测/审查较完整，但没有做一整轮真实 workflow UI/overlay/hub 人工链路验收。
3. **context-mode 当前修复是本机环境级**：已让工具可用，但重点只是“工具可调用”，**不要把它扩展成 MCP 提示词注入改造任务**。
4. **Pi 侧仍值得继续检查是否有重复/分散的配置读取逻辑、小死代码和过期说明**。
5. **gate 部分目前仍是客观总结为主，优化意见/实施并未完成**。

因此：

- 若继续开发，已不需要再从最初 P0 重新开始。
- 新对话应聚焦：**已安装 Pi / 仓库同步、旧 agent md 同步、真实 E2E、Pi 侧重复配置/死代码检查、gate 优化意见与实现**。

---

## 1. 用户明确要求 / 设计原则

### 1.1 不纳入范围

- **opencode legacy 不纳入本轮评估/迁移**。
- 旧 `src/agents/orchestrator.ts`、OpenCode adapter 的 legacy prompt 可以后续再说。
- 本轮主要聚焦 Pi workflow / OMO slim agent职责隔离。

### 1.2 架构目标

用户目标：

- 提升单个 LLM 的专注力
- 避免越界
- 职责分离
- 通过 workflow、工具权限、上下文隔离、结构化输出提高提示词/规则遵守率
- 子代理负责一个职责
- 子代理可以有工具集合型叶子代理，例如 worker/implementer 调 fixer 实现、调 oracle 审查
- 避免中间过程噪音传递给下一个专家

### 1.3 workflow 与 agent prompt 的关系

用户已明确同意：

- **workflow 定义流程标准**
- **agent prompt 不要重复 workflow 流程**
- agent prompt 只定义：角色、边界、工具使用原则、输出契约、停止条件
- 旧 prompt 里 `<<MODE:...>>`、`<<PHASE:...>>` 等模式哨兵应移除
- prompt 要精简，不堆规则

### 1.4 工具配置权威来源

用户明确指出并确认：

- 工具类型不是写在 markdown 里的
- **tools 应该在 OMO slim 的 JSON 配置里作为权威**
- md frontmatter 不应重复 `tools` / `thinking`
- md frontmatter 只保留：`name`、`description`
- 避免 md 与 JSON 工具配置不一致

### 1.5 可配置化要求

用户强调：

- 保持原本实现风格
- 可配置化
- 避免硬编码
- 未来可灵活修改
- delegation matrix 不应永久硬编码在运行逻辑中，应该优先从 OMO slim JSON 的 `delegates` 读取，硬编码只作 fallback
- 默认 workflows 可以在 schema/default config，但应允许用户配置覆盖

### 1.6 最大子代理层级

用户明确：

- **最多两层**

建议定义：

```text
Level 0: coordinator / main mode
Level 1: workflow stage agent
Level 2: stage agent 调用的 leaf subagent
Level 3: 禁止
```

允许示例：

```text
coordinator → worker → fixer
coordinator → worker → oracle
coordinator → thinker-analysis → explorer
```

禁止示例：

```text
coordinator → worker → oracle → explorer
coordinator → fixer → oracle
coordinator → oracle → explorer
```

### 1.7 oracle 职责

用户明确修正过：

- oracle 不只是调查，还有审查职责
- worker / implementer prompt 里本来就有 TDD 和审查实现结果的过程
- 所以 worker / implementer / batch 应允许调用 oracle
- 但 oracle 自身不允许再委托，避免层级复杂度上升

### 1.8 子代理持久化语义

用户关心：

- workflow/pipeline stage 不应该是 single one-shot
- 需要多轮交互时应使用 pool 持久化
- 需求澄清子代理结束前，主 agent / 用户后续应能继续与同一 stage 会话交互

当前设计建议：

- stage 运行期间 pool 持久化
- stage 完成后默认关闭或冻结，只传 StageOutput 给下一阶段
- 如需调试/特殊场景，可配置 `keepAlive`

### 1.9 文档参考

用户给过 OpenAI prompt guidance，仅作为参考，不机械照搬。

后续又要求查询 Pi 最新文档；已经查询，结论见第 8 节。

---

## 2. 必须注意的流程/规则问题

用户指出过我没有遵守 implementer 模式流程。新对话必须避免重犯。

### 2.1 不要假装 TDD / 审查完成

之前我直接修改了大量代码，只跑了 typecheck 和部分测试，然后才补审查。用户明确要求：

- 实施完成后必须补 TDD / 测试 / 审查
- 不要做欺骗性的测试
- 不要把 `typecheck` 伪装成完整测试
- 没有实际 oracle 审查就不要说已经审查
- 测试没覆盖就明确说明

### 2.2 当前应采用的实施方式

虽然用户进入了 implementer 模式，但当前实际操作是主 agent 直接实施。新对话建议更严格：

1. 先写/更新计划或选择已有 task
2. 对每个任务：
   - 先补或设计可验证测试
   - 再实现
   - 跑真实测试
   - 再做 oracle 规格/质量审查
   - 更新 task json / index 状态
3. 不要声称完成未验证内容

### 2.3 新对话建议

建议新对话先做：

```text
1. 读取本 handover
2. 读取当前 git diff / status
3. 不要立即继续实现
4. 先确认剩余 P0 列表
5. 针对一个 P0 写测试 → 实现 → 运行测试 → oracle审查
```

---

## 3. 已完成/已修改的主要内容

> 注意：这些是当前工作区未提交改动的一部分；实际请以 `git diff` 为准。

### 3.1 计划文档重写

已覆盖/新增：

- `docs/oh-my-opencode-slim/plans/plan.md`
- `docs/oh-my-opencode-slim/plans/index.json`
- `docs/oh-my-opencode-slim/plans/task-1.json` ... `task-10.json`

新计划目标：

- agent discovery
- WorkflowManager pool stage
- StageOutput 校验
- Chat overlay/hub 接入
- workflow 控制工具
- delegation matrix/max depth
- prompt 精简
- 工具权限收紧
- 默认 workflows 扩展
- codemap/验证清理

### 3.2 新增文件

当前新增了：

- `src/adapters/agent-discovery.ts`
- `src/adapters/agent-discovery.test.ts`
- `src/adapters/agent-runtime-config.ts`
- `src/adapters/delegation-rules.ts`
- `src/adapters/delegation-rules.test.ts`
- `src/adapters/workflow-manager.ts`
- `src/adapters/workflow-commands.ts`
- `src/adapters/agents/coordinator.md`
- `src/core/workflow-types.ts`
- `docs/oh-my-opencode-slim/workflow-pool-handover.md`（本文件）

### 3.3 `agent-discovery.ts`

当前职责：

- 从项目 `.pi/agents` 和用户 `~/.pi/agents` 读取 agent md
- md 只读 `name` / `description` / body prompt
- tools/model 等从 runtime JSON 合并（目前 model 合并尚未完善）
- 项目 `.pi/agents` 优先于用户全局 agent 文件

关键原则：

- 不再从 md frontmatter 读取 `tools`
- 测试覆盖：自定义 agent md 能被读取；md 中 tools 不作为权威

已知问题：

- JSON 中定义的 agent 如果缺 md prompt，目前不能被发现
- model 解析尚未完整支持 preset/root agents/default 优先级

### 3.4 `agent-runtime-config.ts`

当前职责：

- 读取内置 `src/adapters/agents-default.json`
- 读取用户 `~/.pi/agent/oh-my-opencode-slim.json`
- 合并 `agents` 覆盖
- 提供：
  - `loadRuntimeAgentDefinitions()`
  - `getRuntimeAgentDefinition(name)`
  - `getDelegationRulesFromConfig()`

已知问题（P0）：

- 目前只读 `~/.pi/agent/oh-my-opencode-slim.json`
- 但项目 CLI / OpenCode config 可能写在 `~/.config/opencode/oh-my-opencode-slim.json` 或 `OPENCODE_CONFIG_DIR`
- Pi runtime config 搜索路径需要统一，否则 JSON 权威配置可能对默认安装用户失效
- 还没有合并 active preset 的 agent model/tools/delegates

### 3.5 `delegation-rules.ts`

当前实现：

- 默认 `DEFAULT_MAX_SUBAGENT_DEPTH = 2`
- 优先从 `getDelegationRulesFromConfig()` 读取 JSON `delegates`
- 如果没有配置，fallback 到内置表
- unknown caller 默认 deny
- no caller 允许（主会话例外）

当前规则意图：

```json
{
  "coordinator": [],
  "thinker-clarify": ["explorer", "librarian", "observer"],
  "thinker-analysis": ["explorer", "librarian", "observer", "oracle"],
  "designer": ["explorer", "librarian", "observer", "oracle"],
  "worker": ["fixer", "oracle"],
  "implementer": ["fixer", "oracle"],
  "batch": ["fixer", "oracle"],
  "explorer": [],
  "librarian": [],
  "observer": [],
  "oracle": [],
  "fixer": []
}
```

已知问题（P0/P1）：

- `StageNode.allowedSubagents` 字段已经暴露，但未执行
- 需要决定：实现它，还是删除字段避免假能力

### 3.6 `subagent-pool.ts`

已改方向：

- 引入 `agent-discovery`
- 子进程 env 设置：
  - `OMO_SUB_AGENT=1`
  - `OMO_AGENT_NAME=<agent>`
  - `OMO_SUBAGENT_DEPTH=<depth>`
  - `OMO_PARENT_AGENT_NAME=<parent>`
- `omo_subagent` 执行时检查 delegation rules
- pool `sendPrompt()` 增加：
  - busy 检查
  - 300s timeout
  - kill pending resolve
- `kill()` 会 resolve pending promise

重要：

- 曾经尝试加 `--agent`，但根据 Pi 文档未见官方 `--agent` 参数，已撤回
- 子代理工具应用依赖 `pi-modes.ts` 在子进程读取 `OMO_AGENT_NAME` 并 `setActiveTools`

已知问题（P0/P1）：

- timeout 后目前只是 resolve error，进程生命周期仍需更严谨处理：kill 或 request-id 隔离迟到响应
- pool 相关测试不足，缺 busy/timeout/kill pending 单测
- 注释仍可能有旧配置路径描述

### 3.7 `pi-modes.ts`

已改方向：

- 使用 `loadRuntimeAgentDefinitions()` 合并 JSON 配置
- 新增 `applyAgentTools(pi, name, allowSubagentType)`
- 子进程中如果 `OMO_SUB_AGENT=1` 且 `OMO_AGENT_NAME` 存在，则允许应用 subagent 类型 agent 的 tools
- 主会话仍只允许 mode/both 作为 mode

已知问题：

- runtime config 路径不统一导致 tools/delegates 可能读错配置
- `_agentDefs` 缓存仍可能导致 config 修改后不立即生效
- 空 tools = allow all，目前 fallback 合理但用户误配空数组风险存在

### 3.8 `WorkflowManager`

当前实现方向：

- 使用 `resolveAgent()` 找真实 agent prompt
- 用 `getPool().spawn()` 启动 stage pool，而不是 `runIsolatedTask`
- stage 运行期间持久化
- `StageOutput` parse/validate：目前主要检查 `status` / `summary` / `context`
- JSON parse 失败会向同一 pool 发 repair prompt
- `needs_user` 时等待 `sendUserMessage()` 恢复
- `sendUserMessage()` 会解析 stage 回复并 resolve stage wait
- `retryStage()` 不再另起脱链 runSingleStage，而是在 stage 等待时通过 `sendUserMessage()` 触发当前 stage 重试
- `abort()` 会 resolve choice/stage wait

已知问题（P0/P1）：

- `sendUserMessage()` 在 `needs_user` 后如果 stage 返回 `failed`，需要确认 `runSingleStage()` 是否再次检查 failed；最后 oracle 仍认为有可能 failed 当 complete 推进，需要修/测
- `workflow-manager` 缺单测，这是下一步重点
- `start_workflow` 是 fire-and-forget，失败主要靠状态/日志，需考虑 lastError/status
- `cwd` 当前在 `pi.ts` 初始化时用 `process.cwd()`，多 session/project 场景可能错，应考虑 ctx.cwd

### 3.9 `pi-hub.ts` / `pi-chat-bridge.ts`

已改方向：

- `Hub.registerChat` 支持可选 `onUserMessage`
- workflow stage 注册 chat 时绑定 `(message) => workflowManager.sendUserMessage(message)`
- overlay 输入仍走 `hub.broadcast()`，但 workflow private chat 会进 manager，而不是直接写 pool stdin
- `autoOpenChat` 已改成不设置 `_activeManualMeeting`，避免自动打开被误认为手动 chat

测试覆盖：

- `pi-hub.test.ts` 新增 `private chat can route user input through custom handler`

### 3.10 `workflow-commands.ts`

已实现工具：

- `start_workflow`
- `list_workflows`
- `select_branch`
- `workflow_status`
- `send_stage_message`
- `abort_workflow`
- `retry_stage`

已修：

- `start_workflow` 和 `/workflow start` 前检查 `manager.isRunning()`，避免返回假成功

仍需考虑：

- `start_workflow` 是否支持 name optional 使用 default
- 失败是否进入 manager.status().lastError，而不是只 console.error

### 3.11 `agents-default.json`

已重写为 JSON 权威配置。

当前结构示例：

```json
"worker": {
  "type": "subagent",
  "tools": ["todo", "omo_subagent", "read", "grep", "find", "ls"],
  "delegates": ["fixer", "oracle"],
  "label": "快速实施"
}
```

注意：

- worker/implementer/batch 已改为 `subagent`
- coordinator 是唯一默认 mode
- tools/delegates 在 JSON，不在 md

### 3.12 agent prompts

所有 `src/adapters/agents/*.md` 已精简：

- 只保留 `name` / `description` frontmatter
- 不再写 `tools` / `thinking`
- 移除了旧 `<<MODE:...>>` / `<<PHASE:...>>`
- workflow stage agent 都要求最终返回 StageOutput JSON
- leaf agent 保持简洁职责

已知问题：

- `ensureAgentFiles()` 只复制缺失文件，旧用户已有 md 不会更新，这会影响新 prompt 生效

### 3.13 `schema.ts` / workflows

已新增/扩展：

- `StageNode`: `id`、`agent`、`description`、`task`、`outputSchema`、`keepAlive`、`allowedSubagents`
- `ChoiceNode`: `id`
- `DEFAULT_WORKFLOWS` 导出
- 默认 workflows：
  - `standard-dev`
  - `quick-fix`
  - `batch-dev`
  - `review-only`
  - `research-only`
- `WorkflowsConfigSchema.default` 默认 `standard-dev`
- agent config schema 允许：
  - `type`
  - `tools`
  - `delegates`
  - `blocked`
  - `hidden`
  - `label`

已知问题：

- `allowedSubagents` 字段未执行，是假能力
- Pi config 没统一 schema-normalize 路径，半配置处理仍需加强

### 3.14 package / release

已改：

- `package.json.files` 包含：
  - `src/adapters`
  - `src/core`
  - `src/config`
- `peerDependencies` 增加：
  - `@earendil-works/pi-coding-agent: "*"`
  - `@earendil-works/pi-tui: "*"`
  - `typebox: "*"`
- `scripts/verify-release-artifact.ts` required files 增加 Pi extension 相关源码和 agent assets

验证通过：

- `bun run verify:release`

---

## 4. 已运行验证

已真实运行过：

```bash
bun run generate-schema
bun test src/config/loader.test.ts src/config/utils.test.ts src/adapters/pi-hub.test.ts src/adapters/delegation-rules.test.ts src/adapters/agent-discovery.test.ts
bun run typecheck
bun run build:plugin
bun run verify:release
```

其中最后一次较完整输出：

- `bun test ...`：78 pass / 0 fail（包含 config + hub + delegation + discovery）
- `bun run typecheck`：通过
- `bun run build:plugin`：通过
- `bun run verify:release`：通过

但必须注意：

- 这不等于完整测试
- workflow-manager 状态机还没有单测
- subagent-pool timeout/busy/kill pending 还没有直接单测
- 真实 pi rpc pool e2e 没跑

---

## 5. 最后 oracle 复审结论摘要

最后一次 oracle 仍给出：**仍有阻断**。

它列的阻断：

### 5.1 Pi runtime config 搜索路径不一致（P0）

问题：

- `agent-runtime-config.ts` 目前只读：
  - 内置 `agents-default.json`
  - `~/.pi/agent/oh-my-opencode-slim.json`
- 但项目 CLI / OpenCode config 可能写到：
  - `~/.config/opencode/oh-my-opencode-slim.json`
  - `OPENCODE_CONFIG_DIR`
  - 其他 config loader 搜索路径

影响：

- 用户通过 CLI 生成/修改的 `agents.tools/delegates/type/model` 可能 Pi runtime 读不到
- JSON 权威配置对默认安装用户可能失效

建议：

- 复用项目已有 `loadPluginConfig()` / config loader 搜索顺序，或让 `agent-runtime-config.ts` 支持：
  1. env config dir
  2. `~/.pi/agent`
  3. XDG/OpenCode config
  4. defaults
- 还要合并 active preset

### 5.2 `allowedSubagents` 字段未执行（P0/P1）

问题：

- 类型和 schema 暴露了 `StageNode.allowedSubagents`
- 但 WorkflowManager / subagent-pool / delegation-rules 没有使用它

选择：

A. 实现它：

- WorkflowManager stage 启动时把 allowedSubagents 通过 env 传入子进程，例如：
  - `OMO_ALLOWED_SUBAGENTS=fixer,oracle`
- delegation check 中取全局 delegates 与 stage allowedSubagents 的交集
- stage override 只能收窄不能放宽

B. 删除它：

- 从 type/schema 中移除，避免假能力

建议：

- 如果还没准备好实现，先删除
- 如果确实需要 stage 级限制，则实现，但要补测试

### 5.3 `needs_user` 后 failed 输出处理（P0）

最后 oracle 认为：

- `sendUserMessage()` 对 stage 回复解析后，如果 status 是 `failed`，可能 resolve 给 wait 后被当 complete 推进
- 需要检查/修 `runSingleStage()` 在 `await waitForUserCompletion()` 后是否再次检查 failed

需要重新检查实际代码，确认该问题是否已经彻底修复。

建议测试：

- mock 一个 stage 首次返回 `needs_user`
- send_stage_message 后返回 `failed`
- workflow 应 emit error，不应进入下一 stage

### 5.4 Pool timeout 生命周期（P0/P1）

当前实现：

- timeout 后 resolve error
- 但进程可能还活着
- 迟到 agent_end 可能污染 lastResponse

选择：

A. timeout 后 kill pool agent（简单、安全）

B. 加 request id/turn id，丢弃迟到响应（更复杂）

建议：

- 先采用 A：timeout 后 kill，标记 dead，避免污染
- 补测试：sendPrompt timeout 后 kill 被调用/entry removed 或 dead

### 5.5 WorkflowManager 缺单测（P1）

建议新增：

- `src/adapters/workflow-manager.test.ts`

至少覆盖：

1. complete stage → 下一 stage 接收 context
2. invalid JSON → repair prompt → complete
3. invalid JSON twice → error
4. needs_user → sendUserMessage complete → workflow 继续
5. needs_user → sendUserMessage failed → workflow error，不继续
6. selectBranch invalid index → false，不挂起
7. abort while choice waiting → promise settles
8. retryStage in needs_user → 不脱链，不中止原 workflow

为了可测，可能需要给 WorkflowManager 注入 pool/agentResolver，而不是直接 import singleton `getPool()`。

### 5.6 模型解析问题（P0，用户特别提出）

用户发现并询问：

> 当前子代理配置的模型是不是无效，还是用的主agent的模型配置？

当前判断：**很可能仍有问题**。

原因：

- Pi RPC/JSON 文档确认可通过 `--model` 指定模型
- 当前 `subagent-pool.ts` 会用：

```ts
params.model || agentCfg.model || defaultModel
```

- 但 `agentCfg.model` 主要来自 md frontmatter / discovery，目前还没完整合并 OMO slim JSON 的 root agents + active preset
- 所以如果用户配置了：

```json
{
  "preset": "x",
  "presets": {
    "x": {
      "oracle": { "model": "provider/model" }
    }
  }
}
```

子代理可能没用 oracle 的模型，而 fallback 到主 agent `ctx.model`

建议实现优先级：P0。

模型解析优先级建议：

```text
params.model
> active preset agents[agent].model
> root agents[agent].model
> built-in/default model if any
> ctx.model fallback
```

还要考虑：

- variant
- thinking
- provider/model 格式

### 5.7 配置路径 / model 解析需要结合 Pi 文档

已经查询 Pi docs，结论见第 8 节。

---

## 6. 下一步建议优先级

### P0-1：统一 runtime config 搜索与合并

目标：`agent-runtime-config.ts` 不再只读 `~/.pi/agent/oh-my-opencode-slim.json`。

需要读取/复用现有项目配置逻辑：

- `src/config/loader.ts`
- `src/cli/paths.ts`
- `src/cli/config-io.ts`
- `src/adapters/pi.ts` 里的 `loadOmniMoConfig()`

建议实现：

- 新增一个统一 helper，例如：

```ts
loadPiOmniConfig(): OmniMoConfig | null
```

- 或让 `agent-runtime-config.ts` 使用与 `loadOmniMoConfig()` 相同搜索路径
- 合并：defaults agents + root agents + active preset agents
- active preset 从 `preset` 字段读
- 不要硬编码只读一个路径

验收：

- 测试：用户 config 放在 OpenCode config dir 时，runtime definitions 能读到
- 测试：root agents 覆盖 defaults
- 测试：preset agents 覆盖 root/default 或按项目既有优先级
- 测试：worker/implementer/batch 仍是 subagent

### P0-2：修子代理模型解析

在 `RuntimeAgentDefinition` 中加入：

- `model?: string | Array<...>`（视现有 schema）
- `variant?`
- `thinking?`
- `options?`

但 `subagent-pool` 启动 CLI `--model` 需要 string，先处理 string。

建议：

- `resolveAgent(cwd, name)` 返回的 `AgentConfig.model` 应来自 runtime config
- 若 model array，则可先取第一个 string 或后续用 fallback chain
- 不要从 md frontmatter model 作为主要来源

验收：

- 测试：配置 oracle model 后，`resolveAgent(..., 'oracle').model` 是该配置
- 测试：preset oracle model 覆盖 root oracle model
- 测试：未配置时才 fallback 到 main ctx.model

### P0-3：处理 `allowedSubagents`

需要选择：

#### 方案 A：删除字段

优点：简单，避免假能力。

改动：

- 从 `StageNode` type 删除
- 从 `StageNodeSchema` 删除
- 从 docs/plan 删除相关承诺
- 重新生成 schema

#### 方案 B：实现字段

优点：更灵活，符合用户可配置要求。

实现：

- WorkflowManager stage 启动时 env 传：

```text
OMO_ALLOWED_SUBAGENTS=fixer,oracle
```

- `subagent-pool` delegation check 读取该 env
- check 时：

```text
allowed = intersection(runtime delegates[caller], stageAllowedSubagents)
```

- stage allowedSubagents 只能收窄，不允许放宽

建议：

- 如果实现资源充足，做方案 B
- 否则先做方案 A，避免假能力

### P0-4：修 needs_user → failed 状态

验收：

- stage 首次 needs_user
- user message 后 stage failed
- workflow emit error
- 不 emit complete
- 不进入下一 stage

### P0-5：pool timeout lifecycle

建议最小实现：

- timeout 后：
  - resolve error
  - clear pending
  - mark status dead 或 timeout
  - kill process
  - remove entry 或保持 dead 不可 send

验收：

- timeout 后 sendPrompt 不会继续接受旧 agent
- kill pending resolves
- no permanent pending promise

### P1：WorkflowManager 单测

强烈建议先重构可测试性：

- 注入 `pool` 接口
- 注入 `resolveAgent` 函数
- 不直接 singleton `getPool()`

接口示例：

```ts
interface WorkflowPool {
  spawn(opts): Promise<{ response: string; error?: string }>;
  sendPrompt(id, message): Promise<{ response: string; error?: string }>;
  kill(id): boolean;
}
```

这样才能可靠 mock。

### P1：start_workflow error status

当前 start_workflow fire-and-forget。建议 manager 增加：

- `lastError`
- `lastEvent`
- `status()` 返回 lastError

工具返回启动成功只表示“已排队/已开始”，失败看 status。

### P1：旧用户 agent md 同步机制

`ensureAgentFiles()` 只复制不存在文件。

选择：

A. 提供 `/omo sync-agents` 命令
B. 内置 md 加版本戳，版本低时覆盖
C. 只提醒用户手动删除/刷新

建议：

- 至少在启动时检测缺少 coordinator.md 或 old marker，通知用户
- 后续做 sync 命令

---

## 7. 当前 git status 注意事项

当前工作区包含很多早前任务的改动/删除，不全是本轮新增。

最后一次 `git status --short` 显示：

- 删除 multiplexer 相关文件
- 修改大量 CLI/config/opencode/council/session-manager 文件（来自前文已完成 9 个任务）
- 新增 workflow 相关文件
- 新增 docs/oh-my-opencode-slim 计划文件

继续实施前建议先运行：

```bash
cd /home/h/projects/aiprojects/oh-my-opencode-slim
git status --short
git diff --name-only
```

不要误以为所有 diff 都是本轮需要处理。

---

## 8. Pi 官方文档查询结论

用户要求查询：`https://pi.dev/docs/latest`。

已查询页面：

- `/docs/latest`
- `/docs/latest/extensions`
- `/docs/latest/packages`
- `/docs/latest/rpc`
- `/docs/latest/json`
- `/docs/latest/usage`
- `/docs/latest/settings`
- `/docs/latest/models`
- `/docs/latest/sdk`

也读取了本机安装文档：

- `/home/h/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `packages.md`
- `rpc.md`
- `json.md`

关键结论：

### 8.1 TS extension 源码可以作为 package resource 加载

package manifest 可以写：

```json
"pi": {
  "extensions": ["./src/adapters/pi.ts", "./src/adapters/pi-modes.ts"]
}
```

Pi 会通过 jiti 加载 TS。

所以：

- `dist/index.js` 不含 Pi workflow 不是阻断
- 但 npm `files` 必须包含这些 TS 源码和相对 imports

### 8.2 Pi core 包放 peerDependencies

官方 packages 文档说：

如果 import Pi core packages，应放 peerDependencies，版本 `"*"`，不要 bundle。

相关包：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

当前已加：

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

如后续 import pi-ai/pi-agent-core，也要加。

### 8.3 RPC/JSON CLI 支持 `--model`，没看到 `--agent`

RPC 文档常见 options：

```text
--provider <name>
--model <pattern>
--no-session
--session-dir <path>
```

没有看到 `--agent`。

所以不能依赖 `pi --agent xxx`。

当前正确方向：

- 通过 `--model` 指定子代理模型
- 通过 env `OMO_AGENT_NAME` + pi-modes 在子进程中 setActiveTools
- 通过 prompt/systemPrompt 注入 agent role

### 8.4 RPC mode 支持 `set_model`

也可以通过 RPC 命令切模型：

```json
{"type":"set_model","provider":"...","modelId":"..."}
```

当前用 CLI `--model` 简单可行。

### 8.5 RPC prompt streamingBehavior

如果 agent streaming 时再发送 prompt，需要：

```json
{"type":"prompt", "message":"...", "streamingBehavior":"steer"}
```

或 `followUp`。

当前 pool send 在 busy 时拒绝，是保守策略。未来如果想在运行中插话，可以用 `steer`，但要单独设计。

### 8.6 `setActiveTools` 是官方 API

官方文档明确：

```ts
pi.setActiveTools(active)
```

可动态启用/禁用工具。

所以 pi-modes 根据 JSON tools 设置工具是正确方向。

### 8.7 `before_agent_start` 是官方 system prompt 注入点

官方文档确认可返回：

```ts
{ systemPrompt: event.systemPrompt + "..." }
```

所以恢复 coordinator/mode prompt 注入是正确方向。

### 8.8 后续是否还要继续参考这些链接

当前建议：

- **Pi 官方文档** 仍应继续参考，尤其在处理以下问题时：
  - runtime config / package / peerDependencies
  - RPC/JSON 模式
  - model 选择
  - `setActiveTools`
  - `before_agent_start` / system prompt 注入
- **OpenAI prompt guidance** 已经提炼为当前原则，后续除非专门再做 prompt 策略重构，否则不需要优先重查。

换句话说：

- Pi docs：后续还需要继续参考
- OpenAI prompt guidance：当前可以只保留结论，不必每轮重查

---

## 9. 关于 gate 声明与拦截的客观事实总结

> 这一节只记录这次对话中的实际观察和代码事实，不给优化建议。

### 9.1 这次对话里实际出现过的声明

在分析/设计/实施阶段，工具调用前实际多次出现过这些声明：

- `Intent: ...`
- `READY: ...`
- `APPROVED: ...`
- `ORCHESTRATION: self`
- `CONTINUED: ...`

这些声明主要出现在：

- 读/搜文件前
- 切 mode 前后
- `write` / `edit` 前
- 延续同一任务时

### 9.2 这次对话里实际发生过的 gate 拦截

可见记录中，**明确发生过 1 次拦截**，是 ApprovalGate：

```text
[ApprovalGate] ⚡ 检测到近期的批准记录（第 0 轮）。延续任务？回复开头写 "CONTINUED: <任务名>"，否则写 READY+APPROVED
```

之后补了：

```text
CONTINUED: handover 文档措辞纠正
```

同一个编辑随后成功执行。

### 9.3 这次对话里没有出现的明确拦截

可见记录中，没有出现以下 block message：

- `IntentGate` block
- `ReadinessGate` / `ClarifyGate` block
- `OrchestrationGate` block

因此这次对话里，**实际明确被拦截到的只有 ApprovalGate 一次**。

### 9.4 从本次对话可直接观察到的 gate 行为特点

1. gate 的可见行为主要是在检查声明是否出现。
2. 对 `write` / `edit` 的 gate 检查与这次实际触发的 ApprovalGate 一致。
3. 这次对话里虽然进入了 `implementer` 模式，但后续仍发生了主 agent 直接读写/编辑代码，而不是完全按 implementer prompt 所写流程（先派发 fixer/oracle，再更新 task 状态）推进；这部分偏离实际发生了，但没有在可见层面被 gate 阻止。
4. 因此，这次对话里 gate 的实际效果更接近“声明存在性检查”，而不是完整流程合规性检查。

### 9.5 这次对话中读取到的 gate 代码事实

在本次对话里读取过 `src/adapters/pi.ts` 的 gate 逻辑。可见事实包括：

- `edit` / `write` 前会检查：
  - `READY`
  - `APPROVED`
  - `CONTINUED`
- Orchestration gate 检查的旧工具名是：

```ts
["agent", "workflow", "subagent"]
```

而当前新 workflow 体系实际使用的是：

- `start_workflow`
- `list_workflows`
- `select_branch`
- `send_stage_message`
- `abort_workflow`
- `retry_stage`
- `omo_subagent`

因此从代码字面可见，**旧 gate 检查名与新 workflow 工具名并不完全对应**。

### 9.6 本次对话里关于 gate 的事实总结

1. 后半段对话中多次主动补写了 gate 声明。
2. 实际可见拦截只发生过 1 次，是 ApprovalGate。
3. 该拦截通过补 `CONTINUED:` 后解除。
4. 没有出现 IntentGate / ReadinessGate / OrchestrationGate 的明确 block。
5. 从实际体验看，gate 更像是在做声明存在性检查。
6. 从实际体验看，gate 没有阻止 implementer 流程偏离。
7. 从已读取代码看，部分 gate 检查仍指向旧工具名，而当前 workflow 已使用新工具名。

---

## 10. 用户还问过：子代理调用为什么不是异步持续？

回答要点：

- 我之前调用 oracle 用的是 `omo_subagent` single 模式：

```json
{ "agent": "oracle", "task": "..." }
```

- 这是一次性调用，不持久，不异步。
- 如果要持续，需要：

```json
{ "pool": "spawn", "id": "oracle-review-1", "agent": "oracle", "task": "..." }
```

然后：

```json
{ "pool": "send", "id": "oracle-review-1", "message": "继续..." }
```

- 我当时把 oracle 当作一次性审查器使用，不是底层 bug。
- 但 workflow stage 应该使用 pool，这个已经按方向实现。

---

## 10. 需要更新的计划状态

当前 `docs/oh-my-opencode-slim/plans/index.json` 与各 `task-*.json` 已基本同步到真实状态。

**当前真实状态：**

- Task 1：completed
- Task 2：completed
- Task 3：completed
- Task 4：completed
- Task 5：completed
- Task 6：completed
- Task 7：completed
- Task 8：completed
- Task 9：completed
- Task 10：completed（按本轮计划范围收尾）

但要注意：

- Task 10 completed **不等于所有现实世界尾项都彻底清零**。
- 计划内主线已完成；上节列出的“旧 agent md 同步 / 真实 E2E / Pi 侧重复配置与死代码 / gate 优化 / 已安装 Pi 与仓库同步检查”应视为**下一轮增量收尾主题**。
- 后续若继续推进，请不要把这些剩余工作误记成“本轮已经彻底做完”。

---

## 11. 建议启动 Prompt

下个新对话建议这样开始：

```text
请先完整读取 /home/h/projects/aiprojects/oh-my-opencode-slim/docs/oh-my-opencode-slim/workflow-pool-handover.md。
当前主线代码迁移已基本完成，不要再从最初 P0 重做。
请继续做剩余收尾：
1. 检查已安装 Pi 环境与 oh-my-opencode-slim 仓库实现是否同步；
2. 处理旧用户 ~/.pi/agents/*.md 不自动更新的问题；
3. 设计并执行一轮真实 workflow / chat overlay / hub 的 E2E 验收；
4. 继续检查 Pi 侧重复/分散配置读取逻辑、小死代码、过期说明；
5. 基于 handover 第 9 节 gate 的客观总结，给出优化意见并视情况实现。

注意：
- tools/delegates/model 以 OMO slim JSON 为权威；
- md 不写 tools/thinking；
- 不要用不存在的 --agent；
- context-mode 的目标只是“工具可用”，不要把它扩展成 MCP 提示词注入任务；
- 每个任务完成后跑真实测试并更新 plan/task files；
- 保持本轮对话已经形成的 TDD / oracle审查 / 真实状态更新风格。
```

---

## 12. 最重要的下一步

建议下一轮**第一件事只做一个现实尾项**，不要把所有收尾混在一起。

优先顺序建议：

### 任务 A：检查“已安装 Pi”与仓库实现同步

重点确认：

1. `~/.pi/agent/settings.json` 中 packages/extensions 是否与当前仓库一致
2. `~/.pi/agent/mcp.json` / context-mode 可用性是否稳定，不依赖偶然 PATH
3. 本机 Pi 已安装 agent/prompt/runtime 配置是否仍有旧副本

### 任务 B：解决旧用户 `agent.md` 同步问题

重点确认：

1. `ensureAgentFiles()` 当前只复制不存在文件
2. 已有 `~/.pi/agents/*.md` 时，是否继续跑旧 prompt
3. 决定实现方式：
   - 覆盖同步
   - 版本戳同步
   - 专门 sync 命令
   - 或明确检测并提示用户刷新

### 任务 C：补真实 E2E 验收

至少验收：

1. `start_workflow`
2. stage 真正运行
3. `workflow_status`
4. `send_stage_message`
5. chat overlay / hub 注册和输入路由
6. `abort_workflow` / `retry_stage`

### 任务 D：继续做 Pi 侧重复配置/死代码检查

重点看：

1. `pi.ts`
2. `pi-modes.ts`
3. `workflow-commands.ts`
4. `subagent-pool.ts`
5. 任何仍分散/重复读取 config 的位置

### 任务 E：gate 优化意见与实现

第 9 节目前主要是客观总结，不是最终优化方案；应补：

1. 这些 gate 现在的真实不足
2. 新 workflow 工具名与旧 gate 检查名不一致的问题
3. 是否继续保留“声明存在性检查”模式
4. 如果要优化，应怎么测、怎么分阶段做

---

## 13. 不要忘记

- 不要继续盲目添加硬编码
- 不要把工具写进 md
- 不要用 `--agent`
- 不要把 typecheck 当完整测试
- 不要说审查通过，除非真的委托 oracle 审查并记录结果
- 不要忽略 oracle 的阻断反馈
- 不要马上删 opencode legacy
- 不要把“计划内主线完成”误说成“环境/E2E/旧文件同步也全部闭环”
- context-mode 只要求**工具可用**，不要把它扩展成 MCP 提示词注入任务
- 继续保持当前风格：TDD、真实测试、按真实状态更新 plan/task、必要时用 fixer/oracle 辅助
- 大改前先重新核对本文件中的剩余尾项，而不是机械回到最早那批 P0
