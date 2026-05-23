# Recovery R2 Notes

## 已恢复

- `transition_approval` stage event
- `workflow_complete` event
- `transitionPending` / `pendingEvents`
- `continueWorkflow()`
- `continue_workflow` tool
- `status().transition`
- stage complete 后默认不自动跨阶段
- coordinator 工具列表补回 `continue_workflow`

## 已修改文件

- `src/core/workflow-types.ts`
- `src/adapters/workflow-manager.ts`
- `src/adapters/workflow-manager.test.ts`
- `src/adapters/workflow-commands.ts`
- `src/adapters/agents-default.json`

## 当前验证

- `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
- `bun run typecheck` PASS
- `bun run build:plugin` PASS

## 尚未恢复

- transition approval 的主会话非污染通知
- workflow stage auto-open overlay 禁止
- raw JSON / tool noise 抑制
- workflow stage completed vs dead 显示
- water-level / behavior reminders 通知化
