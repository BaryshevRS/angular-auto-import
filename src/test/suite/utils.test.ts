/**
 * =================================================================================================
 * Utility Functions Tests
 * =================================================================================================
 *
 * Tests for utility functions used throughout the extension.
 */

import * as assert from "node:assert";
import * as path from "node:path";
import { debounce, generateImportStatement, isAngularFile, resolveRelativePath } from "../../utils";

describe("Utility Functions", function () {
  // Set timeout for all tests in this suite
  this.timeout(5000);

  describe("isAngularFile", () => {
    const testCases = [
      // Component files
      {
        path: "/src/app/test.component.ts",
        expected: true,
        description: "component files",
      },
      {
        path: "/src/app/nested/my-component.component.ts",
        expected: true,
        description: "nested component files",
      },

      // Directive files
      {
        path: "/src/app/highlight.directive.ts",
        expected: true,
        description: "directive files",
      },
      {
        path: "/src/shared/directives/tooltip.directive.ts",
        expected: true,
        description: "nested directive files",
      },

      // Pipe files
      {
        path: "/src/app/capitalize.pipe.ts",
        expected: true,
        description: "pipe files",
      },
      {
        path: "/src/shared/pipes/currency.pipe.ts",
        expected: true,
        description: "nested pipe files",
      },

      // Non-Angular files
      {
        path: "/src/app/service.ts",
        expected: false,
        description: "service files",
      },
      {
        path: "/src/app/model.ts",
        expected: false,
        description: "model files",
      },
      {
        path: "/src/app/utils.ts",
        expected: false,
        description: "utility files",
      },
      {
        path: "/src/app/test.spec.ts",
        expected: false,
        description: "test files",
      },

      // Different extensions
      {
        path: "/src/app/test.component.js",
        expected: false,
        description: "JS files",
      },
      {
        path: "/src/app/test.component.html",
        expected: false,
        description: "HTML files",
      },
      {
        path: "/src/app/test.component.css",
        expected: false,
        description: "CSS files",
      },
    ];

    testCases.forEach(({ path, expected, description }) => {
      it(`should ${expected ? "identify" : "reject"} ${description}`, () => {
        assert.strictEqual(isAngularFile(path), expected, `Should ${expected ? "identify" : "reject"} ${description}`);
      });
    });

    it("should handle null and undefined inputs", () => {
      assert.strictEqual(isAngularFile(null as any), false, "Should handle null file path");
      assert.strictEqual(isAngularFile(undefined as any), false, "Should handle undefined file path");
    });
  });

  describe("generateImportStatement", () => {
    const testCases = [
      {
        name: "TestComponent",
        path: "@app/components/test",
        expected: "import { TestComponent } from '@app/components/test';",
        description: "named import statements",
      },
      {
        name: "MyService",
        path: "./services/my-service",
        expected: "import { MyService } from './services/my-service';",
        description: "relative imports",
      },
      {
        name: "Utils",
        path: "../shared/utils",
        expected: "import { Utils } from '../shared/utils';",
        description: "parent directory imports",
      },
      {
        name: "Config",
        path: "@shared/config",
        expected: "import { Config } from '@shared/config';",
        description: "alias imports",
      },
    ];

    testCases.forEach(({ name, path, expected, description }) => {
      it(`should generate ${description}`, () => {
        const result = generateImportStatement(name, path);
        assert.strictEqual(result, expected, `Should generate correct ${description}`);
      });
    });

    it("should handle special characters in names", () => {
      const result = generateImportStatement("My$Component", "@app/components/special");

      assert.strictEqual(
        result,
        "import { My$Component } from '@app/components/special';",
        "Should handle special characters"
      );
    });

    it("should handle empty parameters gracefully", () => {
      const result1 = generateImportStatement("", "@app/test");
      const result2 = generateImportStatement("TestComponent", "");

      assert.strictEqual(result1, "import {  } from '@app/test';", "Should handle empty name");
      assert.strictEqual(result2, "import { TestComponent } from '';", "Should handle empty path");
    });
  });

  describe("resolveRelativePath", () => {
    const testCases = [
      {
        from: "/src/app/components/test.component.ts",
        to: "/src/app/services/data.service.ts",
        expected: "../services/data.service",
        description: "parent directory paths",
      },
      {
        from: "/src/app/components/test.component.ts",
        to: "/src/app/components/other.component.ts",
        expected: "./other.component",
        description: "same directory paths",
      },
      {
        from: "/src/app/pages/home/home.component.ts",
        to: "/src/app/components/shared/button.component.ts",
        expected: "../../components/shared/button.component",
        description: "nested subdirectories",
      },
    ];

    testCases.forEach(({ from, to, expected, description }) => {
      it(`should resolve ${description} correctly`, () => {
        const result = resolveRelativePath(from, to);
        assert.strictEqual(result, expected, `Should resolve ${description}`);
      });
    });

    it("should handle cross-platform paths", () => {
      const from = path.join("src", "app", "components", "test.component.ts");
      const to = path.join("src", "app", "services", "data.service.ts");

      const result = resolveRelativePath(from, to);

      assert.ok(result.includes("services"), "Should work with cross-platform paths");
      assert.ok(result.includes("data.service"), "Should include target file name");
    });

    it("should remove file extensions", () => {
      const from = "/src/app/test.component.ts";
      const to = "/src/app/other.component.ts";

      const result = resolveRelativePath(from, to);

      assert.ok(!result.endsWith(".ts"), "Should remove .ts extension");
      assert.strictEqual(result, "./other.component", "Should have correct relative path without extension");
    });

    it("should handle edge cases gracefully", () => {
      const testCases = [
        { from: "", to: "/test", description: "empty from path" },
        { from: "/test", to: "", description: "empty to path" },
        { from: null, to: "/test", description: "null from path" },
        { from: "/test", to: null, description: "null to path" },
      ];

      testCases.forEach(({ from, to, description }) => {
        assert.doesNotThrow(() => {
          const result = resolveRelativePath(from as any, to as any);
          assert.strictEqual(typeof result, "string", `Should return string for ${description}`);
        }, `Should not throw for ${description}`);
      });
    });

    it("should handle absolute paths outside project", () => {
      const from = "/project/src/app/test.ts";
      const to = "/other/project/file.ts";

      const result = resolveRelativePath(from, to);

      // Should handle gracefully, might return absolute or relative path
      assert.ok(typeof result === "string", "Should return a string");
      assert.ok(result.length > 0, "Should not return empty string");
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should not throw errors for malformed inputs", () => {
      // Test generateImportStatement with null/undefined
      assert.doesNotThrow(() => {
        generateImportStatement(null as any, undefined as any);
      }, "generateImportStatement should not throw for null/undefined inputs");

      // Test resolveRelativePath with invalid types
      assert.doesNotThrow(() => {
        resolveRelativePath(123 as any, {} as any);
      }, "resolveRelativePath should not throw for invalid type inputs");
    });
  });

  describe("debounce", () => {
    it("coalesces a burst into one trailing invocation", async () => {
      let calls = 0;
      const debounced = debounce(() => {
        calls++;
      }, 10);

      debounced();
      debounced();
      debounced();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.strictEqual(calls, 1);
    });

    it("can cancel a pending invocation", async () => {
      let calls = 0;
      const debounced = debounce(() => {
        calls++;
      }, 10);

      debounced();
      debounced.cancel();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.strictEqual(calls, 0);
    });
  });
});
