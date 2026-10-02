/** DCAR 1.1.0: CAutoR permission preset and deterministic-first tool gate. */
import z from "@deepseek-ai/schemastery";
import { DEFAULTS, resolveConfig, patchConfig } from "./config.js";
import { ReviewEngine } from "./engine.js";
import { attachPermissionAdapter } from "./permission-adapter.js";
import { attachDefaultPersistence } from "./preset-defaults.js";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
const handoffKey = Symbol.for("dcar.permission-handoff");
export const name = "@lytharalab/dsh-cons-auto-review";
export const inject = [
  "approval",
  "llm",
  "permissionPresets",
  "sessions",
  "tools",
  "fs",
  "sessionProjections",
];
export const PRESET = "CAutoR";
function schema(value) {
  if (Array.isArray(value)) return z.array(z.string()).default(value);
  if (value && typeof value === "object")
    return z
      .object(
        Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, schema(v)]),
        ),
      )
      .default(value);
  return (
    typeof value === "boolean"
      ? z.boolean()
      : typeof value === "number"
        ? z.number()
        : z.string()
  ).default(value);
}
const fields = Object.fromEntries(
  Object.entries(DEFAULTS).map(([k, v]) => [k, schema(v)]),
);
fields.rules = z
  .object({
    ...Object.fromEntries(
      Object.entries(DEFAULTS.rules)
        .filter(([k]) => k !== "customTools")
        .map(([k, v]) => [k, schema(v)]),
    ),
    customTools: z
      .array(
        z.object({
          name: z.string().required(),
          effect: z.union(["read", "write"]).required(),
          pathFields: z.array(z.string()).required(),
        }),
      )
      .default([]),
  })
  .default(DEFAULTS.rules);
fields.shell = z
  .object({
    ...Object.fromEntries(
      Object.entries(DEFAULTS.shell)
        .filter(([k]) => k !== "trustedCommands")
        .map(([k, v]) => [k, schema(v)]),
    ),
    trustedCommands: z
      .array(
        z.object({
          executable: z.string().required(),
          args: z.array(z.string()).required(),
        }),
      )
      .default([]),
  })
  .default(DEFAULTS.shell);
