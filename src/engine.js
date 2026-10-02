/** Deterministic-first authorization, configurable LLM fallback, and audit. */
import { deterministic } from "./deterministic.js";
import {
  snapshotAutoReview,
  budgetReviewText,
  readDecision,
  REVIEW_POLICY,
  chineseReviewPolicy,
  isChineseReason,
  readChineseReason,
  CHINESE_TRANSLATION_POLICY,
  ReviewResponseError,
} from "./upstream-reviewer.js";
import { ReviewQueue, abortable, delay } from "./async.js";
import { Audit, hash } from "./audit.js";
import { approvalText, reviewFailureMessage, bounded } from "./presentation.js";
export class ReviewEngine {
  queue = new ReviewQueue();
  audit = new Audit();
  cache = new Map();
  lifecycle = new AbortController();
  constructor(ctx, config, options = {}) {
    this.ctx = ctx;
    this.config = config;
    this.snapshot = options.snapshot ?? snapshotAutoReview;
    this.read = options.read ?? readDecision;
  }
  clearCache() {
    this.cache.clear();
  }
  async stop() {
    this.lifecycle.abort(new Error("DCAR plugin disposed"));
    await this.audit.flush();
  }
  async review(exec, c = this.config) {
    const start = performance.now(),
      signal = AbortSignal.any([exec.signal, this.lifecycle.signal]);
    let result,
      layer = "program",
      code,
      reason,
      cacheHit = false,
      error = false;
    const trace = {
      reviewAttempts: 0,
      tokenRetries: 0,
      translationAttempts: 0,
      contextOmitted: 0,
      lastMaxTokens: 0,
    };
    let displayReason;
    try {
      signal.throwIfAborted();
      let first;
      try {
        first = await deterministic(exec, this.ctx, c, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        first = {
          kind: "escalate",
          code: "PROGRAM_CHECK_ERROR",
          reason: String(e.message ?? e),
        };
      }
      code = first.code;
      reason = first.reason;
      if (first.kind === "allow") result = { kind: "allow" };
      else {
        layer = "llm";
        const timer = new AbortController();
        const timeout = setTimeout(
          () =>
            timer.abort(
              new ReviewResponseError(
                "DCAR_REVIEW_TIMEOUT",
                `DCAR review timed out after ${c.review.timeoutMs} ms`,
              ),
            ),
          c.review.timeoutMs,
        );
        const reviewSignal = AbortSignal.any([signal, timer.signal]);
        let release;
        try {
          release = await this.queue.acquire(
            c.review.concurrency,
            c.review.maxQueued,
            reviewSignal,
          );
          const snapshot = this.snapshot(exec.agent, exec);
          const budgeted = budgetReviewText(snapshot, c.review);
          const text = budgeted.text;
          trace.contextOmitted =
            budgeted.omitted.historyEntries +
            budgeted.omitted.instructionEntries;
          if (text.length > budgeted.limit) {
            // The action is never abbreviated, so an oversized action fails closed.
            const error = new ReviewResponseError(
              "DCAR_REVIEW_INPUT",
              `DCAR review input is ${text.length} characters, over the ${budgeted.limit} maxInputChars limit after abbreviating history; the pending action alone is ${budgeted.sizes.action} characters`,
            );
            error.detail = {
              chars: text.length,
              limit: budgeted.limit,
              actionChars: budgeted.sizes.action,
              ...budgeted.omitted,
            };
            throw error;
          }
          const options = {
            provider: c.review.provider || snapshot.provider,
            model: c.review.model || snapshot.model,
            system:
              REVIEW_POLICY +
              (c.review.allowAsk
                ? ""
                : "\nDo not return ask; return allow or deny.") +
              (c.review.policyAppend
                ? `\n\nADMINISTRATOR_POLICY\n${c.review.policyAppend}`
                : "") +
              chineseReviewPolicy(c.review.maxReasonChars),
            messages: [{ role: "user", content: [{ type: "text", text }] }],
            temperature: c.review.temperature,
            maxTokens: Math.min(c.review.maxTokens, c.review.maxTokensLimit),
            signal: reviewSignal,
          };
          if (c.review.reasoningEffort)
            options.reasoningEffort = c.review.reasoningEffort;
          else if (
            c.review.preferLowReasoning &&
            this.ctx.llm.resolveModelInfo
          ) {
            const info = await abortable(
              this.ctx.llm.resolveModelInfo(
                options.provider,
                options.model,
                reviewSignal,
              ),
              reviewSignal,
            );
            if (info.reasoning?.efforts.some((effort) => effort.id === "low"))
              options.reasoningEffort = "low";
          }
          // Bind the cache to the exact text the reviewer saw, so context abbreviation cannot reuse a stale approval.
          const key = hash({
            session: exec.agent.session.id,
            input: text,
            route: { provider: options.provider, model: options.model },
            policy: options.system,
            reasoning: options.reasoningEffort,
            maxTokens: options.maxTokens,
            tokenRecovery: [
              c.review.maxTokensLimit,
              c.review.tokenLimitRetries,
              c.review.tokenGrowthFactor,
            ],
            temperature: options.temperature,
          });
          let decision;
          const cached = c.cache.enabled ? this.cache.get(key) : undefined;
          if (cached && cached.expires > Date.now()) {
            decision = cached.decision;
            cacheHit = true;
          } else {
            if (cached) this.cache.delete(key);
            let retries = 0,
              budget = options.maxTokens,
              tokenRetryPending = false;
            for (;;) {
              reviewSignal.throwIfAborted();
              if (tokenRetryPending) {
                trace.tokenRetries++;
                tokenRetryPending = false;
              }
              this.audit.request(String(exec.agent.session.id));
              trace.reviewAttempts++;
              trace.lastMaxTokens = budget;
              try {
                decision = await abortable(
                  this.read(
                    this.ctx.llm.stream({ ...options, maxTokens: budget }),
                  ),
                  reviewSignal,
                );
                break;
              } catch (e) {
                if (reviewSignal.aborted) throw reviewSignal.reason ?? e;
                if (e.code === "DCAR_MAX_TOKENS") {
                  if (
                    trace.tokenRetries >= c.review.tokenLimitRetries ||
                    budget >= c.review.maxTokensLimit
                  )
                    throw e;
                  budget = Math.min(
                    c.review.maxTokensLimit,
                    budget * c.review.tokenGrowthFactor,
                  );
                  tokenRetryPending = true;
                } else {
                  if (retries >= c.review.retries) throw e;
                  retries++;
                }
                await delay(c.review.retryDelayMs, reviewSignal);
              }
            }
            if (c.cache.enabled && decision.decision === "allow") {
              this.cache.set(key, {
                decision,
                expires: Date.now() + c.cache.ttlMs,
              });
              while (this.cache.size > c.cache.maxEntries)
                this.cache.delete(this.cache.keys().next().value);
            }
          }
          reason =
            decision.reason ?? `LLM ${decision.risk}: ${decision.decision}`;
          const behavior =
            decision.decision === "ask"
              ? c.review.allowAsk
                ? "ask"
                : "deny"
              : c.review.onDeny;
          if (
            decision.decision !== "allow" &&
            behavior === "ask" &&
            this.ctx.approval.overrideOf(exec.agent.session) !== "never"
          )
            displayReason =
              `审查结论：${decision.decision === "deny" ? "拒绝" : "需要人工确认"}（风险等级：${decision.risk === "high" ? "高" : "中"}）。\n` +
              (await this.chineseReason(
                exec,
                decision,
                options,
                c,
                reviewSignal,
                trace,
              ));
          result =
            decision.decision === "allow"
              ? { kind: "allow" }
              : this.nonAllow(
                  exec,
                  behavior,
                  reason,
                  "DCAR_REVIEW_DENIED",
                  c,
                  displayReason,
                );
        } finally {
          clearTimeout(timeout);
          release?.();
        }
      }
    } catch (e) {
      if (signal.aborted) {
        result = { kind: "cancel" };
        reason = String(e.message ?? e);
      } else {
        error = true;
        layer = "llm";
        reason = String(e.message ?? e);
        trace.errorCode = e.code ?? "DCAR_REVIEW_ERROR";
        displayReason = reviewFailureMessage(e, c, trace);
        code ??= "REVIEW_ERROR";
        result = this.nonAllow(
          exec,
          c.review.onError,
          reason,
          "DCAR_REVIEW_FAILED",
          c,
          displayReason,
        );
      }
    }
    if (signal.aborted) result = { kind: "cancel" };
    this.audit.record(
      exec,
      {
        layer,
        decision: result.kind,
        code,
        reason,
        error,
        cacheHit,
        durationMs: Math.round(performance.now() - start),
        ...trace,
        displayReason,
      },
      c,
    );
    return result;
  }
  async chineseReason(exec, decision, options, c, signal, trace) {
    const original = decision.reason?.trim();
    if (isChineseReason(original)) return bounded(original, c.review.maxReasonChars);
    if (original && original.length <= c.review.maxInputChars) {
      for (
        let attempt = 0;
        attempt < c.review.chineseReasonRetries;
        attempt++
      ) {
        if (signal.aborted) break;
        this.audit.request(String(exec.agent.session.id));
        trace.translationAttempts++;
        try {
          return await abortable(
            readChineseReason(
              this.ctx.llm.stream({
                ...options,
                system:
                  CHINESE_TRANSLATION_POLICY +
                  `\n说明最多 ${c.review.maxReasonChars} 字符。`,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({ reason: original }),
                      },
                    ],
                  },
                ],
                maxTokens: Math.min(options.maxTokens, 2048),
              }),
              c.review.maxReasonChars,
            ),
            signal,
          );
        } catch {
          // Translation cannot change an already validated risk/decision or grant permission.
          if (signal.aborted) break;
        }
      }
    }
    if (original)
      return (
        "审查模型没有提供可用的中文说明，请核对本次操作的目标和授权范围后决定。" +
        (c.commands.enabled && c.audit.enabled && c.audit.includeReasons
          ? `原始审查说明的记录可通过 /${c.commands.name} history 查看。`
          : "")
      );
    return decision.decision === "ask"
      ? "审查模型需要你确认本次操作，但未给出具体说明。请核对操作内容、目标及授权范围。"
      : "审查模型未批准本次操作，且未给出具体说明。请核对操作内容、目标及授权范围。";
  }
  nonAllow(
    exec,
    behavior,
    reason,
    code,
    c = this.config,
    chineseExplanation = "请核对本次操作的目标及授权范围。",
  ) {
    const never = this.ctx.approval.overrideOf(exec.agent.session) === "never";
    if (behavior === "ask" && !never) {
      const text = approvalText(exec, c, chineseExplanation);
      return {
        kind: "ask",
        reason: text,
        displayReason: {
          en: text,
          zh: text,
        },
      };
    }
    return {
      kind: "deny",
      reason: `CAutoR did not authorize tool "${exec.name}"; body not executed: ${reason}`,
      info: {
        name:
          code === "DCAR_REVIEW_FAILED"
            ? "DCARReviewFailedError"
            : "DCARReviewDeniedError",
        code,
        reason,
      },
    };
  }
}
