import { z } from "zod";
import { PluginConfigSchema } from "../src/config/schema";

export function generatePluginConfigSchemaJson(): string {
  const schema = z.toJSONSchema(PluginConfigSchema, {
    // Use 'input' so defaulted fields are optional in the schema,
    // matching how users actually write their config files.
    io: "input",
  });

  const jsonSchema = {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "oh-my-opencode-slim",
    description: "Configuration schema for oh-my-opencode-slim plugin for OpenCode",
  };

  return `${JSON.stringify(jsonSchema, null, 2)}\n`;
}
