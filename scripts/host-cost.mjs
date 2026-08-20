/**
 * Runs the Extension Host cost measurement once per implementation and compares them.
 *
 * This is the gate the migration exists for: whether indexing and Angular analysis stop
 * competing with the editor for its own process. Nothing outside the Extension Host can
 * answer it, so the measurement runs inside one — twice, against the same fixture, in
 * the same scenario, with only the implementation changing.
 *
 * Usage: node scripts/host-cost.mjs
 * Requires a packaged build and compiled tests; `pnpm run host-cost` does both.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(path.join(tmpdir(), "aai-host-cost-"));
const runs = {};

try {
  for (const mode of ["direct", "lsp"]) {
    const output = path.join(workspace, `${mode}.json`);
    console.log(`\n── ${mode} ${"─".repeat(60 - mode.length)}\n`);

    execFileSync("npx", ["vscode-test", "--label", `host-cost:${mode}`], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: { ...process.env, AAI_HOST_COST_OUTPUT: output },
    });

    runs[mode] = JSON.parse(readFileSync(output, "utf8"));
  }

  report(runs);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function report({ direct, lsp }) {
  console.log(`\n${"═".repeat(66)}`);
  console.log("Extension Host cost — CPU burned by the editor's own process\n");

  const scenarios = Object.keys(direct.measurements);
  console.log("Scenario            direct        server        change");

  for (const scenario of scenarios) {
    const before = direct.measurements[scenario];
    const after = lsp.measurements[scenario];
    if (!after) {
      console.log(`${scenario.padEnd(20)}${format(before)}  (not measured for the server)`);
      continue;
    }
    console.log(`${scenario.padEnd(20)}${format(before)}${format(after)}${change(before.cpuMs, after.cpuMs)}`);
  }

  console.log("\nWall-clock, for context (the work still happens; the question is where)");
  for (const scenario of scenarios) {
    const before = direct.measurements[scenario];
    const after = lsp.measurements[scenario];
    if (after) {
      console.log(
        `${scenario.padEnd(20)}${`${before.wallMs} ms`.padEnd(14)}${`${after.wallMs} ms`.padEnd(14)}${change(before.wallMs, after.wallMs)}`
      );
    }
  }

  const cold = { before: direct.measurements.coldIndex, after: lsp.measurements.coldIndex };
  if (cold.before && cold.after) {
    console.log(
      `\nA cold index costs the Extension Host ${cold.before.cpuMs} ms of CPU with the direct`
    );
    console.log(`providers and ${cold.after.cpuMs} ms with the server.`);
  }
}

function format(measurement) {
  return `${measurement.cpuMs} ms CPU`.padEnd(14);
}

function change(before, after) {
  if (!before) {
    return "n/a";
  }
  const ratio = ((after - before) / before) * 100;
  return `${ratio >= 0 ? "+" : ""}${ratio.toFixed(0)}%`;
}
