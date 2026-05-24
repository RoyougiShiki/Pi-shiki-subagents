# Recovery TODO

> 创建时间：2026-05-23
> 来源：Workflow/Chat/Gate 恢复人工验收任务

## 待办项（coordinator 越权问题）

- [ ] 检查各 stage agent（thinker-clarify, thinker-analysis, designer, implementer, worker, oracle）的提示词和可用工具配置
  - 背景：coordinator 角色当前能调用 ctx_batch_execute 等不应有的工具，需要搞清楚各 agent 的工具权限边界
  - 来源：用户指出 coordinator 越权使用了 ctx_batch_execute 等技术分析工具

## 验收优先级

- [ ] **P0**: reload 后真实 workflow 场景人工验收
  - stage 是否不再强制弹 overlay
  - 主会话 notify/setStatus 是否符合旧设计
  - /chat 场景是否不再显示 raw JSON / tool noise
- [ ] **P1**: 确认通知链设计（sendMessage / notify / setStatus）
- [ ] **P2**: 处理 handover.md deleted 状态
- [ ] **P3**: 恢复确认后，清理 recovery 临时文件 + 合并回正式 handover

---

### 参考文档

- [Recovery Baseline](recovery-baseline.md)
- [Recovery Matrix](recovery-matrix.md)
- [Recovery R1 笔记](recovery-r1-notes.md)
- [Recovery R2 笔记](recovery-r2-notes.md)
- [Recovery R3 笔记](recovery-r3-notes.md)
- [Recovery R4 笔记](recovery-r4-notes.md)
- [Recovery Next Steps](recovery-next-steps.md)
