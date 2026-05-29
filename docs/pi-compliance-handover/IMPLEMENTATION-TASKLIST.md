# 实施任务单（文件级）：模式优先稳定化改造

> 仓库：`/home/h/projects/aiprojects/oh-my-opencode-slim`
>
> 关联方案文档：`docs/pi-compliance-handover/README.md`
>
> 目标：按“mode + subagent + runtime guard”落地，分阶段下线 workflow 主路径与高风险逻辑。

---

## 0. 执行原则

1. 先下线（disable）再删除（delete）。
2. 禁止新增“改写历史 session/message”逻辑。
3. 所有约束优先 runtime guard，不靠提示词文案优先级。
4. 每阶段完成后必须跑最小回归再进入下一阶段。

---

## 1. 目录级动作总览

### 保留主干
- `src/pi/core/`（mode/state/tool gating）
- `src/pi/subagent/`（委托能力）
- `src/adapters/agents-default.json`（工具与委托配置）

### 下线目标（第一阶段）
- `src/pi/workflow/` 入口能力（默认禁用）
- `src/pi/core/pi.ts` 中 message/history 改写逻辑
- fallback 魔法工具注入逻辑

### 待删除目标（第三阶段）
- `src/pi/workflow/` 主链文件（稳定后）
- workflow 相关测试与命令绑定

---

## 2. P0（冻结高风险路径）

> 预计：1 天

### 2.1 `src/pi/core/pi.ts`

**动作**
- 删除/下线 `message_end` 中对 finalized assistant message 的重写分支。
- 删除/下线任何会触发 session/history 结构改写的路径。
- 保留：合规检查“记录与拦截”能力（如 violation record / block reason）。
- 确保异常处理为 fail-open（不崩主流程）。

**验收**
- 不再出现 message 内容重写导致的结构漂移。
- `bun test --bail`
- `bun x tsc --noEmit`

---

### 2.2 `src/pi/core/pi-modes.ts`

**动作**
- fallback 改为**静态 preset 应用**：
  - 禁止从 `getAllTools()` 动态拼全量并注入。
  - 禁止继承上个模式工具集。
- mode 切换后原子执行：
  1) currentMode
  2) allowedTools
  3) turnExecutionContext reset
- 切换失败立即报错，不做二次魔法补偿。

**验收**
- 连续切换 `coordinator <-> fallback` 无“工具丢失/漂移”。
- 新会话首轮能稳定拿到 preset 工具集。

---

### 2.3 `src/adapters/agents-default.json`

**动作**
- 明确 coordinator/fallback 工具清单（静态可见）。
- 去掉依赖运行态猜测的工具配置。
- 保留 subagent delegates 白名单。

**验收**
- 工具列表不重复、不含未知工具。
- 模式切换后 allowlist 与配置一致。

---

### 2.4 `src/pi/compliance.ts`（若存在）

**动作**
- 保留“检测/记录/拦截”接口。
- 删除“改写最终消息内容”相关 helper 的调用链（可先弃用不删文件）。

**验收**
- 合规违规可以被记录并触发拦截。
- 不再产出消息体结构副作用。

---

## 3. P1（模式主路径上线）

> 预计：1-2 天

### 3.1 `src/pi/core/pi.ts`（runtime guard 强化）

**动作**
- 增加三类硬门：
  1) 非 allowlist 工具调用直接拦截
  2) 伪执行检测（声称执行但无工具证据）
  3) 完成态前置校验（未达条件不可完成）
- 将“提示词注入”降级为辅助信息，不承担强约束。

**验收**
- 非 allowlist 调用 100% 拦截。
- 伪执行可稳定触发重答/拒绝。

---

### 3.2 `src/pi/subagent/subagent-pool.ts`

**动作**
- 保留最小委托能力。
- 删除/下线与 workflow 主链强耦合的桥接逻辑（若有）。
- 保持 worker/oracle 路径简洁：执行 -> 审查 -> 回传。

**验收**
- 子代理可稳定 spawn/send/kill。
- 无 workflow 依赖时仍可完成任务闭环。

---

### 3.3 `src/pi/meeting/*`（可选）

**动作**
- 若与主路径无关，默认关闭入口（不删文件）。
- 避免干扰模式主路径稳定性。

**验收**
- 未启用 meeting 时不影响 mode/subagent。

---

### 3.4 Oracle 审查提示与判据（配置/提示词文件）

**动作**
- 保留章节检查。
- 增加证据有效性检查（测试结果、变更点、风险）。
- 审查结果必须可用于硬门（approve/reject）。

**验收**
- “有格式无证据”会被拒绝。

---

## 4. P2（workflow 物理清理）

> 前提：P1 稳定通过后再做
>
> 预计：1-2 天

### 4.1 `src/pi/workflow/`

**动作**
- 删除默认命令入口绑定（若仍存在）。
- 删除 workflow-manager 主链及其依赖桥接（按引用图逐步删）。
- 清理 stage-result-store 等仅 workflow 使用模块。

**验收**
- 全项目无 workflow 主链编译引用。
- mode + subagent 功能完整。

---

### 4.2 相关测试清理

**动作**
- 删除/重写 workflow 相关测试（尤其依赖旧状态机行为的断言）。
- 新增 mode 主路径与 guard 断言测试。

**建议关注文件（按实际仓库检索确认）**
- `src/adapters/workflow-manager.test.ts`
- `src/pi/workflow/*test*`
- `src/adapters/pi.test.ts`（保留但更新断言）

**验收**
- `bun test --bail` 全绿。

---

## 5. 验证脚本与命令

### 5.1 静态检查
```bash
bun x tsc --noEmit
```

### 5.2 单测
```bash
bun test --bail
```

### 5.3 关键手工回归
1. 启动新会话 -> 默认 mode 可用。
2. `coordinator -> fallback -> coordinator` 连续切换。
3. 非 allowlist 工具调用被拦截。
4. 子代理执行与 oracle 审查闭环正常。
5. 禁用扩展后 pi 可正常工作（兜底验证）。

---

## 6. 风险点与回退点

### 风险点
1. 一次性下线 workflow 可能影响习惯路径。
2. guard 过严导致误拦截。
3. mode preset 配置错误导致工具不可用。

### 回退点
- 每阶段单独提交：`P0`, `P1`, `P2`。
- 任一阶段失败，回退到上一阶段提交。
- 紧急兜底：禁用扩展 + 重启 pi。

---

## 7. 建议提交粒度（Git）

1. `refactor(mode): remove message rewrite and fallback magic injection`
2. `feat(guard): enforce tool allowlist and completion gating`
3. `refactor(subagent): decouple from workflow runtime path`
4. `chore(workflow): disable default workflow entrypoints`
5. `chore(cleanup): remove workflow modules and obsolete tests`
6. `docs: update handover and file-level execution plan`

---

## 8. 完成定义（DoD）

满足以下全部条件视为完成：
1. 默认路径不再依赖 workflow。
2. mode 切换稳定，无工具漂移。
3. 不存在运行时历史消息改写。
4. 关键约束由 runtime guard 生效。
5. 子代理 + oracle 质量门可用。
6. 回归测试通过，扩展可禁用兜底可用。

---

## 9. 附：本任务单与方案文档关系

- 本文件是“执行清单”（what/how/when）。
- `docs/pi-compliance-handover/README.md` 是“决策与架构依据”（why）。
- 实施过程中若冲突，以“稳定性优先、减少耦合优先”为最终裁决原则。
