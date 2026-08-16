/**
 * =================================================================================================
 * Test Suite Index
 * =================================================================================================
 */

import * as path from "node:path";

export function run(): Promise<void> {
  // Create the mocha test
  const Mocha = require("mocha");
  const { glob } = require("glob");

  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 10000, // 10 seconds timeout for tests
    reporter: "spec",
  });

  const testsRoot = path.resolve(__dirname, "..");

  return new Promise((c, e) => {
    // Only the suites that need the VS Code host; `test/node` runs under plain Mocha.
    glob("suite/**/*.test.js", { cwd: testsRoot }, (err: any, files: string[]) => {
      if (err) {
        return e(err);
      }

      // Add files to the test suite
      files.forEach((f: string) => {
        mocha.addFile(path.resolve(testsRoot, f));
      });

      try {
        // Run the mocha test
        mocha.run((failures: number) => {
          if (failures > 0) {
            e(new Error(`${failures} tests failed.`));
          } else {
            c();
          }
        });
      } catch (err) {
        console.error(err);
        e(err);
      }
    });
  });
}
