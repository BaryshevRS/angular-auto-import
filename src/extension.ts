/**
 *
 * VSCode Extension: Angular Auto-Import
 *
 * A modularly designed extension for automatically importing Angular elements.
 *
 * This module serves as the main entry point for the VS Code extension, handling:
 * - Extension activation and deactivation lifecycle
 * - Project discovery and initialization
 * - Configuration management
 * - Provider and command registration
 * - Multi-project workspace support
 *
 * @module Main extension entry point for Angular Auto-Import
 * @author Angular Auto-Import Team
 * @since 1.0.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type CommandContext, registerCommands } from "./commands";
import { type ExtensionConfig, getConfiguration, onConfigurationChanged } from "./config";
import { logger } from "./logger";
import { type ProviderContext, registerProviders } from "./providers";
import { AngularIndexer } from "./services";
import * as TsConfigHelper from "./services/tsconfig";
import type { ProcessedTsConfig, ProjectContext } from "./types";
import { getProjectContextForDocumentWithLogging } from "./utils/project-context";
import { clearAllTemplateCache, clearTemplateCache } from "./utils/template-detection";

/**
 * Sets up periodic reindexing for a project
 */
function setupPeriodicReindexing(
  projectRootPath: string,
  indexer: AngularIndexer,
  intervalMinutes: number,
  context: vscode.ExtensionContext
): void {
  const intervalId = setInterval(
    async () => {
      try {
        logger.info(`🔄 Periodic reindexing for ${path.basename(projectRootPath)}...`);
        await generateIndexForProject(projectRootPath, indexer, context);
      } catch (error) {
        logger.error("❌ Error during periodic reindexing:", error as Error);
      }
    },
    intervalMinutes * 1000 * 60
  );

  projectIntervals.set(projectRootPath, intervalId);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(intervalId);
      projectIntervals.delete(projectRootPath);
    },
  });
}

/**
 * Map of project root paths to their corresponding Angular indexer instances.
 * Each indexer handles the parsing and caching of Angular elements for a specific project.
 */
const projectIndexers = new Map<string, AngularIndexer>();

/**
 * Map of project root paths to their processed TypeScript configuration.
 * Stores parsed tsconfig.json data including path mappings and compiler options.
 */
const projectTsConfigs = new Map<string, ProcessedTsConfig | null>();

/**
 * Map of project root paths to their periodic reindexing interval timers.
 * Used to manage automatic background reindexing for each project.
 */
const projectIntervals = new Map<string, NodeJS.Timeout>();

/**
 * Current extension configuration loaded from VS Code settings.
 * Contains user preferences for project paths, refresh intervals, etc.
 */
let extensionConfig: ExtensionConfig;

/**
 * Activates the Angular Auto-Import extension.
 *
 * This is the main entry point called by VS Code when the extension is activated.
 * Handles the complete initialization process including:
 * - Configuration loading
 * - Project discovery and setup
 * - Provider and command registration
 * - File system watcher setup
 *
 * @param context - The VS Code extension context providing access to extension APIs
 * @throws {Error} When extension activation fails due to configuration or initialization issues
 *
 * @example
 * ```typescript
 * // Called automatically by VS Code when extension activates
 * await activate(context);
 * ```
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.initialize(context);
  try {
    logger.info("🚀 Angular Auto-Import: Starting activation...");

    // Initialize configuration
    extensionConfig = getConfiguration();

    // Determine project roots
    const projectRoots = await determineProjectRoots();
    if (projectRoots.length === 0) {
      return;
    }

    // Initialize projects
    await initializeProjects(projectRoots, context);

    // Project roots can exist without any of them being Angular projects. In
    // that case do not register providers: DiagnosticProvider eagerly loads
    // @angular/compiler and subscribes to document/diagnostic events.
    if (projectIndexers.size === 0) {
      logger.info("Angular Auto-Import: No Angular projects found. Extension will remain inactive.");
      return;
    }

    // Register providers and commands
    await registerProvidersAndCommands(context);

    // Setup configuration change handler
    const configHandler = onConfigurationChanged(async (newConfig) => {
      extensionConfig = newConfig;
      await handleConfigurationChange(newConfig, context);
    });
    context.subscriptions.push(configHandler);

    // Setup document close handler to clear template cache
    const documentCloseHandler = vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "typescript") {
        clearTemplateCache(document.uri.toString());
      }
    });
    context.subscriptions.push(documentCloseHandler);

    logger.info("✅ Angular Auto-Import: Extension activated successfully");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.fatal("❌ Error activating Angular Auto-Import extension:", err);
    vscode.window.showErrorMessage(`❌ Failed to activate Angular-Auto-Import: ${err.message}`);
  }
}

/**
 * Checks if a directory is an Angular project by looking for `@angular/core` in `package.json`.
 * @param projectRoot - The absolute path to the project root.
 * @returns A promise that resolves to `true` if it's an Angular project, `false` otherwise.
 */
