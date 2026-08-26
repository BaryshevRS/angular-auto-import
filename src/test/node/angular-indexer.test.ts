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
import { ComponentImports } from "../../core/component-imports";
import type { AngularElementIndex } from "../../core/element-index";
import type { FileSystem } from "../../core/file-system";
import type { FileChange, FileWatcherFactory } from "../../core/file-watching";
import { type InstrumentedLogger, silentLogger, withInstrumentation } from "../../core/logging";
import type { ProgressHost } from "../../core/progress";
import { silentProgressHost } from "../../core/progress";
import { AngularIndexer } from "../../services";
import { AngularElementData, type FileElementsInfo } from "../../types";

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

    it("only accepts project sources from the watcher, which has no exclude pattern of its own", async () => {
      const guard = (indexer as unknown as { isIndexableProjectFile(filePath: string): Promise<boolean> })
        .isIndexableProjectFile;
      const isIndexable = (...segments: string[]) => guard.call(indexer, path.join(testProjectPath, ...segments));

      assert.strictEqual(await isIndexable("src", "app", "app.component.ts"), true, "Project sources must be indexed");
      assert.strictEqual(await isIndexable("src", "app", "nested", "feature.directive.ts"), true, "Nesting is fine");

      assert.strictEqual(await isIndexable("node_modules", "some-lib", "index.ts"), false, "Dependencies are excluded");
      assert.strictEqual(await isIndexable("dist", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(await isIndexable("out", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(await isIndexable("bazel-out", "main.ts"), false, "Build output is excluded");
      assert.strictEqual(await isIndexable("e2e", "app.e2e.ts"), false, "E2E projects are excluded");
      assert.strictEqual(await isIndexable(".angular", "cache", "x.ts"), false, "Dot directories are excluded");
      assert.strictEqual(await isIndexable("src", "app", "app.component.spec.ts"), false, "Specs are excluded");
      assert.strictEqual(await isIndexable("src", "app", "app.component.test.ts"), false, "Tests are excluded");

      assert.strictEqual(
        await guard.call(indexer, path.join(path.dirname(testProjectPath), "other", "main.ts")),
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

    it("re-reads an NgModule whose exports changed, and forgets them when the file goes", async () => {
      const modulePath = path.join(testProjectPath, "src", "app", "watched.module.ts");
      const moduleWithExport = (exported: string) => `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [${exported}]
})
export class WatchedModule {}
`;
      const nextChange = () =>
        new Promise<void>((resolve) => {
          const subscription = indexer.onDidChangeIndex(() => {
            subscription.dispose();
            resolve();
          });
        });

      try {
        fs.writeFileSync(modulePath, moduleWithExport("FirstThing"));
        await indexer.generateFullIndex();
        indexer.initializeWatcher();

        assert.deepStrictEqual(
          [...(indexer.getExternalModuleExports("WatchedModule") ?? [])],
          ["FirstThing"],
          "The full index should read the module as written"
        );

        let changed = nextChange();
        fs.writeFileSync(modulePath, moduleWithExport("SecondThing"));
        ports.report({ filePath: modulePath, kind: "change" });
        await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 2000))]);

        assert.deepStrictEqual(
          [...(indexer.getExternalModuleExports("WatchedModule") ?? [])],
          ["SecondThing"],
          "An edited module must answer with its current exports"
        );

        changed = nextChange();
        fs.unlinkSync(modulePath);
        ports.report({ filePath: modulePath, kind: "delete" });
        await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 2000))]);

        assert.strictEqual(
          indexer.getExternalModuleExports("WatchedModule"),
          undefined,
          "A deleted module must stop answering"
        );
      } finally {
        if (fs.existsSync(modulePath)) {
          fs.unlinkSync(modulePath);
        }
      }
    });

    it("drops library modules a dependency rescan no longer produces, and keeps project ones", async () => {
      const internal = indexer as unknown as {
        index: AngularElementIndex;
        reindexNodeModulesAfterDependencyChange(): Promise<void>;
      };

      internal.index.addModuleExports("UninstalledModule", {
        importPath: "@acme/uninstalled",
        exports: new Set(["UninstalledThing"]),
        external: true,
      });
      internal.index.addModuleExports("LocalModule", {
        importPath: "src/app/local.module.ts",
        absolutePath: path.join(testProjectPath, "src", "app", "local.module.ts"),
        exports: new Set(["LocalThing"]),
      });

      await internal.reindexNodeModulesAfterDependencyChange();

      assert.strictEqual(
        indexer.getExternalModuleExports("UninstalledModule"),
        undefined,
        "A library the rescan did not find again must be retracted"
      );
      assert.deepStrictEqual(
        [...(indexer.getExternalModuleExports("LocalModule") ?? [])],
        ["LocalThing"],
        "A project module is not part of what a dependency rescan replaces"
      );
    });

    it("drops the bundles of a library a dependency rescan no longer finds", async () => {
      const internal = indexer as unknown as {
        index: AngularElementIndex;
        reindexNodeModulesAfterDependencyChange(): Promise<void>;
      };

      internal.index.addLibraryPath("@acme/uninstalled");
      internal.index.addBundle("GoneBundle", {
        importPath: "@acme/uninstalled",
        members: [{ name: "GoneDirective" }],
      });
      internal.index.addBundle("LocalBundle", {
        importPath: "src/app/ui-kit.ts",
        members: [{ name: "LocalDirective" }],
      });

      await internal.reindexNodeModulesAfterDependencyChange();

      assert.strictEqual(
        indexer.bundlesHolding(["GoneDirective"]).size,
        0,
        "a library the rescan did not find again takes its bundles with it"
      );
      assert.deepStrictEqual(
        (indexer.bundlesHolding(["LocalDirective"]).get("LocalBundle") ?? []).map((entry) => entry.importPath),
        ["src/app/ui-kit.ts"],
        "a workspace bundle is retracted by its own file, not by a dependency rescan"
      );
    });

    it("drops the elements of a library a dependency rescan no longer finds", async () => {
      const internal = indexer as unknown as {
        index: AngularElementIndex;
        reindexNodeModulesAfterDependencyChange(): Promise<void>;
      };

      internal.index.selectors.insert(
        "acme-gone",
        new AngularElementData({
          path: "@acme/uninstalled",
          name: "GoneComponent",
          type: "component",
          originalSelector: "acme-gone",
          selectors: ["acme-gone"],
          isStandalone: true,
          isExternal: true,
        })
      );
      assert.strictEqual(indexer.getElements("acme-gone").length, 1);

      const projectElements = indexer.getElements("test-component").length;

      await internal.reindexNodeModulesAfterDependencyChange();

      assert.deepStrictEqual(
        indexer.getElements("acme-gone"),
        [],
        "An uninstalled library must stop offering elements"
      );
      assert.strictEqual(
        indexer.getElements("test-component").length,
        projectElements,
        "Project elements are not a dependency rescan's to drop"
      );
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

    it("keeps both directives when two of them declare the same selector", async () => {
      // `[tuiSlot]` is TuiAppBarDirective in one Taiga entry point and
      // TuiBlockStatusDirective in another, and Angular applies both: only components
      // are one-per-element. A cache keyed by selector kept whichever was written last,
      // so which fix the user was offered depended on the order the scan ran in.
      const sharedSelectorPath = path.join(testProjectPath, "src", "app", "shared-selector.directive.ts");
      fs.writeFileSync(
        sharedSelectorPath,
        `
import { Directive } from '@angular/core';

@Directive({ selector: '[sharedSlot]', standalone: true })
export class FirstSlotDirective {}

@Directive({ selector: '[sharedSlot]', standalone: true })
export class SecondSlotDirective {}
`
      );

      try {
        indexer.setProjectRoot(testProjectPath);
        await indexer.generateFullIndex();

        const indexed = indexer.getElements("[sharedSlot]").map((element) => element.name);
        assert.deepStrictEqual(indexed.sort(), ["FirstSlotDirective", "SecondSlotDirective"], "both are indexed");

        const restored = new AngularIndexer({ cacheStore, ...hostPorts() });
        restored.setProjectRoot(testProjectPath);
        assert.ok(await restored.loadFromWorkspace(), "cache is loadable");

        try {
          assert.deepStrictEqual(
            restored
              .getElements("[sharedSlot]")
              .map((element) => element.name)
              .sort(),
            ["FirstSlotDirective", "SecondSlotDirective"],
            "both survive the cache round trip"
          );
        } finally {
          restored.dispose();
        }
      } finally {
        fs.rmSync(sharedSelectorPath, { force: true });
      }
    });

    it("discards a cache that still holds a deleted bundle file", async () => {
      // A file whose only export is `export const Card = [A, B] as const` declares no
      // element, so it is not among the cached files: deleted while the extension was
      // not running, its name in an `imports: [...]` would go on answering "imported"
      // and the diagnostics it wrongly satisfies would stay hidden.
      const bundlePath = path.join(testProjectPath, "src", "app", "playground-bundle.ts");
      fs.writeFileSync(
        bundlePath,
        `
import { TestComponent } from './test.component';

export const PlaygroundBundle = [TestComponent] as const;
`
      );

      indexer.setProjectRoot(testProjectPath);
      await indexer.generateFullIndex();
      assert.ok(
        indexer.bundlesHolding(["TestComponent"]).has("PlaygroundBundle"),
        "the bundle is indexed while its file exists"
      );

      fs.rmSync(bundlePath, { force: true });

      const restored = new AngularIndexer({ cacheStore, ...hostPorts() });
      restored.setProjectRoot(testProjectPath);
      try {
        assert.strictEqual(await restored.loadFromWorkspace(), false, "the cache is discarded so the caller rescans");
      } finally {
        restored.dispose();
      }
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

  describe("Module resolution through tsconfig paths", () => {
    const aliasPath = path.join(testProjectPath, "src", "app", "aliased");

    afterEach(() => {
      if (fs.existsSync(aliasPath)) {
        fs.rmSync(aliasPath, { recursive: true, force: true });
      }
    });

    it("answers for the SharedModule an alias points at, not the other one", async () => {
      fs.mkdirSync(path.join(aliasPath, "a"), { recursive: true });
      fs.mkdirSync(path.join(aliasPath, "b"), { recursive: true });

      const only = (name: string, selector: string) => `
import { Component } from '@angular/core';

@Component({
  selector: '${selector}',
  template: '<div></div>',
  standalone: false
})
export class ${name} {}
`;
      const shared = (name: string, file: string) => `
import { NgModule } from '@angular/core';
import { ${name} } from './${file}';

@NgModule({
  declarations: [${name}],
  exports: [${name}]
})
export class SharedModule {}
`;
      fs.writeFileSync(path.join(aliasPath, "a", "a-only.component.ts"), only("AOnly", "app-a-only"));
      fs.writeFileSync(path.join(aliasPath, "a", "shared.module.ts"), shared("AOnly", "a-only.component"));
      fs.writeFileSync(path.join(aliasPath, "b", "b-only.component.ts"), only("BOnly", "app-b-only"));
      fs.writeFileSync(path.join(aliasPath, "b", "shared.module.ts"), shared("BOnly", "b-only.component"));

      // The host names one of them the way a workspace actually writes it: through an alias.
      fs.writeFileSync(
        path.join(aliasPath, "host.component.ts"),
        `
import { Component } from '@angular/core';
import { SharedModule } from '@app/a-shared';

@Component({
  selector: 'app-alias-host',
  standalone: true,
  imports: [SharedModule],
  template: '<div></div>'
})
export class AliasHostComponent {}
`
      );

      const tsconfigPath = path.join(aliasPath, "tsconfig.aliases.json");
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            baseUrl: "../../..",
            paths: {
              "@app/a-shared": ["src/app/aliased/a/shared.module.ts"],
              "@app/b-shared": ["src/app/aliased/b/shared.module.ts"],
            },
          },
        })
      );
      indexer.setProjectScope({ rootPath: testProjectPath, aliasRoots: [] }, tsconfigPath);
      await indexer.generateFullIndex();

      const componentImports = new ComponentImports({ resolveIndex: () => indexer });
      const host = indexer.project.addSourceFileAtPath(path.join(aliasPath, "host.component.ts"));
      const aOnly = indexer.getElements("app-a-only")[0];
      const bOnly = indexer.getElements("app-b-only")[0];

      assert.ok(aOnly && bOnly, "both elements should be indexed");
      assert.strictEqual(
        componentImports.isImported(host, aOnly),
        true,
        "the aliased import names the SharedModule that exports AOnly"
      );
      assert.strictEqual(
        componentImports.isImported(host, bOnly),
        false,
        "the other SharedModule is a different module, whatever it is called"
      );
    });
  });

  describe("Alias resolution and the cache", () => {
    const aliasCachePath = path.join(testProjectPath, "src", "app", "alias-cache");

    afterEach(() => {
      if (fs.existsSync(aliasCachePath)) {
        fs.rmSync(aliasCachePath, { recursive: true, force: true });
      }
    });

    it("follows an alias that was repointed while the extension was not running", async () => {
      fs.mkdirSync(path.join(aliasCachePath, "left"), { recursive: true });
      fs.mkdirSync(path.join(aliasCachePath, "right"), { recursive: true });

      const only = (name: string, selector: string) => `
import { Component } from '@angular/core';

@Component({
  selector: '${selector}',
  template: '<div></div>',
  standalone: false
})
export class ${name} {}
`;
      const shared = (name: string, file: string) => `
import { NgModule } from '@angular/core';
import { ${name} } from './${file}';

@NgModule({
  declarations: [${name}],
  exports: [${name}]
})
export class SharedModule {}
`;
      fs.writeFileSync(path.join(aliasCachePath, "left", "left-only.component.ts"), only("LeftOnly", "app-left-only"));
      fs.writeFileSync(
        path.join(aliasCachePath, "left", "shared.module.ts"),
        shared("LeftOnly", "left-only.component")
      );
      fs.writeFileSync(
        path.join(aliasCachePath, "right", "right-only.component.ts"),
        only("RightOnly", "app-right-only")
      );
      fs.writeFileSync(
        path.join(aliasCachePath, "right", "shared.module.ts"),
        shared("RightOnly", "right-only.component")
      );
      // A module that re-exports whatever the alias currently points at.
      fs.writeFileSync(
        path.join(aliasCachePath, "feature.module.ts"),
        `
import { NgModule } from '@angular/core';
import { SharedModule } from '@app/shared';

@NgModule({
  imports: [SharedModule],
  exports: [SharedModule]
})
export class FeatureModule {}
`
      );

      const tsconfigPath = path.join(aliasCachePath, "tsconfig.alias.json");
      const pointAliasAt = (target: string) =>
        fs.writeFileSync(
          tsconfigPath,
          JSON.stringify({
            compilerOptions: {
              baseUrl: "../../..",
              paths: { "@app/shared": [`src/app/alias-cache/${target}/shared.module.ts`] },
            },
          })
        );

      pointAliasAt("left");
      indexer.setProjectScope({ rootPath: testProjectPath, aliasRoots: [] }, tsconfigPath);
      await indexer.generateFullIndex();

      assert.ok(
        indexer.getExternalModuleExports("FeatureModule")?.has("LeftOnly"),
        "the alias pointed at the left module when the index was built"
      );

      // The alias is repointed with the extension down, so nothing observes the change:
      // the next session only reads the cache.
      pointAliasAt("right");

      const restarted = new AngularIndexer({ cacheStore, ...hostPorts() });
      try {
        restarted.setProjectScope({ rootPath: testProjectPath, aliasRoots: [] }, tsconfigPath);
        assert.ok(await restarted.loadFromWorkspace(), "the cache should still be usable");

        const featureExports = restarted.getExternalModuleExports("FeatureModule");
        assert.ok(featureExports, "FeatureModule should be in the cache");
        assert.ok(featureExports.has("RightOnly"), "expansion must follow the alias as it is now");
        assert.ok(!featureExports.has("LeftOnly"), "and not the module a saved resolution used to name");
      } finally {
        restarted.dispose();
      }
    });
  });

  describe("Inherited tsconfig paths", () => {
    const workspacePath = path.join(fixturesPath, "inherited-paths-workspace");

    afterEach(() => {
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    });

    it("resolves an alias a project inherits through extends, against the config that declared it", async () => {
      // The layout the aliases are written for: paths live in the workspace config, and
      // the project that inherits them sits two directories down.
      const appPath = path.join(workspacePath, "apps", "my-app");
      const libPath = path.join(workspacePath, "libs", "badge");
      fs.mkdirSync(path.join(appPath, "src"), { recursive: true });
      fs.mkdirSync(libPath, { recursive: true });

      fs.writeFileSync(
        path.join(workspacePath, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            paths: { "@workspace/badge": ["libs/badge/badge.module.ts"] },
          },
        })
      );
      fs.writeFileSync(
        path.join(appPath, "tsconfig.json"),
        JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { strict: true } })
      );

      fs.writeFileSync(
        path.join(libPath, "badge.component.ts"),
        `
import { Component } from '@angular/core';

@Component({
  selector: 'lib-inherited-badge',
  template: '<span></span>',
  standalone: false
})
export class InheritedBadgeComponent {}
`
      );
      fs.writeFileSync(
        path.join(libPath, "badge.module.ts"),
        `
import { NgModule } from '@angular/core';
import { InheritedBadgeComponent } from './badge.component';

@NgModule({
  declarations: [InheritedBadgeComponent],
  exports: [InheritedBadgeComponent]
})
export class BadgeModule {}
`
      );
      fs.writeFileSync(
        path.join(appPath, "src", "host.component.ts"),
        `
import { Component } from '@angular/core';
import { BadgeModule } from '@workspace/badge';

@Component({
  selector: 'app-inherited-host',
  standalone: true,
  imports: [BadgeModule],
  template: '<div></div>'
})
export class InheritedHostComponent {}
`
      );

      // The app is the project; the library is in scope because an alias reaches it.
      indexer.setProjectScope({ rootPath: appPath, aliasRoots: [libPath] }, path.join(appPath, "tsconfig.json"));
      await indexer.generateFullIndex();

      const componentImports = new ComponentImports({ resolveIndex: () => indexer });
      const host = indexer.project.addSourceFileAtPath(path.join(appPath, "src", "host.component.ts"));
      const badge = indexer.getElements("lib-inherited-badge")[0];
      assert.ok(badge, "the aliased library element should be indexed");

      const declaration = host.getImportDeclarations()[1];
      assert.strictEqual(
        declaration.getModuleSpecifierSourceFile()?.getFilePath(),
        path.join(libPath, "badge.module.ts").replace(/\\/g, "/"),
        "an inherited alias resolves against the config that declared it, not the one that inherited it"
      );
      assert.strictEqual(componentImports.isImported(host, badge), true);
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

    it("records what a library's bundle holds, so a template need not open the library again", async () => {
      const libPath = path.join(mockNodeModulesPath, "mock-bundle-lib");
      fs.mkdirSync(libPath, { recursive: true });
      fs.writeFileSync(
        path.join(libPath, "package.json"),
        JSON.stringify(
          {
            name: "mock-bundle-lib",
            version: "1.0.0",
            peerDependencies: { "@angular/core": "^17.0.0" },
            types: "./index.d.ts",
          },
          null,
          2
        )
      );
      fs.writeFileSync(
        path.join(libPath, "index.d.ts"),
        `import * as i0 from '@angular/core';

export declare class MockBundleInput {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockBundleInput, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockBundleInput, "[mockBundleInput]", never, {}, {}, never, never, true, never>;
}
export declare class MockBundleLabel {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockBundleLabel, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockBundleLabel, "[mockBundleLabel]", never, {}, {}, never, never, true, never>;
}
export declare const MockBundle: readonly [typeof MockBundleInput, typeof MockBundleLabel];
`
      );

      const projectManifestPath = path.join(testProjectPath, "package.json");
      const projectManifest = fs.readFileSync(projectManifestPath, "utf8");
      const withDependency = JSON.parse(projectManifest);
      withDependency.dependencies = { ...withDependency.dependencies, "mock-bundle-lib": "1.0.0" };
      fs.writeFileSync(projectManifestPath, JSON.stringify(withDependency, null, 2));

      try {
        await indexer.indexNodeModules();

        const holders = indexer.bundlesHolding(["MockBundleLabel"]);
        assert.deepStrictEqual(
          (holders.get("MockBundle") ?? []).map((entry) => entry.members.map((member) => member.name)),
          [["MockBundleInput", "MockBundleLabel"]],
          "the array a name in `imports: [...]` stands for is known from indexing"
        );
        assert.strictEqual(
          indexer.bundlesHolding(["MockBundleInput"]).has("MockBundleInput"),
          false,
          "a class is not a bundle"
        );
      } finally {
        fs.writeFileSync(projectManifestPath, projectManifest);
      }
    });

    it("records the entry point file of a library module, so an alias to it still resolves", async () => {
      const libPath = path.join(mockNodeModulesPath, "mock-ui-lib");
      fs.mkdirSync(libPath, { recursive: true });
      fs.writeFileSync(
        path.join(libPath, "package.json"),
        JSON.stringify(
          {
            name: "mock-ui-lib",
            version: "1.0.0",
            peerDependencies: { "@angular/core": "^17.0.0" },
            types: "./index.d.ts",
          },
          null,
          2
        )
      );
      fs.writeFileSync(
        path.join(libPath, "index.d.ts"),
        `import * as i0 from '@angular/core';

export declare class MockUiButton {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockUiButton, never>;
  static ɵdir: i0.ɵɵDirectiveDeclaration<MockUiButton, "[mockUiButton]", never, {}, {}, never, never, false, never>;
}
export declare class MockUiModule {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockUiModule, never>;
  static ɵmod: i0.ɵɵNgModuleDeclaration<MockUiModule, [typeof MockUiButton], never, [typeof MockUiButton]>;
  static ɵinj: i0.ɵɵInjectorDeclaration<MockUiModule>;
}
`
      );

      // Libraries are found through the project's dependencies, so declare it there.
      const projectManifestPath = path.join(testProjectPath, "package.json");
      const projectManifest = fs.readFileSync(projectManifestPath, "utf8");
      const withDependency = JSON.parse(projectManifest);
      withDependency.dependencies = { ...withDependency.dependencies, "mock-ui-lib": "1.0.0" };
      fs.writeFileSync(projectManifestPath, JSON.stringify(withDependency, null, 2));

      try {
        await indexer.indexNodeModules();

        const internal = indexer as unknown as { index: AngularElementIndex };
        const entries = internal.index.getModuleEntries("MockUiModule");
        assert.ok(entries, "The library module should be indexed");

        const entry = entries.get("mock-ui-lib");
        assert.ok(entry, "It should be keyed by the specifier it is imported from");
        assert.strictEqual(
          entry.absolutePath && path.resolve(entry.absolutePath),
          path.resolve(path.join(libPath, "index.d.ts")),
          "A component importing it through a tsconfig alias has only the resolved file to match on"
        );
      } finally {
        fs.writeFileSync(projectManifestPath, projectManifest);
      }
    });

    it("accepts a module imported from one of the several entry points that reach it", async () => {
      // The shape a design-system package actually has: the class lives in a deep entry
      // point, and the ones above it re-export it. Three import paths, one module.
      const libPath = path.join(mockNodeModulesPath, "mock-uikit");
      const svgPath = path.join(libPath, "components", "svg");
      fs.mkdirSync(svgPath, { recursive: true });
      fs.mkdirSync(path.join(libPath, "components"), { recursive: true });

      fs.writeFileSync(
        path.join(libPath, "package.json"),
        JSON.stringify({
          name: "mock-uikit",
          version: "1.0.0",
          peerDependencies: { "@angular/core": "^17.0.0" },
          exports: {
            ".": { types: "./index.d.ts" },
            "./components": { types: "./components/index.d.ts" },
            "./components/svg": { types: "./components/svg/index.d.ts" },
          },
        })
      );
      fs.writeFileSync(
        path.join(svgPath, "svg.component.d.ts"),
        `import * as i0 from '@angular/core';

export declare class MockSvgComponent {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockSvgComponent, never>;
  static ɵcmp: i0.ɵɵComponentDeclaration<MockSvgComponent, "mock-svg", never, {}, {}, never, never, false, never>;
}
`
      );
      fs.writeFileSync(
        path.join(svgPath, "svg.module.d.ts"),
        `import * as i0 from '@angular/core';
import * as i1 from './svg.component';

export declare class MockSvgModule {
  static ɵfac: i0.ɵɵFactoryDeclaration<MockSvgModule, never>;
  static ɵmod: i0.ɵɵNgModuleDeclaration<MockSvgModule, [typeof i1.MockSvgComponent], never, [typeof i1.MockSvgComponent]>;
  static ɵinj: i0.ɵɵInjectorDeclaration<MockSvgModule>;
}
`
      );
      fs.writeFileSync(
        path.join(svgPath, "index.d.ts"),
        `export * from './svg.component';
export * from './svg.module';
`
      );
      fs.writeFileSync(path.join(libPath, "components", "index.d.ts"), `export * from './svg';\n`);
      fs.writeFileSync(path.join(libPath, "index.d.ts"), `export * from './components';\n`);

      const projectManifestPath = path.join(testProjectPath, "package.json");
      const projectManifest = fs.readFileSync(projectManifestPath, "utf8");
      const withDependency = JSON.parse(projectManifest);
      withDependency.dependencies = { ...withDependency.dependencies, "mock-uikit": "1.0.0" };
      fs.writeFileSync(projectManifestPath, JSON.stringify(withDependency, null, 2));

      const hostPath = path.join(testProjectPath, "src", "app", "uikit-host.component.ts");
      // Imported from the deep entry point, which is not necessarily the one the index
      // picked as the best way to import the element.
      fs.writeFileSync(
        hostPath,
        `
import { Component } from '@angular/core';
import { MockSvgModule } from 'mock-uikit/components/svg';

@Component({
  selector: 'app-uikit-host',
  standalone: true,
  imports: [MockSvgModule],
  template: '<mock-svg></mock-svg>'
})
export class UikitHostComponent {}
`
      );

      try {
        await indexer.generateFullIndex();

        const entries = (indexer as unknown as { index: AngularElementIndex }).index.getModuleEntries("MockSvgModule");
        assert.ok(entries, "the module should be indexed");
        assert.ok(entries.size > 1, "and reachable from more than one entry point, as the package declares it");

        const svg = indexer.getElements("mock-svg")[0];
        assert.ok(svg, "the element should be indexed");

        const componentImports = new ComponentImports({ resolveIndex: () => indexer });
        const host = indexer.project.addSourceFileAtPath(hostPath);
        assert.strictEqual(
          componentImports.isImported(host, svg),
          true,
          "the module is imported: which of its entry points was used is not a different module"
        );
      } finally {
        fs.writeFileSync(projectManifestPath, projectManifest);
        fs.rmSync(hostPath, { force: true });
      }
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

    it("keeps one entry per declaring file when two project modules share a name", async () => {
      const featurePath = path.join(modulesPath, "feature");
      const legacyPath = path.join(modulesPath, "legacy");
      fs.mkdirSync(featurePath, { recursive: true });
      fs.mkdirSync(legacyPath, { recursive: true });

      const cardComponent = (className: string, selector: string) => `
import { Component } from '@angular/core';

@Component({
  selector: '${selector}',
  template: '<div></div>',
  standalone: false
})
export class ${className} {}
`;
      const sharedModule = (className: string, fileName: string) => `
import { NgModule } from '@angular/core';
import { ${className} } from './${fileName}';

@NgModule({
  declarations: [${className}],
  exports: [${className}]
})
export class SharedModule {}
`;

      fs.writeFileSync(
        path.join(featurePath, "feature-card.component.ts"),
        cardComponent("FeatureCard", "app-feature")
      );
      fs.writeFileSync(
        path.join(featurePath, "shared.module.ts"),
        sharedModule("FeatureCard", "feature-card.component")
      );
      fs.writeFileSync(path.join(legacyPath, "legacy-card.component.ts"), cardComponent("LegacyCard", "app-legacy"));
      fs.writeFileSync(path.join(legacyPath, "shared.module.ts"), sharedModule("LegacyCard", "legacy-card.component"));

      await indexer.generateFullIndex();

      const fromFeature = indexer.getExternalModuleExports("SharedModule", {
        resolveAbsolutePath: () => path.join(featurePath, "shared.module.ts"),
      });
      const fromLegacy = indexer.getExternalModuleExports("SharedModule", {
        resolveAbsolutePath: () => path.join(legacyPath, "shared.module.ts"),
      });
      const undecided = indexer.getExternalModuleExports("SharedModule");

      assert.ok(fromFeature, "the feature module should be indexed");
      assert.ok(fromLegacy, "the legacy module should be indexed");
      assert.ok(undecided, "the name should still resolve without an origin");

      assert.deepStrictEqual([...fromFeature], ["FeatureCard"]);
      assert.deepStrictEqual([...fromLegacy], ["LegacyCard"]);
      // With nothing to tell them apart the answer covers both, rather than one file
      // silently overwriting the other.
      assert.deepStrictEqual([...undecided].sort(), ["FeatureCard", "LegacyCard"]);
    });

    it("expands the re-exported SharedModule the feature module actually imported", async () => {
      const aPath = path.join(modulesPath, "a");
      const bPath = path.join(modulesPath, "b");
      fs.mkdirSync(aPath, { recursive: true });
      fs.mkdirSync(bPath, { recursive: true });

      const sharedModule = (only: string) => `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [${only}]
})
export class SharedModule {}
`;
      fs.writeFileSync(path.join(aPath, "shared.module.ts"), sharedModule("AOnly"));
      fs.writeFileSync(path.join(bPath, "shared.module.ts"), sharedModule("BOnly"));

      fs.writeFileSync(
        path.join(modulesPath, "feature.module.ts"),
        `
import { NgModule } from '@angular/core';
import { SharedModule } from './a/shared.module';

@NgModule({
  imports: [SharedModule],
  exports: [SharedModule]
})
export class FeatureModule {}
`
      );

      await indexer.generateFullIndex();

      const featureExports = indexer.getExternalModuleExports("FeatureModule");
      assert.ok(featureExports, "FeatureModule should be indexed");
      assert.deepStrictEqual(
        [...featureExports].sort(),
        ["AOnly", "SharedModule"],
        "only the SharedModule this file imports may be expanded into it"
      );
    });

    it("expands a re-exported module that was imported under another name", async () => {
      const aPath = path.join(modulesPath, "a");
      fs.mkdirSync(aPath, { recursive: true });

      fs.writeFileSync(
        path.join(aPath, "shared.module.ts"),
        `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [AOnly]
})
export class SharedModule {}
`
      );
      fs.writeFileSync(
        path.join(modulesPath, "feature.module.ts"),
        `
import { NgModule } from '@angular/core';
import { SharedModule as LocalShared } from './a/shared.module';

@NgModule({
  imports: [LocalShared],
  exports: [LocalShared]
})
export class FeatureModule {}
`
      );

      await indexer.generateFullIndex();

      const featureExports = indexer.getExternalModuleExports("FeatureModule");
      assert.ok(featureExports, "FeatureModule should be indexed");
      assert.deepStrictEqual(
        [...featureExports].sort(),
        ["AOnly", "SharedModule"],
        "the local name must not hide the module the index knows"
      );
    });

    it("re-points an element when its exporting module stops exporting it", async () => {
      const componentPath = path.join(modulesPath, "badge.component.ts");
      const wideModulePath = path.join(modulesPath, "wide.module.ts");
      const badgeModulePath = path.join(modulesPath, "badge.module.ts");

      fs.writeFileSync(
        componentPath,
        `
import { Component } from '@angular/core';

@Component({
  selector: 'app-badge',
  template: '<span></span>',
  standalone: false
})
export class BadgeComponent {}
`
      );
      fs.writeFileSync(
        badgeModulePath,
        `
import { NgModule } from '@angular/core';
import { BadgeComponent } from './badge.component';

@NgModule({
  declarations: [BadgeComponent],
  exports: [BadgeComponent]
})
export class BadgeModule {}
`
      );
      fs.writeFileSync(
        wideModulePath,
        `
import { NgModule } from '@angular/core';
import { BadgeComponent } from './badge.component';

@NgModule({
  declarations: [BadgeComponent],
  exports: [BadgeComponent, SomethingElse, AndAnother]
})
export class WideModule {}
`
      );

      await indexer.generateFullIndex();
      indexer.initializeWatcher();

      assert.strictEqual(
        indexer.getElements("app-badge")[0]?.exportingModuleName,
        "BadgeModule",
        "the module named after the element is the better suggestion"
      );

      const changed = new Promise<void>((resolve) => {
        const subscription = indexer.onDidChangeIndex(() => {
          subscription.dispose();
          resolve();
        });
      });
      fs.writeFileSync(
        badgeModulePath,
        `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [SomethingUnrelated]
})
export class BadgeModule {}
`
      );
      ports.report({ filePath: badgeModulePath, kind: "change" });
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 3000))]);

      assert.strictEqual(
        indexer.getElements("app-badge")[0]?.exportingModuleName,
        "WideModule",
        "the element must fall back to a module that still exports it, not keep the old one"
      );
    });

    it("stops suggesting a module that no longer exports the element", async () => {
      const modulePath = path.join(modulesPath, "offering.module.ts");
      const offering = (exported: string) => `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [${exported}]
})
export class OfferingModule {}
`;
      const internal = indexer as unknown as { index: AngularElementIndex };

      fs.writeFileSync(modulePath, offering("MovedThing"));
      await indexer.generateFullIndex();
      indexer.initializeWatcher();

      assert.strictEqual(internal.index.getComponentModule("MovedThing")?.moduleName, "OfferingModule");

      const changed = new Promise<void>((resolve) => {
        const subscription = indexer.onDidChangeIndex(() => {
          subscription.dispose();
          resolve();
        });
      });
      fs.writeFileSync(modulePath, offering("SomethingElse"));
      ports.report({ filePath: modulePath, kind: "change" });
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 2000))]);

      assert.strictEqual(
        internal.index.getComponentModule("MovedThing"),
        undefined,
        "the module stopped exporting it, so it is no longer a way to import it"
      );
      assert.strictEqual(internal.index.getComponentModule("SomethingElse")?.moduleName, "OfferingModule");
    });

    it("re-reads a file that declares both a component and the module exporting it", async function () {
      // A file that is its own dependent: re-reading its module would ask for the file to
      // be read again, which would re-read the module. Two seconds is plenty for one pass
      // and nowhere near enough for a loop.
      this.timeout(10000);

      // Not a `.module.ts`: a file named that way is only read by the module pass, while
      // this one is read as a component *and* declares the module — which is what makes
      // it its own dependent.
      const bothPath = path.join(modulesPath, "both.component.ts");
      const both = (selector: string) => `
import { Component, NgModule } from '@angular/core';

@Component({
  selector: '${selector}',
  template: '<div></div>',
  standalone: false
})
export class BothComponent {}

@NgModule({
  declarations: [BothComponent],
  exports: [BothComponent]
})
export class BothModule {}
`;

      fs.writeFileSync(bothPath, both("app-both"));
      await indexer.generateFullIndex();
      indexer.initializeWatcher();

      assert.strictEqual(indexer.getElements("app-both")[0]?.exportingModuleName, "BothModule");

      // Counted rather than asserted by absence: a loop is the failure this guards, and
      // reading the file twice per change is the near miss on the way to one.
      const internal = indexer as unknown as {
        updateFileIndex(filePath: string, options?: unknown): Promise<void>;
        saveIndexToWorkspace(): Promise<void>;
      };
      const reads: string[] = [];
      const originalUpdate = internal.updateFileIndex.bind(internal);
      internal.updateFileIndex = async (filePath: string, options?: unknown) => {
        reads.push(filePath);
        await originalUpdate(filePath, options);
      };
      let saves = 0;
      const originalSave = internal.saveIndexToWorkspace.bind(internal);
      internal.saveIndexToWorkspace = async () => {
        saves++;
        await originalSave();
      };

      const changed = new Promise<void>((resolve) => {
        const subscription = indexer.onDidChangeIndex(() => {
          subscription.dispose();
          resolve();
        });
      });
      fs.writeFileSync(bothPath, both("app-both-renamed"));
      ports.report({ filePath: bothPath, kind: "change" });
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 5000))]);

      assert.deepStrictEqual(
        reads.filter((read) => read === bothPath),
        [bothPath],
        "the file that declares both is read once, not once per role"
      );
      assert.strictEqual(saves, 1, "and the index is written once for the change");

      assert.deepStrictEqual(indexer.getElements("app-both"), [], "the old selector is gone");
      assert.strictEqual(
        indexer.getElements("app-both-renamed")[0]?.exportingModuleName,
        "BothModule",
        "and the file was read again exactly once"
      );
    });

    it("indexes a workspace file whose only Angular content is a bundle", async () => {
      const bundlePath = path.join(modulesPath, "ui-kit.ts");
      const componentPath = path.join(modulesPath, "kit-badge.component.ts");

      fs.writeFileSync(
        componentPath,
        `
import { Directive } from '@angular/core';

@Directive({
  selector: '[kitBadge]',
  standalone: true
})
export class KitBadgeDirective {}
`
      );
      // No decorator anywhere in this file: the scan has to keep it anyway, because
      // `imports: [UiKit]` is how a component gets the directive above.
      fs.writeFileSync(
        bundlePath,
        `
import { KitBadgeDirective } from './kit-badge.component';

export const UiKit = [KitBadgeDirective] as const;
`
      );

      await indexer.generateFullIndex();

      assert.deepStrictEqual(
        (indexer.bundlesHolding(["KitBadgeDirective"]).get("UiKit") ?? []).map((entry) => entry.importPath),
        ["src/app/modules/ui-kit.ts"],
        "a bundle in a file of its own is what a full scan has to find"
      );

      indexer.initializeWatcher();
      const changed = new Promise<void>((resolve) => {
        const subscription = indexer.onDidChangeIndex(() => {
          subscription.dispose();
          resolve();
        });
      });
      fs.unlinkSync(bundlePath);
      ports.report({ filePath: bundlePath, kind: "delete" });
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 3000))]);

      assert.strictEqual(
        indexer.bundlesHolding(["KitBadgeDirective"]).size,
        0,
        "and a deleted file stops answering for what it held"
      );
    });

    it("keeps both modules a file re-exports under one name", async () => {
      const leftPath = path.join(modulesPath, "left");
      const rightPath = path.join(modulesPath, "right");
      fs.mkdirSync(leftPath, { recursive: true });
      fs.mkdirSync(rightPath, { recursive: true });

      const only = (name: string, selector: string) => `
import { Component } from '@angular/core';

@Component({
  selector: '${selector}',
  template: '<div></div>',
  standalone: false
})
export class ${name} {}
`;
      const shared = (name: string, file: string) => `
import { NgModule } from '@angular/core';
import { ${name} } from './${file}';

@NgModule({
  declarations: [${name}],
  exports: [${name}]
})
export class SharedModule {}
`;
      fs.writeFileSync(path.join(leftPath, "left-only.component.ts"), only("LeftOnly", "app-left-only"));
      fs.writeFileSync(path.join(leftPath, "shared.module.ts"), shared("LeftOnly", "left-only.component"));
      fs.writeFileSync(path.join(rightPath, "right-only.component.ts"), only("RightOnly", "app-right-only"));
      fs.writeFileSync(path.join(rightPath, "shared.module.ts"), shared("RightOnly", "right-only.component"));

      // Both are called SharedModule; this file imports each under its own local name and
      // re-exports both.
      fs.writeFileSync(
        path.join(modulesPath, "feature.module.ts"),
        `
import { NgModule } from '@angular/core';
import { SharedModule as LeftShared } from './left/shared.module';
import { SharedModule as RightShared } from './right/shared.module';

@NgModule({
  imports: [LeftShared, RightShared],
  exports: [LeftShared, RightShared]
})
export class FeatureModule {}
`
      );

      await indexer.generateFullIndex();

      const featureExports = indexer.getExternalModuleExports("FeatureModule");
      assert.ok(featureExports, "FeatureModule should be indexed");
      assert.deepStrictEqual(
        [...featureExports].sort(),
        ["LeftOnly", "RightOnly", "SharedModule"],
        "a name collision must not drop one of two re-exported modules"
      );
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

    it("rejects a cache whose NgModule file is gone, even when it declared nothing else", async () => {
      const modulePath = path.join(modulesPath, "vanishing.module.ts");
      fs.writeFileSync(
        modulePath,
        `
import { NgModule } from '@angular/core';

@NgModule({
  exports: [VanishingThing]
})
export class VanishingModule {}
`
      );

      await indexer.generateFullIndex();
      assert.ok(indexer.getExternalModuleExports("VanishingModule"), "the module should be cached");

      // Deleted with the extension down: nothing observed it, so only the cache remembers.
      fs.unlinkSync(modulePath);

      const restarted = new AngularIndexer({ cacheStore, ...hostPorts() });
      try {
        restarted.setProjectRoot(testProjectPath);
        assert.strictEqual(
          await restarted.loadFromWorkspace(),
          false,
          "a cache that would suggest importing a file that is gone must force a rescan"
        );
      } finally {
        restarted.dispose();
      }
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
