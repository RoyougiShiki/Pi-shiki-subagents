---
name: resume-plan
description: 执行已有的计划任务。触发条件：用户说"继续开发"、"继续任务"、"继续"，或计划已准备好待执行。
---

# Resume Plan

## Overview

执行已有的计划任务。可恢复中断的计划，或直接执行准备好的计划。

**Core principle:** Scan → Match → Resume

## 参考文档

执行过程中需要的参考文档位于 `../brainstorming/references/` 目录（与本技能平行的 brainstorming 技能下）：

- `executing-plans.md` - 执行计划（批次间反馈）
- `subagent-workflow.md` - 子代理驱动执行
- `tdd.md` - TDD 流程
- `safe-workspace.md` - 工作空间保护
- `code-review.md` - 代码审查
- `finishing-branch.md` - 完成分支处理

## When to Use

- 用户说"继续"、"继续任务"、"继续开发"、"resume"
- 用户说"执行计划"、"执行 feature-a"
- 用户指定计划名"继续 feature-a"

## 任务状态模型

**状态流转：**
```
pending → implemented → spec_reviewed → completed
              ↑              ↑
              └── 审查不通过回退 ──┘
```

**状态说明：**

| 状态 | 含义 | 恢复动作 |
|------|------|----------|
| `pending` | 待开始 | 开始实现 |
| `implemented` | 已实现（代码已提交） | 开始规格审查 |
| `spec_reviewed` | 已过规格审查 | 开始质量审查 |
| `completed` | 已完成 | 跳过此任务 |

## The Process

### Step 1: 扫描计划目录

扫描 `docs/plans/*/index.json`，找到所有包含 `index.json` 的计划目录。

### Step 2: 筛选未完成的计划

读取每个 `index.json`，筛选 `status` 不为 `completed` 的计划。

如果没有找到，告知用户：
```
未找到进行中的计划。

可能原因：
- 所有计划已完成
- 尚未使用 extract-tasks 生成任务文件
```

### Step 3: 匹配用户输入

- **用户指定计划名** → 在 planId 中匹配，直接定位
- **用户未指定** → 列出所有未完成计划供选择

列出格式：
```
发现 N 个未完成的计划：

1. feature-a (3/5 完成, 更新于 2026-02-17)
2. feature-b (1/3 完成, 更新于 2026-02-16)

请选择要继续的计划（输入编号或名称）：
```

### Step 4: 展示进度 + 选择执行方式

展示当前进度并让用户选择执行方式：
1. 子代理驱动（当前会话）- 为每个任务分配新的子代理
2. 批次执行（当前会话）- 批量执行，批次间等待反馈

### Step 5: 根据状态恢复执行

- **pending** → 开始实现，完成后更新为 `implemented`
- **implemented** → 直接开始规格审查（通过 → `spec_reviewed`，不通过 → 回退，修复后重新审查）
- **spec_reviewed** → 直接开始质量审查（通过 → `completed`，不通过 → 回退 `implemented`）
- **completed** → 跳过

### Step 6: 执行对应流程

选择 1 → 按 subagent-driven-development 执行
选择 2 → 按 batch execution 执行

## Red Flags

**Never:**
- 恢复 status 为 completed 的计划
- 在没有 index.json 时尝试恢复
- 跳过用户选择执行方式的步骤
- 忽略任务的当前状态
