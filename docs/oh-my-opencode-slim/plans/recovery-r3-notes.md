# Recovery R3 Notes

## 已恢复

- workflow stage `message` 不再触发 `autoOpenChat`
- `waiting_user` 改走主会话 `notify` + `setStatus`
- `transition_approval` 改走主会话 `sendAgentMessage`（触发主 agent）
- `workflow_complete` 改走主会话通知并清状态
- workflow chat 已完成状态不会被 process close 覆盖成 `dead`
- `transition_approval` → 主 agent 主动提问是否批准
- `reject_transition` 工具 → 拒绝完成申请，回到 waiting_user
- `error`（不调工具/两次失败）→ 触发主 agent

## 通知路由

| 事件 | 路径 | 谁看到 |
|------|------|--------|
| `waiting_user` | `notify` → UI toast | 用户（去 chat 回复）|
| `transition_approval` | `pi.sendMessage({customType})` `→ deliverAs: 'followUp', triggerTurn: true` | 主 agent 感知 |
| `error` | `pi.sendMessage({customType})` `→ deliverAs: 'followUp', triggerTurn: true` | 主 agent 感知 |
| `workflow_complete` | `pi.sendMessage({customType})` `→ deliverAs: 'followUp', triggerTurn: true` | 主 agent 感知 |

## 已修改文件

- `src/adapters/workflow-chat-binding.ts`
- `src/adapters/workflow-chat-binding.test.ts`
- `src/adapters/pi.ts`
- `src/adapters/workflow-commands.ts`
- `src/adapters/workflow-manager.ts`
- `src/adapters/workflow-manager.test.ts`
- `src/adapters/subagent-pool.ts`
- `src/adapters/agents/*.md`（6 个 stage agent prompt）

## 当前验证

- `bun test src/adapters/` PASS（84 pass）
- `bun run typecheck` PASS
- `bun run build:plugin` PASS
