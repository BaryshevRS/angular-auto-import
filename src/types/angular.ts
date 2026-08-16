/**
 * Defines the core data types for Angular elements.
 * @module
 */

import type { ProcessedTsConfig } from "./tsconfig";

/**
 * Defines the possible types for an Angular element.
 */
type AngularElementType = "component" | "directive" | "pipe";

/**
 * Represents information about an Angular component, directive, or pipe.
 */
export interface ComponentInfo {
  /**
   * The file path where the component is defined.
   */
  path: string;
  /**
   * The name of the component class.
   */
  name: string;
  /**
   * The CSS selector for the component.
   */
  selector: string;
  /**
   * The type of the element.
   */
  type: AngularElementType;
  /**
   * The timestamp of the last modification of the file.
   */
  lastModified: number;
  /**
   * A hash of the file content to detect changes.
   */
  hash: string;
  /**
   * Indicates if the component is standalone.
   */
  isStandalone: boolean;
}

/**
 * Represents a generic Angular element configuration.
 */
export type Element = {
  name: string;
  importPath?: string;
  type: AngularElementType;
  selectors: string[];
  originalSelector: string;
  standalone: boolean;
};

/**
 * Options for creating an AngularElementData instance.
 * @public Part of the public API for creating AngularElementData instances
 */
interface AngularElementDataOptions {
  /** The file path where the element is defined. */
  path: string;
  /** The name of the element's class. */
  name: string;
  /** The type of the element. */
  type: AngularElementType;
  /** The original selector of the element. */
  originalSelector: string;
  /** An array of possible selectors for the element. */
  selectors: string[];
  /** Indicates if the element is standalone. */
  isStandalone: boolean;
  /** Indicates if the element is from an external library. */
  isExternal: boolean;
  /** The name of the module that exports this element, if applicable. */
  exportingModuleName?: string;
  /** The absolute file path to the element (for external libraries). */
  absolutePath?: string;
}

/**
 * Represents data for an Angular element to be indexed.
 */
export class AngularElementData {
  public readonly path: string;
  public readonly name: string;
  public readonly type: AngularElementType;
  public readonly originalSelector: string;
  public readonly selectors: string[];
  public readonly isStandalone: boolean;
  public readonly isExternal: boolean;
  public readonly exportingModuleName?: string;
  public readonly absolutePath?: string;

  /**
   * Creates an instance of AngularElementData.
   * @param options Configuration options for the Angular element
   */
  constructor(options: AngularElementDataOptions) {
    this.path = options.path;
    this.name = options.name;
    this.type = options.type;
    this.originalSelector = options.originalSelector;
    this.selectors = options.selectors;
    this.isStandalone = options.isStandalone;
    this.isExternal = options.isExternal;
    this.exportingModuleName = options.exportingModuleName;
    this.absolutePath = options.absolutePath;
  }
}

/**
 * Information about Angular elements found in a single file.
 */
export interface FileElementsInfo {
  /**
   * The path to the file.
   */
  filePath: string;
  /**
   * The timestamp of the last modification of the file.
   */
  lastModified: number;
  /**
   * A hash of the file content.
   */
  hash: string;
  /**
   * An array of component information found in the file.
   */
  elements: ComponentInfo[];
}

/**
 * The project context to be passed to providers.
 */
export interface ProjectContext {
  /**
   * The root path of the Angular project.
   */
  projectRootPath: string;
  /**
   * An instance of the Angular indexer.
   */
  indexer: import("../services").AngularIndexer;
  /**
   * The processed tsconfig for the project.
   */
  tsConfig: ProcessedTsConfig | null;
}