async function isAngularProject(projectRoot: string): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  try {
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }
    const packageJsonContent = await fs.promises.readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    return !!dependencies["@angular/core"] || !!devDependencies["@angular/core"];
  } catch (error) {
    logger.error(`Error checking for Angular project in ${projectRoot}:`, error as Error);
    return false;
  }
}

/**
 * Deactivates the Angular Auto-Import extension and cleans up all resources.
 *
 * This function is called when the extension is being disabled or VS Code is shutting down.
 * It ensures proper cleanup of:
 * - Active reindexing intervals
 * - Angular indexer instances
 * - TypeScript configuration caches
 * - Template detection caches
 *
 * @example
 * ```typescript
 * // Called automatically by VS Code when extension deactivates
 * deactivate();
 * ```
 */
export function deactivate(): void {
  // Clear intervals
  projectIntervals.forEach((intervalId) => {
    clearInterval(intervalId);
  });
  projectIntervals.clear();

  // Dispose indexers
  projectIndexers.forEach((indexer) => {
    indexer.dispose();
  });
  projectIndexers.clear();

  // Clear caches
  projectTsConfigs.clear();
  TsConfigHelper.clearCache();
  clearAllTemplateCache(); // Clear template detection cache

  logger.info("Angular Auto-Import extension deactivated and resources cleaned up.");
  logger.dispose();
}

/**
 * Determines the project root directories for Angular Auto-Import to operate on.
 *
 * The function follows this priority order:
 * 1. Uses configured projectPath setting if provided and valid (overrides workspace folders)
 * 2. Falls back to workspace folders if no projectPath configured
 * 3. Returns empty array if neither is available or valid
 *
 * @param config - Extension configuration (optional, uses current config if not provided)
 * @returns Promise resolving to array of absolute project root paths
 * @throws {Error} When configured project path is invalid or inaccessible
 *
 * @example
 * ```typescript
 * const roots = await determineProjectRoots();
 * logger.info('Found project roots:', roots);
 * // Output: ['C:\\workspace\\my-angular-app\\src'] (if projectPath configured to src/)
 * ```
 *
 * @internal - Exported for testing purposes only
 */
export async function determineProjectRoots(config?: ExtensionConfig): Promise<string[]> {
  let effectiveProjectRoots: string[] = [];
  const activeConfig = config || extensionConfig;

  // Priority 1: Use projectPath if configured
  if (activeConfig.projectPath && activeConfig.projectPath.trim() !== "") {
    const resolvedPath = path.resolve(activeConfig.projectPath);

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      effectiveProjectRoots.push(resolvedPath);
      logger.info(`Angular Auto-Import: Using configured project path: ${resolvedPath}`);

      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        logger.info("Angular Auto-Import: 'projectPath' setting overrides workspace folders.");
      }
    } else {
      logger.error(
        `Angular Auto-Import: Configured project path does not exist or is not a directory: ${resolvedPath}`
      );
    }
  }
  // Priority 2: Fall back to workspace folders if projectPath not configured
  else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    effectiveProjectRoots = vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath);
    logger.info("Angular Auto-Import: Using workspace folders as project roots.");
  }

  return effectiveProjectRoots;
}

/**
 * Initializes Angular Auto-Import for all discovered project roots.
 *
 * For each project root, this function:
 * - Loads and parses the TypeScript configuration
 * - Creates and configures an Angular indexer instance
 * - Performs initial indexing of Angular elements
 * - Sets up periodic reindexing if configured
 * - Registers cleanup handlers with the extension context
 *
 * @param projectRoots - Array of absolute paths to project root directories
 * @param context - VS Code extension context for resource management
 *
 * @example
 * ```typescript
 * const roots = ['/path/to/project1', '/path/to/project2'];
 * await initializeProjects(roots, context);
 * ```
 */
