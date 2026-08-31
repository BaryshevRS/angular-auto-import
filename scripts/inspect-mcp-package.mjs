import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDirectory = "packages/mcp";
const manifest = JSON.parse(readFileSync(`${packageDirectory}/package.json`, "utf8"));
const extensionManifest = JSON.parse(readFileSync("package.json", "utf8"));
const npmCache = mkdtempSync(join(tmpdir(), "angular-auto-import-npm-cache-"));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: npmCache },
});
rmSync(npmCache, { recursive: true, force: true });

if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

const [description] = JSON.parse(packed.stdout);
const files = new Map(description.files.map((file) => [file.path, file]));
const required = ["LICENSE", "README.md", "dist/mcp.js", "dist/server.js", "package.json"];
const missing = required.filter((file) => !files.has(file));
const unexpected = [...files.keys()].filter((file) => !required.includes(file));

if (manifest.name !== "angular-auto-import-mcp") {
  throw new Error(`Unexpected MCP package name: ${manifest.name}`);
}
if (manifest.version !== extensionManifest.version) {
  throw new Error(`MCP package ${manifest.version} does not match extension ${extensionManifest.version}`);
}
if (manifest.bin?.["angular-auto-import-mcp"] !== "dist/mcp.js") {
  throw new Error("The angular-auto-import-mcp executable does not point at dist/mcp.js");
}
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(`MCP package contents differ: missing [${missing}], unexpected [${unexpected}]`);
}
if ((files.get("dist/mcp.js")?.mode & 0o111) === 0) {
  throw new Error("dist/mcp.js is not executable");
}

console.log(`angular-auto-import-mcp ${manifest.version}: ${description.size} bytes, ${files.size} files`);
