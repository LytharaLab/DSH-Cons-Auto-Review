import { mkdtemp, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
export async function canonical(path, cwd) {
  const displayPath = resolve(cwd, path);
  try {
    return { displayPath, targetKey: await realpath(displayPath) };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const parts = [];
  let current = displayPath;
  for (;;) {
    try {
      return {
        displayPath,
        targetKey: join(await realpath(current), ...parts),
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      parts.unshift(basename(current));
      const p = dirname(current);
      if (p === current) throw e;
      current = p;
    }
  }
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dcar-test-")),
    cwd = join(root, "workspace"),
    outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const requests = [],
    ctx = {
      fs: { resolve: (p, o) => canonical(p, o.cwd) },
      approval: { overrideOf: () => "ask" },
      llm: {
        stream: (options) => {
          requests.push(options);
          return chunks('{"risk":"low","decision":"allow"}');
        },
      },
    };
  const session = { id: "session-1", header: { cwd } },
    agent = { id: "session-1", session };
  const exec = (name, args) => ({
    name,
    arguments: args,
    agent,
    callId: "call-1",
    rootCallId: "call-1",
    signal: new AbortController().signal,
  });
  const snapshot = (_, x) => ({
    provider: "fake",
    model: "main-model",
    cwd,
    projectInstructions: [],
    history: [
      {
        kind: "user-message",
        role: "human-instruction",
        source: { kind: "user" },
        content: [{ type: "text", text: "Work on this project" }],
      },
    ],
    action: {
      mode: "native",
      name: x.name,
      description: "test tool",
      parameters: { type: "object" },
      arguments: x.arguments,
    },
  });
  return { root, cwd, outside, ctx, agent, session, exec, requests, snapshot };
}
export async function* chunks(text, finish = "stop") {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: finish } };
}
