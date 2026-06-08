import { z } from 'zod';
import { AGENT_ALIASES, ALL_AGENT_NAMES } from './constants';
import { TOOL_GROUPS_CONFIG_KEY } from './config-keys';
import { CouncilConfigSchema } from './council-schema';
import type {
  WorkflowNode,
  WorkflowsConfig as WorkflowTypesConfig,
} from './workflow-types';
import { DEFAULT_WORKFLOWS } from './workflow-defaults';
export { DEFAULT_WORKFLOWS, resolveWorkflowList } from './workflow-defaults';

export const ProviderModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    'Expected provider/model format (provider/.../model)',
  );

export const ManualAgentPlanSchema = z
  .object({
    primary: ProviderModelIdSchema,
    fallback1: ProviderModelIdSchema,
    fallback2: ProviderModelIdSchema,
    fallback3: ProviderModelIdSchema,
  })
  .superRefine((value, ctx) => {
    const unique = new Set([
      value.primary,
      value.fallback1,
      value.fallback2,
      value.fallback3,
    ]);
    if (unique.size !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primary and fallbacks must be unique per agent',
      });
    }
  });

export const ManualPlanSchema = z.record(z.string(), ManualAgentPlanSchema);

export type ManualAgentName = string;
export type ManualAgentPlan = z.infer<typeof ManualAgentPlanSchema>;
export type ManualPlan = z.infer<typeof ManualPlanSchema>;

const AgentModelChainSchema = z.array(z.string()).min(1);

const FallbackChainsSchema = z.record(z.string(), AgentModelChainSchema);

export type FallbackAgentName = string;

// Agent override configuration (distinct from SDK's AgentConfig)
export const AgentOverrideConfigSchema = z
  .object({
    model: z
      .union([
        z.string(),
        z
          .array(
            z.union([
              z.string(),
              z.object({
                id: z.string(),
                variant: z.string().optional(),
              }),
            ]),
          )
          .min(1),
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    variant: z.string().optional().catch(undefined),
    thinking: z.string().optional(),
    skills: z.array(z.string()).optional(), // skills this agent can use ("*" = all, "!item" = exclude)
    mcps: z.array(z.string()).optional(), // MCPs this agent can use ("*" = all, "!item" = exclude)
    type: z.enum(['mode', 'subagent', 'both']).optional(),
    roles: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    delegates: z.array(z.string()).optional(),
    pipelineMode: z.boolean().optional(),
    workflow: z.string().min(1).optional(),
    hidden: z.boolean().optional(),
    label: z.string().optional(),
    prompt: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(), // provider-specific model options (e.g., textVerbosity, thinking budget)
    displayName: z.string().min(1).optional(),
  })
  .strict();

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

/** Normalized model entry with optional per-model variant. */
export type ModelEntry = { id: string; variant?: string };

export const PresetSchema = z.record(z.string(), AgentOverrideConfigSchema);

export type Preset = z.infer<typeof PresetSchema>;

export const ToolGroupsConfigSchema = z.record(z.string(), z.array(z.string()));

export type ToolGroupsConfig = z.infer<typeof ToolGroupsConfigSchema>;

// MCP names
export const McpNameSchema = z.enum(['context7', 'grep_app']);
export type McpName = z.infer<typeof McpNameSchema>;

export const InterviewConfigSchema = z.object({
  maxQuestions: z.number().int().min(1).max(10).default(2),
  outputFolder: z.string().min(1).default('interview'),
  autoOpenBrowser: z
    .boolean()
    .default(true)
    .describe(
      'Automatically open the interview UI in your default browser during interactive runs. Disabled automatically in tests and CI.',
    ),
  port: z.number().int().min(0).max(65535).default(0),
  dashboard: z.boolean().default(false),
});

export type InterviewConfig = z.infer<typeof InterviewConfigSchema>;

export const SessionManagerConfigSchema = z.object({
  maxSessionsPerAgent: z.number().int().min(1).max(10).default(2),
  readContextMinLines: z.number().int().min(0).max(1000).default(10),
  readContextMaxFiles: z.number().int().min(0).max(50).default(8),
});

export type SessionManagerConfig = z.infer<typeof SessionManagerConfigSchema>;

// Todo continuation configuration
export const TodoContinuationConfigSchema = z.object({
  maxContinuations: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe(
      'Maximum consecutive auto-continuations before stopping to ask user',
    ),
  cooldownMs: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .default(3000)
    .describe('Delay in ms before auto-continuing (gives user time to abort)'),
  autoEnable: z
    .boolean()
    .default(false)
    .describe(
      'Automatically enable auto-continue when the primary session has enough todos',
    ),
  autoEnableThreshold: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(4)
    .describe(
      'Number of todos that triggers auto-enable (only used when autoEnable is true)',
    ),
});

export type TodoContinuationConfig = z.infer<
  typeof TodoContinuationConfigSchema
>;

export const FailoverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().min(0).default(15000),
  retryDelayMs: z.number().min(0).default(500),
  chains: FallbackChainsSchema.default({}),
  retry_on_empty: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), empty provider responses are treated as failures, ' +
        'triggering fallback/retry. Set to false to treat them as successes.',
    ),
});

export type FailoverConfig = z.infer<typeof FailoverConfigSchema>;

export const HarnessPatternConfigSchema = z
  .object({
    completion: z.array(z.string()).optional(),
    testPass: z.array(z.string()).optional(),
    lintPass: z.array(z.string()).optional(),
    typecheckPass: z.array(z.string()).optional(),
    acknowledgesFailure: z.array(z.string()).optional(),
    acknowledgesUnverified: z.array(z.string()).optional(),
  })
  .strict();

