#!/usr/bin/env node
/**
 * Runs the fixture sweep: every E2E project is asked, through the real server, whether it
 * shows any warning its corpus did not record.
 *
 * It lives behind its own script rather than in `test:node` because it indexes each
 * project's `node_modules` — a minute or two per version, against seventeen seconds for
 * everything else — and the fast suite is run constantly.
 *
 * Usage: pnpm run test:fixtures
 * @module
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mocha = path.join(repoRoot, "node_modules", ".bin", "mocha");

const result = spawnSync(
  mocha,
  ["--ui", "bdd", "--timeout", "600000", "out/test/node/fixtures-clean.test.js"],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, AAI_FIXTURE_SWEEP: "1" } }
);

process.exit(result.status ?? 1);
