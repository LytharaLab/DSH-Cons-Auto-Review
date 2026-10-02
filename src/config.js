/** Validated, immutable runtime configuration. Only allow/escalate exist in layer one. */
export const DEFAULTS = freeze({
  enabled: true,
  inheritSubagents: true,
  rules: {
    enabled: true,
    allowOutsideReads: true,
    includeTempRoots: true,
    additionalWritableRoots: [],
    protectedPaths: [
      "**/.git/**",
      "**/.dsh/**",
      "**/.dcar/**",
      "**/.ssh/**",
      "**/.aws/**",
      "**/.gnupg/**",
      "**/.env",
      "**/.env.*",
      "**/.npmrc",
      "**/credentials.json",
    ],
    safeEnvironmentFiles: [".env.example", ".env.sample", ".env.template"],
    readTools: ["read", "read_image"],
    searchTools: ["glob", "grep", "ls"],
    writeTools: ["write", "edit"],
    harmlessTools: ["todo_write"],
    alwaysReviewTools: [],
    trustedTools: [],
    customTools: [],
    maxArgumentBytes: 2097152,
  },
  shell: {
    enabled: true,
    tools: ["bash", "pwsh"],
    readCommands: [
      "pwd",
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "rg",
      "grep",
      "echo",
      "Get-Location",
      "Get-ChildItem",
      "Get-Content",
      "Write-Output",
    ],
    workspaceMutationCommands: ["mkdir", "touch"],
    trustedCommands: [],
    maxCommandChars: 8192,
  },
  review: {
    provider: "",
    model: "",
    reasoningEffort: "",
    preferLowReasoning: true,
    timeoutMs: 120000,
    maxTokens: 8192,
    maxTokensLimit: 32768,
    tokenLimitRetries: 2,
    tokenGrowthFactor: 2,
    chineseReasonRetries: 1,
    maxReasonChars: 600,
    showAction: true,
    maxActionChars: 3000,
    temperature: 0,
    retries: 0,
    retryDelayMs: 300,
    concurrency: 2,
    maxQueued: 128,
    onError: "ask",
    onDeny: "ask",
    policyAppend: "",
    maxInputChars: 180000,
    allowAsk: true,
  },
  cache: { enabled: false, ttlMs: 30000, maxEntries: 128 },
  audit: {
    enabled: true,
    file: "",
    maxBytes: 5242880,
    historyLimit: 200,
    includeArguments: false,
    includeReasons: true,
  },
  commands: { enabled: true, name: "dcar", allowSessionConfig: true },
  lifecycle: { fallbackPreset: "workspace-write" },
});
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const enums = {
  "review.onError": ["ask", "deny"],
  "review.onDeny": ["ask", "deny"],
};
const ranges = {
  "rules.maxArgumentBytes": [1024, 16777216],
  "shell.maxCommandChars": [64, 1048576],
  "review.timeoutMs": [10, 600000],
  "review.maxTokens": [64, 65536],
  "review.maxTokensLimit": [64, 65536],
  "review.tokenLimitRetries": [0, 5],
  "review.tokenGrowthFactor": [2, 4],
  "review.chineseReasonRetries": [0, 2],
  "review.maxReasonChars": [100, 4000],
  "review.maxActionChars": [200, 32768],
  "review.temperature": [0, 2],
  "review.retries": [0, 5],
  "review.retryDelayMs": [0, 10000],
  "review.concurrency": [1, 32],
  "review.maxQueued": [1, 4096],
  "review.maxInputChars": [1024, 4000000],
  "cache.ttlMs": [1, 3600000],
  "cache.maxEntries": [1, 10000],
  "audit.maxBytes": [1024, 1073741824],
  "audit.historyLimit": [1, 10000],
};
function merge(defaults, input, prefix = "") {
  if (!object(input))
    throw new Error(`DCAR config ${prefix || "<root>"} must be an object`);
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key))
      throw new Error(`Unknown DCAR config: ${prefix}${key}`);
  const output = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const name = `${prefix}${key}`,
      value = Object.hasOwn(input, key)
        ? input[key]
        : structuredClone(fallback);
    if (object(fallback)) {
      output[key] = merge(fallback, value, `${name}.`);
      continue;
    }
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
      if (
        !["rules.customTools", "shell.trustedCommands"].includes(name) &&
        value.some((x) => typeof x !== "string" || !x.trim())
      )
        throw new Error(`${name} must contain non-empty strings`);
      output[key] = structuredClone(value);
      continue;
    }
    if (
      typeof value !== typeof fallback ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error(`${name} has an invalid type`);
    if (enums[name] && !enums[name].includes(value))
      throw new Error(`${name} must be ${enums[name].join(" or ")}`);
    if (
      ranges[name] &&
      (value < ranges[name][0] ||
        value > ranges[name][1] ||
        (name !== "review.temperature" && !Number.isSafeInteger(value)))
    )
      throw new Error(`${name} is outside the supported range`);
    output[key] = value;
  }
  return output;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Merge with defaults, reject unknown fields and invalid security rules, then freeze. */
export function resolveConfig(input = {}) {
  const c = merge(DEFAULTS, input);
  if (!!c.review.provider !== !!c.review.model)
    throw new Error(
      "review.provider and review.model must both be set, or both be empty",
    );
  if (!/^[a-z][a-z0-9_-]*$/.test(c.commands.name))
    throw new Error("commands.name must be a lowercase slash-command name");
  if (
    !c.lifecycle.fallbackPreset ||
    c.lifecycle.fallbackPreset === "CAutoR" ||
    c.lifecycle.fallbackPreset === "danger-full-access"
  )
    throw new Error("lifecycle.fallbackPreset must name a confined preset");
  for (const rule of c.rules.customTools) {
    if (
      !object(rule) ||
      Object.keys(rule).some(
        (k) => !["name", "effect", "pathFields"].includes(k),
      ) ||
      typeof rule.name !== "string" ||
      !rule.name ||
      !["read", "write"].includes(rule.effect) ||
      !Array.isArray(rule.pathFields) ||
      !rule.pathFields.length ||
      rule.pathFields.some(
        (p) => typeof p !== "string" || !/^[a-zA-Z0-9_.]+$/.test(p),
      )
    )
      throw new Error(
        "rules.customTools entries require name, effect (read/write), and non-empty pathFields",
      );
  }
  for (const command of c.shell.trustedCommands) {
    if (
      !object(command) ||
      Object.keys(command).some((k) => !["executable", "args"].includes(k)) ||
      typeof command.executable !== "string" ||
      !command.executable ||
      !Array.isArray(command.args) ||
      command.args.some((a) => typeof a !== "string")
    )
      throw new Error(
        "shell.trustedCommands entries require an executable and exact args array",
      );
  }
  const toolSets = [
    c.rules.readTools,
    c.rules.searchTools,
    c.rules.writeTools,
    c.rules.harmlessTools,
    c.rules.customTools.map((r) => r.name),
  ];
  const all = toolSets.flat();
  if (new Set(all).size !== all.length)
    throw new Error(
      "A tool cannot occur in multiple deterministic tool classes",
    );
  return freeze(c);
}
/** Apply a validated user-originated session configuration patch. */
export function patchConfig(current, patch) {
  function overlay(a, b) {
    if (!object(b)) return b;
    const result = structuredClone(a);
    for (const [k, v] of Object.entries(b))
      result[k] = object(v) && object(a[k]) ? overlay(a[k], v) : v;
    return result;
  }
  return resolveConfig(overlay(current, patch));
}
