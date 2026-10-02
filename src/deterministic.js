/** Layer one: a positive authorization rule or escalation; never a final deny. */
import { checkPaths, allow, escalate } from "./paths.js";
import { checkShell } from "./shell.js";
function field(a, path) {
  return path
    .split(".")
    .reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), a);
}
export async function deterministic(exec, ctx, c, signal = exec.signal) {
  if (!c.enabled || !c.rules.enabled)
    return escalate("RULES_DISABLED", "Deterministic rules disabled; use LLM");
  signal.throwIfAborted();
  const name = exec.name,
    a = exec.arguments;
  if (c.rules.alwaysReviewTools.includes(name))
    return escalate("ALWAYS_REVIEW", "Tool configured for LLM review");
  const encoded = JSON.stringify(a);
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded) > c.rules.maxArgumentBytes
  )
    return escalate("ARGUMENT_SIZE", "Arguments exceed deterministic limit");
  if (c.rules.trustedTools.includes(name))
    return allow("TRUSTED_TOOL", "Administrator explicitly trusted this tool");
  if (c.rules.harmlessTools.includes(name))
    return allow("HARMLESS_TOOL", "No host file or external side effects");
  if (!a || typeof a !== "object" || Array.isArray(a))
    return escalate("INVALID_ARGUMENTS", "Expected object arguments");
  if (c.shell.tools.includes(name)) return checkShell(exec, ctx, c, signal);
  const custom = c.rules.customTools.find((r) => r.name === name);
  const cwd = exec.agent.session.header.cwd;
  if (custom) {
    const paths = custom.pathFields.flatMap((p) => {
      const v = field(a, p);
      return Array.isArray(v) ? v : [v];
    });
    return checkPaths(paths, custom.effect, cwd, ctx, c, signal);
  }
  if (c.rules.readTools.includes(name))
    return checkPaths([a.file_path], "read", cwd, ctx, c, signal);
  if (c.rules.writeTools.includes(name))
    return checkPaths([a.file_path], "write", cwd, ctx, c, signal);
  if (c.rules.searchTools.includes(name)) {
    const path = a.path ?? a.cwd ?? cwd;
    // An absolute/traversing glob can search beyond its supplied root; do not approve it by its cwd.
    if (
      name === "glob" &&
      (typeof a.pattern !== "string" ||
        /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]:/i.test(a.pattern))
    )
      return escalate("SEARCH_SCOPE", "Search pattern needs review");
    return checkPaths([path], "read", cwd, ctx, c, signal);
  }
  return escalate(
    "UNKNOWN_TOOL",
    "No deterministic authorization rule for this tool",
  );
}
