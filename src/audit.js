/** Session-scoped counters, bounded history, and optional redacted JSONL audit. */
import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Audit {
  sessions = new Map();
  tail = Promise.resolve();
  state(id) {
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        total: 0,
        deterministic: 0,
        escalated: 0,
        llmRequests: 0,
        tokenLimitRetries: 0,
        translationRequests: 0,
        cacheHits: 0,
        allowed: 0,
        asked: 0,
        denied: 0,
        errors: 0,
        cancelled: 0,
        history: [],
      };
      this.sessions.set(id, state);
    }
    return state;
  }
  request(id) {
    this.state(id).llmRequests++;
  }
  record(exec, event, c) {
    const id = String(exec.agent.session.id),
      s = this.state(id);
    s.total++;
    s[event.layer === "program" ? "deterministic" : "escalated"]++;
    if (event.cacheHit) s.cacheHits++;
    if (event.error) s.errors++;
    s.tokenLimitRetries += event.tokenRetries ?? 0;
    s.translationRequests += event.translationAttempts ?? 0;
    s[
      { allow: "allowed", ask: "asked", deny: "denied", cancel: "cancelled" }[
        event.decision
      ]
    ]++;
    if (!c.audit.enabled) return;
    const row = {
      time: new Date().toISOString(),
      sessionId: id,
      callId: String(exec.callId),
      tool: exec.name,
      argumentHash: hash(exec.arguments),
      layer: event.layer,
      decision: event.decision,
      rule: event.code,
      durationMs: event.durationMs,
      cacheHit: !!event.cacheHit,
      reviewAttempts: event.reviewAttempts ?? 0,
      tokenLimitRetries: event.tokenRetries ?? 0,
      translationAttempts: event.translationAttempts ?? 0,
      lastMaxTokens: event.lastMaxTokens ?? 0,
    };
    if (event.errorCode) row.errorCode = event.errorCode;
    if (c.audit.includeReasons) {
      row.reason = String(event.reason ?? "").slice(0, 2000);
      if (event.displayReason)
        row.displayReason = String(event.displayReason).slice(0, 2000);
    }
    if (c.audit.includeArguments) row.arguments = exec.arguments;
    s.history.push(row);
    if (s.history.length > c.audit.historyLimit)
      s.history.splice(0, s.history.length - c.audit.historyLimit);
    if (c.audit.file) {
      const cwd = exec.agent.session.header.cwd;
      const file = isAbsolute(c.audit.file)
        ? c.audit.file
        : resolve(cwd, c.audit.file);
      this.tail = this.tail
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          try {
            if (
              (await stat(file)).size +
                Buffer.byteLength(JSON.stringify(row)) +
                1 >
              c.audit.maxBytes
            )
              await rename(file, `${file}.1`);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await appendFile(file, `${JSON.stringify(row)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        })
        .catch((error) => {
          this.lastError = String(error.message ?? error);
        });
    }
  }
  stats(id) {
    const { history, ...s } = this.state(String(id));
    return {
      ...s,
      savedReviewRequests: s.deterministic,
      deterministicRate: s.total
        ? `${((s.deterministic / s.total) * 100).toFixed(1)}%`
        : "0%",
      auditError: this.lastError ?? null,
    };
  }
  history(id, n = 20) {
    return this.state(String(id)).history.slice(-n);
  }
  reset(id) {
    this.sessions.delete(String(id));
  }
  async flush() {
    await this.tail;
  }
}
