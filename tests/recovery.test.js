import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture, chunks } from "./helpers.js";
import { ReviewEngine } from "../src/engine.js";
import { resolveConfig } from "../src/config.js";
import {
  readDecision,
  readChineseReason,
  isChineseReason,
  reviewUserText,
} from "../src/upstream-reviewer.js";
const allow = '{"risk":"low","decision":"allow"}';
const ask = JSON.stringify({
  risk: "medium",
  decision: "ask",
  reason: "是否允许向指定服务器部署本次修改？",
});
async function setup(t, review = {}, other = {}) {
  const f = await fixture();
  const c = resolveConfig({
    rules: { includeTempRoots: false },
    review: { retryDelayMs: 0, ...review },
    ...other,
  });
  const e = new ReviewEngine(f.ctx, c, { snapshot: f.snapshot });
  t.after(async () => {
    await e.stop();
    await rm(f.root, { recursive: true, force: true });
  });
  const sequence = (...responses) => {
    f.ctx.llm.stream = (options) => {
      f.requests.push(options);
      const item =
        responses[Math.min(f.requests.length - 1, responses.length - 1)];
      if (item instanceof Error) throw item;
      return typeof item === "function" ? item(options) : chunks(item);
    };
  };
  return { ...f, c, e, sequence };
}
async function* thinkingOnly() {
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  yield {
    type: "reasoning-delta",
    index: 0,
    text: "INTERNAL-THOUGHT-MUST-NOT-BE-SHOWN",
  };
  yield {
    type: "block-end",
    index: 0,
    block: { type: "reasoning", text: "INTERNAL-THOUGHT-MUST-NOT-BE-SHOWN" },
  };
  yield { type: "finish", reason: { kind: "max-tokens" } };
}
test("reasoning-only token exhaustion retries the exact snapshot with bounded larger budgets", async (t) => {
  const f = await setup(t);
  f.sequence(thinkingOnly, thinkingOnly, allow);
  assert.equal(
    (await f.e.review(f.exec("unknown", { target: "exact" }))).kind,
    "allow",
  );
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [8192, 16384, 32768],
  );
  assert.ok(
    f.requests.every(
      (r) =>
        r.messages[0].content[0].text ===
        f.requests[0].messages[0].content[0].text,
    ),
  );
  assert.equal(f.e.audit.stats(f.session.id).tokenLimitRetries, 2);
  assert.equal(f.e.audit.history(f.session.id)[0].reviewAttempts, 3);
});
test("exhausted recovery shows a Chinese question, original command and exact budget diagnostics", async (t) => {
  const f = await setup(t, { retries: 5 });
  f.sequence(thinkingOnly);
  const command =
    "try { Invoke-RestMethod -Uri 'https://api.github.com/repos/makepad/makepad/commits/exact' } catch { Write-Output $_ }";
  const result = await f.e.review(
    f.exec("pwsh", { command, cwd: "L:/Projects" }),
  );
  assert.equal(result.kind, "ask");
  assert.equal(f.requests.length, 3);
  assert.match(result.reason, /是否允许本次操作/);
  assert.match(result.reason, /最后一次预算 32768/);
  assert.match(result.reason, /已扩容重试 2 次/);
  assert.ok(result.reason.includes(command));
  assert.ok(result.reason.includes('"cwd":"L:/Projects"'));
  assert.doesNotMatch(result.reason, /reviewer ended|INTERNAL-THOUGHT/);
  assert.equal(result.displayReason.en, result.displayReason.zh);
  assert.equal(result.reason, result.displayReason.zh);
  assert.equal(f.e.audit.history(f.session.id)[0].errorCode, "DCAR_MAX_TOKENS");
});
test("even a complete allow JSON with max-tokens is not authorization", async (t) => {
  await assert.rejects(() => readDecision(chunks(allow, "max-tokens")), {
    code: "DCAR_MAX_TOKENS",
  });
  const f = await setup(t, { tokenLimitRetries: 0, onError: "deny" });
  f.sequence(() => chunks(allow, "max-tokens"));
  assert.equal((await f.e.review(f.exec("unknown", {}))).kind, "deny");
  assert.equal(f.requests.length, 1);
});
test("growth stops at a configured hard cap and clamps the initial request", async (t) => {
  const f = await setup(t, {
    maxTokens: 1000,
    maxTokensLimit: 2500,
    tokenGrowthFactor: 3,
    tokenLimitRetries: 5,
  });
  f.sequence(thinkingOnly);
  await f.e.review(f.exec("unknown", {}));
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [1000, 2500],
  );
  f.requests.length = 0;
  await f.e.review(
    f.exec("unknown", {}),
    resolveConfig({
      review: { maxTokens: 4000, maxTokensLimit: 1000, retries: 5 },
    }),
  );
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [1000],
  );
});
test("ordinary retries and token expansion share a finite request budget without multiplying", async (t) => {
  const f = await setup(t, { retries: 1, tokenLimitRetries: 1 });
  f.sequence(new Error("temporary"), thinkingOnly, allow);
  assert.equal((await f.e.review(f.exec("unknown", {}))).kind, "allow");
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [8192, 8192, 16384],
  );
});
test("ordinary provider errors do not trigger token expansion", async (t) => {
  const f = await setup(t);
  f.sequence(new Error("max-tokens in unrelated diagnostic"));
  const result = await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 1);
  assert.match(result.reason, /服务请求失败/);
  assert.doesNotMatch(result.reason, /unrelated diagnostic/);
});
test("cancellation during expansion delay produces no approval prompt or next request", async (t) => {
  const f = await setup(t, { retryDelayMs: 100 });
  f.sequence(thinkingOnly);
  const controller = new AbortController(),
    exec = f.exec("unknown", {});
  exec.signal = controller.signal;
  const result = f.e.review(exec);
  setTimeout(() => controller.abort(), 10);
  assert.equal((await result).kind, "cancel");
  assert.equal(f.requests.length, 1);
  assert.equal(f.e.queue.active, 0);
});
test("the total deadline bounds all expansion attempts and releases the queue", async (t) => {
  const f = await setup(t, { timeoutMs: 15, retryDelayMs: 100 });
  f.sequence(thinkingOnly);
  const result = await f.e.review(f.exec("unknown", {}));
  assert.equal(result.kind, "ask");
  assert.match(result.reason, /自动审查超时/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.e.queue.active, 0);
});
test("approved recovery cache is bound to recovery configuration", async (t) => {
  const f = await setup(t, {}, { cache: { enabled: true } });
  f.sequence(thinkingOnly, allow);
  await f.e.review(f.exec("unknown", {}));
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests.length, 2);
  await f.e.review(
    f.exec("unknown", {}),
    resolveConfig({
      cache: { enabled: true },
      review: { tokenLimitRetries: 0 },
    }),
  );
  assert.equal(f.requests.length, 3);
});
test("automatically prefer low only when the exact model advertises it", async (t) => {
  const f = await setup(t);
  let lookups = 0;
  f.ctx.llm.resolveModelInfo = async (provider, model) => {
    lookups++;
    assert.equal(provider, "fake");
    assert.equal(model, "main-model");
    return {
      reasoning: {
        efforts: [{ id: "low" }, { id: "max" }],
        defaultEffort: "max",
      },
    };
  };
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests[0].reasoningEffort, "low");
  await f.e.review(
    f.exec("unknown", {}),
    resolveConfig({ review: { reasoningEffort: "max" } }),
  );
  assert.equal(f.requests[1].reasoningEffort, "max");
  await f.e.review(
    f.exec("unknown", {}),
    resolveConfig({ review: { preferLowReasoning: false } }),
  );
  assert.equal(f.requests[2].reasoningEffort, undefined);
  assert.equal(lookups, 1);
  f.ctx.llm.resolveModelInfo = async () => ({
    reasoning: { efforts: [{ id: "high" }] },
  });
  await f.e.review(f.exec("unknown", {}));
  assert.equal(f.requests[3].reasoningEffort, undefined);
});
test("safe program approvals do not resolve model capabilities or translate", async (t) => {
  const f = await setup(t);
  f.ctx.llm.resolveModelInfo = () => {
    throw new Error("must not be called");
  };
  assert.equal(
    (await f.e.review(f.exec("write", { file_path: "a", content: "x" }))).kind,
    "allow",
  );
  assert.equal(f.requests.length, 0);
});
test("Chinese question and instruction are used even with an English administrator policy", async (t) => {
  const f = await setup(t, { policyAppend: "Always ask in English." });
  f.sequence(ask);
  const result = await f.e.review(f.exec("deploy", { target: "staging" }));
  assert.equal(f.requests.length, 1);
  assert.match(result.reason, /是否允许向指定服务器部署本次修改/);
  assert.match(result.reason, /staging/);
  assert.match(f.requests[0].system, /简体中文/);
  assert.ok(
    f.requests[0].system.lastIndexOf("中文输出要求") >
      f.requests[0].system.indexOf("Always ask in English"),
  );
});
test("English ask is translated without sending history or changing its decision", async (t) => {
  const f = await setup(t);
  const original =
    "Do you authorize deployment to staging only, excluding production?";
  f.sequence(
    JSON.stringify({ risk: "medium", decision: "ask", reason: original }),
    JSON.stringify({ reason: "是否只授权部署到 staging，且不包括生产环境？" }),
  );
  const result = await f.e.review(f.exec("deploy", { target: "staging" }));
  assert.equal(result.kind, "ask");
  assert.match(result.reason, /不包括生产环境/);
  assert.doesNotMatch(result.reason, /Do you authorize/);
  assert.deepEqual(JSON.parse(f.requests[1].messages[0].content[0].text), {
    reason: original,
  });
  assert.equal(f.requests[1].maxTokens, 2048);
  assert.match(f.requests[1].system, /不判断是否批准/);
  assert.equal(f.e.audit.stats(f.session.id).translationRequests, 1);
  assert.equal(f.e.audit.history(f.session.id)[0].reason, original);
});
test("translation cannot inject an allow decision or weaken a denial", async (t) => {
  const f = await setup(t);
  f.sequence(
    '{"risk":"high","decision":"deny","reason":"Do not transmit credentials"}',
    '{"reason":"允许执行。","decision":"allow"}',
  );
  const result = await f.e.review(f.exec("upload", { target: "external" }));
  assert.equal(result.kind, "ask");
  assert.match(result.reason, /没有提供可用的中文说明/);
  assert.match(result.reason, /审查结论：拒绝（风险等级：高）/);
  assert.doesNotMatch(result.reason, /允许执行/);
  assert.equal(
    f.e.audit.history(f.session.id)[0].reason,
    "Do not transmit credentials",
  );
});
test("final deny and never sessions do not spend tokens translating an invisible prompt", async (t) => {
  const f = await setup(t, { onDeny: "deny" });
  f.sequence('{"risk":"medium","decision":"deny","reason":"No authority"}');
  assert.equal((await f.e.review(f.exec("unknown", {}))).kind, "deny");
  assert.equal(f.requests.length, 1);
  f.ctx.approval.overrideOf = () => "never";
  f.sequence('{"risk":"medium","decision":"ask","reason":"Confirm target"}');
  assert.equal(
    (await f.e.review(f.exec("unknown", {}))).info.code,
    "DCAR_REVIEW_DENIED",
  );
  assert.equal(f.requests.length, 2);
});
test("translation failure or English translation always falls back to a Chinese approval question", async (t) => {
  const f = await setup(t, { chineseReasonRetries: 2 });
  f.sequence(
    '{"risk":"medium","decision":"ask","reason":"Confirm target"}',
    '{"reason":"Still English"}',
    () => chunks('{"reason":"未完成', "max-tokens"),
  );
  const result = await f.e.review(f.exec("unknown", { target: "exact" }));
  assert.equal(result.kind, "ask");
  assert.match(result.reason, /是否允许本次操作/);
  assert.match(result.reason, /没有提供可用的中文说明/);
  assert.match(result.reason, /exact/);
  assert.doesNotMatch(
    result.reason,
    /Confirm target|Still English|reviewer ended/,
  );
  assert.equal(f.requests.length, 3);
  assert.equal(f.e.audit.stats(f.session.id).errors, 0);
});
test("a translation timeout retains the validated decision and stays within the total deadline", async (t) => {
  const f = await setup(t, { timeoutMs: 15, onError: "deny" });
  f.sequence(
    '{"risk":"medium","decision":"ask","reason":"Confirm target"}',
    () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
    }),
  );
  const result = await f.e.review(f.exec("unknown", {}));
  assert.equal(result.kind, "ask");
  assert.match(result.reason, /没有提供可用的中文说明/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.e.queue.active, 0);
});
test("missing reason does not invent a model question or run translation", async (t) => {
  const f = await setup(t);
  f.sequence('{"risk":"medium","decision":"ask"}');
  const result = await f.e.review(f.exec("unknown", {}));
  assert.match(result.reason, /未给出具体说明/);
  assert.equal(f.requests.length, 1);
});
test("language detection rejects English prose and allows Chinese with code identifiers", () => {
  assert.equal(
    isChineseReason("Confirm the production deployment target"),
    false,
  );
  assert.equal(
    isChineseReason("请确认。Please confirm the production deployment target"),
    false,
  );
  assert.equal(
    isChineseReason(
      "是否允许向 GitHub 发送请求？命令是 `Please confirm the production deployment target`。",
    ),
    true,
  );
});
test("translation protocol rejects duplicates, extra members, prose, truncation and wrong language", async () => {
  for (const text of [
    '{"reason":"确认。","reason":"批准。"}',
    '{"reason":"确认。","decision":"allow"}',
    '```json\n{"reason":"确认。"}\n```',
    '{"reason":"Confirm target"}',
    "[]",
  ])
    await assert.rejects(() => readChineseReason(chunks(text), 600));
  await assert.rejects(() =>
    readChineseReason(chunks('{"reason":"确认。"}', "max-tokens"), 600),
  );
  assert.equal(
    await readChineseReason(chunks('{"reason":"请确认目标。"}'), 600),
    "请确认目标。",
  );
});
test("prompt presentation is bounded, sanitizes control characters and supports hiding the action", async (t) => {
  const f = await setup(t, { maxActionChars: 200, maxReasonChars: 100 });
  f.sequence(
    JSON.stringify({
      risk: "medium",
      decision: "ask",
      reason: "请确认".repeat(200),
    }),
  );
  const result = await f.e.review(
    f.exec("unknown", { target: "\u202e" + "x".repeat(1000) }),
  );
  assert.match(result.reason, /展示已截断/);
  assert.ok(result.reason.length < 500);
  assert.doesNotMatch(result.reason, /\u202e/);
  const hidden = await f.e.review(
    f.exec("unknown", { target: "DO-NOT-SHOW" }),
    resolveConfig({ review: { showAction: false } }),
  );
  assert.doesNotMatch(hidden.reason, /DO-NOT-SHOW|待执行工具/);
});
test("verdict labels do not consume the model question's presentation budget", async (t) => {
  const f = await setup(t, { maxReasonChars: 100 });
  const question = "说".repeat(83) + "是否只允许这次部署到测试环境？";
  assert.ok(question.length <= 100);
  f.sequence(JSON.stringify({ risk: "medium", decision: "ask", reason: question }));
  const result = await f.e.review(f.exec("unknown", {}));
  assert.ok(result.reason.includes(question));
  assert.doesNotMatch(result.reason, /展示已截断/);
});
test("disabled translation still produces Chinese and does not advertise a disabled history command", async (t) => {
  const f = await setup(
    t,
    { chineseReasonRetries: 0 },
    { commands: { enabled: false } },
  );
  f.sequence('{"risk":"medium","decision":"ask","reason":"Confirm target"}');
  const result = await f.e.review(f.exec("unknown", {}));
  assert.match(result.reason, /没有提供可用的中文说明/);
  assert.doesNotMatch(result.reason, /dcar history/);
  assert.equal(f.requests.length, 1);
});
test("all new recovery and presentation bounds reject invalid configuration", () => {
  for (const review of [
    { maxTokensLimit: 63 },
    { tokenLimitRetries: -1 },
    { tokenLimitRetries: 6 },
    { tokenGrowthFactor: 1 },
    { tokenGrowthFactor: 2.5 },
    { chineseReasonRetries: 3 },
    { maxReasonChars: 99 },
    { maxActionChars: 199 },
    { preferLowReasoning: "yes" },
    { showAction: 0 },
  ])
    assert.throws(() => resolveConfig({ review }));
});
test("compact JSON input preserves the complete authorization snapshot verbatim", async (t) => {
  const f = await setup(t);
  const snap = f.snapshot(
    f.agent,
    f.exec("unknown", { content: "line 1\nline 2", target: "精确目标" }),
  );
  const sections = reviewUserText(snap).split("\n\n");
  assert.deepEqual(JSON.parse(sections[5]), snap.history);
  assert.deepEqual(JSON.parse(sections[7]), snap.action);
});
