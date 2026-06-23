# Handoff — Quality-Driven Harness Merge v2（第一批完成，第二批已落地待最终验收）

> 日期：2026-06-18
> 分支：`refactor/mode-first-stabilization`
> 方案文档：`docs/oh-my-opencode-slim/plans/quality-driven-harness-merge/proposal-v2.md`
> 工作区状态：未提交，包含第一批成果与第二批本轮改动。

## 当前进度

| 批次 | 范围 | 状态 |
|---|---|---|
| 第一批 H1-H7 + #15-#18 | harness 地基与旧 agent 清理 | 已完成 |
| 第二批 b2-1 至 b2-9 | grill、plan 主控化、designer/research-only 删除、oracle 有界 review loop、Iron Law、dispatcher 模板、WHAT/HOW 注入 | 已完成 |
| 第二批 b2-10 | 文档更新 + 验收 | 进行中 |

已通过：
- `bun run typecheck`
- 相关测试集：`workflow-stage-runtime`、`subagent-pool-notice-bridge`、`workflows-and-tools`、`utils`、`subagent-tool`、`tool-call-gates`（79 pass）

仍需最终跑：
- `bun test`
- `bun run build`

## 本轮第二批已完成项

### b2-1 analysis stage 主控化
- `standard-dev` analysis stage 指向 `standard-dev`。
- `quick-fix` 新增 `analysis` stage，主控为 `quick-fix`，只允许 `search` 辅助。

### b2-2 grill 规则注入
- `standard-dev.md` 和 `quick-fix.md` 增加一次一问、推荐答案、能查代码就不问人的规则。

### b2-3 去重与 AvailableAgents 去后缀
- `buildPiOrchestratorPrompt` 不再给 `<AvailableAgents>` 追加“非阶段可委托”静态后缀。

### b2-4 research-only 合并删除
- 删除 `research-only.md`。
- 删除默认 `research-only` workflow 与 `agents-default.json` 条目。
- 源码/测试默认路径中已无 `research-only` 命中。

### b2-5 designer 删除 + plan 阶段主控化
- 删除 `designer.md`。
- `standard-dev` 的 `plan` stage 从 `designer` 改为 `standard-dev`。
- `agents-default.json` 删除 designer 条目和 fallback delegates 中的 designer。
- `constants.ts`、`delegation-rules.ts`、`managed-agent-files.ts` 清理 designer/observer/research-only 相关默认残留。
- `standard-dev.md` 增加 plan 阶段路径：计划、TDD/验证路径、CONTEXT.md/ADR 沉淀规则。

### b2-6 oracle 有界对抗循环
- `StageNode`/schema 新增 `maxReviewRounds`。
- 默认配置：`standard-dev` implement stage 为 3，`quick-fix` fix stage 为 1。
- `workflow-stage-runtime.ts` 新增 review loop 状态与 `recordReviewVerdict`，按 `poolId` 绑定审查 attempt；阶段推进/恢复会清空旧 review loop 与 active attempts；exhausted 状态在阶段重置前保持 sticky。
- `subagent-pool-notice-bridge.ts` 在 oracle 完成通知中展示 VERDICT、轮次、未超限返工建议或超限用户裁决提示。
- `pi.ts` 复用 `getVerdictStatus` 解析 oracle `VERDICT: PASS|FAIL|PARTIAL`，只在 oracle 完成事件匹配当前阶段已登记 `poolId` 时写入 stage runtime。
- 非 PASS 且未超限时，`tool-call-gates.ts` 阻止进入下一阶段或不相关 pipeline spawn，要求继续当前阶段返工/复审。
- 超出轮次后，`tool-call-gates.ts` 阻止 pipeline spawn；`subagent-tool.ts` 阻止 pool session 的 send/resume 并要求用户裁决。

### b2-7 Iron Law
- `fixer.md` 增加 TDD 铁律与 spirit-over-letter 收口。
- `dispatcher.md` 增加 TDD 铁律与 spirit-over-letter 收口。
- `oracle.md` 增加独立验证者规则、VERDICT 协议与 spirit-over-letter 收口。

### b2-8 dispatcher 四要素
- `dispatcher.md` 增加 Scope / Context / Constraints / Output 模板。
- 明确子代理不继承主 session 上下文。

### b2-9 优先级声明 + WHAT != HOW
- `<ModeWorkflows>` 注入优先级声明：用户决定 WHAT，workflow 决定 HOW；用户要求做 X 不等于可以跳过 workflow、审批或验证。

## 关键改动文件

- `src/config/workflow-defaults.ts`
- `src/config/workflow-types.ts`
- `src/config/schema.ts`
- `src/adapters/agents-default.json`
- `src/adapters/agents/standard-dev.md`
- `src/adapters/agents/quick-fix.md`
- `src/adapters/agents/dispatcher.md`
- `src/adapters/agents/fixer.md`
- `src/adapters/agents/oracle.md`
- `src/pi/core/pi.ts`
- `src/pi/policy/workflow-stage-runtime.ts`
- `src/pi/policy/tool-call-gates.ts`
- `src/pi/subagent/subagent-pool-notice-bridge.ts`
- `src/pi/subagent/subagent-tool.ts`

## 后续建议

1. 跑全量 `bun test`。
2. 跑 `bun run build`。
3. 如全绿，建议提交当前第一批+第二批成果作为稳定检查点。
