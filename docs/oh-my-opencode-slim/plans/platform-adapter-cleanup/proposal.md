# Platform Adapter Cleanup - 清理旧 OpenCode 适配实现设计

> 状态:设计草案,尚未实施删除。
> 日期:2026-06-01
> 目标:整理当前维护中的平台适配层,保留可复用共享层,清理长期未维护的旧 OpenCode adapter 实现。

---

## 0. 背景与命名

本仓库不应被描述为 "Pi-only"。更准确的边界是:

- 当前正在维护和运行的是 **Pi adapter**。
- `config` / `core` / `adapters` 中的 agent 定义、配置 schema、运行时配置加载等仍是**共享层**,未来可供其他平台 adapter 复用。
- 旧 OpenCode adapter 长期未维护,且当前 Pi 扩展不依赖,应作为 legacy platform adapter 清理。

因此本设计目标是:

> 保留 shared 层与当前 Pi adapter,删除或下线 legacy OpenCode adapter。

---

## 1. 当前分层

### 1.1 当前维护的 Pi adapter

这些是 Pi 平台适配层,必须保留:

```text
src/pi/core/pi.ts
src/pi/core/pi-modes.ts
src/pi/meeting/**
src/pi/policy/**
src/pi/subagent/**
src/pi/compliance.ts
```

入口由 `package.json` 的 `pi.extensions` 声明:

```json
"pi": {
  "extensions": [
    "./src/pi/core/pi.ts",
    "./src/pi/core/pi-modes.ts"
  ]
}
```

### 1.2 共享层

这些不属于 Pi-only,应继续作为共享能力保留:

```text
src/adapters/agents/**
src/adapters/agents-default.json
src/adapters/agent-runtime-config.ts
src/adapters/agent-discovery.ts
src/adapters/delegation-rules.ts
src/adapters/pi-env.d.ts
src/config/**
src/core/workflow-types.ts
oh-my-opencode-slim.schema.json
```

说明:

- `src/adapters/agents/**` 是平台无关的 agent prompt 源。
- `agents-default.json` 是 agent 定义与工具/角色边界的配置源。
- `config/schema.ts` 仍提供共享配置 schema 和 `DEFAULT_WORKFLOWS` 种子。
- `workflow-types.ts` 当前仍被 Pi/config 使用;不能随旧 OpenCode 一起删除。

### 1.3 Legacy OpenCode adapter

以下目录/文件属于旧 OpenCode 实现。当前调查结论是:Pi 扩展不 import 它们。

```text
src/index.ts
src/opencode/**
src/agents/**
src/tools/**
src/utils/**
src/council/**
src/hooks/**
```

这些是删除候选,但删除前需先调整 package/build/scripts,避免旧入口断裂导致测试或发布脚本失败。

---

## 2. 关键风险

### 2.1 package 入口仍指向旧 OpenCode

当前 `package.json` 仍有旧入口:

```json
"main": "dist/index.js"
```

`dist/index.js` 来自 `src/index.ts`,而 `src/index.ts` 导出旧 `src/opencode/opencode.ts`。

如果直接删除旧 OpenCode 代码而不调整 package/build,构建和 npm 入口会断。

### 2.2 package files 未明确包含 Pi adapter

当前 `files` 需要确认是否包含当前维护入口:

```text
src/pi/**
```

如果 npm 包发布时未包含 `src/pi`,Pi extension 入口会缺失。

### 2.3 构建脚本仍围绕旧 OpenCode plugin

当前构建脚本包括:

```text
build:plugin → bun build src/index.ts
build:cli    → bun build src/cli/index.ts
verify:host-smoke
verify:release
```

这些需要重新评估:

- `build:plugin` 是否仍需要;
- `src/cli` 是否仍服务当前维护路径;
- release verify 是否仍检查已不存在或即将删除的旧路径。

### 2.4 共享 config 不可误删

`src/config/**` 同时被旧 OpenCode 和 Pi 使用。删除旧 OpenCode 时不能删除 config/schema/loader/constants 等共享代码。

---

## 3. 分阶段方案

### P0 - package/build 边界整理

