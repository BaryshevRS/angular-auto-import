/**
 * The slice of `@angular/compiler` this extension uses.
 *
 * The compiler is imported dynamically, in both hosts, because loading it eagerly
 * costs more than most sessions ever need. Naming what is used keeps that untyped
 * module from spreading through the analysis, and keeps the AST constructors and the
 * nodes they produced coming from one and the same instance — `instanceof` against a
 * second copy of the compiler would silently match nothing.
 * @module
 */

import type { TemplateAstNode } from "../types";
import { type CoreLogger, silentLogger } from "./logging";
import type { AngularSelectorApi } from "./missing-imports";
import type { TemplateAstConstructors } from "./template-scan";

/** The result of parsing one template. */
export interface ParsedTemplate {
  nodes: TemplateAstNode[];
  /** Recoverable syntax errors; the nodes are still a usable partial AST. */
  errors?: unknown[];
}

/** Everything the analysis asks of the Angular compiler. */
export interface AngularCompilerApi {
  /**
   * Parses template text into an AST, tolerating the syntax errors a template has
   * while it is being typed.
   * @param text The template source.
   * @param name A name for the template, used in the compiler's error messages.
   */
  parseTemplate(text: string, name: string): ParsedTemplate;
  /** The node classes {@link TemplateAstConstructors} matches against. */
  ast: TemplateAstConstructors;
  /** The selector classes selector matching runs on. */
  selectors: AngularSelectorApi;
}

/**
 * How the template is parsed.
 *
 * `alwaysAttemptHtmlToR3AstConversion` keeps a partial AST for a template with errors,
 * which is every template while it is being typed.
 *
 * `preserveWhitespaces` is what makes the parser's expression spans usable. Without it
 * the whitespace is normalized before expressions are parsed, so every span an
 * expression node reports is measured against text that no longer matches the document
 * — off by however much was removed ahead of it. With it, a span is an offset into the
 * template as written, which is what a diagnostic needs.
 */
export const PARSE_OPTIONS = {
  alwaysAttemptHtmlToR3AstConversion: true,
  collectCommentNodes: true,
  preserveWhitespaces: true,
};

// biome-ignore lint/suspicious/noExplicitAny: the dynamically imported compiler has no published type surface.
type CompilerModule = any;

let pending: Promise<AngularCompilerApi> | undefined;

/**
 * Names the parts of a loaded compiler module the analysis uses.
 * @param compiler The imported `@angular/compiler` module.
 */
export function adoptAngularCompiler(compiler: CompilerModule): AngularCompilerApi {
  if (typeof compiler?.parseTemplate !== "function") {
    throw new Error("The Angular compiler did not expose parseTemplate");
  }
  if (typeof compiler?.RecursiveAstVisitor !== "function") {
    // Pipes are read off the expression AST; without the visitor they would silently
    // stop being reported, which reads like a template that uses none.
    throw new Error("The Angular compiler did not expose RecursiveAstVisitor");
  }

  return {
    parseTemplate: (text, name) => compiler.parseTemplate(text, name, PARSE_OPTIONS),
    ast: {
      tmplAstElement: compiler.TmplAstElement,
      tmplAstTemplate: compiler.TmplAstTemplate,
      tmplAstBoundEvent: compiler.TmplAstBoundEvent,
      tmplAstReference: compiler.TmplAstReference,
      tmplAstBoundAttribute: compiler.TmplAstBoundAttribute,
      tmplAstBoundText: compiler.TmplAstBoundText,
      recursiveAstVisitor: compiler.RecursiveAstVisitor,
    },
    selectors: { cssSelector: compiler.CssSelector, selectorMatcher: compiler.SelectorMatcher },
  };
}

/**
 * Loads the compiler once per process and hands out the same instance afterwards.
 *
 * A failed load is not remembered, so a transient failure does not disable the
 * analysis for the rest of the session.
 * @param logger Reports the outcome; silent by default.
 */
export function loadAngularCompiler(logger: CoreLogger = silentLogger): Promise<AngularCompilerApi> {
  pending ??= import("@angular/compiler")
    .then((compiler) => {
      const api = adoptAngularCompiler(compiler);
      logger.info("[AngularCompiler] @angular/compiler loaded");
      return api;
    })
    .catch((error) => {
      pending = undefined;
      logger.error("[AngularCompiler] Failed to load @angular/compiler", error as Error);
      throw error;
    });

  return pending;
}
