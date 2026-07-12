# Change Log

All notable changes to the "angular-auto-import" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.7.0] - 2026-07-12

### Fixed
- **Inactive workspace overhead**: project indexers and language providers are now initialized lazily, only after an open document identifies an Angular package, preventing unnecessary discovery and indexing in unrelated workspaces
- **Large-workspace file pressure**: candidate source-file reads are now concurrency-limited, avoiding unbounded parallel filesystem work during indexing
- **Nested project resolution**: documents now resolve to the deepest containing project root, so nested projects and sibling paths with common prefixes use the correct index
- **Generated-file watcher noise**: flattened exclude patterns and watcher guards keep dependency, build, and generated files from triggering redundant ts-morph updates and index saves

### Improved
- **External dependency indexing**: libraries are indexed through package entry points instead of a redundant per-file `node_modules` scan
- **Angular project discovery**: package manifest checks are cached and invalidated when `package.json` changes, reducing repeated filesystem reads while still detecting newly installed Angular dependencies
- **Extension activation**: activation events now target Angular/Nx workspaces and HTML/TypeScript documents instead of running after every VS Code startup

## [2.6.0] - 2026-06-26

### Fixed
- **Module-backed pipe diagnostics**: standalone components that import an NgModule exporting a pipe, such as `TranslateModule`, no longer get false missing-pipe diagnostics when another indexed pipe uses the same selector
- **Pipe selector fallback safety**: module-name fallback is now limited to unindexed external module exports from the same package, avoiding suppression for unrelated `*Module` imports

### Added
- **Angular 22 regression coverage**: added an e2e reproduction for `translate` pipe selector collisions

## [2.5.0] - 2026-06-20

### Fixed
- **False "not imported" warnings on WSL/Windows**: NgModule exports are now resolved by their syntactic name when the TypeScript TypeChecker cannot resolve the symbol (which happens on WSL/Windows mounts with symlinked or case-mismatched `node_modules`). Pipes and directives provided via an imported NgModule — e.g. `TranslatePipe`/`TranslateDirective` from `@ngx-translate/core`'s `TranslateModule` — are no longer reported as missing imports while their declaration is already indexed

### Improved
- **Diagnosability of external module indexing**: added debug logs that surface why a module's exports may be dropped from the index — TypeChecker resolution failure with syntactic fallback, export names that cannot be resolved, and resolved names missing from the collected library classes

### Added
- **Angular 21 & 22 coverage**: end-to-end test projects and per-version case descriptors for Angular 21 and 22, validated through a per-app parallel suite runner

## [2.4.0] - 2026-06-18

### Fixed
- **Path alias imports**: quick fixes now avoid importing an Angular library from its own barrel and use relative imports inside the same alias root
- **Barrel alias safety**: directory aliases now fall back to relative imports when the barrel `index.ts` does not re-export the target module
- **Stale index cache entries**: cached project files that were moved or deleted while the extension was not running are detected and trigger a full reindex instead of producing broken import paths
- **Cross-platform relative paths**: relative import generation now uses the shared path helper for consistent Windows path separator handling

### Improved
- **External library indexing memory usage**: library AST source files are released after indexing to keep ts-morph memory growth bounded in large workspaces
 
## [2.3.0] - 2026-06-17

### Fixed
- **Stale indexes after dependency updates**: the extension now watches `package.json` and lockfiles, then automatically re-indexes `node_modules` when dependencies change
- **Outdated missing-import diagnostics**: open documents refresh after the reindex completes, so stale warnings clear without a manual reindex

## [2.2.0] - 2026-03-11

### Fixed
- **Control flow detection in production builds**: Replaced `constructor.name` checks with duck typing for Angular template AST nodes, fixing broken `@if`/`@for`/`@switch` diagnostics in minified builds
- **Diagnostics on startup**: Re-run diagnostics on all open documents after `@angular/compiler` finishes loading

### Changed
- **Show Logs command**: Simplified to directly open the Output Channel instead of showing a modal dialog

## [2.1.1] - 2026-03-05

### Fixed
- **Diagnostics randomly disappearing**: Fixing a file no longer clears error highlights across all open files
- **Editor freezes on save**: Eliminated an infinite loop that could freeze the editor when saving files with diagnostics
- **Improved stability**: Async error handling prevents the extension from silently crashing on edge cases
 
## [2.1.0] - 2025-12-01

### Fixed
- **Diagnostics Update**: Fixed race condition where diagnostics for HTML files were not always updated when related TypeScript component files changed. Added proper `await` to ensure diagnostics update completes before continuing.
 
## [2.0.0] - 2025-10-28