目标:先让包结构表达当前维护事实,再删除旧代码。

建议改动:

1. 更新 `package.json files`,确保包含:

```text
src/pi
src/adapters
src/config
src/core
oh-my-opencode-slim.schema.json
README.md
LICENSE
```

2. 评估并调整旧入口:

```text
main: dist/index.js
build:plugin
prepublishOnly
prepare
```

建议方向:

- 不再把旧 OpenCode plugin 作为主入口维护。
- 如果 npm 仍要求 `main`,应改为轻量占位或共享入口,而不是旧 OpenCode bundle。
- Pi extension 入口以 `package.json.pi.extensions` 为准。

3. 暂停或重写失效脚本:

```text
scripts/verify-release-artifact.ts
scripts/verify-opencode-host-smoke.ts
```

4. 保留 schema generation:

```text
scripts/generate-schema.ts
```

验收:

```bash
bun run typecheck
bun test
bun run generate-schema
```

---

### P1 - 删除 legacy OpenCode adapter 闭包

前置:P0 完成,package/build 不再依赖旧 OpenCode 主入口。

删除候选:

```text
src/index.ts
src/opencode/**
src/agents/**
src/tools/**
src/utils/**
src/council/**
src/hooks/**
src/vendor/**
```

保留:

```text
src/pi/**
src/adapters/**
src/config/**
src/core/workflow-types.ts
```

验收:

```bash
bun run typecheck
bun test
```

并检查:

```bash
grep -R "src/opencode\|../opencode\|./opencode" src package.json scripts docs
```

---

### P2 - 清理 dist 与旧脚本

前置:P1 完成,旧源码已删除。

处理候选:

```text
dist/index.js
dist/index.d.ts
dist/opencode/**
dist/agents/**
dist/tools/**
dist/utils/**
dist/council/**
dist/hooks/**
dist/cli/**        # 若 CLI 不再维护
```

原则:

- `dist/` 是构建产物,优先通过 clean build 或重新生成处理。
- 不手工保留旧 OpenCode d.ts 残留。

脚本候选:

```text
scripts/verify-opencode-host-smoke.ts
scripts/migrate-omo-config.mjs
```

`verify-release-artifact.ts` 可重写为检查当前 Pi/shared 文件,而不是旧 OpenCode 文件。

---

### P3 - 文档重写

需要重写或删除旧描述：

```text
README.md
```

新文档应表达：

- 当前维护 Pi adapter。
- shared 层保留,未来可供其他平台 adapter 复用。
- legacy OpenCode adapter 已下线或已移除。
- agent 边界:coordinator / analyst / oracle / designer / fixer / worker 等。
- 工具控制方式:tool scope + mode + subagent delegation,不再使用逐工具 approval gate。

---

## 4. 不应做的事

- 不把项目改名为 Pi-only。
- 不把共享 config/core/adapters 移进 `src/pi`。
- 不在 prompt 里硬编码 package/build 细节。
- 不为了旧 OpenCode 入口继续保留大量未维护代码。
- 不在删除旧 OpenCode 的同时重构共享 config schema;共享层瘦身应单独做。

---

## 5. 建议实施顺序

1. **P0 package/build 设计确认**:先确认 `main`、`files`、build scripts、CLI 是否保留。
2. **P0 实施**:调整 package/build/scripts 到当前维护边界。
3. **P1 删除 legacy OpenCode adapter**:删除旧闭包并修复断裂。
4. **P2 清理 dist/scripts**:重新生成或删除旧构建产物。
5. **P3 文档重写**：README 对齐新架构。

---

## 6. 待确认问题

1. `src/cli/**` 是否仍需要?它目前更像安装器/旧 OpenCode 基础设施,但也可能仍用于生成配置。
2. `main` 字段是否移除、改为占位,还是指向某个共享入口?
3. npm 发布是否仍是目标?如果是,`files` 必须包含 `src/pi` 和共享层。
4. `dist` 是否仍需要发布?如果 Pi 可直接加载 TS source,可考虑弱化 dist。
5. `.pi/bundle/` 是否是当前开发/发布必要目录?需要单独确认。
