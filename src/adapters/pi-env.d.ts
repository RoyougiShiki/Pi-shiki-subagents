/**
 * Type declarations for pi extension modules.
 * These are resolved at runtime by pi's jiti loader.
 */

declare module "@earendil-works/pi-coding-agent" {
  import type { Static, TSchema } from "typebox";

  // ── Core types ──────────────────────────────────────────────────────

  export interface ExtensionAPI {
    on<K extends keyof ExtensionEventMap>(
      event: K,
      handler: ExtensionEventMap[K],
    ): void;
    registerTool<T extends TSchema = any>(
      definition: ToolDefinition<T>,
    ): void;
    registerCommand(
      name: string,
      options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
    ): void;
    registerMessageRenderer(
      customType: string,
      renderer: (message: any, options: any, theme: any) => any,
    ): void;
    sendMessage(
      message: { customType: string; content: string; display?: boolean; details?: any },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void;
    sendUserMessage(
      content: string | any[],
      options?: { deliverAs?: "steer" | "followUp" },
    ): void;
    appendEntry(customType: string, data?: any): void;
    getAllTools(): Array<{ name: string; description?: string; parameters?: any; sourceInfo?: any }>;
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
    setModel(model: any): Promise<boolean>;
    getThinkingLevel(): string;
    setThinkingLevel(level: string): void;
    exec(command: string, args?: string[], options?: { signal?: AbortSignal; timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; code: number | null; killed?: boolean }>;
    events: {
      emit(event: string, data?: any): void;
    };
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    sessionManager: SessionManager;
    signal?: AbortSignal;
    ui: ExtensionUI;
    modelRegistry: ModelRegistry;
    model?: any;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    switchSession(sessionPath: string, options?: {
      withSession?: (ctx: any) => Promise<void>;
    }): Promise<{ cancelled: boolean }>;
  }

  export interface ISessionManager {
    getBranch(): SessionEntry[];
    getEntries(): SessionEntry[];
    getLeafId(): string | undefined;
    getSessionFile(): string | undefined;
  }
  // Alias used in imports
  export type SessionManager = ISessionManager;
  export declare var SessionManager: {
    create(cwd: string): ISessionManager;
    inMemory(): ISessionManager;
    list(cwd: string): Promise<string[]>;
    listAll(cwd: string): Promise<string[]>;
  };

  export type SessionEntry = {
    type: string;
    [key: string]: any;
  };

  export interface ModelRegistry {
    find(provider: string, model: string): any;
    getApiKeyAndHeaders(model: any): Promise<{ ok: boolean; apiKey?: string; error?: string }>;
  }

  export interface ExtensionUI {
    notify(message: string, level: "info" | "warning" | "error" | "success"): void;
    confirm(title: string, message: string): Promise<boolean>;
    select<T>(title: string, options: T[]): Promise<T | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    setStatus(id: string, text: string): void;
    setWidget(id: string, lines: string[] | undefined): void;
    custom<T>(
      builder: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
      options?: any,
    ): Promise<T>;
  }

  export interface ToolDefinition<T extends TSchema = any> {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: T;
    execute?(
      toolCallId: string,
      params: Static<T>,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: any) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<{ content: Array<{ type: string; text?: string }>; details: any; isError?: boolean; stopAgent?: boolean }>;
    renderCall?(args: any, theme: any, context: any): any;
    renderResult?(result: any, options: { expanded: boolean; isPartial?: boolean }, theme: any, context: any): any;
  }

  export interface ExtensionEventMap {
    session_start: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    session_shutdown: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    session_tree: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    before_agent_start: (
      event: { prompt: string; images?: any[]; systemPrompt: string; systemPromptOptions: any },
      ctx: ExtensionContext,
    ) => Promise<{ systemPrompt?: string; message?: any } | void>;
    agent_start: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    agent_end: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    turn_start: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    turn_end: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    message_start: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    message_update: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    message_end: (event: any, ctx: ExtensionContext) => Promise<{ message?: any } | void>;
    tool_execution_start: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    tool_execution_end: (event: any, ctx: ExtensionContext) => Promise<void> | void;
    tool_call: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>;
    tool_result: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<{ content?: any[]; details?: any; isError?: boolean } | void>;
    context: (event: { messages: any[] }, ctx: ExtensionContext) => Promise<{ messages: any[] } | void>;
    before_provider_request: (event: { payload: Record<string, any> }, ctx: ExtensionContext) => void;
    resources_discover: (event: any, ctx: ExtensionContext) => Promise<any>;
    input: (event: { text: string; images?: any[]; source: string }, ctx: ExtensionContext) => Promise<any>;
    model_select: (event: any, ctx: ExtensionContext) => Promise<void> | void;
  }

  export interface ToolCallEvent {
    toolName: string;
    toolCallId: string;
    input: Record<string, any>;
  }

  export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
  }

