# Extract Tasks

> 参考文档，由 writing-plans 自动调用，最后询问执行方式。

## 核心流程

读取 plan.md → 提取任务 → 创建 index.json + task-*.json → 更新关联文档 → 询问执行方式

## 执行步骤

### Step 1: 读取计划文档

- 读取 `docs/{project-name}/plans/plan.md` 全文
- 如果是单独的 `.md` 文件，创建同名目录并移入
- 读取 frontmatter 中的 `source` 和 `requirementDoc` 字段

### Step 2: 提取任务

识别 `### Task N:` 格式，提取：
- id、title、files、steps

### Step 3: 分析 Context

每个任务分析：
- 整体定位、依赖关系、架构背景（1-3 句话）

### Step 4: 创建 index.json

```json
{
  "planId": "...",
  "sourcePlan": "plan.md",
  "source": "specproductdesign|direct",
  "requirementDoc": "docs/{project-name}/requirement/|null",
  "goal": "...",
  "status": "pending",
  "createdAt": "...",
  "updatedAt": "...",
  "tasks": [{ "id": 1, "title": "...", "status": "pending" }]
}
```

### Step 5: 创建 task-{id}.json

```json
{
  "id": 1,
  "title": "...",
  "context": "...",
  "files": null,
  "steps": [{ "description": "...", "code": "...", "verification": "..." }]
}
```

**注意：** `files` 初始为 `null`，由执行阶段填充。

### Step 6: 更新关联文档

如果 `source` 为 `specproductdesign` 且 `requirementDoc` 不为空：

1. 读取 `{requirementDoc}/related-plans.md`
2. 追加新的计划条目：

```markdown
## Plan {N}: {计划名称}

- **计划文档：** [plan.md](../plans/plan.md)
- **任务进展：** [index.json](../plans/index.json)
- **状态：** 待开始

---
```

3. 保存更新后的 `related-plans.md`

### Step 7: 询问执行方式

存储完成后询问用户：
1. **子代理驱动**（当前会话）→ 按照 `subagent-workflow.md` 执行
2. **批次执行**（当前会话）→ 按照 `executing-plans.md` 执行

## 文件结构

```
docs/{project-name}/plans/
├── plan.md
├── index.json
├── task-1.json
├── task-2.json
└── ...
```

## 关键约束

1. **files 字段** - 初始必须为 `null`
2. **context 字段** - 1-3 句话，说明定位和依赖，不重复任务描述
3. **状态初始值** - 所有任务为 `pending`
4. **覆盖警告** - 覆盖已存在的 JSON 前必须警告用户
5. **关联更新** - 只有 `source: specproductdesign` 时才更新 `related-plans.md`

## 唯一出口

<HARD-GATE>
根据用户选择：
- 选择 1 → 按照 `subagent-workflow.md` 执行
- 选择 2 → 按照 `executing-plans.md` 执行
</HARD-GATE>

## Red Flags

**Never:**
- 跳过 context 分析
- 遗漏任务的 files 或 steps
- 创建不一致的目录结构
- 覆盖已存在的 JSON 而不警告
- 在 `source: direct` 时更新 `related-plans.md`
