# Recovery Next Steps

> 当前会话收束版任务清单。用于从“确认正确旧设计”进入“按顺序恢复实现”，避免再次丢失上下文。

## 1. 已确认必须持续记录

- P2 已完成部分后续如果有修改/兼容调整，继续写回：
  - `docs/oh-my-opencode-slim/plans/chat-observability-ux/`
- 本轮恢复过程继续写回：
  - `docs/oh-my-opencode-slim/plans/recovery-baseline.md`
  - `docs/oh-my-opencode-slim/plans/recovery-matrix.md`
- 恢复完成后，清理恢复专用临时文件，或合并回正式 handover。

## 2. 当前执行顺序

1. 恢复 stage runtime tool 协议
2. 恢复审批 / continueWorkflow 边界
3. 恢复主会话非污染通知与 workflow chat 行为
4. 恢复 water-level / behavior reminders
5. 最后重建 handover 稳定状态段并清理 recovery 临时文件

## 3. 当前不再需要重新讨论的确认点

- 子代理不能通过 JSON 文本完成 workflow 协议。
- 子代理必须通过 runtime tool 提问/申请完成。
- stage 不能直接推进 workflow。
- 用户同意后，主 agent 才 `continue_workflow`。
- workflow stage 不应强制 auto-open chat overlay。
- 主会话通知必须尽量不污染主 agent 上下文。
- hard gate 应移除，只保留非阻断行为提醒/水位检测。

## 4. 完成判定

恢复完成至少需要同时满足：

- workflow stage 不再输出/展示 raw JSON；
- workflow 不自动跨阶段；
- transition approval 主会话可见，用户批准后才继续；
- needs_user 与 transition_approval 行为分离；
- workflow stage 不强制 auto-open overlay；
- `/chat` workflow 场景验收通过；
- hard gate 不再阻断；
- behavior/water-level 提醒是非阻断通知；
- handover 稳定状态重新与源码一致。