  export interface ToolResultEvent {
    toolName: string;
    toolCallId: string;
    input: Record<string, any>;
    content: any[];
    details: any;
    isError?: boolean;
  }

  export function isToolCallEventType(type: string, event: ToolCallEvent): boolean;
  export function isBashToolResult(event: ToolResultEvent): boolean;
  export function isEditToolResult(event: ToolResultEvent): boolean;
  export function isReadToolResult(event: ToolResultEvent): boolean;
  export function isWriteToolResult(event: ToolResultEvent): boolean;
  export class DynamicBorder {
    constructor(color?: (str: string) => string);
    invalidate(): void;
    render(width: number): string[];
  }

  export function getAgentDir(): string;
  export function parseFrontmatter<T>(content: string): { frontmatter: T; body: string };
  export function stripFrontmatter(content: string): string;

  // SDK
  export function createAgentSession(options?: {
    cwd?: string;
    model?: any;
    thinkingLevel?: string;
    tools?: string[];
    sessionManager?: SessionManager;
  }): Promise<{ session: AgentSession }>;

  export interface AgentSession {
    prompt(text: string, options?: { source?: string }): Promise<void>;
    state: { messages: any[] };
    subscribe(fn: (event: any) => void): () => void;
    dispose(): void;
    abort(): Promise<void>;
    isStreaming: boolean;
  }
}

declare module "@earendil-works/pi-tui" {
  export enum Key {
    up = "up",
    down = "down",
    pageUp = "pageUp",
    pageDown = "pageDown",
  }
  export function matchesKey(data: string, key: Key): boolean;

  export class Container {
    children: any[];
    addChild(c: any): void;
    removeChild(c: any): void;
    clear(): void;
    invalidate(): void;
    render(width: number): string[];
  }
  export class Input {
    focused: boolean;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    invalidate(): void;
    render(width: number): string[];
  }
  export class Spacer {
    constructor(n?: number);
    invalidate(): void;
    render(width: number): string[];
  }
  export class Text {
    constructor(text: string, paddingX?: number, paddingY?: number);
    setText(text: string): void;
    invalidate(): void;
    render(width: number): string[];
  }
}

declare module "typebox" {
  import type { TSchema } from "typebox";

  export const Type: {
    String(options?: Partial<{ description: string; default?: string }>): TSchema;
    Number(options?: Partial<{ description: string; default?: number }>): TSchema;
    Integer(options?: Partial<{ description: string; default?: number }>): TSchema;
    Boolean(options?: Partial<{ description: string; default?: boolean }>): TSchema;
    Array<T extends TSchema>(schema: T, options?: Partial<{ description: string }>): TSchema;
    Object<T extends Record<string, TSchema>>(
      properties: T,
      options?: Partial<{ description: string }>,
    ): TSchema;
    Optional<T extends TSchema>(schema: T): TSchema;
    Union<T extends TSchema[]>(schemas: [...T]): TSchema;
    Literal<T extends string | number | boolean>(value: T): TSchema;
    Record<K extends TSchema, V extends TSchema>(key: K, value: V): TSchema;
    Ref(name: string): TSchema;
    Cyclic(schemaFactory: any, name: string): TSchema;
  };

  export type Static<T extends TSchema> = T extends { static: infer S } ? S : any;
}