### Added
- **Go to Definition**: Added support for definition lookups for HTML and TypeScript files, allowing navigation to component/directive definitions even if they are not yet imported.
- **Enhanced Documentation**: Updated `README.md` and added documentation for the new "Go to Definition" feature.

## [1.17.0] - 2025-10-27

### Added
- **Granular Completion Control**: Separate settings for each Angular element type:
  - `angular-auto-import.completion.pipes.enabled` - Toggle pipe completions
  - `angular-auto-import.completion.components.enabled` - Toggle component completions
  - `angular-auto-import.completion.directives.enabled` - Toggle directive completions
- **Multi-line Tag Support**: Completion now works across multi-line tags (searches up to 50 lines backwards)
- **Smart Bracket Detection**: Ignores `>` inside string literals (e.g., `*ngIf="value > 5"`) to correctly detect tag boundaries

### Improved
- **Completion Accuracy**: Element type filtering now happens before result limiting for more relevant suggestions
- **Selector Classification**: Enhanced logic to distinguish element selectors from attribute selectors
- **Context Detection**: Better handling of complex selectors like `button[mat-button]` and `:not()` pseudo-classes

### Changed
- **Breaking**: `angular-auto-import.completion.enabled` replaced with three type-specific settings
- **Provider Registration**: Completion provider always registers, filtering moved to internal logic

## [1.16.0] - 2025-10-26

### Improved
- **Template Parsing**: Enhanced template parser to handle syntactically incorrect HTML, improving error resilience.
- **Template Detection**: Implemented AST-based detection for inline templates, significantly improving accuracy.

### Changed
- **Activation Notification**: Removed the extension activation message for a quieter user experience.

## [1.15.0] - 2025-10-18

### Added
- **Enhanced Diagnostics Mode**: Introduced a new `quickfix-only` mode that enables quick fixes for missing imports without displaying diagnostic underlines, giving users more control over editor feedback.
- **Debugging Tools**: Added a "Generate Diagnostics Report" command for advanced troubleshooting.

### Changed
- **Settings Refactor**: The `diagnostics.enabled` setting has been replaced with `diagnostics.mode`, which now supports three options: `full` (diagnostics with quick fixes), `quickfix-only`, and `disabled`.
- **Command Naming**: Renamed "Show Performance Metrics" to "Show Performance Metrics (Debug)" to better reflect its purpose.

### Fixed 
- **Error Resilience**: Improved the stability of the quick fix provider by adding graceful error handling for indexer failures.

## [1.14.0] - 2025-10-14

### Changed
- **Forms Directives Refactoring**: Extracted forms directives configuration to separate module for better maintainability
- **Library Exclusion Logic**: Implemented centralized exclusion logic for Angular core packages, compiler tools, and infrastructure libraries

## [1.13.0] - 2025-10-06

### Added
- **Completion Control**: `angular-auto-import.completion.enabled` setting to toggle auto-completion (default: true)

### Improved
- **Transitive Module Exports**: Modules now include all transitive dependencies from re-exported module
 
## [1.12.3] - 2025-10-05

### Changed
- Updated dependencies (@angular/compiler 20.3.2)

## [1.12.2]  - 2025-09-21

### Improved
- **Module Resolution**: Enhanced AngularIndexer with intelligent module mapping that includes export count tracking for better component-to-module association


## [1.12.1] - 2025-09-18

### Improved
- **Code Quality**: Reduced cognitive complexity in DiagnosticProvider by refactoring large methods into smaller, focused functions
- **Performance**: Enhanced Angular indexing with improved SelectorTrie removal logic and better element matching

## [1.12.0] - 2025-09-15

### Added
- **Fix All Command**: New command "Angular Auto Import: Fix all missing imports in current file" automatically imports all components, directives, and pipes that are used in the current file but not yet imported
- **Improved Angular Import Path Handling**: Optimized Angular import path handling in indexer for better performance 

## [1.11.2] - 2025-09-12

