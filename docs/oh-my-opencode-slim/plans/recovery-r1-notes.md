# Recovery R1 Notes

## 已恢复

- `stage_complete`
- `stage_ask_user`
- `writeWorkflowStageResult()`
- `OMO_STAGE_RESULT_PATH`
- `buildSubagentEnv(... stageResultPath)`
- `WorkflowManager` 只读 stage result file
- 缺失 stage tool 报错：`Stage did not call stage_complete or stage_ask_user`

## 已修改文件

- `src/core/workflow-types.ts`
- `src/adapters/subagent-pool.ts`
- `src/adapters/workflow-manager.ts`
- `src/adapters/workflow-manager.test.ts`
- `src/adapters/pi.ts`
- `src/adapters/pi.test.ts`
- `src/adapters/subagent-pool.test.ts`
- `src/adapters/agents-default.json`

## 当前验证

- `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
- `bun run typecheck` PASS
- `bun run build:plugin` PASS

## 尚未恢复

- transition approval / continueWorkflow 边界
- pending event / inbox
- 主会话非污染通知
- 禁止 workflow stage auto-open overlay
- raw JSON/tool noise 抑制
- workflow stage completed vs dead 状态
- water-level / behavior reminders 通知化
