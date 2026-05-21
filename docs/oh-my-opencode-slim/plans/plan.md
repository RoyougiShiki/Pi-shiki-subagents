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

1. 持续运行真实验证：
   - `bun test` 相关集合
   - `bun run typecheck`
   - `bun run generate-schema`
   - `bun run build:plugin`
   - `bun run verify:release`
2. 清理确认无用的 Pi workflow 侧旧说明/小死代码
3. 避免保留会误导后续交接的过期计划表述
4. 视需要更新 codemap，使其反映当前 architecture

## 注意

- 不要再把本文件当作“尚未实施”的原始待办清单
- 继续实施时，以 `task-*.json` 的真实状态和验证记录为准
- 不纳入 `opencode legacy` 范围的清理仍保持不动，除非用户明确要求
