import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { resolveConfig, patchConfig, DEFAULTS } from "../src/config.js";
import { deterministic } from "../src/deterministic.js";
import { literalArgv } from "../src/shell.js";
import { protectedPath } from "../src/paths.js";
const c = resolveConfig({ rules: { includeTempRoots: false } });
test("configuration merges, freezes and validates all security fields", () => {
  const config = resolveConfig({
    review: { model: "custom", provider: "p" },
    rules: { additionalWritableRoots: ["../cache"] },
  });
  assert.equal(config.review.timeoutMs, 120000);
  assert.equal(config.review.model, "custom");
  assert.throws(() => {
    config.rules.writeTools.push("bad");
  }, TypeError);
  assert.throws(() => {
    DEFAULTS.rules.writeTools.push("bad");
  }, TypeError);
  for (const patch of [
    { bogus: 1 },
    { review: { onError: "allow" } },
    { review: { timeoutMs: 0 } },
    { review: { provider: "p" } },
    { cache: { enabled: "yes" } },
    { shell: { trustedCommands: [{ executable: "npm" }] } },
    {
      rules: {
        customTools: [{ name: "x", effect: "deny", pathFields: ["path"] }],
      },
    },
    { rules: { readTools: ["write"] } },
  ])
    assert.throws(() => resolveConfig(patch));
  assert.equal(
    patchConfig(config, { review: { timeoutMs: 99 } }).review.model,
    "custom",
  );
  assert.throws(() => patchConfig(config, { review: { typo: 1 } }));
});
for (const [name, args, kind, code] of [
  ["read", { file_path: "src.js" }, "allow", "SAFE_READ"],
  ["write", { file_path: "src.js", content: "x" }, "allow", "WORKSPACE_WRITE"],
  [
    "edit",
    { file_path: "src.js", old_string: "x", new_string: "y" },
    "allow",
    "WORKSPACE_WRITE",
  ],
  ["write", { file_path: "../outside/a" }, "escalate", "OUTSIDE_WORKSPACE"],
  ["read", { file_path: ".env" }, "escalate", "PROTECTED_PATH"],
  ["read", { file_path: ".env.example" }, "allow", "SAFE_READ"],
  [
    "write",
    { file_path: ".git/hooks/post-commit" },
    "escalate",
    "PROTECTED_PATH",
  ],
  ["write", { file_path: "" }, "escalate", "INVALID_PATH"],
  ["todo_write", { todos: [] }, "allow", "HARMLESS_TOOL"],
  ["mcp_foo", { path: "a" }, "escalate", "UNKNOWN_TOOL"],
  ["glob", { pattern: "../*" }, "escalate", "SEARCH_SCOPE"],
  ["glob", { pattern: "src/**/*.js" }, "allow", "SAFE_READ"],
  ["bash", { command: "pwd" }, "allow", "READ_COMMAND"],
  ["bash", { command: "mkdir -p output" }, "allow", "WORKSPACE_WRITE"],
  ["bash", { command: "touch ../outside/a" }, "escalate", "OUTSIDE_WORKSPACE"],
  ["bash", { command: 'node -e "process.exit()"' }, "escalate", "SHELL_SYNTAX"],
  ["bash", { command: "npm run build" }, "escalate", "UNKNOWN_COMMAND"],
  ["bash", { command: "git diff" }, "escalate", "UNKNOWN_COMMAND"],
  ["bash", { command: "cat .env" }, "escalate", "PROTECTED_PATH"],
  ["bash", { command: "rg --pre malicious foo" }, "escalate", "SHELL_OPTIONS"],
  ["bash", { command: 'rg -n "foo" src' }, "allow", "SAFE_READ"],
  ["pwsh", { command: "Get-Location" }, "allow", "READ_COMMAND"],
  ["pwsh", { command: "Get-Content src.js" }, "allow", "SAFE_READ"],
  [
    "pwsh",
    { command: "Invoke-Expression evil" },
    "escalate",
    "UNKNOWN_COMMAND",
  ],
])
  test(`${name} ${JSON.stringify(args)} => ${kind}`, async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const result = await deterministic(f.exec(name, args), f.ctx, c);
    assert.equal(result.kind, kind);
    assert.equal(result.code, code);
  });
