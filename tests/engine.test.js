import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { fixture, chunks } from "./helpers.js";
import { ReviewEngine } from "../src/engine.js";
import { resolveConfig } from "../src/config.js";
import { parseDecision, readDecision } from "../src/upstream-reviewer.js";
async function setup(t, input = {}) {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const c = resolveConfig({ rules: { includeTempRoots: false }, ...input });
  const e = new ReviewEngine(f.ctx, c, { snapshot: f.snapshot });
  t.after(() => e.stop());
  return { ...f, c, e };
}
test("safe local work performs zero model calls", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await f.e.review(
          f.exec("write", { file_path: `src/f${i}.js`, content: "a" }),
        )
      ).kind,
      "allow",
    );
  assert.equal(f.requests.length, 0);
  assert.equal(f.e.audit.stats(f.session.id).savedReviewRequests, 20);
});
test("unknown action makes one model request with policy, human source and exact arguments", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.e.review(f.exec("bash", { command: "npm run test" }))).kind,
    "allow",
  );
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.model, "main-model");
  assert.match(request.messages[0].content[0].text, /human-instruction/);
  assert.match(request.messages[0].content[0].text, /npm run test/);
  assert.equal(request.temperature, 0);
});
test("route overrides and prompt configuration are sent only for escalations", async (t) => {
  const f = await setup(t, {
    review: {
      provider: "p2",
      model: "m2",
      reasoningEffort: "low",
      maxTokens: 333,
      policyAppend: "Respect deployment targets.",
    },
  });
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests[0].provider, "p2");
  assert.equal(f.requests[0].maxTokens, 333);
  assert.equal(f.requests[0].reasoningEffort, "low");
  assert.match(f.requests[0].system, /Respect deployment/);
});
for (const [output, behavior, kind] of [
  ['{"risk":"medium","decision":"deny","reason":"No authority"}', "ask", "ask"],
  ['{"risk":"medium","decision":"deny"}', "deny", "deny"],
  [
    '{"risk":"medium","decision":"ask","reason":"Confirm target"}',
    "deny",
    "ask",
  ],
])
  test(`LLM result ${output} uses configured follow-up`, async (t) => {
    const f = await setup(t, { review: { onDeny: behavior } });
    f.ctx.llm.stream = (o) => {
      f.requests.push(o);
      return chunks(output);
    };
    assert.equal((await f.e.review(f.exec("unknown", {}))).kind, kind);
  });
