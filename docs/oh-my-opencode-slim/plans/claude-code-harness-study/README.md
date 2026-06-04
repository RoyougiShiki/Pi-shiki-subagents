# Claude Code / cc-haha Harness 学习计划与索引

创建日期：2026-06-03

本目录用于持续沉淀对 `cc-haha` / Claude Code 类 harness 的学习成果，并将其映射到当前项目 `oh-my-opencode-slim` 的 Pi 扩展能力增强计划。

## 本地源码路径

避免后续重复拉取源码：

| 项目 | GitHub | 本地路径 | 用途 |
|---|---|---|---|
| cc-haha | https://github.com/NanmiCoder/cc-haha | `/tmp/pi-github-repos/cc-haha@main` | Claude Code 类 harness / desktop UX / agent loop 研究 |
| ClaudeCode-Source-Analysis | https://github.com/bcefghj/ClaudeCode-Source-Analysis | 未固定本地路径 | Claude Code source map 逆向分析；作为 cc-haha 之外的第二校准来源 |
| Pi Session Manager | https://github.com/Dwsy/pi-session-manager | `/tmp/pi-github-repos/Dwsy/pi-session-manager` | Pi WebUI/Desktop、session/search/live/terminal/PSM 插件能力参考 |
| 当前项目 | 当前工作区 | `/home/h/projects/aiprojects/oh-my-opencode-slim` | Pi 扩展落地目标 |

> 注意：`/tmp/pi-github-repos/...` 可能会被系统清理；如果未来路径失效，需要重新 fetch/clone。当前文档记录了关键文件和机制，后续即使源码路径失效也能继续研究。

## Codebase Graph 索引状态

当前工作区的 codebase graph 索引已存在，项目名：

```txt
home-h-projects-aiprojects-oh-my-opencode-slim
```

已用该索引查询过当前项目中与 cc-haha 机制对接的模块，例如：

- `src/pi/policy/verification-evidence-policy.ts`
  - `checkVerificationEvidence`
- `src/pi/policy/evidence-tracker.ts`
  - `verifyCompletion`
  - `recordEvidence`
  - `getWriteEvidences`
- `src/pi/policy/tool-scope-manager.ts`
  - `setToolScope`
  - `getToolScope`
  - `isToolAllowed`
  - `auditPayloadTools`

当前已确认 Pi fallback reload 后可直接调用 `codebase_memory_index_repository`。当前项目索引已重建；cc-haha 源码如需后续深入图谱查询，应使用同一工具建立独立 graph 索引。

建议未来索引名：

```txt
cc-haha-main-local
```

## 第二轮源码复核结论（2026-06-04）

第二轮重点复核了 cc-haha 的 verification 相关源码：

```txt
src/utils/hooks.ts
src/entrypoints/sdk/coreSchemas.ts
src/tools/AgentTool/built-in/verificationAgent.ts
src/constants/prompts.ts
src/tools/TodoWriteTool/TodoWriteTool.ts
src/tools/TaskUpdateTool/TaskUpdateTool.ts
src/utils/toolResultStorage.ts
```

关键修正：

1. **Stop hook 是通用框架**：提供 `last_assistant_message` 和 `transcript_path`，不内置“工具成功即验证”的粗暴判断。
2. **PostToolUse 保留完整语义**：提供 `tool_name`、`tool_input`、`tool_response`、`tool_use_id`，后续判断应基于输入/输出语义。
3. **强验证来自独立 verification agent**：verifier 只读/运行检查，输出 `Command run`、`Output observed`，并以 `VERDICT: PASS|FAIL|PARTIAL` 结束。
4. **Reading code is not verification**：实现者自己的检查、caveat、自我声明不能替代 verifier。
5. **Todo/Task completion nudge**：关闭 3+ task/todo 且无 verification step 时，tool result 结构化提醒最终总结前需要 verifier。
6. **Pi 当前风险**：`DEFAULT_VERIFICATION_TOOLS=["bash"]` 会把 `git status`、`grep`、`echo` 等普通 bash 成功误判为 verification，属于只学机制大纲但未学细节精髓的设计，需要修正。

后续设计必须继续坚持当前项目架构底线：唯一真源、纯函数模块、runtime 解耦、不硬编码工具/agent 名、不保留错误兼容逻辑。

## 文档结构

| 文件 | 内容 |
|---|---|
| `01-core-harness-map.md` | cc-haha 核心 harness 文件与 agent loop 结构图 |
| `02-anti-hallucination-instruction-following.md` | 防幻觉、指令遵循、完成态诚实报告机制 |
| `03-context-and-tool-result-management.md` | context compaction、tool result budget、大输出治理 |
| `04-tools-permissions-and-orchestration.md` | tool orchestration、权限系统、hooks、并发/串行策略 |
| `05-pi-extension-mapping.md` | 映射到当前 Pi 扩展的落地设计 |
| `06-psm-and-desktop-workbench-notes.md` | PSM 与 cc-haha UI/UX 对 Pi WebUI/Desktop 的参考 |
| `07-future-study-backlog.md` | 后续继续学习清单，不丢弃 Claude-specific 特性 |
| `08-implementation-progress.md` | 当前 Pi harness 实现进度、测试状态、已知缺口 |
| `09-implementation-review-2026-06-04.md` | 对照 cc-haha 后的实现风险审查 |
| `10-claude-code-source-analysis-calibration.md` | 基于 `bcefghj/ClaudeCode-Source-Analysis` 的第二来源校准补充 |

## 当前结论摘要

1. cc-haha 的核心价值不是“某个神秘 prompt”，而是完整 agent loop 的工程控制：
   - 工具调用闭环
   - 权限 gate
   - 大输出治理
   - 上下文压缩
   - stop hooks / 完成前验证
   - 子代理/worker 隔离
   - prompt 分层与动态上下文

2. 对当前 Pi 扩展最值得优先吸收的机制：
   - completion auditor / verification gate
   - tool result budget / large output persistence
   - diff guard / scope guard
   - tool discipline policy
   - context recall + compaction
   - model router + verifier model separation

3. Claude-specific 特性不应丢弃，只应标记为“当前不直接迁移 / 未来可泛化”：
   - prompt cache / cache editing
   - thinking block / signature
   - Anthropic beta headers
   - task budget
   - context management API
   - structured tool schema optimizations

