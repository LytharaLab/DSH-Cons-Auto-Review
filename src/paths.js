/** DSH filesystem resolution + the upstream canonical containment check. */
import { basename, isAbsolute, resolve } from "node:path";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";
import { isPathUnder } from "./containment.js";
export const allow = (code, reason) => ({ kind: "allow", code, reason });
export const escalate = (code, reason) => ({ kind: "escalate", code, reason });
const regexCache = new Map();
/** Match a slash-normalized full path against an administrator-configured glob. */
export function matchesGlob(path, pattern) {
  let r = regexCache.get(pattern);
  if (!r) {
    let s = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*" && pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          s += "(?:.*/)?";
        } else s += ".*";
      } else if (ch === "*") s += "[^/]*";
      else if (ch === "?") s += "[^/]";
      else s += ch.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
    }
    r = new RegExp(`^${s}$`, process.platform === "win32" ? "i" : "");
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, r);
  }
  return r.test(path.replaceAll("\\", "/"));
}
export function protectedPath(path, config) {
  const sample = config.rules.safeEnvironmentFiles.includes(basename(path));
  const normalized = path.replaceAll("\\", "/");
  return config.rules.protectedPaths.some(
    (p) =>
      !(sample && p.startsWith("**/.env")) &&
      (matchesGlob(normalized, p) || matchesGlob(`${normalized}/`, p)),
  );
}
/** Check every path, including aliases and missing targets, without changing sandbox policy. */
export async function checkPaths(paths, effect, cwd, ctx, config, signal) {
  if (!paths.length)
    return escalate("INVALID_PATH", "No target paths supplied");
  if (!isAbsolute(cwd))
    return escalate("WORKSPACE_UNAVAILABLE", "No absolute session workspace");
  const roots = config.rules.includeTempRoots
    ? writableRoots({ mode: "workspace-write", workspaceRoot: cwd })
    : [cwd];
  roots.push(
    ...config.rules.additionalWritableRoots.map((p) =>
      isAbsolute(p) ? p : resolve(cwd, p),
    ),
  );
  for (const path of paths) {
    if (typeof path !== "string" || !path.trim())
      return escalate("INVALID_PATH", "Path arguments are missing or invalid");
    // Windows alternate data streams, devices, and ambiguous namespace spellings require review.
    if (
      process.platform === "win32" &&
      (/^\\\\[?.]\\/.test(path) ||
        /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(path) ||
        /:/.test(path.replace(/^[a-z]:/i, "")))
    )
      return escalate(
        "WINDOWS_SPECIAL_PATH",
        "Device paths or alternate data streams require review",
      );
    const target = await ctx.fs.resolve(path, { cwd, signal });
    const key = String(target.targetKey);
    if (protectedPath(key, config) || protectedPath(target.displayPath, config))
      return escalate(
        "PROTECTED_PATH",
        `Protected path: ${target.displayPath}`,
      );
    if (effect === "read" && config.rules.allowOutsideReads) continue;
    let contained = false;
    for (const root of roots) {
      const canonical = await ctx.fs.resolve(root, { cwd, signal });
      if (await isPathUnder(key, String(canonical.targetKey))) {
        contained = true;
        break;
      }
    }
    if (!contained)
      return escalate(
        "OUTSIDE_WORKSPACE",
        `Path is outside permitted ${effect} roots: ${target.displayPath}`,
      );
  }
  return allow(
    effect === "write" ? "WORKSPACE_WRITE" : "SAFE_READ",
    `All ${effect} paths passed DSH workspace rules`,
  );
}