/** DSH plugin settings schema; full semantic validation runs at activation. */
export const Config = z.object(fields);
export { resolveConfig, DEFAULTS } from "./config.js";
export { ReviewEngine } from "./engine.js";
/** Install the gate before exposing any command that selects CAutoR. */
export function apply(ctx, input = {}) {
  const config = resolveConfig(input),
    presets = ctx.permissionPresets;
  if (
    typeof ctx.tools.get !== "function" ||
    typeof presets.catalog !== "function" ||
    typeof ctx.fs.resolve !== "function" ||
    typeof ctx.llm.stream !== "function"
  )
    throw new Error(
      "DCAR requires the DSH tools, filesystem, permission catalog and LLM extension APIs; see docs/COMPATIBILITY.md",
    );
  const fallback = presets.resolve(config.lifecycle.fallbackPreset);
  if (fallback.sandbox === "danger-full-access")
    throw new Error("DCAR disposal fallback must be a confined preset");
  const engine = new ReviewEngine(ctx, config),
    overrides = new WeakMap(),
    inherited = new WeakSet(),
    active = new Set();
  let handoff = Object.getOwnPropertyDescriptor(ctx.fiber, handoffKey)?.value;
  if (!handoff) {
    handoff = new WeakMap();
    Object.defineProperty(ctx.fiber, handoffKey, { value: handoff });
  }
  let accepting = true;
  let stopGate, stopDefaultPersistence, stopSessionCreated, stopAgentCreated;
  const admit = () => {
    if (!accepting || !config.enabled) throw new Error("DCAR is disabled or closing");
  };
  const getConfig = (session) => overrides.get(session) ?? config;
  function selected(session) {
    if (presets.current(session) === PRESET) return true;
    const state = ctx.sessionProjections.stateOf(session, "permissions");
    // In-process subagents pin approval=never; configured custom presets otherwise derive as custom.
    return state?.preset === PRESET && state.sandbox === "danger-full-access";
  }
  function markInherited(session) {
    if (!config.inheritSubagents || !session.header.parentSession) return;
    const parent = ctx.sessions.get(session.header.parentSession);
    if (!parent) return;
    const childState = ctx.sessionProjections.stateOf(session, "permissions");
    const capturedReview =
      childState?.sandbox === "danger-full-access" &&
      childState.approval === "never" &&
      childState.preset !== "danger-full-access" &&
      childState.preset !== "auto" &&
      parent
        .snapshotEvents()
        .some(
          (event) =>
            event.type === "permission/preset" && event.data.preset === PRESET,
        );
    // DSH captures its delegation knobs before awaiting child creation. Keep review
    // if the parent switched away while a captured custom review child was pending.
    if (selected(parent) || inherited.has(parent) || capturedReview)
      inherited.add(session);
  }
  ctx.effect(function* () {
    yield attachPermissionAdapter(presets);
    for (const session of ctx.sessions.list()) markInherited(session);
    yield stopSessionCreated = ctx.on(
      "session/created",
      (session) => {
        if (!accepting) return;
        markInherited(session);
        const state = ctx.sessionProjections.stateOf(session, "permissions");
        if (!session.header.parentSession && state?.preset === null &&
            state.sandbox === null && state.approval === null && !state.seeded &&
            presets.defaultPreset === PRESET)
          presets.set(session, accepting && config.enabled ? PRESET : config.lifecycle.fallbackPreset);
      },
      { prepend: true },
    );
    yield stopAgentCreated = ctx.on("agent/created", ({ agent }) => {
      if (!accepting) return;
      if (inherited.has(agent.session))
        agent.session.append("permission/preset", { preset: PRESET });
    });
    yield stopGate = ctx.on(
      "tools/pre-execute",
      async (exec, next) => {
        if (
          !exec.agent ||
          (exec.parent === undefined && exec.name === "run_code")
        )
          return next();
        if (!selected(exec.agent.session) && !inherited.has(exec.agent.session))
          return next();
        if (!accepting) return { kind: "cancel" };
        let done;
        const completed = new Promise((resolve) => {
          done = resolve;
        });
        active.add(completed);
        try {
          const c = getConfig(exec.agent.session);
          const decision = c.enabled
            ? await engine.review(exec, c)
            : engine.nonAllow(
                exec,
                "ask",
                "DCAR is disabled; select another permission mode",
                "DCAR_REVIEW_FAILED",
              );
          if (!accepting || exec.signal.aborted) return { kind: "cancel" };
          // A DCAR allow delegates: other policy listeners and DSH tool guards retain their decisions.
          if (decision.kind !== "allow") return decision;
          return await next();
        } finally {
          active.delete(completed);
          done();
        }
      },
      { prepend: true },
    );
    yield presets.registerReviewPreset(
      PRESET,
      {
        sandbox: "danger-full-access",
        approval: "ask",
        name: PRESET,
        description: "Con's 自动审查：程序直接放行安全操作，其余交给 LLM。",
      },
      admit,
    );
    // Dependency reloads reuse this plugin fiber. Restore only the exact session
    // cursor we confined on unload; a later user permission change invalidates it.
    for (const session of ctx.sessions.list()) {
      const pending = handoff.get(session);
      handoff.delete(session);
      if (!config.enabled || !pending || pending.seq !== session.seq) continue;
      presets.apply(session, PRESET, (policy) => setApprovalPolicy(session, pending.approval === "never" ? "never" : policy));
      if (pending.inherited) inherited.add(session);
    }
    // A session created while the persisted default's provider was absent starts
    // confined. Restore an untouched fresh root only after the review gate is live.
    if (config.enabled)
      for (const session of ctx.sessions.list()) {
        const state = ctx.sessionProjections.stateOf(session, "permissions");
        if (session.header.parentSession || state?.preset !== PRESET ||
            state.sandbox !== "read-only" || state.approval !== "never") continue;
        const events = session.snapshotEvents();
        if (events.some((event) => ["turn/start", "user/message", "assistant/message"].includes(event.type)) ||
            events.filter((event) => event.type === "sandbox/mode").length !== 1 ||
            events.filter((event) => event.type === "approval/policy").length !== 1) continue;
        presets.set(session, PRESET);
      }
    ctx.inject(["configEditor"], (child) => {
      child.effect(() => {
        const dispose = attachDefaultPersistence(child.configEditor, presets, admit);
        stopDefaultPersistence = dispose;
        return dispose;
      });
    });
    if (config.commands.enabled)
      ctx.inject(["commands"], (child) => {
        child.effect(() =>
          child.commands.register({
            name: config.commands.name,
            description: "Con's 自动审查：切换 CAutoR、查看统计、历史和配置",
            input: {
              hint: "on | off | status | stats | history [N] | config [JSON] | reset | clear-cache | check <tool> <JSON>",
            },
            handler: async ({ agent, rawInput, signal }) => {
              const text = rawInput.trim(),
                space = text.indexOf(" "),
                cmd = space < 0 ? text : text.slice(0, space),
                rest = space < 0 ? "" : text.slice(space + 1).trim(),
                session = agent.session;
              try {
                if (cmd === "on") {
                  if (!getConfig(session).enabled)
                    throw new Error("DCAR is disabled in configuration");
                  presets.set(session, PRESET);
                  return { kind: "success", text: "CAutoR 已启用。" };
                }
                if (cmd === "off") {
                  presets.set(session, config.lifecycle.fallbackPreset);
                  inherited.delete(session);
                  return {
                    kind: "success",
                    text: `已切换至 ${config.lifecycle.fallbackPreset}。`,
                  };
                }
                if (cmd === "config") {
                  if (rest) {
                    if (!config.commands.allowSessionConfig)
                      throw new Error("Session configuration is disabled");
                    const patch = JSON.parse(rest);
                    if (
                      Object.keys(patch).some(
                        (k) =>
                          ![
                            "enabled",
                            "rules",
                            "shell",
                            "review",
                            "cache",
                            "audit",
                          ].includes(k),
                      )
                    )
                      throw new Error(
                        "Change lifecycle, commands and inheritSubagents in the profile configuration and restart DSH",
                      );
                    overrides.set(
                      session,
                      patchConfig(getConfig(session), patch),
                    );
                    engine.clearCache();
                  }
                  return {
                    kind: "success",
                    text: JSON.stringify(getConfig(session), null, 2),
                  };
                }
                if (cmd === "stats")
                  return {
                    kind: "success",
                    text: JSON.stringify(
                      engine.audit.stats(session.id),
                      null,
                      2,
                    ),
                  };
                if (cmd === "history") {
                  const n = rest ? Number(rest) : 20;
                  if (
                    !Number.isSafeInteger(n) ||
                    n < 1 ||
                    n > getConfig(session).audit.historyLimit
                  )
                    throw new Error(
                      `N must be 1..${getConfig(session).audit.historyLimit}`,
                    );
                  return {
                    kind: "success",
                    text: JSON.stringify(
                      engine.audit.history(session.id, n),
                      null,
                      2,
                    ),
                  };
                }
                if (cmd === "reset") {
                  engine.audit.reset(session.id);
                  overrides.delete(session);
                  engine.clearCache();
                  return {
                    kind: "success",
                    text: "会话配置、统计和审查缓存已重置。",
                  };
                }
                if (cmd === "clear-cache") {
                  engine.clearCache();
                  return { kind: "success", text: "审查缓存已清空。" };
                }
                if (cmd === "check") {
                  const i = rest.indexOf(" ");
                  if (i < 1)
                    throw new Error("Usage: /dcar check <tool> <JSON>");
                  const { deterministic } = await import("./deterministic.js");
                  const result = await deterministic(
                    {
                      name: rest.slice(0, i),
                      arguments: JSON.parse(rest.slice(i + 1)),
                      agent,
                      signal,
                    },
                    ctx,
                    getConfig(session),
                    signal,
                  );
                  return {
                    kind: "success",
                    text: JSON.stringify(result, null, 2),
                  };
                }
                if (cmd === "" || cmd === "status")
                  return {
                    kind: "success",
                    text: `DCAR 1.1.0 | 当前权限：${presets.current(session)} | CAutoR 审查：${selected(session) || inherited.has(session) ? "启用" : "未启用"}\n/dcar on · off · stats · history · config · reset · clear-cache · check`,
                  };
                return {
                  kind: "error",
                  text: `未知子命令 ${cmd}；使用 /${config.commands.name} 查看帮助。`,
                };
              } catch (error) {
                return { kind: "error", text: String(error.message ?? error) };
              }
            },
          }),
        );
      });
    yield async () => {
      accepting = false;
      engine.lifecycle.abort(new Error("DCAR plugin disposed"));
      try {
        for (const session of ctx.sessions.list())
          if (selected(session) || inherited.has(session)) {
            const state = ctx.sessionProjections.stateOf(session, "permissions");
            const wasInherited = inherited.has(session);
            presets.set(session, config.lifecycle.fallbackPreset);
            handoff.set(session, { seq: session.seq, approval: state?.approval, inherited: wasInherited });
          }
      } finally {
        stopGate?.();
        stopSessionCreated?.();
        stopAgentCreated?.();
        stopDefaultPersistence?.();
        await Promise.allSettled([...active]);
        await engine.stop();
      }
    };
  }, "DCAR authorization lifecycle");
}
