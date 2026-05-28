import type { WorkflowStageToolResult } from "../../core/workflow-types";

// Single-slot stage result store.
let _result: WorkflowStageToolResult | undefined;

export function setStageResult(result: WorkflowStageToolResult): void {
  _result = result;
}

export function getStageResult(): WorkflowStageToolResult | undefined {
  return _result;
}

export function clearStageResult(): void {
  _result = undefined;
}

// Shared stage output format — used by buildStageTask (subagent prompt) and
// runAutoReview (oracle review prompt).  Edit once, both stay in sync.
export const STAGE_OUTPUT_FORMAT = `When done, include a structured summary at the end of your reply:

## 任务与目标
（本阶段的原始指令与成功标准）

## 关键决策
- 主要决策及理由
- 考虑过但被否决的方案

## 产出清单
- 文件路径 | 操作（创建/修改/删除） | 变更摘要
- ...

## 当前状态
- 完成度：全部完成 / 部分完成
- 待确认事项：（如有）
- 建议下一步：（如有）

## 验收证据
- 凭什么说完成？分析了哪些文件？关键发现是什么？
- 做了什么决策？依据是什么？
-（如涉及产出）测试是否通过？结果是什么？

## 传递给下一阶段
- 用户偏好、约束条件
- 需要下一阶段知道的上下文

---

## 停止条件
以下情况必须立即停下来等待用户指示：
- 任务描述存在歧义或不完整
- 需要用户决策才能继续（如方案选择、范围确认）
- 遇到预期之外的错误或阻塞
- 发现任务可能需要偏离原定范围

处理方式：在回复中明确说明停下的原因、当前进度、以及需要用户决定的问题。`;

export const STAGE_REVIEW_FORMAT = `Output format requirements (check for completeness):
- ## 任务与目标  — required
- ## 关键决策  — required
- ## 产出清单  — required
- ## 当前状态  — required, must include 完成度
- ## 验收证据  — required, missing = REJECT
- ## 传递给下一阶段  — required
- ## 停止条件  — check if any unaddressed blockers

Missing any required section → REJECT.
验收证据 insufficient → REJECT.`;
