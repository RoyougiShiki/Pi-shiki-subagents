# 06 — PSM 与 cc-haha 对 Pi WebUI/Desktop Workbench 的参考

本文记录 UI/UX 层面的学习：Pi 只有终端时，session 搜索、文件列表、diff、权限审批、tool call 可视化等体验不足。未来如果做 WebUI/Desktop，不建议重做，而是结合 PSM 与 cc-haha 的长处。

## 1. 参考项目路径

| 项目 | 本地路径 | 参考重点 |
|---|---|---|
| Pi Session Manager | `/tmp/pi-github-repos/Dwsy/pi-session-manager` | Pi session/search/live/terminal/data/backend |
| cc-haha | `/tmp/pi-github-repos/cc-haha@main` | active coding workbench UX、diff、permissions、tool rendering |

## 2. 不建议现在拆独立项目

当前不建议把 WebUI/Desktop 拆成独立项目，原因：

1. 目前仍处于 harness 学习和 Pi 扩展增强阶段。
2. 当前目标是增强 `pi-shiki-subagents`，不是发布独立桌面产品。
3. PSM 与 cc-haha 还只是参考对象，先沉淀设计，不急着工程化。
4. 一旦拆项目，会增加构建、发布、协议同步和维护成本。

建议：

```txt
先在当前项目 docs/plans 中沉淀设计
  ↓
先做 Pi extension 能力增强
  ↓
再做最小 Pi Workbench
  ↓
最后如果独立运行需求明确，再拆项目
```

## 3. PSM 适合作为数据层/接口层参考

PSM 是 Pi Workbench 的优秀参考，重点不是 agent harness，而是 session management。

本地路径：

```txt
/tmp/pi-github-repos/Dwsy/pi-session-manager
```

关键能力：

- session browser
- project/session grouping
- full-text search
- SQLite FTS5 / Tantivy
- tags / favorites
- Kanban
- Pi Live
- terminal / resume
- dataset browser
- dashboard / token stats
- HTTP / WS / SSE / Tauri IPC
- model config UI
- plugin SDK

## 4. PSM 架构可借鉴点

PSM README / agent docs 中描述了四层架构：

```txt
Commands (thin) <- Tauri IPC / HTTP / WS
Domain (business) <- model_config, session_list, stats, terminal
Data <- search / sqlite cache
Server <- HTTP / WebSocket / SSE
```

对 Pi Workbench 的建议：

```txt
Frontend UI
  ↓
Transport adapter: HTTP / WS / Tauri IPC
  ↓
Command dispatch
  ↓
Domain services:
    session
    search
    diff
    terminal
    model config
    evidence
    tool result refs
  ↓
Data:
    session db
    FTS index
    tool result files
    tag/favorite metadata
```

## 5. cc-haha 适合作为 active coding UX 参考

cc-haha 的桌面端不是 session browser，而是 coding workbench。

可参考能力：

- 多标签 session workspace
- 实时 chat streaming
- tool call card
- Bash terminal chrome
- Edit/Write diff viewer
- Read code viewer
- permission dialog
- plan / accept edits / bypass mode
- changed files panel
- provider/model selector
- scheduled tasks
- agent team status
- H5 remote access
- IM approval

## 6. Pi Workbench MVP 不应做太大

第一版建议只做：

| 功能 | 来源参考 | 优先级 |
|---|---|---|
| session 列表 | PSM | P0 |
| session 搜索 | PSM | P0 |
| 当前会话实时消息 | PSM Pi Live + cc-haha chat | P0 |
| tool call 可视化 | cc-haha | P0 |
| 文件 diff 面板 | cc-haha | P0 |
| 一键 resume | PSM | P0 |
| 文件列表 / changed files | cc-haha + PSM | P1 |
| model/token/cost 显示 | PSM dashboard + cc-haha status | P1 |
| permission approval | cc-haha | P1 |
| 多 tab | cc-haha | P2 |
| Kanban/tags | PSM | P2 |
| scheduled tasks | cc-haha | P3 |
| IM/H5 remote | cc-haha | P3 |

## 7. UI 对防幻觉的间接帮助

UI 本身不会显著提升 benchmark 分数，但能提升可观测性和可控性：

| UI 能力 | 防幻觉价值 |
|---|---|
| tool call 可视化 | 用户能看到模型是否用了正确工具 |
| diff panel | 用户能发现无关修改 |
| test result card | 防止模型虚称测试通过 |
| evidence panel | 显示最终结论的证据来源 |
| permission dialog | 防止危险行为自动发生 |
| session search | 让模型/用户找回历史决策 |
| changed files list | 减少遗漏或越界修改 |
| subagent status | 防止子代理未完成就总结 |

## 8. 推荐 Workbench 信息架构

```txt
Left Sidebar:
  - Projects
  - Sessions
  - Search
  - Tags/Favorites

Center:
  - Chat / transcript
  - Tool call timeline
  - Streaming output

Right Panel:
  - Changed files
  - Diff viewer
  - Evidence / verification
  - Tool result refs
  - Context pressure

Bottom:
  - Terminal
  - Model/token/cost status
  - Permission mode
```

## 9. 与 Pi 扩展的关系

不要让 UI 直接承担 harness 逻辑。

正确分层：

```txt
Pi extension / harness policy:
  - completion audit
  - evidence tracker
  - tool result budget
  - diff guard
  - model router

Workbench UI:
  - 展示这些 policy 的结果
  - 提供用户审批入口
  - 提供搜索/导航/恢复
```

## 10. PSM 可直接参考的接口方向

PSM 已有：

```txt
/api
/ws
/api/events
/health
```

未来 Pi Workbench 可设计类似命令协议：

```ts
interface WorkbenchCommandRequest {
  command: string
  payload: unknown
}

interface WorkbenchEvent {
  type:
    | 'session_changed'
    | 'message_delta'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'diff_changed'
    | 'evidence_updated'
    | 'permission_requested'
    | 'context_warning'
  payload: unknown
}
```

## 11. 不要照搬 cc-haha Desktop 架构

cc-haha Desktop 架构是：

```txt
Tauri 主进程
  -> Bun server sidecar
  -> CLI child process
```

这对 cc-haha 合理，但 Pi Workbench 不一定要照搬。

Pi 更合理：

```txt
Pi runtime / extension exposes events
  -> lightweight local server / bridge
  -> WebUI or Tauri shell
```

先做 WebUI/HTTP 更灵活；如果需要本地体验，再包 Tauri。

## 12. 最终建议

```txt
能力层：Pi extension
数据层：参考 PSM
工作台 UX：参考 cc-haha
桌面壳：后置，可选 Tauri
```

不要把 cc-haha 的 agent core 迁移进 UI 项目；harness 增强应先在 Pi 扩展内完成。

