/**
 * =================================================================================================
 * Package JSON Utilities Tests
 * =================================================================================================
 *
 * Tests for utility functions that work with package.json files to find Angular dependencies
 * and extract library entry points.
 */

import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AngularDependency } from "../../utils/package-json";
import { findAngularDependencies, getLibraryEntryPoints } from "../../utils/package-json";

describe("Package JSON Utilities", function () {
  // Set timeout for all tests in this suite
  this.timeout(10000);

  const fixturesPath = path.join(__dirname, "..", "fixtures");
  const simpleProjectPath = path.join(fixturesPath, "simple-package-project");
  const complexProjectPath = path.join(fixturesPath, "complex-package-project");
  const noPackageProjectPath = path.join(fixturesPath, "no-package-project");
  const invalidPackageProjectPath = path.join(fixturesPath, "invalid-package-project");
  const nonAngularProjectPath = path.join(fixturesPath, "non-angular-project");

  // Setup mock node_modules for test projects
  before(async () => {
    // Simple Project
    await fs.mkdir(path.join(simpleProjectPath, "node_modules", "@angular", "core"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(simpleProjectPath, "node_modules", "@angular", "core", "package.json"),
      JSON.stringify({ name: "@angular/core", version: "17.0.0" })
    );
    await fs.mkdir(path.join(simpleProjectPath, "node_modules", "angular-lib"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(simpleProjectPath, "node_modules", "angular-lib", "package.json"),
      JSON.stringify({
        name: "angular-lib",
        version: "1.0.0",
        peerDependencies: { "@angular/core": "*" },
        types: "lib/index.d.ts",
      })
    );
    await fs.mkdir(path.join(simpleProjectPath, "node_modules", "dev-angular-lib"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(simpleProjectPath, "node_modules", "dev-angular-lib", "package.json"),
      JSON.stringify({
        name: "dev-angular-lib",
        version: "1.0.0",
        dependencies: { "@angular/core": "*" },
        typings: "dist/index.d.ts",
      })
    );

    // Complex Project
    await fs.mkdir(path.join(complexProjectPath, "node_modules", "ngx-bootstrap"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(complexProjectPath, "node_modules", "ngx-bootstrap", "package.json"),
      JSON.stringify({
        name: "ngx-bootstrap",
        version: "1.0.0",
        peerDependencies: { "@angular/core": "*" },
        exports: {
          ".": { types: "./index.d.ts" },
          "./datepicker": { types: "./datepicker/index.d.ts" },
          "./modal": { types: "./modal/index.d.ts" },
        },
      })
    );
    await fs.mkdir(path.join(complexProjectPath, "node_modules", "primeng"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(complexProjectPath, "node_modules", "primeng", "package.json"),
      JSON.stringify({
        name: "primeng",
        version: "1.0.0",
        peerDependencies: { "@angular/core": "*" },
        exports: {
          ".": "./index.d.ts",
          "./button": "./button/index.d.ts",
        },
      })
    );
  });

  after(async () => {
    // Cleanup mock node_modules
    await fs.rm(path.join(simpleProjectPath, "node_modules"), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(complexProjectPath, "node_modules"), {
      recursive: true,
      force: true,
    });
  });

  describe("#findAngularDependencies", () => {
    it("should find Angular dependencies in simple project", async () => {
      const result = await findAngularDependencies(simpleProjectPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.ok(result.length >= 3, "Should find at least 3 Angular dependencies");

      // Check for @angular/core
      const angularCore = result.find((dep) => dep.name === "@angular/core");
      assert.ok(angularCore, "Should find @angular/core");
      assert.ok(angularCore.path.endsWith(path.join("@angular", "core")), "Should have correct path for @angular/core");

      // Check for angular-lib (has peerDependencies with @angular/core)
      const angularLib = result.find((dep) => dep.name === "angular-lib");
      assert.ok(angularLib, "Should find angular-lib");
      assert.ok(angularLib.path.endsWith("angular-lib"), "Should have correct path for angular-lib");

      // Check for dev-angular-lib (has dependencies with @angular/core)
      const devAngularLib = result.find((dep) => dep.name === "dev-angular-lib");
      assert.ok(devAngularLib, "Should find dev-angular-lib");
      assert.ok(devAngularLib.path.endsWith("dev-angular-lib"), "Should have correct path for dev-angular-lib");

      // Should not find non-Angular dependencies
      const rxjs = result.find((dep) => dep.name === "rxjs");
      assert.strictEqual(rxjs, undefined, "Should not find rxjs as Angular dependency");
    });

    it("should find Angular dependencies with complex exports", async () => {
      const result = await findAngularDependencies(complexProjectPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.ok(result.length >= 2, "Should find at least 2 Angular dependencies");

      // Check for ngx-bootstrap
      const ngxBootstrap = result.find((dep) => dep.name === "ngx-bootstrap");
      assert.ok(ngxBootstrap, "Should find ngx-bootstrap");

      // Check for primeng
      const primeng = result.find((dep) => dep.name === "primeng");
      assert.ok(primeng, "Should find primeng");
    });

    it("should handle both dependencies and devDependencies", async () => {
      const result = await findAngularDependencies(simpleProjectPath);

      // angular-lib is in dependencies
      const angularLib = result.find((dep) => dep.name === "angular-lib");
      assert.ok(angularLib, "Should find dependency from dependencies section");

      // dev-angular-lib is in devDependencies
      const devAngularLib = result.find((dep) => dep.name === "dev-angular-lib");
      assert.ok(devAngularLib, "Should find dependency from devDependencies section");
    });

    it("should return empty array for non-Angular project", async () => {
      const result = await findAngularDependencies(nonAngularProjectPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.strictEqual(result.length, 0, "Should return empty array for non-Angular project");
    });

    it("should return empty array for missing package.json", async () => {
      const result = await findAngularDependencies(noPackageProjectPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.strictEqual(result.length, 0, "Should return empty array for missing package.json");
    });

    it("should handle invalid package.json gracefully", async () => {
      const result = await findAngularDependencies(invalidPackageProjectPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.strictEqual(result.length, 0, "Should return empty array for invalid package.json");
    });

    it("should handle non-existent project path", async () => {
      const nonExistentPath = path.join(fixturesPath, "non-existent-project");
      const result = await findAngularDependencies(nonExistentPath);

      assert.ok(Array.isArray(result), "Should return an array");
      assert.strictEqual(result.length, 0, "Should return empty array for non-existent path");
    });

    it("should handle missing node_modules gracefully", async () => {
      // Create a temporary project with package.json but no node_modules
      const tempProjectPath = path.join(fixturesPath, "temp-no-node-modules");
      const tempPackageJsonPath = path.join(tempProjectPath, "package.json");

      try {
        await fs.mkdir(tempProjectPath, { recursive: true });
        await fs.writeFile(
          tempPackageJsonPath,
          JSON.stringify({
            name: "temp-project",
            dependencies: {
              "@angular/core": "^17.0.0",
            },
          })
        );

        const result = await findAngularDependencies(tempProjectPath);

        assert.ok(Array.isArray(result), "Should return an array");
        assert.strictEqual(result.length, 0, "Should return empty array when node_modules is missing");
      } finally {
        // Clean up
        try {
          await fs.unlink(tempPackageJsonPath);
          await fs.rmdir(tempProjectPath);
        } catch (_error) {
          // Ignore cleanup errors
        }
      }
    });

    it("should resolve Angular dependencies from an ancestor node_modules when the application has no node_modules", async () => {
      const tempWorkspacePath = await fs.mkdtemp(path.join(fixturesPath, "temp-hoisted-angular-"));
      const applicationRoot = path.join(tempWorkspacePath, "apps", "fixture-app");
      const dependencyName = "@angular/hoisted-only-fixture";
      const hoistedDependencyPath = path.join(tempWorkspacePath, "node_modules", dependencyName);

      try {
        await fs.mkdir(applicationRoot, { recursive: true });
        await fs.mkdir(hoistedDependencyPath, { recursive: true });
        await fs.writeFile(
          path.join(tempWorkspacePath, "package.json"),
          JSON.stringify({
            name: "tooling-only-workspace",
            private: true,
            devDependencies: { nx: "0.0.0" },
          })
        );
        await fs.writeFile(
          path.join(applicationRoot, "package.json"),
          JSON.stringify({
            name: "fixture-app",
            private: true,
            dependencies: {
              "@angular/core": "0.0.0",
              [dependencyName]: "0.0.0",
            },
          })
        );
        await fs.writeFile(
          path.join(hoistedDependencyPath, "package.json"),
          JSON.stringify({ name: dependencyName, version: "0.0.0" })
        );

        await assert.rejects(fs.access(path.join(applicationRoot, "node_modules")));
        const result = await findAngularDependencies(applicationRoot);

        assert.deepStrictEqual(result, [
          {
            name: dependencyName,
            path: await fs.realpath(hoistedDependencyPath),
          },
        ]);
      } finally {
        await fs.rm(tempWorkspacePath, { recursive: true, force: true });
      }
    });

    it("should handle dependencies with missing package.json", async () => {
      // This test verifies that missing package.json in node_modules doesn't crash the function
      const result = await findAngularDependencies(simpleProjectPath);

      // Should still work even if some dependencies have issues
      assert.ok(Array.isArray(result), "Should return an array");
      assert.ok(result.length > 0, "Should find some dependencies even if others have issues");
    });
  });

  describe("#getLibraryEntryPoints", () => {
    let ngxBootstrapLib: AngularDependency;
    let primengLib: AngularDependency;
    let angularLibLib: AngularDependency;
    let devAngularLibLib: AngularDependency;

    before(async () => {
      // Set up library objects for testing
      ngxBootstrapLib = {
        name: "ngx-bootstrap",
        path: path.join(complexProjectPath, "node_modules", "ngx-bootstrap"),
      };

      primengLib = {
        name: "primeng",
        path: path.join(complexProjectPath, "node_modules", "primeng"),
      };

      angularLibLib = {
        name: "angular-lib",
        path: path.join(simpleProjectPath, "node_modules", "angular-lib"),
      };

      devAngularLibLib = {
        name: "dev-angular-lib",
        path: path.join(simpleProjectPath, "node_modules", "dev-angular-lib"),
      };
    });

    it("should get entry points from exports field with types object", async () => {
      const result = await getLibraryEntryPoints(ngxBootstrapLib);

      assert.ok(result instanceof Map, "Should return a Map");
      assert.ok(result.size > 0, "Should have entry points");

      // Check main entry point
      const mainEntry = result.get("ngx-bootstrap");
      assert.ok(mainEntry, "Should have main entry point");
      assert.ok(mainEntry.endsWith("index.d.ts"), "Main entry should point to index.d.ts");

      // Check sub-entries
      const datepickerEntry = result.get("ngx-bootstrap/datepicker");
      assert.ok(datepickerEntry, "Should have datepicker entry point");
      assert.ok(datepickerEntry.includes("datepicker"), "Datepicker entry should point to datepicker types");

      const modalEntry = result.get("ngx-bootstrap/modal");
      assert.ok(modalEntry, "Should have modal entry point");
      assert.ok(modalEntry.includes("modal"), "Modal entry should point to modal types");
    });

    it("should get entry points from exports field with string values", async () => {
      const result = await getLibraryEntryPoints(primengLib);

      assert.ok(result instanceof Map, "Should return a Map");
      assert.ok(result.size > 0, "Should have entry points");

      // Check main entry point
      const mainEntry = result.get("primeng");
      assert.ok(mainEntry, "Should have main entry point");
      assert.ok(mainEntry.endsWith("index.d.ts"), "Main entry should point to index.d.ts");

      // Check sub-entries
      const buttonEntry = result.get("primeng/button");
      assert.ok(buttonEntry, "Should have button entry point");
      assert.ok(buttonEntry.includes("button"), "Button entry should point to button types");
    });

    it("should fallback to types field when no exports", async () => {
      const result = await getLibraryEntryPoints(angularLibLib);

      assert.ok(result instanceof Map, "Should return a Map");
      assert.strictEqual(result.size, 1, "Should have one entry point");

      const mainEntry = result.get("angular-lib");
      assert.ok(mainEntry, "Should have main entry point");
      assert.ok(mainEntry.endsWith("lib/index.d.ts"), "Should use types field");
    });

    it("should fallback to typings field when no exports or types", async () => {
      const result = await getLibraryEntryPoints(devAngularLibLib);

      assert.ok(result instanceof Map, "Should return a Map");
      assert.strictEqual(result.size, 1, "Should have one entry point");

      const mainEntry = result.get("dev-angular-lib");
      assert.ok(mainEntry, "Should have main entry point");
      assert.ok(mainEntry.endsWith("dist/index.d.ts"), "Should use typings field");
    });

    it("should handle missing package.json", async () => {
      const nonExistentLib: AngularDependency = {
        name: "non-existent-lib",
        path: path.join(fixturesPath, "non-existent-lib"),
      };

      const result = await getLibraryEntryPoints(nonExistentLib);

      assert.ok(result instanceof Map, "Should return a Map");
      assert.strictEqual(result.size, 0, "Should return empty map for missing package.json");
    });

    it("should handle invalid package.json", async () => {
      // Create a temporary lib with invalid package.json
      const tempLibPath = path.join(fixturesPath, "temp-invalid-lib");
      const tempPackageJsonPath = path.join(tempLibPath, "package.json");

      try {
        await fs.mkdir(tempLibPath, { recursive: true });
        await fs.writeFile(tempPackageJsonPath, "{ invalid json }");

        const invalidLib: AngularDependency = {
          name: "invalid-lib",
          path: tempLibPath,
        };

        const result = await getLibraryEntryPoints(invalidLib);

        assert.ok(result instanceof Map, "Should return a Map");
        assert.strictEqual(result.size, 0, "Should return empty map for invalid package.json");
      } finally {
        // Clean up
        try {
          await fs.unlink(tempPackageJsonPath);
          await fs.rmdir(tempLibPath);
        } catch (_error) {
          // Ignore cleanup errors
        }
      }
    });

    it("should return empty map for library without types", async () => {
      // Create a temporary lib without types
      const tempLibPath = path.join(fixturesPath, "temp-no-types-lib");
      const tempPackageJsonPath = path.join(tempLibPath, "package.json");

      try {
        await fs.mkdir(tempLibPath, { recursive: true });
        await fs.writeFile(
          tempPackageJsonPath,
          JSON.stringify({
            name: "no-types-lib",
            version: "1.0.0",
            main: "index.js",
          })
        );

        const noTypesLib: AngularDependency = {
          name: "no-types-lib",
          path: tempLibPath,
        };

        const result = await getLibraryEntryPoints(noTypesLib);

        assert.ok(result instanceof Map, "Should return a Map");
        assert.strictEqual(result.size, 0, "Should return empty map for library without types");
      } finally {
        // Clean up
        try {
          await fs.unlink(tempPackageJsonPath);
          await fs.rmdir(tempLibPath);
        } catch (_error) {
          // Ignore cleanup errors
        }
      }
    });

    it("should handle exports with non-.d.ts files", async () => {
      // Create a temporary lib with exports pointing to non-.d.ts files
      const tempLibPath = path.join(fixturesPath, "temp-no-dts-exports-lib");
      const tempPackageJsonPath = path.join(tempLibPath, "package.json");

      try {
        await fs.mkdir(tempLibPath, { recursive: true });
        await fs.writeFile(
          tempPackageJsonPath,
          JSON.stringify({
            name: "no-dts-exports-lib",
            version: "1.0.0",
            exports: {
              ".": "./index.js",
              "./sub": {
                default: "./sub.js",
              },
            },
          })
        );

        const noDtsExportsLib: AngularDependency = {
          name: "no-dts-exports-lib",
          path: tempLibPath,
        };

        const result = await getLibraryEntryPoints(noDtsExportsLib);

        assert.ok(result instanceof Map, "Should return a Map");
        assert.strictEqual(result.size, 0, "Should return empty map when exports don't have .d.ts files");
      } finally {
        // Clean up
        try {
          await fs.unlink(tempPackageJsonPath);
          await fs.rmdir(tempLibPath);
        } catch (_error) {
          // Ignore cleanup errors
        }
      }
    });

    it("should resolve absolute paths correctly", async () => {
      const result = await getLibraryEntryPoints(angularLibLib);

      const mainEntry = result.get("angular-lib");
      assert.ok(mainEntry, "Should have main entry point");
      assert.ok(path.isAbsolute(mainEntry), "Should return absolute path");
      assert.ok(mainEntry.includes(angularLibLib.path), "Should include library path");
    });

    it("should normalize import paths with forward slashes", async () => {
      const result = await getLibraryEntryPoints(ngxBootstrapLib);

      for (const [importPath] of result) {
        assert.ok(!importPath.includes("\\"), "Import paths should use forward slashes");
        assert.ok(importPath.startsWith("ngx-bootstrap"), "Import paths should start with library name");
      }
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle concurrent calls to the same project", async () => {
      // Test concurrent calls to ensure no race conditions
      const promises = Array.from({ length: 5 }, () => findAngularDependencies(simpleProjectPath));

      const results = await Promise.all(promises);

      // All results should be identical
      for (let i = 1; i < results.length; i++) {
        assert.strictEqual(results[i].length, results[0].length, "All concurrent calls should return same length");

        for (let j = 0; j < results[i].length; j++) {
          assert.strictEqual(results[i][j].name, results[0][j].name, "Dependencies should have same names");
        }
      }
    });

    it("should handle very long file paths", async () => {
      // Test with a project that has a very long path
      const longPath = path.join(
        fixturesPath,
        "very-long-path-name-that-exceeds-normal-length-limits-for-testing-purposes-and-edge-cases"
      );

      const result = await findAngularDependencies(longPath);

      assert.ok(Array.isArray(result), "Should handle long paths gracefully");
      assert.strictEqual(result.length, 0, "Should return empty array for non-existent long path");
    });

    it("should handle special characters in paths", async () => {
      // Test with paths containing special characters
      const specialPath = path.join(fixturesPath, "special-chars-тест-📁-project");

      const result = await findAngularDependencies(specialPath);

      assert.ok(Array.isArray(result), "Should handle special characters in paths");
      assert.strictEqual(result.length, 0, "Should return empty array for non-existent special path");
    });
  });
});