test("subagent never policy converts ask into a structured denial", async (t) => {
  const f = await setup(t);
  f.ctx.approval.overrideOf = () => "never";
  f.ctx.llm.stream = () =>
    chunks('{"risk":"medium","decision":"ask","reason":"Need authority"}');
  const result = await f.e.review(f.exec("unknown", {}));
  assert.equal(result.kind, "deny");
  assert.equal(result.info.code, "DCAR_REVIEW_DENIED");
  assert.match(result.reason, /Need authority/);
});
test("invalid or failed model output never executes and follows onError", async (t) => {
  const f = await setup(t, { review: { onError: "deny" } });
  f.ctx.llm.stream = () => chunks("sure go ahead");
  const result = await f.e.review(f.exec("unknown", {}));
  assert.equal(result.kind, "deny");
  assert.equal(result.info.code, "DCAR_REVIEW_FAILED");
  assert.equal(f.e.audit.stats(f.session.id).errors, 1);
});
test("timeout covers hung providers and queue waiting", async (t) => {
  const f = await setup(t, {
    review: { timeoutMs: 15, onError: "deny", concurrency: 1 },
  });
  f.ctx.llm.stream = () => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  });
  const results = await Promise.all([
    f.e.review(f.exec("unknown", {})),
    f.e.review(f.exec("unknown", {})),
  ]);
  assert.ok(
    results.every((r) => r.kind === "deny" && /timed out/.test(r.reason)),
  );
  assert.equal(f.e.queue.active, 0);
  assert.equal(f.e.queue.waiting.length, 0);
});
test("caller cancellation returns cancel without a failed-review prompt", async (t) => {
  const f = await setup(t);
  const controller = new AbortController(),
    x = f.exec("unknown", {});
  x.signal = controller.signal;
  f.ctx.llm.stream = () => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  });
  const p = f.e.review(x);
  setTimeout(() => controller.abort(), 10);
  assert.equal((await p).kind, "cancel");
});
test("retry is bounded and occurs only on review failure", async (t) => {
  const f = await setup(t, { review: { retries: 1, retryDelayMs: 0 } });
  let n = 0;
  f.ctx.llm.stream = () => {
    n++;
    if (n === 1) throw new Error("temporary");
    return chunks('{"risk":"low","decision":"allow"}');
  };
  assert.equal((await f.e.review(f.exec("unknown", {}))).kind, "allow");
  assert.equal(n, 2);
});
test("exact-snapshot cache includes session, authority and route and can be cleared", async (t) => {
  const f = await setup(t, { cache: { enabled: true } });
  await f.e.review(f.exec("unknown", {}));
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 1);
  f.session.id = "other-session";
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 2);
  f.e.snapshot = (_, x) => ({
    ...f.snapshot(_, x),
    history: [{ text: "new authority" }],
  });
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 3);
  f.e.clearCache();
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 4);
});
test("oversized authorization context is not silently truncated", async (t) => {
  const f = await setup(t, {
    review: { maxInputChars: 1024, onError: "deny" },
  });
  f.e.snapshot = (_, x) => ({
    ...f.snapshot(_, x),
    history: [{ text: "x".repeat(2000) }],
  });
  assert.equal((await f.e.review(f.exec("unknown", {}))).kind, "deny");
  assert.equal(f.requests.length, 0);
});
test("audit file omits file content by default", async (t) => {
  const f = await setup(t, { audit: { file: ".dcar/audit.jsonl" } });
  await f.e.review(
    f.exec("write", { file_path: "a", content: "SECRET-CONTENT" }),
  );
  await f.e.audit.flush();
  const text = await readFile(`${f.cwd}/.dcar/audit.jsonl`, "utf8");
  assert.doesNotMatch(text, /SECRET-CONTENT/);
  assert.equal(JSON.parse(text).decision, "allow");
});
test("strict protocol rejects duplicate keys, invalid combinations, prose and tool calls", async () => {
  for (const text of [
    '{"risk":"low","decision":"deny"}',
    '{"risk":"high","decision":"allow"}',
    '{"risk":"low","decision":"allow","decision":"allow"}',
    '{"risk":"low","decision":"allow","reason":"yes"}',
    '```json\n{"risk":"low","decision":"allow"}\n```',
    "[]",
  ])
    assert.throws(() => parseDecision(text));
  await assert.rejects(() =>
    readDecision(chunks('{"risk":"low","decision":"allow"}', "length")),
  );
});
test("program check errors escalate to the model instead of denying directly", async (t) => {
  const f = await setup(t);
  f.ctx.fs.resolve = async () => {
    throw new Error("Cannot resolve path");
  };
  assert.equal(
    (await f.e.review(f.exec("write", { file_path: "a", content: "x" }))).kind,
    "allow",
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.e.audit.history(f.session.id)[0].rule, "PROGRAM_CHECK_ERROR");
});
test("review queue enforces concurrent model request limit", async (t) => {
  const f = await setup(t, { review: { concurrency: 2 } });
  let active = 0,
    peak = 0;
  f.ctx.llm.stream = () => ({
    async *[Symbol.asyncIterator]() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield* chunks('{"risk":"low","decision":"allow"}');
      active--;
    },
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.e.review(f.exec("unknown", {}))),
  );
  assert.equal(peak, 2);
  assert.ok(results.every((r) => r.kind === "allow"));
});
test("denials are not reused from cache", async (t) => {
  const f = await setup(t, {
    cache: { enabled: true },
    review: { onDeny: "deny" },
  });
  let n = 0;
  f.ctx.llm.stream = () => {
    n++;
    return chunks('{"risk":"medium","decision":"deny"}');
  };
  await f.e.review(f.exec("unknown", {}));
  await f.e.review(f.exec("unknown", {}));
  assert.equal(n, 2);
});