test("symlink targets outside workspace always escalate, including missing descendants", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await symlink(f.outside, join(f.cwd, "linked"), "dir");
  assert.equal(
    (
      await deterministic(
        f.exec("write", { file_path: "linked/new/a" }),
        f.ctx,
        c,
      )
    ).kind,
    "escalate",
  );
  await writeFile(join(f.outside, "file"), "x");
  await symlink(join(f.outside, "file"), join(f.cwd, "alias"));
  assert.equal(
    (await deterministic(f.exec("edit", { file_path: "alias" }), f.ctx, c))
      .kind,
    "escalate",
  );
});
test("workspace prefix collisions are not contained", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(`${f.cwd}-evil`);
  assert.equal(
    (
      await deterministic(
        f.exec("write", { file_path: `${f.cwd}-evil/a` }),
        f.ctx,
        c,
      )
    ).kind,
    "escalate",
  );
});
test("temp roots, additional roots and outside reads are configurable", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(
    (
      await deterministic(
        f.exec("write", { file_path: join(f.outside, "a") }),
        f.ctx,
        resolveConfig(),
      )
    ).kind,
    "allow",
  );
  const extra = patchConfig(c, {
    rules: { additionalWritableRoots: [f.outside] },
  });
  assert.equal(
    (
      await deterministic(
        f.exec("write", { file_path: join(f.outside, "a") }),
        f.ctx,
        extra,
      )
    ).kind,
    "allow",
  );
  assert.equal(
    (
      await deterministic(
        f.exec("read", { file_path: join(f.outside, "a") }),
        f.ctx,
        patchConfig(c, { rules: { allowOutsideReads: false } }),
      )
    ).kind,
    "escalate",
  );
});
test("protected directory still applies to environment samples", () => {
  assert.equal(protectedPath("/a/.ssh/.env.example", c), true);
  assert.equal(protectedPath("/a/.env.example", c), false);
});
test("all ambiguous shell forms escalate instead of matching a command prefix", () => {
  for (const command of [
    "pwd; rm -rf /",
    "pwd && evil",
    "pwd | evil",
    "echo $(evil)",
    "echo `evil`",
    "cat <(evil)",
    "cat > out",
    "pwd\nevil",
    "cat *.txt",
    'cat "a\\b"',
    'cat "unclosed',
    "cat #hidden",
    "A=B pwd",
    "pwd & evil",
    "cat .e[n]v",
    'Get-Content ".e[n]v"',
    'Get-Content "*.txt"',
    "Get-Content @args",
  ])
    assert.equal(literalArgv(command), undefined, command);
});
test("trusted argv requires an exact match, and alwaysReview precedes all grants", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const trusted = patchConfig(c, {
    shell: { trustedCommands: [{ executable: "npm", args: ["run", "build"] }] },
  });
  assert.equal(
    (
      await deterministic(
        f.exec("bash", { command: "npm run build" }),
        f.ctx,
        trusted,
      )
    ).kind,
    "allow",
  );
  assert.equal(
    (
      await deterministic(
        f.exec("bash", { command: "npm run build extra" }),
        f.ctx,
        trusted,
      )
    ).kind,
    "escalate",
  );
  assert.equal(
    (
      await deterministic(
        f.exec("write", { file_path: "a" }),
        f.ctx,
        patchConfig(c, {
          rules: { alwaysReviewTools: ["write"], trustedTools: ["write"] },
        }),
      )
    ).kind,
    "escalate",
  );
});
test("custom tools check every declared target", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const config = patchConfig(c, {
    rules: {
      customTools: [{ name: "copy", effect: "write", pathFields: ["targets"] }],
    },
  });
  assert.equal(
    (
      await deterministic(
        f.exec("copy", { targets: ["a", "../outside/a"] }),
        f.ctx,
        config,
      )
    ).kind,
    "escalate",
  );
  assert.equal(
    (
      await deterministic(
        f.exec("copy", { targets: ["a", "b"] }),
        f.ctx,
        config,
      )
    ).kind,
    "allow",
  );
  assert.equal(
    (await deterministic(f.exec("copy", { targets: [] }), f.ctx, config)).kind,
    "escalate",
  );
});
