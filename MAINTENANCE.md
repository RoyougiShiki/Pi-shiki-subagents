# oh-my-opencode-slim OMO Fork — Maintenance Guide

## 项目概况

基于 `alvinunreal/oh-my-opencode-slim` fork，移植 OMO (oh-my-openagent) 核心功能。
**分支**：`feature/omo-core`
**仓库**：`https://github.com/RoyougiShiki/oh-my-opencode-slim`

## 已完成的功能

| 功能 | 文件 | 状态 |
|------|------|------|
| IntentGate | `src/agents/orchestrator.ts` | ✅ 已验证 |
| Background Agents | `src/utils/background-task.ts`<br>`src/hooks/background-task/index.ts` | ✅ 含轮询+通知 |
| Ralph Loop / ULW | `src/utils/ralph-loop.ts`<br>`src/hooks/ralph-loop/index.ts` | ✅ 已验证 |
| Hashline Edit | `src/utils/hashline.ts`<br>`src/hooks/hashline-edit/index.ts` | ✅ 已验证（默认关闭） |
| 配置迁移 | `scripts/migrate-omo-config.mjs` | ✅ |

## 配置文件位置

| 文件 | 路径 | 说明 |
|------|------|------|
| 主配置 | `~/.config/opencode/opencode.json` | 插件列表、provider |
| slim 配置 | `~/.config/opencode/oh-my-opencode-slim.json` | agent 模型映射 |
| OMO 旧配置 | `~/.config/opencode/oh-my-openagent.json` | 参考用，已不加载 |

## 当前 opencode.json 插件配置

```json
"plugin": [
  "file:///mnt/f/AIProjects/OpenCodePlugins/oh-my-opencode-slim",
  "file:///mnt/f/AIProjects/OpenCodePlugins/opencode-image-proxy",
  "file://F:/AIProjects/develop_skills/superpowers"
]
```

**注意**：路径必须用 Linux 格式 `/mnt/f/...`（WSL2 环境）。如果切换到 Windows 原生，需改回 `F:/...`。

## 功能测试清单

| 测试项 | 操作 | 预期 |
|--------|------|------|
| 插件加载 | 重启 OpenCode，检查 UI agent 名称 | 显示 `orchestrator`，不是 `build` |
| IntentGate | 发送 "帮我看下 src/ 目录" | 输出意图分类（如 `Intent: investigate → @explorer`） |
| Agent 委派 | "帮我搜索所有 .ts 文件" | 委派给 @explorer |
| Background Tasks | `task(run_in_background=true)` | 返回 task_id |
| Background 轮询 | 启动后台任务，等待 8s，发新消息 | 看到 `<system-reminder>` 完成通知 |
| Ralph Loop | `/ralph-loop 帮我重构这个函数` | 启动自引用循环 |
| Hashline Edit | 编辑文件时 | LINE#ID 哈希验证（需在配置中启用） |
| grep_app MCP | "搜索 GitHub 上 React useState 用法" | 返回代码搜索结果 |
| websearch MCP | "搜索 OpenCode 最新版本" | 调用 websearch |
| Council | "帮我对比这两种架构方案" | 委派给 @council |

## 已知问题

### 1. MCP prompts API 错误（不影响功能）
```
ERROR MCP error -32601: Method not found failed to get prompts
```
context7、grep_app 不支持 `prompts/list` 方法，但工具本身创建成功（toolCount=1/2）。**不影响使用**。

### 2. Hashline Edit 默认关闭
需要在 `src/index.ts` 中将 `enabled: false` 改为 `enabled: true`，或在 slim 配置中添加 `hashlineEdit` 字段。

### 3. superpowers 插件路径
`file://F:/AIProjects/develop_skills/superpowers` 使用 Windows 路径，在 WSL2 环境下可能加载失败。需改为 `file:///mnt/f/AIProjects/develop_skills/superpowers`。

## 构建命令

```bash
export PATH="/home/h/.npm-global/bin:/home/h/.bun/bin:$PATH"
cd /mnt/f/AIProjects/OpenCodePlugins/oh-my-opencode-slim

bun run typecheck    # 类型检查
bun run build        # 完整构建
bun test             # 运行测试
```

## Git 工作流

```bash
# 提交格式（PLAIN + ENGLISH）
git add <files>
git commit -m "<message>" \
  -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" \
  -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"

# 推送
git remote set-url origin https://RoyougiShiki:<token>@github.com/RoyougiShiki/oh-my-opencode-slim.git
git push origin feature/omo-core
git remote set-url origin https://github.com/RoyougiShiki/oh-my-opencode-slim.git  # 移除 token
```

## 代码风格

- Biome 格式化：单引号、无分号、2 空格缩进
- 类型导入：`import type { X } from '...'`
- 日志：`log('[module-name] message', { data })`
- Hook 工厂模式：`createXxxHook(ctx, options) => { event, tools, ... }`

## 后续可做

1. **启用 Hashline Edit** — 修改 `src/index.ts` 中 `enabled: false` → `true`
2. **添加 hashlineEdit 到配置 schema** — 在 `src/config/schema.ts` 中添加字段
3. **修复 superpowers 路径** — 改为 Linux 格式
4. **完善测试覆盖** — 为 background-task、ralph-loop、hashline 添加单元测试
5. **性能优化** — 轮询间隔可配置化
