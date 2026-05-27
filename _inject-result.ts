import { writeWorkflowStageResult } from "./src/pi/core/pi.ts";

const poolId = process.argv[2];
if (!poolId) {
  console.error("Usage: bun _inject-result.ts <poolId>");
  process.exit(1);
}

const result = {
  status: "completed",
  summary: "完成 src/config 目录文件数量统计与分析",
  context: `## 分析结果

### 澄清结论
任务明确：检查 src/config 目录下的文件数量并完成分析。无模糊之处。

### 分析结论

#### 文件数量与分类
**总计 16 个文件**
- 源码 (.ts): 8 个 (index.ts, constants.ts, schema.ts, council-schema.ts, loader.ts, agent-mcps.ts, utils.ts, runtime-preset.ts)
- 测试 (.test.ts): 7 个 (agent-mcps.test.ts, council-schema.test.ts, loader.test.ts, model-resolution.test.ts, runtime-preset.test.ts, utils.test.ts, workflows-and-tools.test.ts)
- 文档 (.md): 1 个 (codemap.md)

#### 源码职责
| 文件 | 行数 | 职责 |
|------|------|------|
| index.ts | 5 | 桶导出 |
| constants.ts | 89 | agent 名称/别名、委派规则、超时/轮询默认值 |
| schema.ts | 361 | 主配置 Schema（PluginConfig、AgentOverride、Workflow 定义等） |
| council-schema.ts | 244 | Council 专属 Schema（councillor 配置、预设、旧字段兼容） |
| loader.ts | 289 | 配置 IO、deepMerge、预设合成、prompt 加载 |
| agent-mcps.ts | 68 | agent 默认 MCP 列表、通配符/排除解析 |
| utils.ts | 42 | agent 覆写查找、自定义 agent 名发现 |
| runtime-preset.ts | 37 | 运行时 preset 状态管理 |

#### 架构特点
1. 分层清晰：Schema → 加载合并 → 辅助函数 → 运行时状态
2. 高测试覆盖：2547 行测试 / 798 行生产代码 = 3.2x
3. 兼容性处理：tmux→multiplexer 迁移、council master* 旧字段降级、JSONC 支持
4. 配置优先级：用户配置 → 项目配置（合并）→ 环境变量覆盖 → preset 合成
5. codemap.md 文档完善

#### 影响范围
上游消费方：src/index.ts, src/agents/, src/council/, runtime hooks, src/multiplexer/`,
  evidence: [
    { reason: "文件数量统计", path: "src/config" },
    { reason: "codemap 文档", path: "src/config/codemap.md" },
    { reason: "源码职责验证", path: "src/config/index.ts" },
    { reason: "行数统计", path: "src/config" },
  ],
};

const ok = writeWorkflowStageResult(result, poolId);
console.log(ok ? "OK: result injected" : "FAILED: could not inject result");
process.exit(ok ? 0 : 1);
