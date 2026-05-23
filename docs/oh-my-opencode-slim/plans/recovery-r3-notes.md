# Recovery R3 Notes

## 已恢复

- workflow stage `message` 不再触发 `autoOpenChat`
- `waiting_user` 改走主会话 `notify` + `setStatus`
- `transition_approval` 改走主会话 `notify` + `setStatus`
- `workflow_complete` 改走主会话通知并清状态
- workflow chat 已完成状态不会被 process close 覆盖成 `dead`

## 已修改文件

- `src/adapters/pi-hub.ts`
- `src/adapters/workflow-chat-binding.ts`
- `src/adapters/workflow-chat-binding.test.ts`
- `src/adapters/pi.ts`

## 当前验证

- `bun test src/adapters/workflow-manager.test.ts src/adapters/subagent-pool.test.ts src/adapters/pi.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
- `bun run typecheck` PASS
- `bun run build:plugin` PASS

## 仍待真实验收

- workflow stage 不再强制弹出 overlay
- 主会话通知是否符合旧设计（用户可见、主 agent 不被污染）
- workflow `/chat` 场景是否不再显示 raw JSON / tool noise
