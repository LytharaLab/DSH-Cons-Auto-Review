import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, writeFile } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import * as ToolFS from "@deepseek-ai/dsh-tool-fs";
import LlmRuntime, {
  LlmAdapter,
  createMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import Approval from "@deepseek-ai/dsh-user-approval";
import Commands from "@deepseek-ai/dsh-commands";
import PermissionPresets from "@deepseek-ai/dsh-permission-presets";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Settings from "@deepseek-ai/dsh-settings";
import Bridge from "../src/permission-presets.js";
import * as Plugin from "../src/index.js";
import { fixture, chunks } from "./helpers.js";
import { parse } from "yaml";
import { DORMANT_PRESET } from "../src/preset-defaults.js";
class Adapter extends LlmAdapter {
  requests = [];
  text = '{"risk":"low","decision":"allow"}';
  produce;
  async *stream(options) {
    this.requests.push(options);
    yield* this.produce ? this.produce(options, this.requests.length) : chunks(this.text);
  }
}
async function mounted(t, options = {}) {
  const f = await fixture(),
    ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(Projection);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalFS, { cwd: f.cwd });
  await ctx.plugin(ToolFS);
  ctx.provide("shell", { sandboxMode: "workspace-write" });
  await ctx.plugin(Approval, { policy: "ask" });
  await ctx.plugin(Commands);
  const permissionConfig = options.permissionConfig ?? {
    presets: {
      "read-only": { sandbox: "read-only", approval: "ask" },
      "workspace-write": { sandbox: "workspace-write", approval: "ask" },
      "danger-full-access": {
        sandbox: "danger-full-access",
        approval: "never",
      },
    },
  };
  let entry, configFile, plugin, originalEdit;
  if (options.settings) {
    await ctx.plugin(Loader);
    ctx.loader.builtins.permission = options.legacyBridge ? Bridge : PermissionPresets;
    await ctx.loader.create({ id: "permission-custom", name: "cordis:permission", config: permissionConfig });
    entry = ctx.loader.resolve("permission-custom");
    configFile = `${f.root}/permission-settings.json`;
    const inherited = structuredClone(permissionConfig);
    ctx.provide("profileContext", { home: f.root, dir: f.root });
    // Exercise native Settings and Loader; the test store writes detached JSON
    // instead of running DSH's whole multi-layer profile configuration editor.
    ctx.provide("configEditor", {
      entries() { return [entry]; },
      configuration() { return [{ entry, inherited, override: entry.options.config }]; },
      async edit(target, change) {
        const next = change(structuredClone(target.options.config), structuredClone(inherited));
        await writeFile(configFile, JSON.stringify(next));
        await target.update({ config: next });
        await ctx.loader.await();
        if (plugin) await plugin.await();
      },
    });
    originalEdit = Object.getOwnPropertyDescriptor(ctx.configEditor, "edit").value;
    await ctx.plugin(Settings);
  } else {
    await ctx.plugin(options.legacyBridge ? Bridge : PermissionPresets, permissionConfig);
  }
  const adapter = new Adapter();
  ctx.llm.registerAdapter(["test"], adapter);
  plugin = options.withoutPlugin
    ? undefined
    : await ctx.plugin(
        Plugin,
        options.config ?? { rules: { includeTempRoots: false } },
      );
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(f.root, { recursive: true, force: true });
  });
  const session = ctx.sessions.create(SessionId("integration"), {
      meta: { cwd: f.cwd },
    }),
    agent = {
      id: session.id,
      session,
      options: { provider: "test", model: "fake" },
    };
  const calls = new WeakMap();
  async function run(name, args, caller = agent) {
    const session = caller.session;
    const n = (calls.get(session) ?? 0) + 1;
    calls.set(session, n);
    const id = `call-${n}`,
      raw = JSON.stringify(args);
    if (n === 1) session.append("turn/start", { turn: 1 });
    session.append("request/header", {
      header: {
        config: { provider: "test", model: "fake" },
        tools: ctx.tools.schemas(),
      },
      reason: session.requestHeader() ? "change" : "initial",
    });
    session.append(
      "user/message",
      createUserMessage({
        source: { kind: "user", rpcId: `rpc-${n}` },
        content: [
          { type: "text", text: "Edit project files and test the project." },
        ],
      }),
      { surfaceOp: "append" },
    );
    session.append("step/start", { turn: 1, step: n });
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: n,
        stream: [],
        message: createMessage({
          role: "assistant",
          source: { kind: "model", provider: "test", model: "fake" },
          content: [{ type: "tool-call", id, name, arguments: raw }],
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("tool/call", {
      turn: 1,
      step: n,
      callId: id,
      name,
      arguments: raw,
    });
    const result = await ctx.tools.execute({
      name,
      arguments: args,
      agent: caller,
      callId: id,
      signal: new AbortController().signal,
    });
    session.append("step/end", { turn: 1, step: n });
    return result;
  }
  return { ...f, ctx, adapter, plugin, session, agent, run, entry, configFile, originalEdit };
}
function probe(ctx, name = "probe") {
  let runs = 0;
  ctx.tools.register({
    name,
    description: "integration probe",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "string" },
      render: (value) => [{ type: "text", text: value }],
    },
    async execute() {
      runs++;
      return "executed";
    },
  });
  return () => runs;
}
test("real LLM and tool services recover max-tokens before executing once", async (t) => {
  const f = await mounted(t, { config: { review: { retryDelayMs: 0 } } });
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.produce = (_, n) => chunks('{"risk":"low","decision":"allow"}', n === 1 ? "max-tokens" : "stop");
  const result = await f.run("probe", { target: "exact" });
  assert.equal(result.isError, false);
  assert.equal(count(), 1);
  assert.deepEqual(f.adapter.requests.map((r) => r.maxTokens), [8192, 16384]);
  assert.equal(f.adapter.requests[0].messages[0].content[0].text, f.adapter.requests[1].messages[0].content[0].text);
});
for (const outcome of ["rejected", "allowed-once"])
  test(`screenshot max-tokens scenario reaches Chinese native approval: ${outcome}`, async (t) => {
    const f = await mounted(t, { config: { review: { retryDelayMs: 0 } } });
    const count = probe(f.ctx, "pwsh");
    f.ctx.permissionPresets.set(f.session, "CAutoR");
    f.adapter.produce = () => chunks('{"risk":"medium","decision":"ask","reason":"Unfinished question"}', "max-tokens");
    const command = "try { Invoke-RestMethod -Uri 'https://api.github.com/repos/makepad/makepad/commits/exact' } catch { Write-Output $_ }";
    let requests = 0;
    f.ctx.on("approval/request", async (req) => {
      requests++;
      assert.equal(count(), 0);
      assert.match(req.reason, /是否允许本次操作/);
      assert.match(req.displayReason.zh, /输出 token 上限/);
      assert.ok(req.reason.includes(command));
      assert.equal(req.displayReason.en, req.displayReason.zh);
      assert.doesNotMatch(req.reason, /reviewer ended|Unfinished question/);
      return outcome;
    });
    const result = await f.run("pwsh", { command });
    assert.equal(result.isError, outcome === "rejected");
    assert.equal(count(), outcome === "allowed-once" ? 1 : 0);
    assert.equal(requests, 1);
    assert.equal(f.adapter.requests.length, 3);
    const asked = f.session.snapshotEvents().find((event) => event.type === "approval/asked");
    assert.match(asked.data.reason, /是否允许本次操作/);
  });
