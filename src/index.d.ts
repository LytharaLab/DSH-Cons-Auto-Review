import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
export interface DCARConfig {
  enabled: boolean;
  inheritSubagents: boolean;
  rules: {
    enabled: boolean;
    allowOutsideReads: boolean;
    includeTempRoots: boolean;
    additionalWritableRoots: string[];
    protectedPaths: string[];
    safeEnvironmentFiles: string[];
    readTools: string[];
    searchTools: string[];
    writeTools: string[];
    harmlessTools: string[];
    alwaysReviewTools: string[];
    trustedTools: string[];
    customTools: {
      name: string;
      effect: "read" | "write";
      pathFields: string[];
    }[];
    maxArgumentBytes: number;
  };
  shell: {
    enabled: boolean;
    tools: string[];
    readCommands: string[];
    workspaceMutationCommands: string[];
    trustedCommands: { executable: string; args: string[] }[];
    maxCommandChars: number;
  };
  review: {
    provider: string;
    model: string;
    reasoningEffort: string;
    preferLowReasoning: boolean;
    timeoutMs: number;
    maxTokens: number;
    maxTokensLimit: number;
    tokenLimitRetries: number;
    tokenGrowthFactor: number;
    chineseReasonRetries: number;
    maxReasonChars: number;
    showAction: boolean;
    maxActionChars: number;
    temperature: number;
    retries: number;
    retryDelayMs: number;
    concurrency: number;
    maxQueued: number;
    onError: "ask" | "deny";
    onDeny: "ask" | "deny";
    policyAppend: string;
    maxInputChars: number;
    allowAsk: boolean;
  };
  cache: { enabled: boolean; ttlMs: number; maxEntries: number };
  audit: {
    enabled: boolean;
    file: string;
    maxBytes: number;
    historyLimit: number;
    includeArguments: boolean;
    includeReasons: boolean;
  };
  commands: { enabled: boolean; name: string; allowSessionConfig: boolean };
  lifecycle: { fallbackPreset: string };
}
export type PartialConfig = {
  [K in keyof DCARConfig]?: DCARConfig[K] extends object
    ? Partial<DCARConfig[K]>
    : DCARConfig[K];
};
export const name: "@lytharalab/dsh-cons-auto-review";
export const PRESET: "CAutoR";
export const inject: string[];
export const Config: z<DCARConfig>;
export const DEFAULTS: Readonly<DCARConfig>;
export function resolveConfig(input?: PartialConfig): Readonly<DCARConfig>;
export function apply(ctx: Context, config?: PartialConfig): void;
/** Low-level review engine; DSH normally instantiates this through apply(). */
export class ReviewEngine {
  constructor(
    ctx: Context,
    config: Readonly<DCARConfig>,
    options?: { snapshot?: Function; read?: Function },
  );
  review(
    exec: {
      agent: { session: { id: string; header: { cwd: string } } };
      name: string;
      arguments: unknown;
      callId: string;
      signal: AbortSignal;
    },
    config?: Readonly<DCARConfig>,
  ): Promise<
    | { kind: "allow" | "cancel" }
    | { kind: "ask"; reason: string; displayReason: Record<string, string> }
    | {
        kind: "deny";
        reason: string;
        info: { name: string; code: string; reason: string };
      }
  >;
  clearCache(): void;
  stop(): Promise<void>;
}