### Fixed
- **Critical indexing stability**: Fixed "forgotten node" errors that occurred during periodic project reindexing ([#15]) 

[#15]: https://github.com/<repo-owner>/<repo-name>/issues/15 

## [1.11.1] - 2025-09-12

### Fixed
- **Project path override behavior**: `projectPath` setting now correctly overrides workspace folders when specified ([#16])
- Previously, `projectPath` was ignored when workspace folders were open, making it impossible to force a specific project root (e.g., `src/` subdirectory) 

[#16]: https://github.com/<repo-owner>/<repo-name>/issues/16 

## [1.11.0] - 2025-09-12

### Added  
- Debounce mechanism for document updates to reduce unnecessary processing 
- Template caching for improved diagnostic performance

### Improved 
- Enhanced external module exports handling 

## [1.10.1] - 2025-08-31

### Added
- New command "Show Logs" to view extension logs in output channel or log files
- New command "Show Performance Metrics" with detailed memory usage and indexing statistics 

## [1.10.0] - 2025-08-31

### Removed
- Removed highlighting of diagnostics and autocomplete for non-standalone components. Extension now only provides diagnostics and autocomplete for standalone Angular components, directives, and pipes.
 
## [1.9.0] - 2025-08-30

### Added
- Comprehensive logging system with configurable levels (DEBUG, INFO, WARN, ERROR, FATAL) 
- Enhanced tsconfig parsing with robust error handling using `get-tsconfig` library

### Configuration
- `angular-auto-import.logging.enabled` - Enable/disable logging (default: true)
- `angular-auto-import.logging.level` - Set logging level (default: INFO)
- `angular-auto-import.logging.fileLoggingEnabled` - Enable file logging (default: false)
- `angular-auto-import.logging.outputFormat` - Log format: plain or json (default: plain)

## [1.8.0] - 2025-08-18

### Changed

- Removed file naming convention restrictions - all TypeScript files are now indexed regardless of suffix

## [1.7.0] - 2025-08-13
 
### Improved
- Completion suggestions now show shared selectors with element names for better disambiguation
- More intelligent attribute and structural directive context detection
- Better filter text handling for improved search accuracy 

## [1.6.2] - 2025-08-03

### Improved
- Semantic resolution of module exports for external libraries using TypeScript's `TypeChecker` for more accurate class name detection, especially when dealing with type aliases.

## [1.6.1] - 2025-08-02

### Fixed
- Fixed pipe expressions in Angular templates

## [1.6.0] - 2025-08-01

### Added
- Support for Angular control flow blocks in diagnostic analysis (@if, @switch, @for, @defer)
- Enhanced template parsing to handle complex Angular template structures including conditional branches and defer blocks

### Improved
- Diagnostic provider now processes all template branches including @if branches, @switch cases, @for empty blocks, and @defer loading/error/placeholder blocks
- More comprehensive template analysis for better import detection accuracy

## [1.5.0] - 2025-07-30

### Added
- Support for indexing components, directives, and pipes from local, non-standalone NgModules.

### Fixed
- A bug with the index cache that could cause stale data or incorrect suggestions.

## [1.4.0] - 2025-07-28

### Added
- **External library support** for Angular components, directives, and pipes from npm packages  

### Changed 
- Autocompletion now uses regex-only context detection for better performance
- Import path resolution prefers module paths over relative paths
- Enhanced diagnostic provider with improved error handling
 

## [1.3.0] - 2025-07-14

### Improved
- Enhanced selector matching logic for better diagnostic accuracy
- Improved CSS selector specificity handling - now captures all matched selectors and uses the most specific one
- Better pipe handling in template diagnostics
- Simplified quickfix provider logic for cleaner code maintenance

### Changed
- Quickfix provider now only handles diagnostics from "angular-auto-import" source for better separation of concerns
- Streamlined diagnostic handling workflow

## [1.2.0] - 2025-07-11

### Changed
- Rewrote selector parsing using `@angular/compiler` for dramatically improved accuracy.
- Major internal refactoring for better performance and future-proofing.
- Replaced project tooling with Biome.

### Added
- More intelligent autocompletion for various Angular template syntaxes.

### Fixed
- Reduced noisy or duplicate diagnostics.

## [1.1.1] - 2025-06-24

### Fixed
- Fixed document saving after applying import edits to prevent race conditions with other providers
- Improved diagnostics update timing to ensure proper synchronization

## [1.1.0] - 2025-06-18

### Added
- Implemented Trie data structure for improved autocompletion performance (O(N) to O(L) complexity)
- Added support for template reference variables detection and handling
- Added built-in Angular directives (NgForm, NgModelGroup, FormGroup, RouterLink, RouterLinkActive, RouterOutlet)
- Enhanced completion provider with better context filtering and text replacement
- Improved quickfix provider with alternative selector generation and better import path resolution

### Changed
- Updated TypeScript path alias resolution to always prefer aliases over relative paths for cleaner imports
- Enhanced diagnostic provider to handle template reference elements
- Improved element indexing with better file caching and Trie-based search optimization
- Refactored completion suggestions grouping by element type for better performance

### Fixed
- Fixed generic import suggestions when Angular diagnostics are present
- Improved handling of secondary entry points for external packages (e.g., @angular/material/form-field)

## [1.0.0] - 2025-06-17
 
- Initial release
