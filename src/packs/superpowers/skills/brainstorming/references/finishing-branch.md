# Finishing a Development Branch

> 参考文档，最后需要询问用户选择处理方式。

## Overview

Guide completion of development work by presenting clear options and handling chosen workflow.

**Core principle:** Verify tests → Present options → Execute choice → Clean up.

## The Process

### Step 1: Verify Tests

**Before presenting options, verify tests pass:**

```bash
npm test / cargo test / pytest / go test ./...
```

**If tests fail:**
```
Tests failing (<N> failures). Must fix before completing:

[Show failures]

Cannot proceed until tests pass.
```

Stop. Don't proceed to Step 2.

### Step 2: Determine Base Branch

```bash
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

### Step 3: Present Options

**For Git projects:**
```
实现完成。你想如何处理？

1. 提交变更 - 提交到当前分支
2. 回滚变更 - 恢复到任务前状态
3. 保留现状 - 暂不处理

选择哪个？
```

**For SVN projects:**
```
实现完成。你想如何处理？

1. 提交变更 - 提交到 SVN
2. 回滚变更 - svn revert 恢复
3. 保留现状 - 暂不处理

选择哪个？
```

**For no-VCS projects:**
```
实现完成。你想如何处理？

1. 保留变更 - 文件已修改
2. 回滚变更 - 从快照恢复

选择哪个？
```

### Step 4: Execute Choice

#### Option 1: Commit Changes

**Git:**
```bash
git add <files-from-tasks>
git commit -m "feat: <feature description>"
```

**SVN:**
```bash
svn commit <files-from-tasks> -m "feat: <feature description>"
```

#### Option 2: Rollback Changes

**Git:**
```bash
git checkout HEAD -- <files-from-tasks>
```

**SVN:**
```bash
svn revert <files-from-tasks>
```

**No VCS:**
从 `.snapshots/` 恢复文件。

#### Option 3: Keep As-Is

不做任何操作，保持当前状态。

## Quick Reference

| VCS | Commit | Rollback | Keep |
|-----|--------|----------|------|
| Git | git add + commit | git checkout HEAD -- | no action |
| SVN | svn commit | svn revert | no action |
| No VCS | no action | restore from snapshot | no action |

## Red Flags

**Never:**
- Proceed with failing tests
- Commit files not in task.json files field
- Delete snapshots before confirming rollback success

**Always:**
- Verify tests before offering options
- Present options based on VCS type
- Use files list from task.json for targeted operations
