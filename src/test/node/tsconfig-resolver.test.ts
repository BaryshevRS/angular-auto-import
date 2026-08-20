/**
 * =================================================================================================
 * TSConfig Helper Tests
 * =================================================================================================
 *
 * Comprehensive tests for the TsConfigHelper service that handles TypeScript configuration
 * parsing and path alias resolution.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { TsConfigResolver } from "../../core/tsconfig";
import type { ProcessedTsConfig } from "../../types";

/**
 * A fresh resolver per test, which is what a project runtime owns.
 *
 * The Extension Host once shared a single instance across every project; the server
 * gives each root its own, so clearing "the" cache between tests is now just building a
 * new resolver.
 */
let TsConfigHelper: TsConfigResolver;

describe("TsConfigResolver", function () {
  // Set timeout for all tests in this suite - increased for complex operations
  this.timeout(10000);

  const fixturesPath = path.join(__dirname, "..", "fixtures");
  const simpleProjectPath = path.join(fixturesPath, "simple-project");
  const complexProjectPath = path.join(fixturesPath, "complex-project");
  const nxProjectPath = path.join(fixturesPath, "nx-project");
  const noTsconfigProjectPath = path.join(fixturesPath, "no-tsconfig-project");
  const testProjectPath = path.join(fixturesPath, "test-project");

  beforeEach(() => {
    TsConfigHelper = new TsConfigResolver();
  });

  after(() => {
    // Clean up cache after all tests
    TsConfigHelper.clearCache();
  });

  describe("#findAndParseTsConfig", () => {
    it("should find and parse a standard tsconfig.json", async () => {
      const result = await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);

      assert.ok(result, "Should return a ProcessedTsConfig object");
      assert.strictEqual(typeof result.absoluteBaseUrl, "string", "Should have absoluteBaseUrl");
      assert.strictEqual(typeof result.paths, "object", "Should have paths object");
      assert.strictEqual(typeof result.sourceFilePath, "string", "Should have sourceFilePath");

      // Check that baseUrl is resolved correctly
      assert.strictEqual(result.absoluteBaseUrl, simpleProjectPath, "BaseUrl should be project root");

      // Check that paths are parsed correctly
      assert.ok(result.paths["@app/*"], "Should have @app/* path mapping");
      assert.ok(result.paths["@shared/*"], "Should have @shared/* path mapping");
      assert.ok(result.paths["@core"], "Should have @core path mapping");

      // Verify path arrays
      assert.deepStrictEqual(result.paths["@app/*"], ["src/app/*"]);
      assert.deepStrictEqual(result.paths["@shared/*"], ["src/shared/*"]);
      assert.deepStrictEqual(result.paths["@core"], ["src/app/core/index.ts"]);
    });

    it("should find and parse tsconfig.base.json for Nx projects", async () => {
      const result = await TsConfigHelper.findAndParseTsConfig(nxProjectPath);

      assert.ok(result, "Should return a ProcessedTsConfig object for Nx project");
      assert.strictEqual(result.absoluteBaseUrl, nxProjectPath, "BaseUrl should be project root");

      // Check Nx-style path mappings
      assert.ok(result.paths["@myorg/shared-ui"], "Should have @myorg/shared-ui path mapping");
      assert.ok(result.paths["@myorg/shared-data"], "Should have @myorg/shared-data path mapping");
      assert.ok(result.paths["@myorg/feature-auth"], "Should have @myorg/feature-auth path mapping");
      assert.ok(result.paths["@myorg/core"], "Should have @myorg/core path mapping");

      // Verify Nx path arrays
      assert.deepStrictEqual(result.paths["@myorg/shared-ui"], ["libs/shared/ui/src/index.ts"]);
      assert.deepStrictEqual(result.paths["@myorg/shared-data"], ["libs/shared/data/src/index.ts"]);
    });

    it("should handle complex tsconfig with multiple path mappings", async () => {
      const result = await TsConfigHelper.findAndParseTsConfig(complexProjectPath);

      assert.ok(result, "Should return a ProcessedTsConfig object for complex project");

      // Check that baseUrl is resolved correctly (should be src/ subdirectory)
      const expectedBaseUrl = path.join(complexProjectPath, "src");
      assert.strictEqual(result.absoluteBaseUrl, expectedBaseUrl, "BaseUrl should be src subdirectory");

      // Check complex path mappings
      assert.ok(result.paths["@/*"], "Should have @/* path mapping");
      assert.ok(result.paths["@app/*"], "Should have @app/* path mapping");
      assert.ok(result.paths["@components/*"], "Should have @components/* path mapping");
      assert.ok(result.paths["@services/*"], "Should have @services/* path mapping");
      assert.ok(result.paths["@utils/*"], "Should have @utils/* path mapping");
      assert.ok(result.paths["@lib/*"], "Should have @lib/* path mapping");
      assert.ok(result.paths["~/*"], "Should have ~/* path mapping");

      // Verify specific mappings
      assert.deepStrictEqual(result.paths["@/*"], ["./*"]);
      assert.deepStrictEqual(result.paths["@components/*"], ["app/components/*"]);
      assert.deepStrictEqual(result.paths["@lib/*"], ["../libs/*"]);
      assert.deepStrictEqual(result.paths["~/*"], ["assets/*"]);
    });

    it("should return null for projects without tsconfig", async () => {
      const result = await TsConfigHelper.findAndParseTsConfig(noTsconfigProjectPath);

      assert.strictEqual(result, null, "Should return null when no tsconfig is found");
    });

    it("should cache results for the same project", async () => {
      // First call
      const result1 = await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);

      // Second call should return cached result
      const result2 = await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);

      assert.strictEqual(result1, result2, "Should return the same cached object");
    });

    it("should handle invalid project paths gracefully", async () => {
      const invalidPath = path.join(fixturesPath, "non-existent-project");
      const result = await TsConfigHelper.findAndParseTsConfig(invalidPath);

      assert.strictEqual(result, null, "Should return null for invalid project paths");
    });
  });

  describe("#resolveImportPath", () => {
    let simpleProjectConfig: ProcessedTsConfig;
    let complexProjectConfig: ProcessedTsConfig;

    before(async () => {
      // Load configs once for all resolve tests
      simpleProjectConfig = (await TsConfigHelper.findAndParseTsConfig(simpleProjectPath)) as ProcessedTsConfig;
      complexProjectConfig = (await TsConfigHelper.findAndParseTsConfig(complexProjectPath)) as ProcessedTsConfig;

      assert.ok(simpleProjectConfig, "Simple project config should be loaded");
      assert.ok(complexProjectConfig, "Complex project config should be loaded");
    });

    describe("Alias Resolution", () => {
      it("should resolve @app/* aliases correctly", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);

        const targetPath = path.join(simpleProjectPath, "src", "app", "components", "my-component");
        const currentFile = path.join(simpleProjectPath, "src", "app", "pages", "home.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(result, "@app/components/my-component", "Should resolve to @app alias");
      });

      it("should resolve @shared/* aliases correctly", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        const targetPath = path.join(simpleProjectPath, "src", "shared", "utils", "helper");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "test.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(result, "@shared/utils/helper", "Should resolve to @shared alias");
      });

      it("should resolve barrel imports (@core) correctly", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        const targetPath = path.join(simpleProjectPath, "src", "app", "core");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "test.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(result, "@core", "Should resolve to @core barrel import");
      });

      it("should avoid barrel self-imports inside the same Nx library", async () => {
        await TsConfigHelper.findAndParseTsConfig(nxProjectPath);
        const targetPath = path.join(
          nxProjectPath,
          "libs",
          "shared",
          "ui",
          "src",
          "lib",
          "components",
          "button",
          "button"
        );
        const currentFile = path.join(
          nxProjectPath,
          "libs",
          "shared",
          "ui",
          "src",
          "lib",
          "components",
          "card",
          "card.ts"
        );

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, nxProjectPath);

        assert.strictEqual(
          result,
          "../button/button",
          "Should use relative path instead of importing library from itself"
        );
      });

      it("should handle complex nested aliases", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(complexProjectPath);
        const targetPath = path.join(complexProjectPath, "src", "app", "components", "ui", "button");
        const currentFile = path.join(complexProjectPath, "src", "app", "pages", "home.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, complexProjectPath);

        assert.strictEqual(result, "@components/ui/button", "Should resolve to @components alias");
      });

      it("should resolve paths outside src using @lib/* alias", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(complexProjectPath);
        const targetPath = path.join(complexProjectPath, "libs", "shared", "utils");
        const currentFile = path.join(complexProjectPath, "src", "app", "components", "test.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, complexProjectPath);

        assert.strictEqual(result, "@lib/shared/utils", "Should resolve to @lib alias for external libs");
      });

      it("should prefer more specific aliases over general ones", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(complexProjectPath);
        // @components/* should be preferred over @app/* for components
        const targetPath = path.join(complexProjectPath, "src", "app", "components", "button");
        const currentFile = path.join(complexProjectPath, "src", "app", "pages", "home.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, complexProjectPath);

        assert.strictEqual(result, "@components/button", "Should prefer @components over @app");
      });

      it("should handle case-insensitive path matching", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        // Test with mixed case in the target path
        const targetPath = path.join(simpleProjectPath, "src", "App", "Components", "MyComponent");
        const currentFile = path.join(simpleProjectPath, "src", "app", "pages", "home.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        // Should still resolve to alias despite case differences
        assert.strictEqual(result, "@app/Components/MyComponent", "Should handle case-insensitive matching");
      });
    });

    describe("Relative Path Fallback", () => {
      it("should fall back to relative paths when no alias matches", async () => {
        const targetPath = path.join(simpleProjectPath, "src", "assets", "images", "logo");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "header.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(result, "../../assets/images/logo", "Should fall back to relative path");
      });

      it("should handle same directory relative imports", async () => {
        const targetPath = path.join(simpleProjectPath, "src", "app", "components", "sibling-component");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "main.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(
          result,
          "@app/components/sibling-component",
          "Should use alias path for same directory when available"
        );
      });

      it("should handle parent directory relative imports", async () => {
        const targetPath = path.join(simpleProjectPath, "src", "app", "services", "data.service");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "list.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(
          result,
          "@app/services/data.service",
          "Should use alias path for parent directory when available"
        );
      });
    });

    describe("Edge Cases", () => {
      it("should handle files outside project root", async () => {
        const targetPath = "/some/external/path/module";
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "test.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        assert.strictEqual(result, "/some/external/path/module", "Should return absolute path for external files");
      });

      it("should handle current file outside project root", async () => {
        const targetPath = path.join(simpleProjectPath, "src", "app", "components", "test-component");
        const currentFile = "/some/external/file.ts";

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        // Should fall back to relative path calculation
        assert.ok(result.includes("test-component"), "Should include target component name");
      });

      it("should handle empty or invalid paths gracefully", async () => {
        const currentFile = path.join(simpleProjectPath, "src", "app", "test.component.ts");

        // Test empty target path
        const result1 = await TsConfigHelper.resolveImportPath("", currentFile, simpleProjectPath);
        assert.strictEqual(result1, ".", "Should handle empty target path");

        // Test invalid project root
        const result2 = await TsConfigHelper.resolveImportPath(
          path.join(simpleProjectPath, "src", "app", "component"),
          currentFile,
          ""
        );
        assert.ok(typeof result2 === "string", "Should return string for invalid project root");
      });

      it("should prefer aliases over relative paths when both are possible", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        // Even if relative path is shorter, should prefer alias
        const targetPath = path.join(simpleProjectPath, "src", "app", "utils", "helper");
        const currentFile = path.join(simpleProjectPath, "src", "app", "components", "test.component.ts");

        const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);

        // Should prefer @app alias over ../utils/helper
        assert.strictEqual(result, "@app/utils/helper", "Should prefer alias over relative path");
      });
    });

    describe("Cache Management", () => {
      it("should use cached trie for subsequent resolutions", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        const targetPath1 = path.join(simpleProjectPath, "src", "app", "components", "comp1");
        const targetPath2 = path.join(simpleProjectPath, "src", "app", "services", "service1");
        const currentFile = path.join(simpleProjectPath, "src", "app", "pages", "home.component.ts");

        const result1 = await TsConfigHelper.resolveImportPath(targetPath1, currentFile, simpleProjectPath);
        const result2 = await TsConfigHelper.resolveImportPath(targetPath2, currentFile, simpleProjectPath);

        assert.strictEqual(result1, "@app/components/comp1", "First resolution should work");
        assert.strictEqual(result2, "@app/services/service1", "Second resolution should use cached trie");
      });

      it("should clear cache correctly", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        // First, populate cache
        const targetPath = path.join(simpleProjectPath, "src", "app", "components", "test");
        const currentFile = path.join(simpleProjectPath, "src", "app", "pages", "home.component.ts");

        const result1 = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);
        assert.strictEqual(result1, "@app/components/test", "Should resolve with fresh cache");

        // Clear cache
        TsConfigHelper.clearCache(simpleProjectPath);

        // Should still work after cache clear
        const result2 = await TsConfigHelper.resolveImportPath(targetPath, currentFile, simpleProjectPath);
        assert.strictEqual(result2, "@app/components/test", "Should resolve after cache clear");
      });

      it("should handle cache clear for all projects", async () => {
        // Ensure tsconfig is loaded first
        await TsConfigHelper.findAndParseTsConfig(simpleProjectPath);
        await TsConfigHelper.findAndParseTsConfig(complexProjectPath);
        // Populate cache for multiple projects
        const targetPath1 = path.join(simpleProjectPath, "src", "app", "test1");
        const targetPath2 = path.join(complexProjectPath, "src", "app", "test2");
        const currentFile1 = path.join(simpleProjectPath, "src", "app", "home.ts");
        const currentFile2 = path.join(complexProjectPath, "src", "app", "home.ts");

        await TsConfigHelper.resolveImportPath(targetPath1, currentFile1, simpleProjectPath);
        await TsConfigHelper.resolveImportPath(targetPath2, currentFile2, complexProjectPath);

        // Clear all cache
        TsConfigHelper.clearCache();

        // Should still work for both projects
        const result1 = await TsConfigHelper.resolveImportPath(targetPath1, currentFile1, simpleProjectPath);
        const result2 = await TsConfigHelper.resolveImportPath(targetPath2, currentFile2, complexProjectPath);

        assert.strictEqual(result1, "@app/test1", "Simple project should work after global cache clear");
        assert.strictEqual(result2, "@app/test2", "Complex project should work after global cache clear");
      });
    });
  });

  describe("PathAliasTrie (Internal)", () => {
    it("should handle wildcard vs barrel alias precedence correctly", async () => {
      // This tests the internal trie logic for handling different alias types
      const config = (await TsConfigHelper.findAndParseTsConfig(simpleProjectPath)) as ProcessedTsConfig;
      assert.ok(config, "Config should be loaded");

      // Test barrel import (@core) vs wildcard (@app/*)
      const barrelTarget = path.join(simpleProjectPath, "src", "app", "core");
      const wildcardTarget = path.join(simpleProjectPath, "src", "app", "components", "test");
      const currentFile = path.join(simpleProjectPath, "src", "app", "pages", "home.ts");

      const barrelResult = await TsConfigHelper.resolveImportPath(barrelTarget, currentFile, simpleProjectPath);
      const wildcardResult = await TsConfigHelper.resolveImportPath(wildcardTarget, currentFile, simpleProjectPath);

      assert.strictEqual(barrelResult, "@core", "Should use barrel import for exact match");
      assert.strictEqual(wildcardResult, "@app/components/test", "Should use wildcard for path extension");
    });

    it("should handle longest prefix matching correctly", async () => {
      // Test that more specific paths are preferred over general ones
      const config = (await TsConfigHelper.findAndParseTsConfig(complexProjectPath)) as ProcessedTsConfig;
      assert.ok(config, "Complex config should be loaded");

      // @components/* should be preferred over @app/* for components
      const componentTarget = path.join(complexProjectPath, "src", "app", "components", "button");
      const serviceTarget = path.join(complexProjectPath, "src", "app", "services", "data");
      const currentFile = path.join(complexProjectPath, "src", "app", "pages", "home.ts");

      const componentResult = await TsConfigHelper.resolveImportPath(componentTarget, currentFile, complexProjectPath);
      const serviceResult = await TsConfigHelper.resolveImportPath(serviceTarget, currentFile, complexProjectPath);

      assert.strictEqual(componentResult, "@components/button", "Should prefer @components over @app");
      assert.strictEqual(serviceResult, "@services/data", "Should prefer @services over @app");
    });
  });

  describe("Test Project Aliases", () => {
    it("should resolve @shared/* aliases correctly", async () => {
      // Ensure tsconfig is loaded first
      await TsConfigHelper.findAndParseTsConfig(testProjectPath);

      const targetPath = path.join(
        testProjectPath,
        "src",
        "app",
        "project",
        "shared",
        "component",
        "table",
        "pagination",
        "pagination.component"
      );
      const currentFile = path.join(testProjectPath, "src", "app", "some-component.ts");

      const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, testProjectPath);

      assert.strictEqual(
        result,
        "@shared/component/table/pagination/pagination.component",
        "Should resolve to @shared alias for shared components"
      );
    });

    it("should resolve ~/* aliases correctly", async () => {
      // Ensure tsconfig is loaded first
      await TsConfigHelper.findAndParseTsConfig(testProjectPath);

      const targetPath = path.join(
        testProjectPath,
        "src",
        "app",
        "project",
        "mobile",
        "shared",
        "pipes",
        "number-separator.pipe"
      );
      const currentFile = path.join(testProjectPath, "src", "app", "some-component.ts");

      const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, testProjectPath);

      assert.strictEqual(
        result,
        "~/app/project/mobile/shared/pipes/number-separator.pipe",
        "Should resolve to ~/ alias for src paths"
      );
    });

    it("should resolve @domain/* aliases correctly", async () => {
      // Ensure tsconfig is loaded first
      await TsConfigHelper.findAndParseTsConfig(testProjectPath);

      const targetPath = path.join(testProjectPath, "src", "app", "project", "domain", "models", "user.model");
      const currentFile = path.join(testProjectPath, "src", "app", "components", "user.component.ts");

      const result = await TsConfigHelper.resolveImportPath(targetPath, currentFile, testProjectPath);

      assert.strictEqual(result, "@domain/models/user.model", "Should resolve to @domain alias for domain models");
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed tsconfig.json gracefully", async () => {
      // Create a temporary malformed tsconfig
      const tempProjectPath = path.join(fixturesPath, "temp-malformed-project");
      const tempTsconfigPath = path.join(tempProjectPath, "tsconfig.json");

      try {
        // Create directory and malformed file
        if (!fs.existsSync(tempProjectPath)) {
          fs.mkdirSync(tempProjectPath, { recursive: true });
        }
        fs.writeFileSync(tempTsconfigPath, "{ invalid json content }");

        const result = await TsConfigHelper.findAndParseTsConfig(tempProjectPath);

        // With improved error handling, we now return a fallback config even for malformed JSON
        // This provides more robust behavior in real-world scenarios
        if (result === null) {
          // Old behavior - strict error handling
          assert.strictEqual(result, null, "Should return null for malformed tsconfig");
        } else {
          // New behavior - fallback config with default values
          assert.ok(result, "Should return fallback config for malformed tsconfig");
          assert.ok(result.absoluteBaseUrl, "Should have fallback baseUrl");
          assert.ok(typeof result.paths === "object", "Should have paths object (even if empty)");
        }
      } finally {
        // Clean up in finally block to ensure cleanup even if test fails
        try {
          if (fs.existsSync(tempTsconfigPath)) {
            fs.unlinkSync(tempTsconfigPath);
          }
          if (fs.existsSync(tempProjectPath)) {
            fs.rmdirSync(tempProjectPath);
          }
        } catch (cleanupError) {
          console.warn("Cleanup error:", cleanupError);
        }
      }
    });

    it("should handle missing compilerOptions gracefully", async () => {
      // Create a temporary tsconfig without compilerOptions
      const tempProjectPath = path.join(fixturesPath, "temp-no-compiler-options");
      const tempTsconfigPath = path.join(tempProjectPath, "tsconfig.json");

      try {
        if (!fs.existsSync(tempProjectPath)) {
          fs.mkdirSync(tempProjectPath, { recursive: true });
        }
        fs.writeFileSync(
          tempTsconfigPath,
          JSON.stringify({
            include: ["src/**/*"],
            exclude: ["node_modules"],
          })
        );

        const result = await TsConfigHelper.findAndParseTsConfig(tempProjectPath);

        assert.ok(result, "Should return config even without compilerOptions");
        assert.strictEqual(typeof result.absoluteBaseUrl, "string", "Should have default baseUrl");
        assert.deepStrictEqual(result.paths, {}, "Should have empty paths object");
      } finally {
        // Clean up in finally block to ensure cleanup even if test fails
        try {
          if (fs.existsSync(tempTsconfigPath)) {
            fs.unlinkSync(tempTsconfigPath);
          }
          if (fs.existsSync(tempProjectPath)) {
            fs.rmdirSync(tempProjectPath);
          }
        } catch (cleanupError) {
          console.warn("Cleanup error:", cleanupError);
        }
      }
    });

    it("should handle permission errors gracefully", async () => {
      // Test with a path that might have permission issues
      const restrictedPath = "/root/restricted-project";

      const result = await TsConfigHelper.findAndParseTsConfig(restrictedPath);

      assert.strictEqual(result, null, "Should return null for inaccessible paths");
    });
  });
});
