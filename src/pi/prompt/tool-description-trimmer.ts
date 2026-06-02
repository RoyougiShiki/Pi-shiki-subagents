export interface ToolDescriptionTrimConfig {
  hide?: string[];
  truncate?: Record<string, number>;
}

export function trimToolDescriptions(prompt: string, config: ToolDescriptionTrimConfig | Record<string, any>): string {
  const hide = new Set((config?.hide as string[]) ?? []);
  const truncCfg = (config?.truncate ?? {}) as Record<string, number>;
  const defaultTrunc = truncCfg.default ?? 0;

  const lines = prompt.split("\n");
  const out: string[] = [];
  let inTools = false;
  let inJsonSection = false;
  const jsonBlock: string[] = [];
  let braceDepth = 0;

  function flushJsonBlock(): void {
    if (jsonBlock.length === 0) return;
    const block = jsonBlock.join("\n");
    try {
      const obj = JSON.parse(block);
      if (obj && typeof obj.name === "string") {
        const name = obj.name;
        if (hide.has(name)) {
          jsonBlock.length = 0;
          return;
        }
        if (typeof obj.description === "string") {
          const maxLen = truncCfg[name] ?? defaultTrunc;
          if (maxLen > 0 && obj.description.length > maxLen) {
            obj.description = obj.description.slice(0, maxLen) + "...";
            jsonBlock.length = 0;
            jsonBlock.push(JSON.stringify(obj, null, 2));
          }
        }
      }
    } catch {}
    for (const l of jsonBlock) out.push(l);
    jsonBlock.length = 0;
  }

  for (const line of lines) {
    // Detect "Available Tool Schemas" section header
    if (/^\s*Available Tool Schemas/i.test(line)) {
      flushJsonBlock();
      inJsonSection = true;
      out.push(line);
      continue;
    }

    // Detect "Available tools" section header (line format)
    if (/^\s*Available tools[:\s]/i.test(line)) {
      flushJsonBlock();
      inTools = true;
      inJsonSection = false;
      out.push(line);
      continue;
    }

    if (inJsonSection) {
      const trimmed = line.trim();
      if (trimmed === "" && jsonBlock.length === 0) {
        out.push(line);
        continue;
      }
      if (trimmed === "" && jsonBlock.length > 0) {
        flushJsonBlock();
        out.push(line);
        continue;
      }

      jsonBlock.push(line);
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }

      if (braceDepth <= 0 && jsonBlock.length > 0) {
        flushJsonBlock();
        braceDepth = 0;
      }
      continue;
    }

    if (inTools) {
      // Tool line: "- tool_name: description" (allow indentation + underscore names)
      const match = line.match(/^\s*-\s+([A-Za-z0-9_]+):\s*/);
      if (match) {
        const name = match[1]!;
        const desc = line.slice(match[0].length);

        if (hide.has(name)) {
          // Hidden tools must be removed from visible list to avoid prompt leakage.
        } else {
          const maxLen = truncCfg[name] ?? defaultTrunc;
          if (maxLen > 0 && desc.length > maxLen) {
            out.push(`  - ${name}: ${desc.slice(0, maxLen)}...`);
          } else {
            out.push(line);
          }
        }
        continue;
      }

      // Empty line or non-bullet line: end of tools section
      if (line.trim() === "" || !/^\s*-\s+/.test(line)) {
        inTools = false;
        out.push(line);
        continue;
      }
    }

    out.push(line);
  }

  flushJsonBlock();
  return out.join("\n");
}

export function trimProviderToolDescriptions(
  obj: Record<string, any>,
  hide: Set<string>,
  truncCfg: Record<string, number>,
  defaultTrunc: number,
): void {
  // OpenAI / Anthropic format: { tools: [{ function: { name, description } }] }
  if (Array.isArray(obj.tools)) {
    obj.tools = obj.tools.filter((t: any) => {
      const name = t.function?.name ?? t.name ?? "";
      if (hide.has(name)) return false;
      const descField = t.function?.description ?? t.description ?? "";
      if (typeof descField === "string") {
        const maxLen = truncCfg[name] ?? defaultTrunc;
        if (maxLen > 0 && descField.length > maxLen) {
          if (t.function) t.function.description = descField.slice(0, maxLen) + "...";
          else t.description = descField.slice(0, maxLen) + "...";
        }
      }
      return true;
    });
  }
  // Google / Vertex format: { tools: [{ functionDeclarations: [{ name, description }] }] }
  for (const t of (Array.isArray(obj.tools) ? obj.tools : [])) {
    if (Array.isArray(t.functionDeclarations)) {
      t.functionDeclarations = t.functionDeclarations.filter((fd: any) => {
        const name = fd.name ?? "";
        if (hide.has(name)) return false;
        const maxLen = truncCfg[name] ?? defaultTrunc;
        if (maxLen > 0 && typeof fd.description === "string" && fd.description.length > maxLen) {
          fd.description = fd.description.slice(0, maxLen) + "...";
        }
        return true;
      });
    }
  }
}
