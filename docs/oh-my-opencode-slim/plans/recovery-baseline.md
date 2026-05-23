# Workflow / Chat / Gate 恢复基线

> 2026-05-23 记录。当前确认存在多项已完成设计/实现回退。本文只记录用户确认过的正确行为、当前异常表现与恢复边界，作为后续恢复依据。

## 0. 当前总判断

当前问题不是单个 `/chat` UX bug，而是多项已完成的 workflow / chat / gate 设计整体回退或丢失。

已确认需要按“恢复已完成设计”处理，而不是重新发明新方案。

## 1. 已确认的正确旧设计

### 1.1 子代理不能通过 JSON 文本完成 workflow 协议

正确行为：

- workflow stage 子代理不能输出 JSON 文本来提问或完成阶段。
- workflow manager 不能依赖模型普通文本 JSON 来推进。
- 用户不应该看到 StageOutput JSON。
- 子代理必须通过 runtime tool 来提问或申请完成。

错误行为：

- 子代理输出 `{ "status": "complete", ... }`。
- chat overlay 展示这段 JSON。
- workflow manager parse/repair 普通文本 JSON。

### 1.2 子代理通过工具提问或申请完成

正确行为：

- 子代理需要用户输入时，调用 stage ask-user 类工具。
- 子代理认为阶段可完成时，调用 stage complete / request-complete 类工具。
- 工具走结构化通道，不走普通 assistant 文本协议。

### 1.3 stage 不能直接推进 workflow

正确行为：

- 子代理不能自己让 workflow 自动进入下一阶段。
- 子代理只能申请完成 / 请求完成许可。
- 主 agent 和用户都应知道这个申请。
- 用户同意后，由主 agent 调用 `continue_workflow`。
- 之后 workflow 才进入下一 stage。

错误行为：

- stage complete 后 workflow 自动进入下一 stage。

### 1.4 不应强制弹出 chat overlay

正确行为：

- workflow stage 不应强制打开 chat overlay 打断用户。
- 之前已经实现过一种主会话 UI 通知机制：
  - 通知用户 chat 有 agent 提问或申请完成；
  - 不让主 agent 感知具体正文；
  - 不污染主 agent conversation context；
  - 替代强制 auto-open overlay。

错误行为：

- workflow stage message 触发 `autoOpenChat`。
- overlay 自动弹出并展示内部内容。

### 1.5 gate hard block 应已移除

正确行为：

- IntentGate / ReadinessGate / ApprovalGate / OrchestrationGate 这类 hard block 不应存在。
- 剩余机制应是：
  - 水位检测；
  - 行为规范提示；
  - 非阻断；
  - 不通过拦截工具调用实现。

更准确的通知方式：

- 类似“子代理申请完成许可”的通知机制。
- 检测到行为水位低或需要提醒时，通过 UI/通知机制告知主 agent。
- 不阻断工具调用。
- 不污染主 agent context。
- 不只是简单注入 system/context reminder。

补充说明（用户确认）：

- 行为规范/水位检测的提示方式，应尽量复用 workflow 已有的通知思路：
  - 主会话可见；
  - 主 agent 被提醒；
  - 但不把提示正文当成普通用户输入塞进主 agent 对话上下文。
- 若实现上需要主动提示，应优先考虑主会话 UI 通知 / 状态更新 / 非会话正文消息，而不是：
  - tool_call hard block；
  - 强制弹 overlay；
  - 普通文本注入主 agent 对话。
- 上一主 session 也记录过相关顾虑：`pi.sendMessage({ triggerTurn: true })` 的通知可能污染主 agent 上下文，因此 gate/水位提示的最终实现必须把“可见通知”与“上下文污染”分离。
### 1.6 `/chat` 的正确定位

正确行为：

- `/chat` 对象是子代理 / pool agent 会话，不是 workflow 本身。
- `/chat` 用于用户主动进入查看或交流。
- `/chat` 可显示轻量状态：
  - `Workflow  thinker-analysis · working · 00:10`
  - `Pool  p2-chat-reload-check · idle · 01:56`
- 进入后底部显示：
  - `thinker-analysis · working · workflow`
  - `p2-chat-reload-check · idle · pool`

错误行为：