async function initializeProjects(projectRoots: string[], context: vscode.ExtensionContext): Promise<void> {
  for (const projectRootPath of projectRoots) {
    if (!(await isAngularProject(projectRootPath))) {
      logger.info(`Skipping non-Angular project: ${projectRootPath}`);
      continue;
    }

    logger.info(`📁 Initializing project: ${projectRootPath}`);

    try {
      // Initialize TsConfig
      TsConfigHelper.clearCache(projectRootPath);
      const tsConfig = await TsConfigHelper.findAndParseTsConfig(projectRootPath);
      projectTsConfigs.set(projectRootPath, tsConfig);

      if (tsConfig) {
        logger.info(`🔧 Tsconfig loaded for ${path.basename(projectRootPath)}.`);
      } else {
        logger.warn(`⚠️ Tsconfig not found for ${path.basename(projectRootPath)}.`);
      }

      // Initialize indexer
      const indexer = new AngularIndexer();
      projectIndexers.set(projectRootPath, indexer);

      await generateInitialIndexForProject(projectRootPath, indexer, context);

      // Setup periodic reindexing
      if (extensionConfig.indexRefreshInterval > 0) {
        setupPeriodicReindexing(projectRootPath, indexer, extensionConfig.indexRefreshInterval, context);
      }
    } catch (error) {
      logger.error(`Error initializing project ${projectRootPath}:`, error as Error);
    }
  }
}

/**
 * Handles runtime configuration changes for the extension.
 *
 * Responds to changes in VS Code settings by:
 * - Updating periodic reindexing intervals
 * - Handling project path changes
 * - Preserving existing indexer state when possible
 *
 * @param newConfig - The updated extension configuration
 * @param context - VS Code extension context for resource management
 *
 * @example
 * ```typescript
 * // Called automatically when user changes settings
 * await handleConfigurationChange(updatedConfig, context);
 * ```
 */
async function handleConfigurationChange(newConfig: ExtensionConfig, context: vscode.ExtensionContext): Promise<void> {
  logger.info("Configuration changed, updating...");

  // Handle refresh interval changes
  if (newConfig.indexRefreshInterval !== extensionConfig.indexRefreshInterval) {
    // Clear existing intervals
    projectIntervals.forEach((intervalId, projectPath) => {
      clearInterval(intervalId);
      projectIntervals.delete(projectPath);
    });

    // Setup new intervals if needed
    if (newConfig.indexRefreshInterval > 0) {
      for (const [projectRootPath, indexer] of projectIndexers) {
        setupPeriodicReindexing(projectRootPath, indexer, newConfig.indexRefreshInterval, context);
      }
    }
  }

  // Handle project path changes
  if (newConfig.projectPath !== extensionConfig.projectPath) {
    logger.info("Project path changed, reinitializing...");
    // This would require a full reinitialization
    // For now, just log the change
  }
}

/**
 * Generates the initial Angular element index for a specific project.
 *
 * This function handles the first-time indexing of a project by:
 * - Setting the project root path in the indexer
 * - Attempting to load from workspace cache
 * - Performing full scan if cache is unavailable or invalid
 * - Initializing file system watchers for incremental updates
 * - Logging index statistics and warnings
 *
 * @param projectRootPath - Absolute path to the project root directory
 * @param indexer - The Angular indexer instance for this project
 * @param context - VS Code extension context for persistence operations
 *
 * @example
 * ```typescript
 * const indexer = new AngularIndexer();
 * await generateInitialIndexForProject('/path/to/project', indexer, context);
 * ```
 */
