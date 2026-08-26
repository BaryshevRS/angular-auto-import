/**
 * Checks that a packaged VSIX really contains a working client and server.
 *
 * Bundling is where this migration can fail silently: the extension can build, the
 * tests can pass, and the shipped archive can still be missing the server, or carry a
 * server that reaches for `vscode`, or leave `@angular/compiler` as a bare require that
 * resolves to nothing inside the packaged extension. None of that is visible from the
 * source tree, so it is checked on the artifact itself.
 *
 * Usage: node scripts/inspect-vsix.mjs [path/to/extension.vsix]
 * With no argument it picks the newest .vsix in the repository root.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** What the packaged archive has to contain to be shippable. */
const EXPECTATIONS = [
  {
    file: "extension/dist/server.js",
    label: "language server bundle",
    forbidden: [
      // The server runs outside the Extension Host; reaching for `vscode` there throws.
      { pattern: 'require("vscode")', why: "the server must not depend on the editor API" },
      { pattern: 'require("@angular/compiler")', why: "the Angular compiler must be bundled, not resolved at runtime" },
      { pattern: 'require("ts-morph")', why: "ts-morph must be bundled, not resolved at runtime" },
      { pattern: 'require("prettier")', why: "formatting config is read directly, so Prettier is not shipped" },
    ],
    required: [
      { pattern: "parseTemplate", why: "the Angular compiler is what the analysis runs on" },
      { pattern: "createConnection", why: "the server has to be able to open a connection" },
    ],
  },
  {
    file: "extension/dist/extension.js",
    label: "extension bundle",
    forbidden: [
      { pattern: 'require("prettier")', why: "formatting belongs in the language server" },
      { pattern: "ts-morph", why: "analysis must not run in the Extension Host" },
    ],
    required: [
      { pattern: '"server.js"', why: "the client has to know which file to start" },
      { pattern: "TransportKind", why: "the client starts the server over a transport" },
    ],
  },
];

/**
 * What the archive must not carry. A forbidden `require` only says the bundle stopped
 * asking for something; this says the something stopped being shipped, which is the half
 * that shows up in the download size.
 */
const FORBIDDEN_PATHS = [
  { file: "extension/dist/node_modules", why: "the server bundles what it needs; nothing is resolved at runtime" },
];

function newestVsix(directory) {
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => ({ name, mtime: statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);

  if (candidates.length === 0) {
    throw new Error(`No .vsix found in ${directory}; run "pnpm run vsce:package" first`);
  }
  return path.join(directory, candidates[0].name);
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const archive = process.argv[2] ? path.resolve(process.argv[2]) : newestVsix(repositoryRoot);
const extracted = mkdtempSync(path.join(tmpdir(), "aai-vsix-"));
const failures = [];

try {
  execFileSync("unzip", ["-q", archive, "-d", extracted]);

  for (const expectation of EXPECTATIONS) {
    const filePath = path.join(extracted, expectation.file);
    let contents;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch {
      failures.push(`${expectation.label}: ${expectation.file} is missing from the archive`);
      continue;
    }

    for (const { pattern, why } of expectation.forbidden ?? []) {
      if (contents.includes(pattern)) {
        failures.push(`${expectation.label}: contains ${pattern} — ${why}`);
      }
    }
    for (const { pattern, why } of expectation.required ?? []) {
      if (!contents.includes(pattern)) {
        failures.push(`${expectation.label}: missing ${pattern} — ${why}`);
      }
    }

    console.log(`✓ ${expectation.label} (${(contents.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  for (const { file, why } of FORBIDDEN_PATHS) {
    if (existsSync(path.join(extracted, file))) {
      failures.push(`archive: contains ${file} — ${why}`);
    } else {
      console.log(`✓ no ${file}`);
    }
  }
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${path.basename(archive)} is not shippable:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}

console.log(`\n${path.basename(archive)} carries both bundles and nothing they do not need.`);
