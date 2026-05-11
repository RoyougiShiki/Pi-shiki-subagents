# Subagent-Driven Development

> 参考文档，全自动执行，不需要人类交互。

## 核心流程

准备阶段 → 循环执行任务（实现 → 并行派发规格/质量审查 + 规格门禁）→ 最终审查

## 准备阶段（必须）

1. **确认 index.json 存在** → 不存在则先执行 extract-tasks 流程
2. **读取 index.json**（仅 goal + task 列表 + 状态）
3. **创建 TodoWrite** 追踪任务

## 任务执行循环

```
更新 index.json 为 implemented
    ↓
派发实现者 subagent（传递 plan_folder 和 task_id）
    ↓
回答问题（如有）→ 实现/测试/提交
    ↓
并行派发：@oracle 规格审查 + @oracle 质量审查（质量结果先暂存）
    ↓
等待规格审查结果（优先门禁）
    ↓
规格不通过 → 立即结束本轮，回退到 implemented 修复，再次并行审查
    ↓
规格通过 → 更新为 spec_reviewed，采纳质量审查结果
    ↓
质量不通过 → 回退到 implemented 修复，再次审查；通过 → 更新为 completed
    ↓
下一任务
```

### 并行审查门禁规则（必须）

1. 规格审查是**硬门禁**；质量审查不是门禁入口。
2. 质量审查可与规格审查并行启动，派发 `@oracle` 执行，但结果在规格通过前仅为 **provisional（暂存）**。
3. 规格审查派发 `@oracle` 执行，一旦失败主 Agent **立即短路**当前轮次并进入修复，不等待质量审查返回。
4. 下一轮修复后，必须重新并行派发两类审查，旧的 provisional 质量结果作废。

## 状态流转规则

| 状态 | 含义 | 更新时机 |
|------|------|----------|
| `pending` | 待开始 | 初始 |
| `implemented` | 已实现 | 代码完成并提交后 |
| `spec_reviewed` | 已过规格审查 | 规格审查通过后 |
| `completed` | 已完成 | 质量审查通过后 |

**审查不通过 → 回退到 `implemented` 重新修复 → 再次审查**

## 主 Agent 约束

### 允许
- 读取 `docs/plans/{folder}/index.json`
- 创建/更新 TodoWrite
- 派发 `plan_folder` 和 `task_id` 给实现者 subagent
- 派发 `@oracle` 进行规格审查，派发 `@oracle` 进行质量审查
- **更新 index.json 状态（必须同步）**

### 禁止
- 读取 plan.md 或 task-*.json
- 直接修改代码文件
- 并行派发多个实现者（会冲突）

## Subagent 约束

收到 `plan_folder` 和 `task_id` 后：
1. 读取 `task-{task_id}.json` 获取任务详情
2. 按需读取相关代码文件
3. **禁止**读取 plan.md 或 index.json

## 更新 task.json

Subagent 完成后报告格式：
```
任务完成报告：
修改文件:
- 创建: [文件列表]
- 修改: [文件列表]
- 删除: [文件列表]
测试: [结果]
提交: [commit hash]
```

主 Agent 收到后更新 `task-{id}.json`：
```json
{
  "id": 1,
  "title": "...",
  "files": {
    "created": ["实际文件"],
    "modified": ["实际文件"],
    "deleted": ["实际文件"]
  },
  "status": "completed"
}
```

**无 VCS 项目：** 子代理报告要修改文件时，主 Agent 先创建快照到 `.snapshots/task-{id}/`

## 唯一出口

<HARD-GATE>
所有任务完成后，**必须按照 `finishing-branch.md` 执行完成流程**。
</HARD-GATE>

## Red Flags

**严禁：**
- 跳过 extract-tasks（index.json 不存在时）
- 忘记更新 index.json 状态
- 跳过审查或审查循环
- 将质量审查结果在规格通过前当作最终结论
- 规格审查失败后仍等待质量审查结束才进入修复
- 并行派发多个实现者 subagent（会冲突）
- 用自审查替代正式审查
- 忽略 subagent 的提问
