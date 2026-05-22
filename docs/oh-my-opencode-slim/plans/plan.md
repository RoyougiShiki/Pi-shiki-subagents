---
source: direct
requirementDoc: null
---

# Workflow Pool 持久化与职责隔离迁移计划

## 当前状态

本轮 Pi workflow / agent 职责隔离迁移的主功能实现已基本完成，当前计划状态以 `docs/oh-my-opencode-slim/plans/index.json` 与各 `task-*.json` 为准。

当前已完成：

- Task 1: agent discovery / agent frontmatter
- Task 2: WorkflowManager 真实 pool stage
- Task 3: StageOutput parse/repair/needs_user/failed 处理
- Task 4: workflow stage 与 Chat overlay / hub 接通
- Task 5: workflow 控制工具与错误可观察性
- Task 6: delegation matrix / 最大两层 / allowedSubagents
- Task 7: prompt 精简与职责去重
- Task 8: 工具权限收紧与默认配置同步
- Task 9: 默认 workflows 扩展

当前剩余：

- Task 10: 验证、codemap 与清理收尾

## 已落地架构

- `WorkflowManager` 使用真实 `resolveAgent(...)` + `pool.spawn(...)` 运行 stage
- stage 会话通过 pool 持久化，支持 `needs_user` 多轮交互
- `StageOutput` 经过 parse / validate / repair 处理
- `workflow_status` 暴露 `lastError` / `lastEvent`
- `allowedSubagents` 已从 schema/types 打通到 runtime delegation check
- `tools / delegates / model / thinking / blocked` 以 OMO slim JSON runtime config 为权威
- agent markdown frontmatter 只保留 `name` / `description`
- `DEFAULT_WORKFLOWS` 已包含：
  - `standard-dev`
  - `quick-fix`
  - `batch-dev`
  - `review-only`
  - `research-only`

## 当前收尾重点（Task 10）

已完成的最新收尾：

1. Pi adapter runtime config 已统一复用 shared config loader，并保留 Pi native config 作为 fallback。
2. 旧 `~/.pi/agents/*.md` 同步机制已实现：managed metadata、stale 更新、legacy OMO md 迁移、旧英文 OMO-generated prompt 迁移、自定义 md 保护、迁移后刷新 in-memory `AGENT_PROMPTS`。
3. agent markdown frontmatter 保持 `name` / `description` / OMO managed metadata，不写 tools/model/thinking。
4. `oracle` 模型已在 OMO slim JSON 配置中设为 `dmxapi/gpt-5.5`，模型链路由 JSON → agent discovery → subagent pool `pi --model` 生效。
5. 全量验证已通过：reload 漂移修复后 `bun test` 1068 pass / 0 fail；`bun run typecheck` 通过；oracle 复审 no blockers。

仍待用户再次 reload 后做真实 E2E：

1. `start_workflow` / `workflow_status` / `send_stage_message`
2. workflow stage pool spawn 与 StageOutput 传递
3. chat overlay / hub 注册和输入路由
4. `abort_workflow` / `retry_stage`
5. 确认真实 oracle 子代理使用 `dmxapi/gpt-5.5`

后续非阻塞小债：gate 优化、`buildPiOrchestratorPrompt` 旧/死代码、agent md 备份策略、日志级别、`OmniMoConfig` 类型收敛。

## 注意

- 不要再把本文件当作“尚未实施”的原始待办清单
- 继续实施时，以 `task-*.json` 的真实状态和验证记录为准
- 不纳入 `opencode legacy` 范围的清理仍保持不动，除非用户明确要求
