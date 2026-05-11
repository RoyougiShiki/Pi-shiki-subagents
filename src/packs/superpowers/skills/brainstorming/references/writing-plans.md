# Writing Plans

> 参考文档，由 brainstorming 自动调用，不需要人类交互。

## 前置条件

- 已完成 brainstorming，设计已获批准
- 接收 brainstorming 传递的关联判断结果（`requirementDoc`）

## 核心流程

编写计划文档 → 保存到 docs/{project-name}/plans/plan.md → 执行 extract-tasks 流程

## 关键原则

1. 假设零上下文 - 工程师不了解代码库，文档必须详尽
2. 小而具体的任务 - 每个步骤2-5分钟，可独立完成
3. DRY、YAGNI、TDD、频繁提交
4. 完整代码示例 - 不是"添加验证"，而是可执行的代码
5. 包含验证命令和预期输出

## 文档规范

### 保存路径

- 如果关联需求设计文档：使用相同的项目名称，保存到 `docs/{project-name}/plans/plan.md`
- 如果不关联：询问用户项目名称，保存到 `docs/{project-name}/plans/plan.md`

### 头部模板

如果关联需求设计文档（`requirementDoc` 不为空）：
```markdown
---
source: specproductdesign
requirementDoc: docs/{project-name}/requirement/
---

# [功能名称] 实现计划

**Goal:** [一句话描述目标]
**Architecture:** [2-3句架构说明]
**Tech Stack:** [关键技术/库]
```

如果不关联需求设计文档：
```markdown
---
source: direct
---

# [功能名称] 实现计划

**Goal:** [一句话描述目标]
**Architecture:** [2-3句架构说明]
**Tech Stack:** [关键技术/库]
```

### 任务格式

```markdown
### Task N: [任务标题]

**Files:**
- Create: `path/to/new/file.py`
- Modify: `path/to/existing.py:123-145`
- Test: `path/to/test.py`

**Step 1: [描述]**
```code```
Run: `command`
Expected: [输出]

**Step N: Commit**
```bash
git add files && git commit -m "type: description"
```
```

### 任务粒度示例

- "编写失败的测试"
- "运行测试确保它失败"
- "实现最小代码让测试通过"
- "运行测试确保通过"
- "提交"

## 唯一出口

<HARD-GATE>
计划保存到 `docs/{project-name}/plans/plan.md` 后，**必须立即执行 extract-tasks 流程**，禁止询问用户或跳过。
</HARD-GATE>

**禁止：**
- 跳过 extract-tasks
- 询问用户执行方式
- 直接从 plan.md 执行