export const HarnessMessageConfigSchema = z
  .object({
    verificationEvidence: z
      .object({
        subagentPending: z.string().optional(),
        toolFailedWithoutRecovery: z.string().optional(),
        modificationWithoutVerification: z.string().optional(),
      })
      .strict()
      .optional(),
    completionAuditor: z
      .object({
        testPassWithoutEvidence: z.string().optional(),
        lintPassWithoutEvidence: z.string().optional(),
        typecheckPassWithoutEvidence: z.string().optional(),
        completionWithPendingSubagent: z.string().optional(),
        completionWithPendingTasks: z.string().optional(),
        completionAfterFailureWithoutAcknowledgement: z.string().optional(),
        completionAgainstVerifierFail: z.string().optional(),
        completionAgainstVerifierPartial: z.string().optional(),
        modificationWithoutVerification: z.string().optional(),
        injectedHeader: z.string().optional(),
      })
      .strict()
      .optional(),
    toolResultBudget: z
      .object({
        persistedOutputTemplate: z.string().optional(),
        clearedOutputTemplate: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const HarnessConfigSchema = z
  .object({
    completionAuditor: z
      .object({
        enabled: z.boolean().optional(),
        blockOnUnverifiedModification: z.boolean().optional(),
        patterns: HarnessPatternConfigSchema.optional(),
      })
      .strict()
      .optional(),
    toolResultBudget: z
      .object({
        enabled: z.boolean().optional(),
        thresholds: z
          .object({
            default: z.number().int().positive().optional(),
            byTool: z
              .record(z.string(), z.number().int().positive())
              .optional(),
          })
          .strict()
          .optional(),
        previewChars: z.number().int().positive().optional(),
        storageBaseDir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    messages: HarnessMessageConfigSchema.optional(),
  })
  .strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

const ReviewConfigSchema = z.object({
  agent: z.string(),
  maxRetries: z.number().int().min(1).optional(),
});

export const StageNodeSchema = z.object({
  id: z.string().optional(),
  agent: z.string(),
  description: z.string().optional(),
  task: z.string().optional(),
  outputSchema: z.string().optional(),
  allowedSubagents: z.array(z.string()).optional(),
  review: ReviewConfigSchema.optional(),
});

export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = StageNodeSchema;

export const WorkflowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  stages: z.array(WorkflowNodeSchema),
});

export const WorkflowsConfigSchema = z.object({
  default: z.string().optional(),
  list: z.array(WorkflowDefinitionSchema).default(DEFAULT_WORKFLOWS),
});

export type WorkflowsConfig = WorkflowTypesConfig;

function validateCustomOnlyPromptFields(
  overrides: Record<string, z.infer<typeof AgentOverrideConfigSchema>>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number>,
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const isBuiltInOrAlias =
      (ALL_AGENT_NAMES as readonly string[]).includes(name) ||
      AGENT_ALIASES[name] !== undefined;

    if (!isBuiltInOrAlias) {
      continue;
    }

    if (override.prompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, name, 'prompt'],
        message: 'prompt is only supported for custom agents',
      });
    }
  }
}

export const PluginConfigSchema = z
  .object({
    preset: z.string().optional(),
    setDefaultAgent: z.boolean().optional(),
    scoringEngineVersion: z.enum(['v1', 'v2-shadow', 'v2']).optional(),
    balanceProviderUsage: z.boolean().optional(),
    showStartupToast: z
      .boolean()
      .optional()
      .describe(
        'Show the startup activation toast when OpenCode starts. Defaults to true.',
      ),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Disable automatic installation of plugin updates when false. Defaults to true.',
      ),
    manualPlan: ManualPlanSchema.optional(),
    presets: z.record(z.string(), PresetSchema).optional(),
    agents: z.record(z.string(), AgentOverrideConfigSchema).optional(),
    [TOOL_GROUPS_CONFIG_KEY]: ToolGroupsConfigSchema.optional().describe(
      'Named tool expression groups. Agent roles and @group tool entries resolve through this map.',
    ),
    disabled_agents: z
      .array(z.string())
      .optional()
      .describe(
        'Agent names to omit from generated AvailableAgents and delegation hints. ' +
          'Agents listed here are not advertised for delegation or mode switching. ' +
          'Use this for optional agents you do not want surfaced in runtime prompts.',
      ),
    disabled_mcps: z.array(z.string()).optional(),

    interview: InterviewConfigSchema.optional(),
    sessionManager: SessionManagerConfigSchema.optional(),
    workflows: WorkflowsConfigSchema.optional(),
    todoContinuation: TodoContinuationConfigSchema.optional(),
    fallback: FailoverConfigSchema.optional(),
    harness: HarnessConfigSchema.optional(),
    council: CouncilConfigSchema.optional(),
    visionModel: z
      .string()
      .optional()
      .describe(
        'Model ID (provider/model format) for the vision_analyze tool. ' +
          'This model is used to analyze images via direct API call. ' +
          'Defaults to "dmxapi/glm-4.1v-thinking-flash" if not set.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.agents) {
      validateCustomOnlyPromptFields(value.agents, ctx, ['agents']);
    }

    if (value.presets) {
      for (const [presetName, preset] of Object.entries(value.presets)) {
        validateCustomOnlyPromptFields(preset, ctx, ['presets', presetName]);
      }
    }
  });

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Agent names - re-exported from constants for convenience
export type { AgentName } from './constants';
