import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';

const z = tool.schema;

/** Read provider connection info from opencode.json. */
function readProviderConfig(
  providerName: string,
): { baseURL: string; apiKey: string } | null {
  try {
    const configDir = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'opencode',
    );
    const configPath = join(configDir, 'opencode.json');
    if (!existsSync(configPath)) return null;

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      provider?: Record<
        string,
        { options?: { baseURL?: string; apiKey?: string } }
      >;
    };
    const provider = config.provider?.[providerName];
    if (!provider?.options?.baseURL || !provider?.options?.apiKey) return null;
    return {
      baseURL: provider.options.baseURL,
      apiKey: provider.options.apiKey,
    };
  } catch {
    return null;
  }
}

/** Parse "provider/model" format into { provider, model }. */
function parseVisionModel(visionModel: string): {
  provider: string;
  model: string;
} {
  const slashIndex = visionModel.indexOf('/');
  if (slashIndex === -1) {
    // No provider prefix — assume dmxapi and use as model ID directly
    return { provider: 'dmxapi', model: visionModel };
  }
  return {
    provider: visionModel.slice(0, slashIndex),
    model: visionModel.slice(slashIndex + 1),
  };
}

function getMimeFromExt(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  return map[ext] ?? 'image/png';
}

const DEFAULT_VISION_MODEL = 'dmxapi/glm-4.1v-thinking-flash';

/**
 * Creates the vision_analyze tool.
 *
 * Directly calls the vision model API via fetch, bypassing OpenCode SDK
 * which has a known bug (#20001) where subtask handling strips file parts.
 *
 * @param visionModel - Model ID in "provider/model" format (e.g. "dmxapi/minimax-m2.7").
 *                      Falls back to DEFAULT_VISION_MODEL if not provided.
 */
export function createVisionAnalyzeTool(
  ctx: PluginInput,
  visionModel?: string,
): Record<string, ToolDefinition> {
  // Resolve the model: parse "provider/model" format, extract provider name for API call
  const { provider: providerName, model: modelId } = parseVisionModel(
    visionModel ?? DEFAULT_VISION_MODEL,
  );
  const vision_analyze = tool({
    description: `Analyze an image using a vision-capable model (currently: ${modelId}). Reads an image file from disk and returns a detailed text description.

Use this tool when:
- @observer needs to analyze an image
- You need to "see" a screenshot or visual content
- The read tool returns "[Image attachment detected...]" text instead of actual image content

The tool calls the vision model API directly, bypassing SDK limitations.`,
    args: {
      file_path: z
        .string()
        .describe('Absolute path to the image file to analyze'),
      goal: z
        .string()
        .optional()
        .describe(
          'What to extract from the image (default: thorough description)',
        ),
    },
    async execute(args, _toolContext) {
      const filePath = args.file_path;
      const goal =
        args.goal ??
        'Describe what you see in this image in detail. Include all visible text, UI elements, layout, colors, and overall purpose.';

      if (!existsSync(filePath)) {
        return `[vision_analyze error: File not found: ${filePath}]`;
      }

      // Resolve API connection from opencode.json provider config
      const conn = readProviderConfig(providerName);
      if (!conn) {
        return `[vision_analyze error: Could not read provider '${providerName}' config from opencode.json. Ensure provider exists with options.baseURL and options.apiKey.]`;
      }

      // Read and encode image
      const fileBuffer = readFileSync(filePath);
      const base64Data = fileBuffer.toString('base64');
      const mime = getMimeFromExt(filePath);
      const imageDataUrl = `data:${mime};base64,${base64Data}`;
      const displayName = basename(filePath);

      try {
        const response = await fetch(`${conn.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${conn.apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            stream: false,
            messages: [
              {
                role: 'system',
                content:
                  'You are a visual analysis specialist. Analyze images thoroughly and describe exactly what you see. Extract all text verbatim. Be precise and concise.',
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: goal },
                  {
                    type: 'image_url',
                    image_url: { url: imageDataUrl },
                  },
                ],
              },
            ],
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          return `[vision_analyze error: API returned HTTP ${response.status} - ${errText.substring(0, 500)}]`;
        }

        const responseText = await response.text();
        if (!responseText || responseText.trim().length === 0) {
          return '[vision_analyze error: empty response from API]';
        }

        let data: {
          choices?: Array<{
            message?: { content?: string; reasoning_content?: string };
          }>;
        };
        try {
          data = JSON.parse(responseText);
        } catch (parseErr) {
          return `[vision_analyze error: JSON parse error - ${parseErr instanceof Error ? parseErr.message : String(parseErr)}]`;
        }

        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          return `[vision_analyze error: no content in response. Keys: ${JSON.stringify(Object.keys(data ?? {}))}]`;
        }

        // Strip thinking tags if present
        const cleaned = content
          .replace(/<think[^>]*>[\s\S]*?<\/think>/g, '')
          .trim();
        return cleaned || content;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `[vision_analyze error: ${msg}]`;
      }
    },
  });

  return { vision_analyze };
}