test("real native approval receives translated Chinese question before a rejected tool", async (t) => {
  const f = await mounted(t);
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.produce = (_, n) => chunks(n === 1
    ? '{"risk":"medium","decision":"ask","reason":"May I deploy to staging only, excluding production?"}'
    : '{"reason":"是否仅允许部署到 staging，且不包括生产环境？"}');
  f.ctx.on("approval/request", async (req) => {
    assert.match(req.reason, /不包括生产环境/);
    assert.doesNotMatch(req.reason, /May I deploy/);
    return "rejected";
  });
  assert.equal((await f.run("probe", { target: "staging" })).isError, true);
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 2);
});
test("max-tokens final denial cannot execute the real body or enter human approval", async (t) => {
  const f = await mounted(t, { config: { review: { tokenLimitRetries: 0, onError: "deny" } } });
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.produce = () => chunks('{"risk":"low","decision":"allow"}', "max-tokens");
  f.ctx.on("approval/request", () => { assert.fail("onError deny must not ask"); });
  const result = await f.run("probe", {});
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "DCAR_REVIEW_FAILED");
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 1);
});
test("bundle inserts only DCAR and does not depend on replacing the host permission row", async () => {
  const patch = parse(
    await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8"),
  );
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(patch.length, 1);
  assert.equal(patch[0].insert[0].id, "dcar");
  assert.equal(patch[0].insert[0].name, pkg.name);
});
test("actual DSH permission catalog displays CAutoR and selecting it writes full-access knobs", async (t) => {
  const f = await mounted(t);
  assert.equal(Object.getPrototypeOf(f.ctx.permissionPresets).constructor, PermissionPresets);
  const option = f.ctx.permissionPresets
    .catalog()
    .options.find((o) => o.value === "CAutoR");
  assert.equal(option.name, "CAutoR");
  assert.ok(f.ctx.permissionPresets.catalog().defaultOptions.some((o) => o.value === "CAutoR"));
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
  assert.equal(
    f.ctx.sessionProjections.stateOf(f.session, "permissions").sandbox,
    "danger-full-access",
  );
  assert.equal(
    f.ctx.sessionProjections.stateOf(f.session, "permissions").approval,
    "ask",
  );
});
test("native Settings persists CAutoR as the default and initializes reviewed new sessions", async (t) => {
  const f = await mounted(t, { settings: true });
  const descriptor = f.ctx.settings.describe().find((row) => row.ns === "permission-custom");
  await f.ctx.settings.update(descriptor.ns, { defaultPreset: "CAutoR" }, descriptor.revision);
  assert.equal(f.entry.fiber.state, 2);
  assert.equal(f.ctx.permissionPresets.catalog().defaultPreset, "CAutoR");
  assert.equal(f.ctx.permissionPresets.current(f.session), "workspace-write");
  const saved = JSON.parse(await readFile(f.configFile, "utf8"));
  assert.equal(saved.defaultPreset, "CAutoR");
  assert.deepEqual(saved.presets.CAutoR, DORMANT_PRESET);
  const session = f.ctx.sessions.create(SessionId("default-session"), { meta: { cwd: f.cwd } });
  const agent = { ...f.agent, id: session.id, session };
  assert.equal(f.ctx.permissionPresets.current(session), "CAutoR");
  const state = f.ctx.sessionProjections.stateOf(session, "permissions");
  assert.equal(state.sandbox, "danger-full-access");
  assert.equal(state.approval, "ask");
  const written = await f.run("write", { file_path: "default.txt", content: "ok" }, agent);
  assert.equal(written.isError, false, JSON.stringify(written));
  assert.equal(f.adapter.requests.length, 0);
  const count = probe(f.ctx);
  assert.equal((await f.run("probe", {}, agent)).isError, false);
  assert.equal(count(), 1);
  assert.equal(f.adapter.requests.length, 1);
});
test("a persisted CAutoR default survives an original-service restart and gates fresh sessions", async (t) => {
  const first = await mounted(t, { settings: true });
  await first.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  const saved = JSON.parse(await readFile(first.configFile, "utf8"));
  const restored = await mounted(t, { settings: true, permissionConfig: saved });
  assert.equal(restored.ctx.permissionPresets.catalog().defaultPreset, "CAutoR");
  assert.equal(restored.ctx.permissionPresets.current(restored.session), "CAutoR");
  assert.equal(restored.ctx.sessionProjections.stateOf(restored.session, "permissions").sandbox, "danger-full-access");
  assert.equal((await restored.run("write", { file_path: "restart.txt", content: "ok" })).isError, false);
  assert.equal(restored.adapter.requests.length, 0);
});
test("saving a new-session default preserves an existing CAutoR session through service reload", async (t) => {
  const f = await mounted(t, { settings: true });
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  await f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
  assert.equal(f.ctx.sessionProjections.stateOf(f.session, "permissions").sandbox, "danger-full-access");
  await f.ctx.settings.update("permission-custom", { defaultPreset: "workspace-write" });
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
  assert.equal((await f.run("write", { file_path: "kept.txt", content: "ok" })).isError, false);
  assert.equal(f.adapter.requests.length, 0);
});
test("default-setting reload preserves delegated CAutoR review with approval never", async (t) => {
  const f = await mounted(t, { settings: true });
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const child = f.ctx.sessions.prepare(SessionId("default-reload-child"), {
    meta: { cwd: f.cwd, parentSession: f.session.id, origin: "subagent" },
  });
  child.append("sandbox/mode", { mode: "danger-full-access", source: "delegation" });
  child.append("approval/policy", { policy: "never", source: "delegation" });
  f.ctx.effect(() => f.ctx.sessions.enter(child));
  f.ctx.sessions.announce(child);
  const agent = { ...f.agent, id: child.id, session: child };
  await f.ctx.serial("agent/created", { agent });
  await f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  assert.equal(f.ctx.permissionPresets.current(child), "CAutoR");
  assert.equal(f.ctx.sessionProjections.stateOf(child, "permissions").approval, "never");
  f.adapter.text = '{"risk":"medium","decision":"ask","reason":"Confirm"}';
  const count = probe(f.ctx);
  assert.equal((await f.run("probe", {}, agent)).isError, true);
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 1);
});
test("stopping a CAutoR default confines new sessions and reactivation restores the live choice", async (t) => {
  const f = await mounted(t, { settings: true });
  await f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  await f.plugin.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(f.ctx.configEditor, "edit").value, f.originalEdit);
  const pending = f.ctx.sessions.create(SessionId("provider-absent"), { meta: { cwd: f.cwd } });
  const state = f.ctx.sessionProjections.stateOf(pending, "permissions");
  assert.equal(state.sandbox, "read-only");
  assert.equal(state.approval, "never");
  assert.match(f.ctx.permissionPresets.catalog().defaultOptions.find((o) => o.value === "CAutoR").name, /未启用/);
  await f.ctx.plugin(Plugin, { rules: { includeTempRoots: false } });
  assert.equal(f.ctx.sessionProjections.stateOf(pending, "permissions").sandbox, "danger-full-access");
  assert.equal(f.ctx.sessionProjections.stateOf(pending, "permissions").approval, "ask");
  assert.equal(f.ctx.permissionPresets.catalog().defaultOptions.filter((o) => o.value === "CAutoR").length, 1);
  assert.equal(f.ctx.permissionPresets.catalog().defaultOptions.find((o) => o.value === "CAutoR").name, "CAutoR");
  await f.ctx.settings.update("permission-custom", { defaultPreset: "workspace-write" });
  const normal = f.ctx.sessions.create(SessionId("default-reset"), { meta: { cwd: f.cwd } });
  assert.equal(f.ctx.permissionPresets.current(normal), "workspace-write");
});
test("the legacy permission adapter also supports a persisted native CAutoR default", async (t) => {
  const f = await mounted(t, { settings: true, legacyBridge: true });
  await f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  assert.equal(f.ctx.permissionPresets.catalog().defaultPreset, "CAutoR");
  const root = f.ctx.sessions.create(SessionId("legacy-default"), { meta: { cwd: f.cwd } });
  assert.equal(f.ctx.sessionProjections.stateOf(root, "permissions").sandbox, "danger-full-access");
});
test("a default CAutoR session cannot execute a tool denied by its reviewer", async (t) => {
  const f = await mounted(t, { settings: true, config: { review: { onDeny: "deny" } } });
  await f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" });
  const session = f.ctx.sessions.create(SessionId("default-deny"), { meta: { cwd: f.cwd } });
  const count = probe(f.ctx);
  f.adapter.text = '{"risk":"medium","decision":"deny","reason":"No authority"}';
  const result = await f.run("probe", {}, { ...f.agent, id: session.id, session });
  assert.equal(result.isError, true);
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 1);
});
test("disabled DCAR rejects a native default selection without persisting full access", async (t) => {
  const f = await mounted(t, { settings: true, config: { enabled: false } });
  await assert.rejects(f.ctx.settings.update("permission-custom", { defaultPreset: "CAutoR" }), /disabled/);
  assert.equal(f.ctx.permissionPresets.defaultPreset, "workspace-write");
  assert.equal(f.ctx.sessionProjections.stateOf(f.session, "permissions").sandbox, "workspace-write");
});
test("the dormant default entry cannot label a manually restricted active session as CAutoR", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.session.append("sandbox/mode", { mode: "read-only" });
  f.session.append("approval/policy", { policy: "never" });
  assert.equal(f.ctx.permissionPresets.current(f.session), "custom");
  await f.plugin.dispose();
  assert.equal(f.ctx.sessionProjections.stateOf(f.session, "permissions").sandbox, "read-only");
});
test("enabling only the main plugin on an existing Desktop-style host registers CAutoR", async (t) => {
  const f = await mounted(t, { withoutPlugin: true });
  const originalTable = f.ctx.permissionPresets.presets;
  const originalNames = f.ctx.permissionPresets.names;
  let changes = 0;
  f.ctx.on("permission-presets/catalog-changed", () => { changes++; });
  const plugin = await f.ctx.plugin(Plugin, { rules: { includeTempRoots: false } });
  assert.equal(f.ctx.permissionPresets.presets, originalTable);
  assert.deepEqual(f.ctx.permissionPresets.names, [...originalNames, "CAutoR"]);
  assert.ok(changes > 0);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  assert.equal((await f.run("write", { file_path: "enabled.txt", content: "ok" })).isError, false);
  assert.equal(f.adapter.requests.length, 0);
  await plugin.dispose();
  assert.deepEqual(f.ctx.permissionPresets.names, originalNames);
  for (const key of ["names", "derive", "specOf", "apply", "registerReviewPreset"])
    assert.equal(Object.hasOwn(f.ctx.permissionPresets, key), false);
});
test("the original permission projection reflects CAutoR and a plugin toggle can reactivate it", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  assert.equal(f.ctx.sessionProjections.snapshot(f.session).values.permissions.currentValue, "CAutoR");
  await f.plugin.dispose();
  assert.equal(f.ctx.permissionPresets.current(f.session), "workspace-write");
  await f.ctx.plugin(Plugin, { rules: { includeTempRoots: false } });
  assert.equal(f.ctx.permissionPresets.catalog().options.filter((o) => o.value === "CAutoR").length, 1);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const count = probe(f.ctx);
  assert.equal((await f.run("probe", {})).isError, false);
  assert.equal(count(), 1);
  assert.equal(f.adapter.requests.length, 1);
});
test("profiles retaining the 1.0.0 permission adapter can load the new main plugin", async (t) => {
  const f = await mounted(t, { legacyBridge: true });
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  assert.equal(f.ctx.permissionPresets.catalog().options.filter((o) => o.value === "CAutoR").length, 1);
  assert.equal((await f.run("write", { file_path: "legacy.txt", content: "ok" })).isError, false);
  assert.equal(f.adapter.requests.length, 0);
});
test("a conflicting host preset fails activation and rolls back service augmentation", async (t) => {
  const f = await mounted(t, { withoutPlugin: true });
  f.ctx.permissionPresets.presets.CAutoR = { sandbox: "read-only", approval: "ask" };
  await assert.rejects(async () => { await f.ctx.plugin(Plugin); }, /already exists/);
  assert.equal(typeof f.ctx.permissionPresets.registerReviewPreset, "undefined");
  assert.equal(f.ctx.permissionPresets.resolve("CAutoR").sandbox, "read-only");
  assert.equal(f.ctx.permissionPresets.current(f.session), "workspace-write");
});
test("real DSH filesystem writes local files without making any model request", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const result = await f.run("write", {
    file_path: "test.txt",
    content: "created by DCAR integration",
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(
    await readFile(`${f.cwd}/test.txt`, "utf8"),
    "created by DCAR integration",
  );
  assert.equal(f.adapter.requests.length, 0);
});
test("real DSH pipeline performs one review before an unknown tool body", async (t) => {
  const f = await mounted(t);
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const result = await f.run("probe", {});
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(count(), 1);
  assert.equal(f.adapter.requests.length, 1);
});
test("real DSH tool body does not execute after an LLM denial", async (t) => {
  const f = await mounted(t, { config: { review: { onDeny: "deny" } } });
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.text =
    '{"risk":"medium","decision":"deny","reason":"Unapproved target"}';
  const result = await f.run("probe", {});
  assert.equal(result.isError, true);
  assert.equal(count(), 0);
  assert.equal(result.error.info.code, "DCAR_REVIEW_DENIED");
});
test("DCAR delegates a program allow to independent downstream policy", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.ctx.on("tools/pre-execute", async () => ({
    kind: "deny",
    reason: "Other policy blocks this",
  }));
  const result = await f.run("write", {
    file_path: "blocked.txt",
    content: "x",
  });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /Other policy/);
  assert.equal(f.adapter.requests.length, 0);
});
test("disposal removes CAutoR from the real catalog and restores workspace-write", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  await f.plugin.dispose();
  assert.equal(f.ctx.permissionPresets.current(f.session), "workspace-write");
  assert.ok(!f.ctx.permissionPresets.names.includes("CAutoR"));
  assert.throws(() => f.ctx.permissionPresets.set(f.session, "CAutoR"));
});
test("a stale CAutoR session is blocked while its review provider is absent", async (t) => {
  const f = await mounted(t, { withoutPlugin: true, legacyBridge: true });
  const count = probe(f.ctx);
  f.session.append("permission/preset", { preset: "CAutoR" });
  f.session.append("sandbox/mode", { mode: "danger-full-access" });
  const result = await f.run("probe", {});
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "DCAR_UNAVAILABLE");
  assert.equal(count(), 0);
});
test("official Auto and CAutoR can coexist as separate permission choices", async (t) => {
  const f = await mounted(t);
  const stop = f.ctx.permissionPresets.registerAuto(() => {});
  assert.ok(f.ctx.permissionPresets.names.includes("auto"));
  assert.ok(f.ctx.permissionPresets.names.includes("CAutoR"));
  await stop();
});
test("sessions pinned to never retain CAutoR and remain reviewed", async (t) => {
  const f = await mounted(t);
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.session.append("approval/policy", {
    policy: "never",
    source: "delegation",
  });
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
  f.adapter.text =
    '{"risk":"medium","decision":"ask","reason":"Need approval"}';
  assert.equal((await f.run("probe", {})).isError, true);
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 1);
});
test("native /permission CAutoR and /dcar commands use the real DSH command registry", async (t) => {
  const f = await mounted(t),
    signal = new AbortController().signal;
  let result = await f.ctx.commands.execute(
    f.agent,
    "/permission CAutoR",
    [],
    signal,
  );
  assert.equal(result.result.kind, "success");
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
  result = await f.ctx.commands.execute(
    f.agent,
    '/dcar check write {"file_path":"file.txt","content":"x"}',
    [],
    signal,
  );
  assert.equal(JSON.parse(result.result.text).kind, "allow");
  assert.equal(f.adapter.requests.length, 0);
  result = await f.ctx.commands.execute(
    f.agent,
    '/dcar config {"review":{"timeoutMs":100}}',
    [],
    signal,
  );
  assert.equal(JSON.parse(result.result.text).review.timeoutMs, 100);
  result = await f.ctx.commands.execute(
    f.agent,
    '/dcar config {"review":{"onError":"allow"}}',
    [],
    signal,
  );
  assert.equal(result.result.kind, "error");
  await f.run("write", { file_path: "a", content: "x" });
  result = await f.ctx.commands.execute(f.agent, "/dcar stats", [], signal);
  assert.equal(JSON.parse(result.result.text).deterministic, 1);
  result = await f.ctx.commands.execute(f.agent, "/dcar history", [], signal);
  assert.equal(JSON.parse(result.result.text).length, 1);
  result = await f.ctx.commands.execute(f.agent, "/dcar reset", [], signal);
  assert.equal(result.result.kind, "success");
  result = await f.ctx.commands.execute(f.agent, "/dcar off", [], signal);
  assert.equal(f.ctx.permissionPresets.current(f.session), "workspace-write");
  result = await f.ctx.commands.execute(f.agent, "/dcar on", [], signal);
  assert.equal(f.ctx.permissionPresets.current(f.session), "CAutoR");
});
async function inner(f, name, args) {
  const root = "ptc-outer",
    callId = "ptc-inner",
    raw = JSON.stringify({ code: "tools.test()" });
  f.session.append("request/header", {
    header: { config: { provider: "test", model: "fake" } },
    reason: "initial",
  });
  f.session.append("step/start", { turn: 1, step: 1 });
  f.session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      stream: [],
      message: createMessage({
        role: "assistant",
        source: { kind: "model", provider: "test", model: "fake" },
        content: [
          { type: "tool-call", id: root, name: "run_code", arguments: raw },
        ],
      }),
    },
    { surfaceOp: "append" },
  );
  f.session.append("tool/call", {
    turn: 1,
    step: 1,
    callId: root,
    name: "run_code",
    arguments: raw,
  });
  f.session.append("tool/ptc-dispatch-start", {
    rootCallId: root,
    parentCallId: root,
    subCallId: callId,
    name,
    arguments: args,
  });
  return f.ctx.tools.execute({
    name,
    arguments: args,
    agent: f.agent,
    rootCallId: root,
    callId,
    parent: Symbol("outer"),
    schema: {
      name,
      description: "PTC binding schema",
      parameters: { type: "object" },
    },
    signal: new AbortController().signal,
  });
}
test("PTC inner filesystem call uses the same deterministic gate", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  assert.equal(
    (await inner(f, "write", { file_path: "ptc.txt", content: "nested" }))
      .isError,
    false,
  );
  assert.equal(f.adapter.requests.length, 0);
  assert.equal(await readFile(`${f.cwd}/ptc.txt`, "utf8"), "nested");
});
test("PTC inner unknown call is reviewed using its actual binding arguments", async (t) => {
  const f = await mounted(t, { config: { review: { onDeny: "deny" } } });
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.text =
    '{"risk":"medium","decision":"deny","reason":"No authorization"}';
  const result = await inner(f, "probe", { target: "exact-target" });
  assert.equal(result.isError, true);
  assert.equal(count(), 0);
  assert.equal(f.adapter.requests.length, 1);
  assert.match(f.adapter.requests[0].messages[0].content[0].text, /ptc-inner/);
  assert.match(
    f.adapter.requests[0].messages[0].content[0].text,
    /exact-target/,
  );
});
test("subagent inheritance is captured at creation and survives later parent permission changes", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const child = f.ctx.sessions.create(SessionId("child"), {
    meta: { cwd: f.cwd, parentSession: f.session.id, origin: "subagent" },
  });
  child.append("sandbox/mode", {
    mode: "danger-full-access",
    source: "delegation",
  });
  child.append("approval/policy", { policy: "never", source: "delegation" });
  const childAgent = {
    id: child.id,
    session: child,
    options: { provider: "test", model: "fake" },
  };
  await f.ctx.serial("agent/created", { agent: childAgent });
  assert.equal(f.ctx.permissionPresets.current(child), "CAutoR");
  f.ctx.permissionPresets.set(f.session, "danger-full-access");
  const definition = f.ctx.commands.find(childAgent, "dcar");
  assert.match(
    (
      await definition.handler({
        agent: childAgent,
        rawInput: "status",
        signal: new AbortController().signal,
      })
    ).text,
    /启用/,
  );
});
test("provider failure and malformed output cannot reach the real tool body", async (t) => {
  const f = await mounted(t, { config: { review: { onError: "deny" } } });
  const count = probe(f.ctx);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  f.adapter.text = "not JSON";
  const result = await f.run("probe", {});
  assert.equal(result.isError, true);
  assert.equal(count(), 0);
  assert.equal(result.error.info.code, "DCAR_REVIEW_FAILED");
});
for (const [outcome, executes] of [
  ["allowed-once", true],
  ["rejected", false],
  ["unavailable", false],
])
  test(`native approval flow ${outcome} executes the call only when approved`, async (t) => {
    const f = await mounted(t);
    const count = probe(f.ctx);
    f.ctx.permissionPresets.set(f.session, "CAutoR");
    f.adapter.text =
      '{"risk":"medium","decision":"ask","reason":"请确认本次操作的具体目标。"}';
    f.ctx.on("approval/request", async (req) => {
      assert.match(req.displayReason.zh, /Con's 自动审查/);
      return outcome;
    });
    const result = await f.run("probe", {});
    assert.equal(!result.isError, executes);
    assert.equal(count(), executes ? 1 : 0);
    assert.equal(f.adapter.requests.length, 1);
    assert.ok(
      f.session.snapshotEvents().some((e) => e.type === "approval/asked"),
    );
  });
test("a parent permission change during the child creation window does not drop captured DCAR review", async (t) => {
  const f = await mounted(t);
  f.ctx.permissionPresets.set(f.session, "CAutoR");
  const child = f.ctx.sessions.prepare(SessionId("racing-child"), {
    meta: { cwd: f.cwd, parentSession: f.session.id, origin: "subagent" },
  });
  child.append("sandbox/mode", {
    mode: "danger-full-access",
    source: "delegation",
  });
  child.append("approval/policy", { policy: "never", source: "delegation" });
  f.ctx.permissionPresets.set(f.session, "workspace-write");
  f.ctx.effect(() => f.ctx.sessions.enter(child));
  f.ctx.sessions.announce(child);
  const childAgent = {
    id: child.id,
    session: child,
    options: { provider: "test", model: "fake" },
  };
  await f.ctx.serial("agent/created", { agent: childAgent });
  assert.equal(f.ctx.permissionPresets.current(child), "CAutoR");
});
