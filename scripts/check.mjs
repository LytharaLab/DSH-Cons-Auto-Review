import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
for (const file of readdirSync("src").filter((f) => f.endsWith(".js"))) {
  const r = spawnSync(process.execPath, ["--check", `src/${file}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const patch = parse(readFileSync("cordis.patch.yml", "utf8"));
if (patch.length !== 1 || patch[0].insert[0].name !== pkg.name)
  throw new Error("Invalid bundle: patch name must equal the package name");
const plugin = await import("../src/index.js");
plugin.resolveConfig(plugin.Config({}));
console.log("ESM imports, syntax, Cordis schema and CAutoR bundle checked.");
