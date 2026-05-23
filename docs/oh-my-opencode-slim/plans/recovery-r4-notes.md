# Recovery R4 Notes

## 已恢复（最小收口）

- hard gate 保持移除
- `[Behavior Reminders]` 不再通过 context 注入污染模型上下文
- 可选 `compliance_check` 的提醒改为主会话 UI 通知 + 状态栏
- 不再通过 `sendUserMessage(... followUp)` 把行为提醒写进主 agent 对话

## 已修改文件

- `src/adapters/pi.ts`

## 当前验证

- `bun test src/adapters/pi.test.ts src/adapters/workflow-manager.test.ts src/adapters/workflow-chat-binding.test.ts src/adapters/pi-hub.test.ts src/adapters/subagent-pool.test.ts src/adapters/chat-status-view.test.ts` PASS（63 pass）
- `bun run typecheck` PASS
- `bun run build:plugin` PASS

## 仍待后续增强

- 水位检测本身（阈值/信号源）
- 行为规范提示与完成许可通知统一
- 最终“主 agent 可见但不污染上下文”的通知通道确认
