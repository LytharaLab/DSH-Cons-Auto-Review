/** Conservative command grammar for unconfined execution. Unrecognized syntax escalates. */
import { checkPaths, allow, escalate } from "./paths.js";
/** Parse literal argv only; never evaluate a command or use a prefix permission match. */
export function literalArgv(command) {
  if (
    typeof command !== "string" ||
    !command.trim() ||
    /[\r\n\x00-\x1f$`<>|;&(){}\\*?\[\]@]/.test(command)
  )
    return undefined;
  const args = [];
  let token = "",
    started = false,
    quote = "";
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    if (/[\\*?!#]/.test(ch)) return undefined;
    token += ch;
    started = true;
  }
  if (quote) return undefined;
  if (started) args.push(token);
  if (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) return undefined;
  return args.length ? args : undefined;
}
function same(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
/** Exact literal commands and checked workspace mutations can skip LLM review. */
export async function checkShell(exec, ctx, c, signal) {
  const a = exec.arguments;
  if (!c.shell.enabled)
    return escalate("SHELL_RULES_DISABLED", "Shell rules disabled");
  if (
    typeof a.command !== "string" ||
    a.command.length > c.shell.maxCommandChars
  )
    return escalate("COMMAND_SIZE", "Command missing or too long");
  const argv = literalArgv(a.command);
  if (!argv)
    return escalate(
      "SHELL_SYNTAX",
      "Expansion, compound syntax or scripts require LLM review",
    );
  const [exe, ...args] = argv;
  const cwd = exec.agent.session.header.cwd;
  if (a.workdir !== undefined) {
    const checked = await checkPaths([a.workdir], "write", cwd, ctx, c, signal);
    if (checked.kind !== "allow") return checked;
  }
  const base =
    a.workdir === undefined
      ? cwd
      : String((await ctx.fs.resolve(a.workdir, { cwd, signal })).targetKey);
  if (
    c.shell.trustedCommands.some(
      (cmd) => cmd.executable === exe && same(cmd.args, args),
    )
  )
    return allow("TRUSTED_COMMAND", "Administrator configured this exact argv");
  const isPwsh = exec.name === "pwsh";
  // PowerShell resolves aliases and case-insensitive names; only canonical cmdlets are admitted.
  const readExe = c.shell.readCommands.find((x) =>
    isPwsh ? x.toLowerCase() === exe.toLowerCase() : x === exe,
  );
  if (readExe) {
    if (isPwsh) {
      if (
        ![
          "Get-Location",
          "Get-ChildItem",
          "Get-Content",
          "Write-Output",
        ].includes(readExe)
      )
        return escalate("UNKNOWN_COMMAND", "Unknown PowerShell read semantics");
      if (readExe === "Get-Location")
        return args.length
          ? escalate("SHELL_OPTIONS", "Unsupported parameters")
          : allow("READ_COMMAND", "Get-Location");
      if (readExe === "Write-Output")
        return args.some((x) => x.startsWith("-"))
          ? escalate("SHELL_OPTIONS", "Unsupported parameters")
          : allow("READ_COMMAND", "Literal output");
      if (args.some((x) => x.startsWith("-")))
        return escalate("SHELL_OPTIONS", "PowerShell options require review");
      return checkPaths(
        args.length ? args : [base],
        "read",
        base,
        ctx,
        c,
        signal,
      );
    }
    if (exe === "pwd")
      return args.length
        ? escalate("SHELL_OPTIONS", "Unsupported pwd arguments")
        : allow("READ_COMMAND", "Print current directory");
    if (exe === "echo") return allow("READ_COMMAND", "Literal output");
    const safeOptions = {
      ls: new Set([
        "-a",
        "-l",
        "-h",
        "-la",
        "-al",
        "-lh",
        "-lah",
        "-R",
        "--all",
      ]),
      cat: new Set(["-n", "-b", "--number"]),
      head: new Set(["-n", "-c"]),
      tail: new Set(["-n", "-c"]),
      wc: new Set(["-l", "-w", "-c", "-m"]),
      rg: new Set([
        "-n",
        "-l",
        "-i",
        "--files",
        "--hidden",
        "--no-ignore",
        "-F",
        "--fixed-strings",
        "--count",
      ]),
      grep: new Set(["-n", "-l", "-i", "-r", "-R", "-F", "--count"]),
    };
    if (!safeOptions[exe])
      return escalate(
        "UNKNOWN_COMMAND",
        "Configured command has no built-in semantics; use trustedCommands for exact argv",
      );
    let positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("-")) {
        if (!safeOptions[exe].has(arg))
          return escalate("SHELL_OPTIONS", `Unsupported ${exe} option ${arg}`);
        if (
          (exe === "head" || exe === "tail") &&
          (arg === "-n" || arg === "-c")
        ) {
          if (!/^\d+$/.test(args[++i] ?? ""))
            return escalate("SHELL_OPTIONS", "Invalid count");
        }
      } else positional.push(arg);
    }
    if ((exe === "rg" && !args.includes("--files")) || exe === "grep") {
      if (!positional.length)
        return escalate("SHELL_OPTIONS", "Missing search pattern");
      positional = positional.slice(1);
    }
    return checkPaths(
      positional.length ? positional : [base],
      "read",
      base,
      ctx,
      c,
      signal,
    );
  }
  if (c.shell.workspaceMutationCommands.includes(exe)) {
    if (isPwsh || !["mkdir", "touch"].includes(exe))
      return escalate("UNKNOWN_COMMAND", "No built-in mutation semantics");
    const paths = args.filter(
      (x) => !(exe === "mkdir" && x === "-p") && x !== "--",
    );
    if (!paths.length || paths.some((x) => x.startsWith("-")))
      return escalate("SHELL_OPTIONS", "Unsupported mutation options");
    return checkPaths(paths, "write", base, ctx, c, signal);
  }
  return escalate("UNKNOWN_COMMAND", `Command ${exe} requires semantic review`);
}
