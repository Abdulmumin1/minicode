/** A JSON Schema document. minicode validates a practical subset of it. */
export type JsonSchema = Record<string, unknown>;

/** Plain JSON data: what crosses between a program and the host. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ToolContext {
  /** Aborted when the program ends, times out, or is interrupted. */
  signal: AbortSignal;
}

export interface Tool<Input = any, Output = any> {
  description?: string;
  /** Validated before `execute` runs, and shown to the model as a TypeScript signature. */
  input?: JsonSchema;
  /** Only used for the signature shown to the model. */
  output?: JsonSchema;
  execute(input: Input, context: ToolContext): Output | Promise<Output>;
}

/** Tools grouped by namespace: `{ math: { add } }` is called as `tools.math.add(...)`. */
export interface ToolTree {
  [name: string]: Tool | ToolTree;
}

export interface Limits {
  /** Total run time. Default 30,000. */
  timeoutMs?: number;
  /** Tool calls, `search()` and `fetch` calls. Default 100. */
  maxToolCalls?: number;
  /** Result and console output kept. Default 64,000. */
  maxOutputBytes?: number;
  /** Host heap growth allowed during a run. Default 256. */
  maxHeapGrowthMB?: number;
}

export interface FetchOptions {
  /** Hostnames the program may fetch, or `["*"]` for any. */
  allow: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RuntimeOptions {
  tools?: ToolTree;
  limits?: Limits;
  /** Adds a `fetch` global, limited to the allowed hosts. Off by default. */
  fetch?: FetchOptions;
}

export type ErrorKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "ExecutionFailure"
  | "TimeoutExceeded"
  | "ToolCallLimitExceeded"
  | "MemoryLimit"
  | "ResourceLimit"
  | "Stuck"
  | "Interrupted"
  | "InvalidResult"
  | "InternalError";

export interface ToolCallRecord {
  tool: string;
  input: Json;
  status: "running" | "completed" | "error" | "interrupted";
  /** When the call started, in ms since the run began. */
  startMs?: number;
  ms?: number;
  error?: string;
}

export interface RunStats {
  steps: number;
  slices: number;
  jobs: number;
  ms: number;
}

interface ResultBase {
  logs: string[];
  toolCalls: ToolCallRecord[];
  warnings?: string[];
  truncated?: boolean;
  stats: RunStats;
}

export type Result =
  | (ResultBase & { ok: true; value: Json })
  | (ResultBase & { ok: false; error: { kind: ErrorKind; message: string; line?: number; column?: number } });

export interface Runtime {
  /** Every tool's call path and description. */
  catalog(): Array<{ path: string; description?: string }>;
  /** TypeScript-style signatures for every tool, for the model's prompt. */
  describe(): string;
  /** Run one program. Never throws for program errors; check `ok`. */
  execute(code: string, options?: { signal?: AbortSignal }): Promise<Result>;
}

export declare const DEFAULT_LIMITS: Required<Limits>;

export declare function createRuntime(options?: RuntimeOptions): Runtime;

/** The model-facing signature of a tool, e.g. `tools.math.add(input: {...}): Promise<number>`. */
export declare function signature(tool: Tool & { path: string[] }): string;

export declare function schemaToTs(schema: JsonSchema, indent?: string): string;

export declare function searchTools(
  registry: Map<string, Tool & { path: string[] }>,
  options?: { query?: string; namespace?: string; limit?: number; offset?: number },
): {
  items: Array<{ path: string; description: string; signature: string }>;
  remaining: number;
  next: { offset: number } | null;
};

export declare function toolExpression(path: string[]): string;