- workflow 主动强制弹出 `/chat` overlay。
- `/chat` 展示 workflow 内部 JSON。

## 2. 当前已观察到的异常

### 2.1 StageOutput JSON 裸露

验收时出现：

```json
{
  "status": "complete",
  "summary": "...",
  "context": "...",
  "artifacts": { ... },
  "openQuestions": []
}
```

这不应显示给用户。

### 2.2 chat overlay 被强制弹出

workflow stage 有 message 时自动弹出 overlay。用户没有主动进入 `/chat`，仍被打断。

### 2.3 workflow 自动进入下一 stage

`thinker-clarify` 完成后直接出现 `thinker-analysis · working`。这不符合“申请完成 → 用户同意 → 主 agent continue_workflow”的边界。

### 2.4 completed stage 在 `/chat` 中显示为 dead

`thinker-clarify` 显示为：

```text
Workflow  thinker-clarify · dead · 00:22
```

完成阶段不应被用户理解为异常死亡；应区分 completed/done 与 process dead。

### 2.5 hard gate 曾重新拦截 fallback 实施

本轮出现过：

- IntentGate block
- ReadinessGate block
- ApprovalGate block

这说明 hard gate 残留曾重新影响实现流程。当前工作区已补删并提交，但需作为回退异常记录。

### 2.6 handover 稳定状态段丢失

context-mode 记忆里存在更晚版本：

- `2026-05-23 当前稳定状态`
- runtime stage tool + IPC result file
- hard gate removed
- 非阻断 runtime instruction

当前磁盘 `workflow-pool-handover.md` 只有 1267 行，缺失该尾部稳定状态。

### 2.7 workflow 主链路表现回退到旧协议

当前表现与正确旧设计冲突：

- 子代理输出 JSON 文本；
- workflow 解析文本；
- JSON 被 overlay 展示；
- stage 自动推进。

## 3. 当前已保护提交

已做保护性提交，防止本轮 P2 / gate 修复再次丢失：

```text
d218f33 fix(pi): stabilize chat observability and remove hard gates
```

该提交包括：

- `/chat` pool 场景分组短状态；
- 底部短状态；
- hard gate 移除；
- chat status view 纯数据层；
- P2/P1 计划记录。

未提交的可疑项：

- `D docs/oh-my-opencode-slim/handover.md`

## 4. 后续恢复优先级建议

### P0：恢复 workflow runtime tool 协议

目标：

- 子代理通过工具提问/申请完成；
- 不再依赖 JSON 文本；
- StageOutput 不进入 chat message；
- workflow manager 读取结构化结果。

### P1：恢复完成许可边界

目标：

- stage 申请完成；
- 主会话通知主 agent/用户；
- 用户同意后主 agent 调 `continue_workflow`；
- workflow 不自动推进。

### P2：恢复非污染 UI 通知

目标：

- agent 提问通知；
- agent 申请完成通知；
- gate 水位提示通知；
- 不 auto-open overlay；
- 不污染主 agent context。

对 gate/水位提示的附加要求：

- 可以让主 agent “知道发生了提醒”，但不能让提醒正文变成普通对话上下文的一部分。
- 行为规范提示与完成许可通知应尽量统一成一套主会话 UI 机制，而不是两套不同的打断模型。
- 若必须在技术上使用 `sendMessage` 或类似主动推送机制，需要进一步确认其在主 agent prompt 中的可见性与角色归类，避免再次出现“通知进入上下文”的副作用。

### P3：修复 `/chat` workflow 场景

目标：

- workflow stage 可在 `/chat` 列表中可观测；
- 不显示内部 JSON；
- 不把完成 stage 显示成异常 dead。

### P4：恢复/重写 handover 稳定状态

目标：

- 恢复丢失的稳定状态段；
- 明确哪些是已恢复，哪些仍待恢复；
- 避免后续再次基于过期 handover 推进。

## 5. 禁止事项

- 不要把普通文本 JSON 重新作为 workflow stage 正常协议。
- 不要强制 auto-open chat overlay。
- 不要让 stage 自动推进 workflow。
- 不要用 hard gate 拦截工具调用。
- 不要把 workflow stage 内部正文注入主 agent conversation context。
- 不要在未恢复基线前继续推进 P3/P4 新功能。
