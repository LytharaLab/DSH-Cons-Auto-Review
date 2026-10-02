/** Abort-aware queue and timers. */
export function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "Aborted"));
}
export function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
export class ReviewQueue {
  active = 0;
  waiting = [];
  async acquire(limit, maxQueued, signal) {
    signal.throwIfAborted();
    if (this.active < limit) {
      this.active++;
      return () => this.release();
    }
    if (this.waiting.length >= maxQueued)
      throw new Error("DCAR review queue is full");
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.waiting = this.waiting.filter((x) => x !== entry);
          reject(abortError(signal));
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
  release() {
    const entry = this.waiting.shift();
    if (entry) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.resolve(() => this.release());
    } else this.active--;
  }
}
