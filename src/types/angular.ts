/**
 * Defines the core data types for Angular elements.
 * @module
 */

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
  /** What a template may bind on it, its own declaration merged with what it extends. */
  inputs?: ElementInput[];
  /** What a template may listen to on it. */
  outputs?: ElementOutput[];
  /** The directives that come with it, and what they expose on the host. */
  hostDirectives?: ElementHostDirective[];
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
 * One input a template can bind on an element.
 *
 * Named by what a template writes rather than by the class property behind it: an
 * `@Input({ alias })` and an `input(…, { alias })` both make those two different, and the
 * alias is the one a template is allowed to use.
 */
export interface ElementInput {
  /** The name a template writes. */
  name: string;
  /** The class property behind it, present only when it differs from {@link ElementInput.name}. */
  propertyName?: string;
  /** Whether Angular refuses to compile a template that leaves it unbound. */
  required: boolean;
  /** Whether it is a signal input, which decides how a value is read inside the class. */
  isSignal: boolean;
}

/** One binding a host directive puts on every element its host matches. */
export interface ExposedBinding {
  /** The name a template writes on the host element. */
  name: string;
  /** The name it has on the host directive, present only when the two differ. */
  directiveName?: string;
}

/**
 * A directive Angular applies wherever this element matches, and what of it shows through.
 *
 * Nothing shows through by default — a host directive exposes an input or an output only
 * where the host says to, optionally under another name. What it exposes is written out
 * in the host's own emit, so these names are known without opening the host directive;
 * what is not known that way is whether each is required or a signal, which is a fact
 * about the host directive's declaration and not about this one.
 */
export interface ElementHostDirective {
  /** The class name as the declaration writes it, without the import alias in front. */
  name: string;
  inputs: ExposedBinding[];
  outputs: ExposedBinding[];
}

/** One output a template can listen to, named the same way an input is. */
export interface ElementOutput {
  name: string;
  /** The class property behind it, present only when it differs from {@link ElementOutput.name}. */
  propertyName?: string;
}

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
  /** What a template may bind on it, as its own declaration gives it. */
  inputs?: ElementInput[];
  /** What a template may listen to on it. */
  outputs?: ElementOutput[];
  /** The `ng-content` selectors a component projects into, in declaration order. */
  contentSelectors?: string[];
  /** The directives that come with it, and what they expose on the host. */
  hostDirectives?: ElementHostDirective[];
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
  public readonly inputs?: ElementInput[];
  public readonly outputs?: ElementOutput[];
  public readonly contentSelectors?: string[];
  public readonly hostDirectives?: ElementHostDirective[];

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
    // Left undefined rather than empty when nothing was read, so that "this element
    // declares no inputs" and "nobody has read this element's inputs" stay different
    // answers — a persisted index written before they were read holds neither.
    this.inputs = options.inputs;
    this.outputs = options.outputs;
    this.contentSelectors = options.contentSelectors;
    this.hostDirectives = options.hostDirectives;
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
