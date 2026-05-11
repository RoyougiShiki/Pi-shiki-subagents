# Safe Workspace

> 参考文档，为执行任务前提供工作空间保护。

## Overview

VCS 无关的轻量保护机制。检测项目版本控制系统类型，提供相应的保护能力。

**Core principle:** Detect VCS → Light protection → Work in place

## The Process

### Step 1: 检测 VCS 类型

| 检测 | 标志 |
|------|------|
| Git | `.git` 目录 |
| SVN | `.svn` 目录 |
| 无 VCS | 无以上标志 |

### Step 2: 检测多仓库情况

**Git Submodules:** `git submodule status`
**SVN Externals:** `svn propget svn:externals -R`

### Step 3: 根据 VCS 类型提供保护

| VCS | 保护机制 |
|-----|---------|
| Git | `git stash` 或记录当前状态 |
| SVN | 记录 `svn status` 输出 |
| 无 VCS | 创建 `.snapshots/` 目录，按需快照 |

### Step 4: 报告状态

```
VCS 检测结果: {git/svn/none}
多仓库情况: {描述或"无"}
保护机制: {描述}

准备就绪，可以开始工作。
```

## 无 VCS 快照机制

### 快照目录结构

```
.snapshots/
├── .gitignore
├── task-{id}/
│   ├── manifest.json
│   └── files/
│       └── {path_with_underscores}.bak
```

### 快照时机

当子代理报告将要修改文件时：
1. 检查文件是否存在
2. 如果存在，复制到 `.snapshots/task-{id}/files/`
3. 记录到 `manifest.json`

### 快照文件命名

将路径转换为文件名：
- `src/auth/login.ts` → `src_auth_login.ts.bak`
- 使用 `.bak` 扩展名避免被 IDE 编译

## 回滚操作

| VCS | 回滚命令 |
|-----|---------|
| Git | `git checkout HEAD -- <files>` |
| SVN | `svn revert <files>` |
| 无 VCS | 从 `.snapshots/` 恢复 |

## Red Flags

**Never:**
- 创建隔离工作目录
- 复制整个项目作为快照（无 VCS 时只快照变更文件）
- 忽略 externals/submodules 导致部分文件无法正确提交

**Always:**
- 检测 VCS 类型
- 检测多仓库情况
- 使用 `.bak` 扩展名避免编译
