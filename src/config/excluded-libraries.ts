/**
 * Configuration for libraries that should be excluded from indexing.
 * @module
 */

/**
 * Set of library package names that should not be indexed.
 *
 * These libraries are excluded because:
 * - They contain only internal/system Angular components (@angular/core, @angular/platform-*)
 * - They have complex shared module structures that cause ambiguity (@angular/forms)
 * - They are compiler/tooling packages (@angular/compiler*, @angular/language-service)
 * - They are testing utilities (jest-preset-angular)
 * - They are infrastructure packages (@taiga-ui/event-plugins, @taiga-ui/i18n)
 *
 * @internal
 */
const EXCLUDED_LIBRARIES = new Set([
  // Angular core packages
  "@angular/animations",
  "@angular/core",
  "@angular/platform-browser",
  "@angular/platform-browser-dynamic",
  "@angular/common", // Common directives like NgIf, NgFor are handled via STANDARD_ANGULAR_ELEMENTS

  // Angular forms - has complex shared module structure with FormsModule/ReactiveFormsModule
  "@angular/forms",

  // Angular compiler and tooling
  "@angular/compiler",
  "@angular/compiler-cli",
  "@angular/language-service",

  // Testing utilities
  "jest-preset-angular",

  // Taiga UI infrastructure packages
  "@taiga-ui/event-plugins",
  "@taiga-ui/i18n",
]);

/**
 * Checks if a library should be excluded from indexing based on its import path.
 *
 * @param importPath - The import path to check (e.g., "@angular/forms", "@angular/core")
 * @returns `true` if the library should be excluded, `false` otherwise
 *
 * @example
 * ```typescript
 * isLibraryExcluded("@angular/forms") // true
 * isLibraryExcluded("@angular/material") // false
 * isLibraryExcluded("@taiga-ui/core") // false
 * ```
 */
export function isLibraryExcluded(importPath: string): boolean {
  // Signal Forms exports standalone directives, unlike the legacy forms modules.
  // Index only the entry point a project's installed Angular actually provides.
  if (importPath === "@angular/forms/signals") {
    return false;
  }
  // Normalize the import path by removing any subpath exports
  // e.g., "@angular/forms/testing" -> "@angular/forms"
  const normalizedPath = importPath.split("/").slice(0, 2).join("/");

  return EXCLUDED_LIBRARIES.has(normalizedPath);
}
