---
name: resume-plan
description: 执行已有的计划任务。触发条件：用户说"继续开发"、"继续任务"、"继续"，或计划已准备好待执行。
---

# Resume Plan

## Overview

执行已有的计划任务。可恢复中断的计划，或直接执行准备好的计划。

**Core principle:** Scan → Match → Resume

## When to Use

- 用户说"继续"、"继续任务"、"继续开发"、"resume"
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
```

### Step 3: 匹配用户输入

- **用户指定计划名** → 在 planId 中匹配
- **用户未指定** → 列出所有未完成计划供选择

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