async function generateInitialIndexForProject(
  projectRootPath: string,
  indexer: AngularIndexer,
  context: vscode.ExtensionContext
): Promise<void> {
  logger.info(`GENERATE_INITIAL_INDEX: For project ${projectRootPath}`);
  indexer.setProjectRoot(projectRootPath);

  // Load from workspace cache first, if available and valid
  const loadedFromCache = await indexer.loadFromWorkspace(context);

  if (loadedFromCache) {
    logger.info(`Initial index loaded from cache for ${projectRootPath}.`);
    // The watcher will pick up any changes from here.
  } else {
    logger.info(`No cache found or cache invalid for ${projectRootPath}. Performing full initial index scan...`);
    await indexer.generateFullIndex(context);
  }

  indexer.initializeWatcher(context);

  const indexSize = Array.from(indexer.getAllSelectors()).length;
  logger.info(`📊 Initial index size for ${projectRootPath}: ${indexSize} elements`);

  if (indexSize === 0) {
    logger.warn(`⚠️ Index is still empty for ${projectRootPath} after initial scan!`);
  }
}

/**
 * Regenerates the complete Angular element index for a project.
 *
 * This function performs a full reindexing operation, typically called:
 * - During periodic refresh intervals
 * - When significant project structure changes are detected
 * - As a fallback when incremental updates fail
 *
 * The function ensures cache keys are properly set and reinitializes
 * file watchers if they become inactive.
 *
 * @param projectRootPath - Absolute path to the project root directory
 * @param indexer - The Angular indexer instance for this project
 * @param context - VS Code extension context for persistence operations
 *
 * @example
 * ```typescript
 * // Called periodically or on demand
 * await generateIndexForProject('/path/to/project', existingIndexer, context);
 * ```
 */
async function generateIndexForProject(
  projectRootPath: string,
  indexer: AngularIndexer,
  context: vscode.ExtensionContext
): Promise<void> {
  logger.info(`GENERATE_INDEX: For project ${projectRootPath}`);
  indexer.ensureCacheKeys(projectRootPath);
  await indexer.generateFullIndex(context);

  if (!indexer.fileWatcher) {
    logger.info(`Watcher for ${projectRootPath} was not active, initializing.`);
    indexer.initializeWatcher(context);
  }
}

/**
 * Retrieves the project context for a given VS Code document.
 *
 * This function determines which project a document belongs to and returns
 * the associated indexer and TypeScript configuration. The lookup follows:
 * 1. Direct workspace folder membership
 * 2. Fallback to path-based matching against known project roots
 *
 * @param document - The VS Code text document to find context for
 * @returns Project context containing indexer and tsconfig, or undefined if not found
 *
 * @example
 * ```typescript
 * const context = getProjectContextForDocument(document);
 * if (context) {
 *   const { projectRootPath, indexer, tsConfig } = context;
 *   // Use indexer to find Angular elements
 * }
 * ```
 */
export function getProjectContextForDocument(document: vscode.TextDocument): ProjectContext | undefined {
  return getProjectContextForDocumentWithLogging(document, projectIndexers, projectTsConfigs);
}

/**
 * Registers all VS Code providers and commands for the extension.
 *
 * This function sets up:
 * - Language service providers (completion, diagnostics, quickfix)
 * - Extension commands (reindex, manual import)
 * - Provider and command contexts with shared state
 *
 * The registration order ensures providers are available before commands
 * that might depend on them.
 *
 * @param context - VS Code extension context for provider/command registration
 *
 * @example
 * ```typescript
 * // Called during extension activation
 * await registerProvidersAndCommands(context);
 * ```
 */
async function registerProvidersAndCommands(context: vscode.ExtensionContext): Promise<void> {
  // Create provider context
  const providerContext: ProviderContext = {
    projectIndexers,
    projectTsConfigs,
    extensionConfig,
    extensionContext: context,
  };

  // Register providers first
  const diagnosticProvider = registerProviders(context, providerContext);

  // Refresh diagnostics when a project's external library index is rebuilt after
  // a dependency manifest change, so stale "missing import" warnings clear on
  // their own (e.g. right after installing a library like @ngx-translate/core).
  if (diagnosticProvider) {
    for (const indexer of projectIndexers.values()) {
      context.subscriptions.push(
        indexer.onDidIndexNodeModules(() => {
          void diagnosticProvider.refreshOpenDocuments();
        })
      );
    }
  }

  // Create command context
  const commandContext: CommandContext = {
    projectIndexers,
    projectTsConfigs,
    extensionConfig,
    diagnosticProvider,
  };

  // Register commands
  registerCommands(context, commandContext);
}
