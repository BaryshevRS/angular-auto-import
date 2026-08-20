/**
 * =================================================================================================
 * Angular Indexer Tests
 * =================================================================================================
 *
 * Comprehensive tests for the AngularIndexer service that handles indexing of Angular components,
 * directives, and pipes from both local files and node_modules libraries.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { createNodeFileSystem } from "../../adapters/node/file-system";
import { type CacheStore, createMemoryCacheStore } from "../../core/cache";
import type { FileSystem } from "../../core/file-system";
import type { FileChange, FileWatcherFactory } from "../../core/file-watching";
import { type InstrumentedLogger, silentLogger, withInstrumentation } from "../../core/logging";
import type { ProgressHost } from "../../core/progress";
import { silentProgressHost } from "../../core/progress";
import { AngularIndexer } from "../../services";
import type { FileElementsInfo } from "../../types";

/**
 * The ports a server gives every indexer, with the watcher's reporting under test control.
 *
 * In the server nothing polls the filesystem: the client reports changes and they are
 * dispatched to whichever subscription watches that root. These tests do the same, which
 * is both faster and free of the races a live watcher introduces.
 */
function hostPorts(): {
  logger: InstrumentedLogger;
  fileSystem: FileSystem;
  progressHost: ProgressHost;
  fileWatchers: FileWatcherFactory;
  report(change: FileChange): void;
} {
  const listeners = new Set<(change: FileChange) => void>();

  return {
    logger: withInstrumentation(silentLogger),
    fileSystem: createNodeFileSystem(),
    progressHost: silentProgressHost,
    fileWatchers: {
      watch: (_watch, listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    report: (change) => {
      for (const listener of listeners) {
        listener(change);
      }
    },
  };
}

describe("AngularIndexer", function () {
  // Set timeout for all tests in this suite
  this.timeout(30000);

  let indexer: AngularIndexer;
  /** Shared between the indexer and the tests, which assert on what it holds. */
  let cacheStore: CacheStore;
  /** Reports a filesystem change to the indexer, as the client's watcher would. */
  let ports: ReturnType<typeof hostPorts>;
  const fixturesPath = path.join(__dirname, "..", "fixtures");
  const testProjectPath = path.join(fixturesPath, "test-angular-project");
  const mockNodeModulesPath = path.join(testProjectPath, "node_modules");

  before(async () => {
    // Create comprehensive test project structure
    await createTestProject();
  });

  beforeEach(() => {
    cacheStore = createMemoryCacheStore();
    ports = hostPorts();
    indexer = new AngularIndexer({ cacheStore, ...ports });
  });

  afterEach(() => {
    if (indexer) {
      indexer.dispose();
    }
  });

  after(async () => {
    // Clean up test project
    await cleanupTestProject();
  });

  describe("Basic Setup", () => {
    it("should initialize with empty state", () => {
      assert.ok(indexer, "Indexer should be created");
      assert.ok(indexer.project, "Should have ts-morph project");
      assert.strictEqual(indexer.fileWatcher, null, "Should not have file watcher initially");
    });

    it("should set project root and initialize cache keys", () => {
      indexer.setProjectRoot(testProjectPath);

      assert.ok(indexer.workspaceFileCacheKey, "Should have file cache key");
      assert.ok(indexer.workspaceIndexCacheKey, "Should have index cache key");
      assert.ok(
        indexer.workspaceFileCacheKey.includes("angularFileCache_"),
        "File cache key should have correct prefix"
      );
      assert.ok(
        indexer.workspaceIndexCacheKey.includes("angularSelectorToDataIndex_"),
        "Index cache key should have correct prefix"
      );
    });
  });

  describe("File Indexing", () => {
    beforeEach(async () => {
      indexer.setProjectRoot(testProjectPath);
    });

    it("should index all Angular files in project", async () => {
      const result = await indexer.generateFullIndex();

      assert.ok(result instanceof Map, "Should return a Map");
      assert.ok(
        result.size >= 5,
        "Should index at least 5 elements (component, directive, pipe, standalone component, complex directive)"
      );

      // Check specific elements
      const selectors = indexer.getAllSelectors();
      assert.ok(selectors.includes("test-component"), "Should include basic component");
      assert.ok(selectors.includes("testDirective"), "Should include basic directive");
      assert.ok(selectors.includes("testPipe"), "Should include basic pipe");
      assert.ok(selectors.includes("standalone-component"), "Should include standalone component");
      assert.ok(selectors.includes("complexButton"), "Should include complex directive");
    });

    it("notifies consumers after a full reindex", async () => {
      let changeEvents = 0;
      const subscription = indexer.onDidChangeIndex(() => {
        changeEvents++;
      });

      try {
        await indexer.generateFullIndex();
        assert.strictEqual(changeEvents, 1, "A completed full reindex should request one diagnostics refresh");
      } finally {
        subscription.dispose();
      }
    });

    it("should handle standalone components correctly", async () => {
      await indexer.generateFullIndex();

      const standaloneElements = indexer.getElements("standalone-component");
      assert.ok(standaloneElements.length > 0, "Should find standalone component");

      const standaloneComponent = standaloneElements[0];
      assert.strictEqual(standaloneComponent.isStandalone, true, "Should be marked as standalone");
      assert.strictEqual(standaloneComponent.name, "StandaloneComponent", "Should have correct name");
    });

    it("should parse complex selectors correctly", async () => {
      await indexer.generateFullIndex();

      // Test complex selector parsing
      const complexElements = indexer.getElements("complexButton");
      assert.ok(complexElements.length > 0, "Should find complex directive");

      const complexDirective = complexElements[0];
      assert.strictEqual(
        complexDirective.originalSelector,
        "button[complexButton],a[complexButton]",
        "Should preserve original selector"
      );
      assert.ok(complexDirective.selectors.includes("complexButton"), "Should include parsed selector");
    });

    it("should handle empty project gracefully", async () => {
      const emptyProjectPath = path.join(fixturesPath, "empty-project");

      try {
        if (!fs.existsSync(emptyProjectPath)) {
          fs.mkdirSync(emptyProjectPath, { recursive: true });
        }

        indexer.setProjectRoot(emptyProjectPath);
        const result = await indexer.generateFullIndex();

        assert.ok(result instanceof Map, "Should return a Map");
        assert.strictEqual(result.size, 0, "Should have no elements for empty project");
      } finally {
        if (fs.existsSync(emptyProjectPath)) {
          fs.rmSync(emptyProjectPath, { recursive: true, force: true });
        }
      }
    });

    it("should handle malformed files gracefully", async () => {
      // Create a malformed Angular file
      const malformedPath = path.join(testProjectPath, "src", "app", "malformed.component.ts");
      fs.writeFileSync(malformedPath, "invalid typescript content @Component({");

      try {
        // Should not throw an error
        await indexer.generateFullIndex();

        // Check that other files were still indexed
        const selectors = indexer.getAllSelectors();
        assert.ok(selectors.length > 0, "Should still index valid files");
      } finally {
        if (fs.existsSync(malformedPath)) {
          fs.unlinkSync(malformedPath);
        }
      }
    });

    it("should limit concurrent file reads while filtering Angular candidates", async () => {
      let activeReads = 0;
      let maxActiveReads = 0;
      const pendingReads: Array<() => void> = [];

      const readFile = async () => {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise<void>((resolve) => pendingReads.push(resolve));
        activeReads--;
        return "@Component({})";
      };

      const filePaths = Array.from({ length: 40 }, (_, index) => path.join(testProjectPath, `candidate-${index}.ts`));
      const filtering = (
        indexer as unknown as {
          _filterRelevantFiles(files: string[], fileReader: (filePath: string) => Promise<string>): Promise<string[]>;
        }
      )._filterRelevantFiles(filePaths, readFile);

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(maxActiveReads > 0, "Filtering should start reading files");
      assert.ok(maxActiveReads <= 8, `Expected at most 8 concurrent reads, observed ${maxActiveReads}`);

      while (pendingReads.length > 0 || activeReads > 0) {
        pendingReads.splice(0).forEach((resolve) => {
          resolve();
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const result = await filtering;
      assert.strictEqual(result.length, filePaths.length, "All matching files should be returned");
    });
  });

  describe("SelectorTrie Functionality", () => {
    beforeEach(async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();
    });

    it("should support prefix searching", () => {
      const results = indexer.searchWithSelectors("test");
      assert.ok(results.length >= 3, "Should find elements with 'test' prefix");

      const selectors = results.map((r) => r.selector);
      assert.ok(
        selectors.some((s) => s.startsWith("test")),
        "Should include selectors starting with 'test'"
      );
    });

    it("should return exact matches", () => {
      const elements = indexer.getElements("test-component");
      assert.ok(elements.length > 0, "Should find exact match for 'test-component'");

      const element = elements[0];
      assert.strictEqual(element.name, "TestComponent", "Should return correct component");
    });

    it("should return empty array for non-existent selectors", () => {
      const elements = indexer.getElements("non-existent-selector");
      assert.strictEqual(elements.length, 0, "Should return empty array for non-existent selector");
    });

    it("should handle multiple elements with same selector", () => {
      // This tests the trie's ability to handle multiple elements per selector
      const allSelectors = indexer.getAllSelectors();
      assert.ok(allSelectors.length > 0, "Should have selectors");

      // Test that all selectors are unique in the trie structure
      const uniqueSelectors = [...new Set(allSelectors)];
      assert.strictEqual(allSelectors.length, uniqueSelectors.length, "All selectors should be unique in trie");
    });
  });

  describe("File Watching", () => {
    beforeEach(async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();
    });

    it("should initialize file watcher", () => {
      indexer.initializeWatcher();
      assert.ok(indexer.fileWatcher, "Should have file watcher");
    });

    it("only accepts project sources from the watcher, which has no exclude pattern of its own", () => {
      const guard = (indexer as unknown as { isIndexableProjectFile(filePath: string): boolean })
        .isIndexableProjectFile;
      const isIndexable = (...segments: string[]) => guard.call(indexer, path.join(testProjectPath, ...segments));

      assert.strictEqual(isIndexable("src", "app", "app.component.ts"), true, "Project sources must be indexed");
      assert.strictEqual(isIndexable("src", "app", "nested", "feature.directive.ts"), true, "Nesting is fine");

      assert.strictEqual(isIndexable("node_modules", "some-lib", "index.ts"), false, "Dependencies are excluded");
      assert.strictEqual(isIndexable("dist", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(isIndexable("out", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(isIndexable("bazel-out", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(isIndexable("e2e", "app.e2e.ts"), false, "E2E projects are excluded");
      assert.strictEqual(isIndexable(".angular", "cache", "x.ts"), false, "Dot directories are excluded");
      assert.strictEqual(isIndexable("src", "app", "app.component.spec.ts"), false, "Specs are excluded");
      assert.strictEqual(isIndexable("src", "app", "app.component.test.ts"), false, "Tests are excluded");

      assert.strictEqual(
        guard.call(indexer, path.join(path.dirname(testProjectPath), "other", "main.ts")),
        false,
        "Files outside the project root are excluded"
      );
    });

    it("should dispose file watcher on dispose", () => {
      indexer.initializeWatcher();
      indexer.dispose();
      assert.strictEqual(indexer.fileWatcher, null, "File watcher should be null after dispose");
    });

    it("should initialize dependency watcher", () => {
      indexer.initializeWatcher();
      const depWatcher = (indexer as unknown as { dependencyWatcher: unknown }).dependencyWatcher;
      assert.ok(depWatcher, "Should have a dependency watcher");
      assert.strictEqual(typeof indexer.onDidIndexNodeModules, "function", "Should expose onDidIndexNodeModules event");
    });

    it("should dispose dependency watcher on dispose", () => {
      indexer.initializeWatcher();
      indexer.dispose();
      const depWatcher = (indexer as unknown as { dependencyWatcher: unknown }).dependencyWatcher;
      assert.strictEqual(depWatcher, null, "Dependency watcher should be null after dispose");
    });

    it("should re-index node_modules and emit event on dependency change", async () => {
      indexer.initializeWatcher();

      let fired = 0;
      let indexChanged = 0;
      const subscription = indexer.onDidIndexNodeModules(() => {
        fired++;
      });
      const indexSubscription = indexer.onDidChangeIndex(() => {
        indexChanged++;
      });

      try {
        const indexerInternal = indexer as unknown as {
          reindexNodeModulesAfterDependencyChange: () => Promise<void>;
        };
        await indexerInternal.reindexNodeModulesAfterDependencyChange();
        assert.strictEqual(fired, 1, "onDidIndexNodeModules should fire once after a dependency change");
        assert.strictEqual(indexChanged, 1, "Dependency changes should also request a diagnostics refresh");
      } finally {
        subscription.dispose();
        indexSubscription.dispose();
      }
    });

    it("should skip dependency reindex while a full index is running", async () => {
      indexer.initializeWatcher();

      let fired = 0;
      const subscription = indexer.onDidIndexNodeModules(() => {
        fired++;
      });

      const indexerInternal = indexer as unknown as {
        isIndexing: boolean;
        reindexNodeModulesAfterDependencyChange: () => Promise<void>;
      };
      try {
        indexerInternal.isIndexing = true;
        await indexerInternal.reindexNodeModulesAfterDependencyChange();
        assert.strictEqual(fired, 0, "Should not re-index or emit while a full index is in progress");
      } finally {
        indexerInternal.isIndexing = false;
        subscription.dispose();
      }
    });

    it("should handle file creation", async () => {
      indexer.initializeWatcher();

      const newComponentPath = path.join(testProjectPath, "src", "app", "new.component.ts");
      const newComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'new-component',
  template: '<div>New Component</div>'
})
export class NewComponent {}
`;

      try {
        const indexChanged = new Promise<void>((resolve) => {
          const subscription = indexer.onDidChangeIndex(() => {
            subscription.dispose();
            resolve();
          });
        });

        // Create the file and report it, as the client's watcher would.
        fs.writeFileSync(newComponentPath, newComponentContent);
        ports.report({ filePath: newComponentPath, kind: "create" });

        // Wait for the watcher to finish updating the index.
        await Promise.race([indexChanged, new Promise((resolve) => setTimeout(resolve, 1000))]);

        // Check if the new component was indexed
        const elements = indexer.getElements("new-component");
        assert.ok(elements.length > 0, "Should index newly created component");
      } finally {
        if (fs.existsSync(newComponentPath)) {
          fs.unlinkSync(newComponentPath);
        }
      }
    });

    it("should handle file deletion", async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();
      indexer.initializeWatcher();

      const tempComponentPath = path.join(testProjectPath, "src", "app", "temp.component.ts");
      const tempComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'temp-component',
  template: '<div>Temp Component</div>'
})
export class TempComponent {}
`;

      // Create and index the file first
      fs.writeFileSync(tempComponentPath, tempComponentContent);

      // Force a reindex to include the new file
      await indexer.generateFullIndex();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify it's indexed
      let elements = indexer.getElements("temp-component");
      assert.ok(elements.length > 0, "Should index temp component");

      // Delete the file
      fs.unlinkSync(tempComponentPath);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Force a reindex after deletion
      await indexer.generateFullIndex();

      // Verify it's removed from index
      elements = indexer.getElements("temp-component");
      assert.strictEqual(elements.length, 0, "Should remove deleted component from index");
    });
  });

  describe("Caching", () => {
    it("should save and load index to/from workspace state", async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();

      // Verify data was saved
      const fileCacheKey = indexer.workspaceFileCacheKey;
      const indexCacheKey = indexer.workspaceIndexCacheKey;

      assert.ok(cacheStore.get(fileCacheKey) !== undefined, "Should save file cache");
      assert.ok(cacheStore.get(indexCacheKey) !== undefined, "Should save index cache");

      // Create new indexer and load from cache
      const newIndexer = new AngularIndexer({ cacheStore, ...hostPorts() });
      newIndexer.setProjectRoot(testProjectPath);

      const loaded = await newIndexer.loadFromWorkspace();
      assert.ok(loaded, "Should successfully load from cache");

      // Verify loaded data
      const selectors = newIndexer.getAllSelectors();
      assert.ok(selectors.length > 0, "Should have selectors after loading from cache");
      assert.ok(selectors.includes("test-component"), "Should include cached selectors");

      newIndexer.dispose();
    });

    it("should handle missing cache gracefully", async () => {
      indexer.setProjectRoot(testProjectPath);

      // Try to load from empty cache
      const loaded = await indexer.loadFromWorkspace();
      assert.strictEqual(loaded, false, "Should return false when no cache exists");
    });

    it("should discard cache when a cached project file no longer exists", async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();

      // Simulate a file that was moved/deleted while the extension was not running:
      // the cached fileCache still references its old (now missing) path.
      const fileCacheKey = indexer.workspaceFileCacheKey;
      const cachedFiles = cacheStore.get<Record<string, FileElementsInfo>>(fileCacheKey) as Record<
        string,
        FileElementsInfo
      >;
      const stalePath = path.join(testProjectPath, "src", "app", "__moved-away__.component.ts");
      cachedFiles[stalePath] = {
        filePath: stalePath,
        lastModified: Date.now(),
        hash: "stale",
        elements: [],
      };
      await cacheStore.set(fileCacheKey, cachedFiles);

      const newIndexer = new AngularIndexer({ cacheStore, ...hostPorts() });
      newIndexer.setProjectRoot(testProjectPath);

      const loaded = await newIndexer.loadFromWorkspace();
      assert.strictEqual(loaded, false, "Should reject a cache that references a missing file");
      assert.strictEqual(
        newIndexer.getAllSelectors().length,
        0,
        "Stale in-memory state should be cleared so the caller performs a full reindex"
      );

      newIndexer.dispose();
    });

    it("should handle FileElementsInfo format correctly", async () => {
      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();

      // Check that the cached data uses the new FileElementsInfo format
      const fileCacheKey = indexer.workspaceFileCacheKey;
      const cachedData = cacheStore.get<Record<string, FileElementsInfo>>(fileCacheKey);

      assert.ok(cachedData, "Should have cached file data");

      const firstEntry = Object.values(cachedData)[0];
      assert.ok(firstEntry, "Should have at least one cached file");
      assert.ok("elements" in firstEntry, "Should use FileElementsInfo format with elements array");
      assert.ok(Array.isArray(firstEntry.elements), "Elements should be an array");
      assert.ok(firstEntry.elements.length > 0, "Should have at least one element");
    });
  });

  describe("Library Indexing", () => {
    beforeEach(async () => {
      // Create mock node_modules structure
      await createMockNodeModules();
      indexer.setProjectRoot(testProjectPath);
    });

    afterEach(async () => {
      await cleanupMockNodeModules();
    });

    it("should index Angular libraries from node_modules", async () => {
      // Mock the library indexing functionality
      // Note: Full library indexing is complex and requires actual Angular libraries
      // This test focuses on the indexing structure

      await indexer.generateFullIndex();

      // The indexer should handle the presence of node_modules
      // Even if no actual Angular libraries are found, it shouldn't error
      const selectors = indexer.getAllSelectors();
      assert.ok(Array.isArray(selectors), "Should return selectors array even with node_modules present");
    });

    it("should index libraries only through package entry points", async () => {
      await indexer.generateFullIndex();

      const libraryElements = indexer.getElements("mock-icon");
      assert.ok(libraryElements.length > 0, "Entry-point indexing should find library elements");
      assert.strictEqual(libraryElements[0].isExternal, true, "Library elements must be marked as external");
    });

    it("keeps node_modules out of the project file scan", async () => {
      type UpdateFileIndex = (filePath: string) => Promise<void>;
      const testIndexer = indexer as unknown as { updateFileIndex: UpdateFileIndex };
      const originalUpdateFileIndex = testIndexer.updateFileIndex.bind(indexer);
      const scannedPaths: string[] = [];

      testIndexer.updateFileIndex = async (...args: Parameters<UpdateFileIndex>) => {
        scannedPaths.push(args[0]);
        return originalUpdateFileIndex(...args);
      };

      await indexer.generateFullIndex();

      const dependencyPaths = scannedPaths.filter((filePath) => filePath.split(path.sep).includes("node_modules"));
      assert.deepStrictEqual(
        dependencyPaths,
        [],
        "The exclude glob must keep node_modules out of the project scan; a mis-parsed glob pulls it back in"
      );
    });

    it("should ignore entry points that only re-export private ɵ aliases", async () => {
      await indexer.generateFullIndex();

      const iconElements = indexer.getElements("mock-icon");
      const submenuElements = indexer.getElements("mock-submenu");

      assert.ok(
        iconElements.some((element) => element.name === "MockIconDirective"),
        "Should index public directive"
      );
      assert.ok(
        submenuElements.some((element) => element.name === "MockSubMenuDirective"),
        "Should index public submenu directive"
      );
      assert.ok(
        !iconElements.some((element) => element.name === "MockTransitionPatchDirective"),
        "Should not index a directive re-exported only as a private ɵ alias for mock-icon"
      );
      assert.ok(
        !submenuElements.some((element) => element.name === "MockTransitionPatchDirective"),
        "Should not index a directive re-exported only as a private ɵ alias for mock-submenu"
      );
    });
  });

  describe("NgModule export name resolution", () => {
    /**
     * Builds the first element of a tuple type so it can be fed to the private
     * `_resolveExportedClassName`, mirroring an `ɵmod` exports tuple entry.
     */
    function firstTupleElement(sourceText: string) {
      const project = new Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile("mod.d.ts", sourceText);
      const alias = sourceFile.getTypeAliasOrThrow("Exports");
      const tuple = alias.getTypeNodeOrThrow().asKindOrThrow(SyntaxKind.TupleType);
      return { element: tuple.getElements()[0], typeChecker: project.getTypeChecker() };
    }

    it("resolves the class name via the TypeChecker when the symbol is available", () => {
      const { element, typeChecker } = firstTupleElement(
        "declare class TranslatePipe {}\ntype Exports = [typeof TranslatePipe];"
      );

      const resolved = (indexer as any)._resolveExportedClassName(element, typeChecker);
      assert.strictEqual(resolved, "TranslatePipe");
    });

    it("falls back to the syntactic name when cross-file symbol resolution fails", () => {
      // `i1` is an unresolved namespace (no import), so the TypeChecker yields no
      // symbol — mirroring environments (e.g. WSL/Windows mounts) where compiled
      // library `.d.ts` cross-file references don't resolve. Without the fallback
      // the module's exports are silently dropped, causing false-positive
      // "not imported" diagnostics for pipes provided via an NgModule.
      const { element, typeChecker } = firstTupleElement("type Exports = [typeof i1.TranslatePipe];");

      const resolved = (indexer as any)._resolveExportedClassName(element, typeChecker);
      assert.strictEqual(resolved, "TranslatePipe");
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid project paths gracefully", async () => {
      const invalidPath = path.join(fixturesPath, "non-existent-project");
      indexer.setProjectRoot(invalidPath);

      // Should not throw an error
      const result = await indexer.generateFullIndex();
      assert.ok(result instanceof Map, "Should return a Map even for invalid paths");
      assert.strictEqual(result.size, 0, "Should have no elements for invalid path");
    });

    it("should handle dispose without initialization", () => {
      const newIndexer = new AngularIndexer({ cacheStore, ...hostPorts() });
      assert.doesNotThrow(() => {
        newIndexer.dispose();
      }, "Should handle dispose without initialization");
    });

    it("should handle getElements with invalid selectors", () => {
      indexer.setProjectRoot(testProjectPath);

      const testCases = [
        { selector: "", description: "empty string" },
        { selector: null, description: "null" },
        { selector: undefined, description: "undefined" },
        { selector: 123, description: "number" },
      ];

      testCases.forEach(({ selector, description }) => {
        const result = indexer.getElements(selector as any);
        assert.strictEqual(Array.isArray(result), true, `Should return array for ${description}`);
        assert.strictEqual(result.length, 0, `Should return empty array for ${description}`);
      });
    });

    it("should handle ts-morph parsing errors with regex fallback", async () => {
      // Create a file that might cause ts-morph issues but is parseable with regex
      const problematicPath = path.join(testProjectPath, "src", "app", "problematic.component.ts");
      const problematicContent = `
// This might cause ts-morph issues but should work with regex
export class ProblematicComponent {
}
// @Component decorator after class (unusual but possible)
ProblematicComponent = Component({
  selector: 'problematic-component',
  template: 'test'
})(ProblematicComponent);
`;

      fs.writeFileSync(problematicPath, problematicContent);

      try {
        // Should not throw an error and should attempt fallback
        await indexer.generateFullIndex();

        // The indexer should handle this gracefully
        const selectors = indexer.getAllSelectors();
        assert.ok(Array.isArray(selectors), "Should return selectors array even with problematic files");
      } finally {
        if (fs.existsSync(problematicPath)) {
          fs.unlinkSync(problematicPath);
        }
      }
    });
  });

  describe("Performance and Batching", () => {
    it("should handle large numbers of files efficiently", async () => {
      // Create multiple test files
      const testFiles: string[] = [];
      const srcPath = path.join(testProjectPath, "src", "app", "bulk");

      if (!fs.existsSync(srcPath)) {
        fs.mkdirSync(srcPath, { recursive: true });
      }

      try {
        // Create 10 test components
        for (let i = 0; i < 10; i++) {
          const componentPath = path.join(srcPath, `bulk${i}.component.ts`);
          const componentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'bulk-component-${i}',
  template: '<div>Bulk Component ${i}</div>'
})
export class BulkComponent${i} {}
`;
          fs.writeFileSync(componentPath, componentContent);
          testFiles.push(componentPath);
        }

        indexer.setProjectRoot(testProjectPath);

        const startTime = Date.now();
        await indexer.generateFullIndex();
        const endTime = Date.now();

        // Should complete in reasonable time (less than 10 seconds for 10 files)
        assert.ok(endTime - startTime < 10000, "Should index files efficiently");

        // Should index all bulk components
        const selectors = indexer.getAllSelectors();
        for (let i = 0; i < 10; i++) {
          assert.ok(selectors.includes(`bulk-component-${i}`), `Should include bulk-component-${i}`);
        }
      } finally {
        // Clean up test files
        testFiles.forEach((file) => {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        });
        if (fs.existsSync(srcPath)) {
          fs.rmSync(srcPath, { recursive: true, force: true });
        }
      }
    });
  });

  // Helper functions
  async function createTestProject(): Promise<void> {
    if (!fs.existsSync(testProjectPath)) {
      fs.mkdirSync(testProjectPath, { recursive: true });
    }

    const srcPath = path.join(testProjectPath, "src", "app");
    fs.mkdirSync(srcPath, { recursive: true });

    // Create basic component
    const componentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'test-component',
  template: '<div>Test Component</div>',
  standalone: false
})
export class TestComponent {}
`;
    fs.writeFileSync(path.join(srcPath, "test.component.ts"), componentContent);

    // Create basic directive
    const directiveContent = `
import { Directive } from '@angular/core';

@Directive({
  selector: '[testDirective]',
  standalone: false
})
export class TestDirective {}
`;
    fs.writeFileSync(path.join(srcPath, "test.directive.ts"), directiveContent);

    // Create basic pipe
    const pipeContent = `
import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'testPipe',
  standalone: false
})
export class TestPipe implements PipeTransform {
  transform(value: any): any {
    return value;
  }
}
`;
    fs.writeFileSync(path.join(srcPath, "test.pipe.ts"), pipeContent);

    // Create standalone component
    const standaloneComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'standalone-component',
  template: '<div>Standalone Component</div>',
  standalone: true
})
export class StandaloneComponent {}
`;
    fs.writeFileSync(path.join(srcPath, "standalone.component.ts"), standaloneComponentContent);

    // Create directive with complex selector
    const complexDirectiveContent = `
import { Directive } from '@angular/core';

@Directive({
  selector: 'button[complexButton],a[complexButton]',
  standalone: true
})
export class ComplexDirective {}
`;
    fs.writeFileSync(path.join(srcPath, "complex.directive.ts"), complexDirectiveContent);

    // Create package.json
    const packageJsonContent = {
      name: "test-angular-project",
      version: "1.0.0",
      dependencies: {
        "@angular/core": "^17.0.0",
        "@angular/common": "^17.0.0",
        "mock-private-lib": "^1.0.0",
      },
    };
    fs.writeFileSync(path.join(testProjectPath, "package.json"), JSON.stringify(packageJsonContent, null, 2));

    // Create tsconfig.json
    const tsconfigContent = {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        lib: ["ES2022", "DOM"],
        strict: true,
      },
    };
    fs.writeFileSync(path.join(testProjectPath, "tsconfig.json"), JSON.stringify(tsconfigContent, null, 2));
  }

  async function createMockNodeModules(): Promise<void> {
    if (!fs.existsSync(mockNodeModulesPath)) {
      fs.mkdirSync(mockNodeModulesPath, { recursive: true });
    }

    // Create a mock Angular library structure
    const mockLibPath = path.join(mockNodeModulesPath, "@angular", "material");
    fs.mkdirSync(mockLibPath, { recursive: true });

    const mockPackageJson = {
      name: "@angular/material",
      version: "17.0.0",
      peerDependencies: {
        "@angular/core": "^17.0.0",
      },
    };
    fs.writeFileSync(path.join(mockLibPath, "package.json"), JSON.stringify(mockPackageJson, null, 2));

    const mockPrivateLibPath = path.join(mockNodeModulesPath, "mock-private-lib");
    const mockTransitionPatchPath = path.join(mockPrivateLibPath, "core", "transition-patch");
    fs.mkdirSync(mockTransitionPatchPath, { recursive: true });

    const mockPrivateLibPackageJson = {
      name: "mock-private-lib",
      version: "1.0.0",
      peerDependencies: {
        "@angular/core": "^17.0.0",
      },
      exports: {
        ".": {
          types: "./index.d.ts",
        },
        "./core/transition-patch": {
          types: "./core/transition-patch/public-api.d.ts",
        },
      },
    };
    fs.writeFileSync(path.join(mockPrivateLibPath, "package.json"), JSON.stringify(mockPrivateLibPackageJson, null, 2));

    fs.writeFileSync(
      path.join(mockPrivateLibPath, "index.d.ts"),
      `export { MockIconDirective } from './icon.directive';
export { MockSubMenuDirective } from './submenu.directive';
`
    );

    fs.writeFileSync(
      path.join(mockPrivateLibPath, "icon.directive.d.ts"),
      `import * as i0 from '@angular/core';

export declare class MockIconDirective {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockIconDirective, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockIconDirective, "mock-icon,[mock-icon]", never, {}, {}, never, never, true, never>;
}
`
    );

    fs.writeFileSync(
      path.join(mockPrivateLibPath, "submenu.directive.d.ts"),
      `import * as i0 from '@angular/core';

export declare class MockSubMenuDirective {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockSubMenuDirective, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockSubMenuDirective, "[mock-submenu]", never, {}, {}, never, never, true, never>;
}
`
    );

    fs.writeFileSync(
      path.join(mockTransitionPatchPath, "public-api.d.ts"),
      `export { MockTransitionPatchDirective as ɵMockTransitionPatchDirective } from './transition-patch.directive';
`
    );

    fs.writeFileSync(
      path.join(mockTransitionPatchPath, "transition-patch.directive.d.ts"),
      `import * as i0 from '@angular/core';

export declare class MockTransitionPatchDirective {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockTransitionPatchDirective, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockTransitionPatchDirective, "[mock-icon], mock-icon, [mock-submenu]", never, {}, {}, never, never, true, never>;
}
`
    );
  }

  async function cleanupMockNodeModules(): Promise<void> {
    if (fs.existsSync(mockNodeModulesPath)) {
      fs.rmSync(mockNodeModulesPath, { recursive: true, force: true });
    }
  }

  async function cleanupTestProject(): Promise<void> {
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  }

  /**
   * Tests for transitive module exports expansion functionality.
   * Verifies that when a module re-exports another module, all the re-exported module's
   * exports are also available (e.g., ChipsModule exports InputTextModule, which exports InputText).
   */
  describe("Transitive Module Exports", () => {
    const modulesPath = path.join(testProjectPath, "src", "app", "modules");

    beforeEach(async () => {
      if (!fs.existsSync(modulesPath)) {
        fs.mkdirSync(modulesPath, { recursive: true });
      }
      indexer.setProjectRoot(testProjectPath);
    });

    afterEach(() => {
      // Clean up module files
      if (fs.existsSync(modulesPath)) {
        fs.rmSync(modulesPath, { recursive: true, force: true });
      }
    });

    it("should expand direct module re-exports", async () => {
      // Create InputText directive
      const inputTextDirectiveContent = `
import { Directive } from '@angular/core';

@Directive({
  selector: '[pInputText]',
  standalone: false
})
export class InputText {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.directive.ts"), inputTextDirectiveContent);

      // Create InputTextModule that exports InputText
      const inputTextModuleContent = `
import { NgModule } from '@angular/core';
import { InputText } from './input-text.directive';

@NgModule({
  declarations: [InputText],
  exports: [InputText]
})
export class InputTextModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.module.ts"), inputTextModuleContent);

      // Create ChipsComponent
      const chipsComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'p-chips',
  template: '<div>Chips</div>',
  standalone: false
})
export class ChipsComponent {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.component.ts"), chipsComponentContent);

      // Create ChipsModule that re-exports InputTextModule
      const chipsModuleContent = `
import { NgModule } from '@angular/core';
import { InputTextModule } from './input-text.module';
import { ChipsComponent } from './chips.component';

@NgModule({
  declarations: [ChipsComponent],
  imports: [InputTextModule],
  exports: [InputTextModule, ChipsComponent]
})
export class ChipsModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.module.ts"), chipsModuleContent);

      // Index the modules
      await indexer.generateFullIndex();

      // Verify that ChipsModule exports include transitive exports from InputTextModule
      const chipsModuleExports = indexer.getExternalModuleExports("ChipsModule");
      assert.ok(chipsModuleExports, "ChipsModule should have exports");
      assert.ok(chipsModuleExports.has("InputTextModule"), "ChipsModule should export InputTextModule");
      assert.ok(chipsModuleExports.has("InputText"), "ChipsModule should transitively export InputText");
      assert.ok(chipsModuleExports.has("ChipsComponent"), "ChipsModule should export ChipsComponent");
    });

    it("should expand nested module re-exports", async () => {
      // Create InputText directive
      const inputTextDirectiveContent = `
import { Directive } from '@angular/core';

@Directive({
  selector: '[pInputText]',
  standalone: false
})
export class InputText {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.directive.ts"), inputTextDirectiveContent);

      // Create InputTextModule
      const inputTextModuleContent = `
import { NgModule } from '@angular/core';
import { InputText } from './input-text.directive';

@NgModule({
  declarations: [InputText],
  exports: [InputText]
})
export class InputTextModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.module.ts"), inputTextModuleContent);

      // Create ChipsComponent
      const chipsComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'p-chips',
  template: '<div>Chips</div>',
  standalone: false
})
export class ChipsComponent {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.component.ts"), chipsComponentContent);

      // Create ChipsModule
      const chipsModuleContent = `
import { NgModule } from '@angular/core';
import { InputTextModule } from './input-text.module';
import { ChipsComponent } from './chips.component';

@NgModule({
  declarations: [ChipsComponent],
  imports: [InputTextModule],
  exports: [InputTextModule, ChipsComponent]
})
export class ChipsModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.module.ts"), chipsModuleContent);

      // Create FormComponent
      const formComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'p-form',
  template: '<div>Form</div>',
  standalone: false
})
export class FormComponent {}
`;
      fs.writeFileSync(path.join(modulesPath, "form.component.ts"), formComponentContent);

      // Create FormModule that re-exports ChipsModule
      const formModuleContent = `
import { NgModule } from '@angular/core';
import { ChipsModule } from './chips.module';
import { FormComponent } from './form.component';

@NgModule({
  declarations: [FormComponent],
  imports: [ChipsModule],
  exports: [ChipsModule, FormComponent]
})
export class FormModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "form.module.ts"), formModuleContent);

      // Index the modules
      await indexer.generateFullIndex();

      // Verify nested transitive exports
      const formModuleExports = indexer.getExternalModuleExports("FormModule");
      assert.ok(formModuleExports, "FormModule should have exports");
      assert.ok(formModuleExports.has("ChipsModule"), "FormModule should export ChipsModule");
      assert.ok(formModuleExports.has("InputTextModule"), "FormModule should transitively export InputTextModule");
      assert.ok(formModuleExports.has("InputText"), "FormModule should transitively export InputText");
      assert.ok(formModuleExports.has("ChipsComponent"), "FormModule should transitively export ChipsComponent");
      assert.ok(formModuleExports.has("FormComponent"), "FormModule should export FormComponent");
    });

    it("should expand module exports after loading from cache", async () => {
      // Create InputText directive
      const inputTextDirectiveContent = `
import { Directive } from '@angular/core';

@Directive({
  selector: '[pInputText]',
  standalone: false
})
export class InputText {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.directive.ts"), inputTextDirectiveContent);

      // Create InputTextModule
      const inputTextModuleContent = `
import { NgModule } from '@angular/core';
import { InputText } from './input-text.directive';

@NgModule({
  declarations: [InputText],
  exports: [InputText]
})
export class InputTextModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "input-text.module.ts"), inputTextModuleContent);

      // Create ChipsComponent
      const chipsComponentContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'p-chips',
  template: '<div>Chips</div>',
  standalone: false
})
export class ChipsComponent {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.component.ts"), chipsComponentContent);

      // Create ChipsModule
      const chipsModuleContent = `
import { NgModule } from '@angular/core';
import { InputTextModule } from './input-text.module';
import { ChipsComponent } from './chips.component';

@NgModule({
  declarations: [ChipsComponent],
  imports: [InputTextModule],
  exports: [InputTextModule, ChipsComponent]
})
export class ChipsModule {}
`;
      fs.writeFileSync(path.join(modulesPath, "chips.module.ts"), chipsModuleContent);

      // Index and save to cache
      await indexer.generateFullIndex();

      // Verify exports before loading from cache
      let chipsModuleExports = indexer.getExternalModuleExports("ChipsModule");
      assert.ok(chipsModuleExports?.has("InputText"), "Should have transitive exports before cache");

      // Create new indexer and load from cache
      const newIndexer = new AngularIndexer({ cacheStore, ...hostPorts() });
      newIndexer.setProjectRoot(testProjectPath);
      const loaded = await newIndexer.loadFromWorkspace();
      assert.ok(loaded, "Should successfully load from cache");

      // Verify that transitive exports are still present after loading from cache
      chipsModuleExports = newIndexer.getExternalModuleExports("ChipsModule");
      assert.ok(chipsModuleExports, "ChipsModule should have exports after loading from cache");
      assert.ok(chipsModuleExports.has("InputTextModule"), "Should have InputTextModule after cache load");
      assert.ok(chipsModuleExports.has("InputText"), "Should have transitive InputText after cache load");
      assert.ok(chipsModuleExports.has("ChipsComponent"), "Should have ChipsComponent after cache load");

      newIndexer.dispose();
    });

    it("should handle circular module dependencies", async () => {
      // Create ComponentA
      const componentaContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'component-a',
  template: '<div>Component A</div>',
  standalone: false
})
export class ComponentA {}
`;
      fs.writeFileSync(path.join(modulesPath, "component-a.component.ts"), componentaContent);

      // Create ComponentB
      const componentbContent = `
import { Component } from '@angular/core';

@Component({
  selector: 'component-b',
  template: '<div>Component B</div>',
  standalone: false
})
export class ComponentB {}
`;
      fs.writeFileSync(path.join(modulesPath, "component-b.component.ts"), componentbContent);

      // Create ModuleA that exports ModuleB
      const moduleaContent = `
import { NgModule } from '@angular/core';
import { ModuleB } from './module-b.module';
import { ComponentA } from './component-a.component';

@NgModule({
  declarations: [ComponentA],
  imports: [ModuleB],
  exports: [ModuleB, ComponentA]
})
export class ModuleA {}
`;
      fs.writeFileSync(path.join(modulesPath, "module-a.module.ts"), moduleaContent);

      // Create ModuleB that exports ModuleA (circular dependency)
      const modulebContent = `
import { NgModule } from '@angular/core';
import { ModuleA } from './module-a.module';
import { ComponentB } from './component-b.component';

@NgModule({
  declarations: [ComponentB],
  imports: [ModuleA],
  exports: [ModuleA, ComponentB]
})
export class ModuleB {}
`;
      fs.writeFileSync(path.join(modulesPath, "module-b.module.ts"), modulebContent);

      // Index should not hang or crash
      await indexer.generateFullIndex();

      // Verify that both modules were indexed and circular dependency was handled
      const moduleaExports = indexer.getExternalModuleExports("ModuleA");
      const modulebExports = indexer.getExternalModuleExports("ModuleB");

      assert.ok(moduleaExports, "ModuleA should be indexed");
      assert.ok(modulebExports, "ModuleB should be indexed");

      // Each module should have its own component
      assert.ok(moduleaExports.has("ComponentA"), "ModuleA should have ComponentA");
      assert.ok(modulebExports.has("ComponentB"), "ModuleB should have ComponentB");

      // Verify circular references are handled (modules reference each other)
      assert.ok(moduleaExports.has("ModuleB"), "ModuleA should reference ModuleB");
      assert.ok(modulebExports.has("ModuleA"), "ModuleB should reference ModuleA");
    });
  });
});
