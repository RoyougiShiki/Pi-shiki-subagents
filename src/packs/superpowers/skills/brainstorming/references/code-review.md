# Code Review

> 参考文档，派发 subagent 进行代码审查。

## Overview

Dispatch @oracle to review code and catch issues before they cascade.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-workflow
- After completing major feature
- Before merge to main

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. 派发 `@oracle` 进行代码审查：**

在 prompt 中说明：
- 实现内容：修改了哪些文件、做了什么
- 审查重点：逻辑错误、边界情况、安全隐患
- 参考基线：`{BASE_SHA}` → `{HEAD_SHA}`

**Placeholders（填入 prompt）：**
- `{WHAT_WAS_IMPLEMENTED}` - 本次实现了什么
- `{PLAN_OR_REQUIREMENTS}` - 应该做什么（方案/需求依据）
- `{BASE_SHA}` - 起始 commit
- `{HEAD_SHA}` - 结束 commit
- `{DESCRIPTION}` - 简要描述

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Integration with Workflows

**subagent-workflow:**
- Review after EACH task
- Catch issues before they compound
- Fix before moving to next task

**executing-plans:**
- Review after each batch (3 tasks)
- Get feedback, apply, continue

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback
