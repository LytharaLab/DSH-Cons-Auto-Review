/** Resolve paths where the host executes them, without moving the permission root. */
import { isAbsolute } from "node:path";

function directoryService(ctx) {
  return typeof ctx.get === "function"
    ? ctx.get("workingDirectory")
    : ctx.workingDirectory;
}

export function workspaceDirectory(exec, ctx) {
  return exec.agent.session.header.cwd ?? directoryService(ctx)?.defaultDirectory;
}

export async function executionDirectories(exec, ctx, signal) {
  const service = directoryService(ctx);
  const original = exec.agent.session.header.cwd;
  // Older DSH releases have no mutable working-directory service.
  const cwd = service === undefined
    ? original
    : await service.ensure(exec.agent, signal);
  const workspaceRoot = original ?? service?.defaultDirectory;
  if (typeof cwd !== "string" || !isAbsolute(cwd) ||
      typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot))
    throw new Error("DCAR 无法确定当前工作目录和原始工作区，不能据此自动放行");
  return { cwd, workspaceRoot };
}
