#!/usr/bin/env node
/**
 * Runs a version's e2e suite as independent parallel shards, one per Angular
 * demo app. The apps are disjoint on disk (apps/angular-demo, apps/ng-zorro-demo,
 * ...), so their cases never touch the same files and can run concurrently.
 *
 * Each shard is a separate `vscode-test --label e2e:<version>` process with:
 *   - AAI_E2E_APP        — restricts the suite to that app's cases
 *   - AAI_VSCODE_DATA_DIR — a private user-data/extensions dir so concurrent
 *                           VS Code instances don't clash on shared lock files
 *
 * Usage: node scripts/e2e-parallel.mjs <version>   (e.g. v22)
 * Compile the tests first (the npm script does `compile-tests && copy-e2e-cases`).
 *
 * The quickfix cases strip a fixture's imports and restore them in an `after` hook a
 * timed-out test never reaches, so this restores what the run changed — and only that,
 * leaving alone anything that was already modified when the run started.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { stageFixturePackages } from "./stage-e2e-fixtures.mjs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/e2e-parallel.mjs <version>  (e.g. v22)");
  process.exit(2);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const casesDir = path.join(repoRoot, "src", "e2e", "cases", version);
if (!existsSync(casesDir)) {
  console.error(`No cases directory for ${version}: ${casesDir}`);
  process.exit(2);
}

/** Discover the distinct apps referenced by this version's descriptors. */
function discoverApps() {
  const apps = new Set();
  for (const entry of readdirSync(casesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const descriptorPath = path.join(casesDir, entry.name, "descriptor.json");
    if (!existsSync(descriptorPath)) {
      continue;
    }
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    const match = /^apps\/([^/]+)\//.exec(descriptor.componentPath ?? "");
    if (match) {
      apps.add(match[1]);
    }
  }
  return [...apps].sort();
}

const apps = discoverApps();
if (apps.length === 0) {
  console.error(`No app descriptors found under ${casesDir}`);
  process.exit(2);
}

const logRoot = path.join(tmpdir(), "aai-e2e", version);
mkdirSync(logRoot, { recursive: true });

// VS Code writes an IPC socket inside --user-data-dir; that path must stay under
// the 103-char Unix-socket limit. tmpdir() is already long on macOS, so the
// per-shard data dir uses a short index-based name (not the long app name).
const dataRoot = path.join(tmpdir(), "aai");
mkdirSync(dataRoot, { recursive: true });

const vscodeTestBin = path.join(repoRoot, "node_modules", ".bin", "vscode-test");

// Once, here: the shards run concurrently and must not replace a package another one
// is already reading.
stageFixturePackages(version);

console.log(`Running ${apps.length} parallel e2e shards for ${version}: ${apps.join(", ")}`);
console.log(`Logs: ${logRoot}\n`);

/** Spawn one shard and resolve with its result. */
function runShard(app, index) {
  return new Promise((resolve) => {
    const dataDir = path.join(dataRoot, `${version}-${index}`);
    mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(logRoot, `${app}.log`);
    const logFd = openSync(logPath, "w");

    const started = Date.now();
    const child = spawn(vscodeTestBin, ["--label", `e2e:${version}`], {
      cwd: repoRoot,
      env: { ...process.env, AAI_E2E_APP: app, AAI_VSCODE_DATA_DIR: dataDir },
      stdio: ["ignore", logFd, logFd],
    });

    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      // Pull the mocha summary line from the shard log for the final report.
      const log = readFileSync(logPath, "utf-8").replace(/\x1b\[[0-9;]*m/g, "");
      const summary = log.match(/\d+ passing.*|\d+ failing.*/g)?.join(" / ") ?? "(no summary)";
      resolve({ app, code: code ?? 1, seconds, summary, logPath });
    });
  });
}

/** Fixture files already modified before the run, which are the developer's business. */
function dirtyFixtures() {
  try {
    const output = execFileSync("git", ["status", "--porcelain", "--", fixturesDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return new Set(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
    );
  } catch {
    // No git, no restore. The suite is still the point.
    return undefined;
  }
}

/** Restores fixture files this run modified, and reports which. */
function restoreFixtures(alreadyDirty) {
  if (!alreadyDirty) {
    return;
  }
  const changed = [...(dirtyFixtures() ?? [])].filter((file) => !alreadyDirty.has(file));
  if (changed.length === 0) {
    return;
  }
  try {
    execFileSync("git", ["checkout", "--", ...changed], { cwd: repoRoot });
    console.log(`\nRestored ${changed.length} fixture file(s) the run left modified:`);
    for (const file of changed) {
      console.log(`  ${file}`);
    }
  } catch (error) {
    console.warn(`\nCould not restore fixtures: ${error.message}`);
    console.warn("Check `git status` before the next run — it would start from this state.");
  }
}

const fixturesDir = path.join("src", "e2e", "projects", version);
const alreadyDirty = dirtyFixtures();

const results = await Promise.all(apps.map((app, index) => runShard(app, index)));

restoreFixtures(alreadyDirty);

console.log("\n=== Parallel e2e results ===");
let failed = false;
for (const r of results) {
  const status = r.code === 0 ? "✔ PASS" : "✗ FAIL";
  if (r.code !== 0) {
    failed = true;
  }
  console.log(`  ${status}  ${r.app.padEnd(24)} ${String(r.seconds).padStart(4)}s  ${r.summary}`);
  if (r.code !== 0) {
    console.log(`         log: ${r.logPath}`);
  }
}

process.exit(failed ? 1 : 0);
