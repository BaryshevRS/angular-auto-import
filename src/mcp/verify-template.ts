/**
 * Checking a template an agent is about to write, and saying what to change.
 *
 * The compiler answers the same question later and differently: it says `'app-card' is
 * not a known element` and cannot say which class that is, which package it lives in, or
 * whether it arrives standalone or through an NgModule. Computing that answer is what
 * this extension does, and this is that answer put where an agent can reach it — before
 * a build rather than after one.
 * @module
 */

import type { Project } from "ts-morph";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AngularCompilerApi } from "../core/angular-compiler";
import { ComponentImports } from "../core/component-imports";
import { planImports } from "../core/import-planner";
import { resolveElementImportPath } from "../core/import-resolution";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import { syncSourceFile } from "../core/source-file-sync";
import { analyzeTemplate, type DiagnosticIndex } from "../core/template-diagnostics";
import type { TextEdit } from "../core/text-edits";
import type { AngularElementData } from "../types";
import { getAngularElements, orderElementsForSelector } from "../utils/angular";

/** One thing wrong with the template, and what would put it right. */
export interface TemplateProblem {
  /** One-based, as an editor and an agent both count. */
  line: number;
  column: number;
  /** The selector the token was reported under. */
  token: string;
  message: string;
  /**
   * What to import, most specific first; empty when nothing in the index answers.
   *
   * `from` is the specifier to write in an `import` statement, not a file path.
   */
  fixes: Array<{ name: string; from: string }>;
}

/** What `verify_template` answers. */
export interface TemplateVerdict {
  problems: TemplateProblem[];
  /** The class names added to the component's `imports`, in the order they were added. */
  addedImports: string[];
  /** The component file as it would read once the imports are added; absent when nothing changes. */
  updatedComponent?: string;
}

/**
 * What checking a template needs from the project that owns it.
 *
 * Narrower than a `ProjectRuntime`, which satisfies it: the four things below are all
 * this asks for, and saying so lets the analysis be tested against an index built in a
 * temporary directory rather than against a whole runtime.
 */
export interface TemplateProject {
  /** Absolute path of the Angular root, which import specifiers are resolved against. */
  rootPath: string;
  indexer: DiagnosticIndex & {
    project: Project;
    /** Every element under a selector prefix; an empty prefix is the whole index. */
    searchWithSelectors(prefix: string): Array<{ selector: string; element: AngularElementData }>;
  };
  resolveImportPath(targetModulePathNoExt: string, currentFilePath: string): Promise<string>;
}

export interface VerifyTemplateRequest {
  runtime: TemplateProject;
  compiler: AngularCompilerApi;
  /** Absolute path of the component's TypeScript file. */
  componentPath: string;
  /** The component's current text, as it is on disk. */
  componentText: string;
  /** The template to check, which need not be the one the component currently has. */
  template: string;
}

/**
 * Reports what a template uses that its component cannot, and plans the imports for it.
 * @param request The component, its project, and the template to check.
 */
export async function verifyTemplate(request: VerifyTemplateRequest): Promise<TemplateVerdict> {
  const { runtime, compiler, componentPath, componentText, template } = request;

  const sourceFile = syncSourceFile(runtime.indexer.project, componentPath, componentText);
  const componentImports = new ComponentImports({ resolveIndex: () => runtime.indexer });
  componentImports.invalidate(componentPath);

  const document = TextDocument.create(`file://${componentPath}.template.html`, "html", 1, template);
  const diagnostics = analyzeTemplate({
    document,
    template: { text: template, offset: 0 },
    sourceFile,
    index: runtime.indexer,
    componentImports,
    compiler,
    severity: "warning",
  });

  // The specifier an import statement would be written with, which is not the path the
  // index holds: a project element is stored relative to the root and imported relative
  // to the file asking, or through whichever alias the tsconfig prefers. Saying where to
  // import from is the answer the compiler's own error cannot give, so it is resolved
  // here rather than handed over half-done.
  const specifier = (element: AngularElementData): Promise<string> =>
    resolveElementImportPath(element, componentPath, runtime.rootPath, (modulePath, fromFile) =>
      runtime.resolveImportPath(modulePath, fromFile)
    );

  const problems: TemplateProblem[] = [];
  const toImport: AngularElementData[] = [];
  const claimed = new Set<string>();

  for (const diagnostic of diagnostics) {
    const candidates = elementsFor(diagnostic, runtime);
    problems.push({
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      token: selectorOf(diagnostic),
      message: diagnostic.message,
      fixes: await Promise.all(
        candidates.map(async (element) => ({ name: element.name, from: await specifier(element) }))
      ),
    });

    for (const element of independent(diagnostic, candidates)) {
      const identity = `${element.name} ${element.path}`;
      if (!claimed.has(identity)) {
        claimed.add(identity);
        toImport.push(element);
      }
    }
  }

  if (toImport.length === 0) {
    return { problems, addedImports: [] };
  }

  const plan = await planImports({
    filePath: componentPath,
    text: componentText,
    version: 1,
    elements: toImport,
    project: runtime.indexer.project,
    resolveImportPath: specifier,
  });

  return {
    problems,
    addedImports: plan.addedImports,
    updatedComponent: plan.edits.length > 0 ? applyEdits(componentPath, componentText, plan.edits) : undefined,
  };
}

/**
 * The indexed elements one diagnostic names, ranked.
 *
 * Read out of the index rather than out of the diagnostic, because a diagnostic carries
 * a name and a path while a plan needs the element: the same lookup a quick fix does.
 * @internal
 */
function elementsFor(diagnostic: MissingImportDiagnostic, runtime: TemplateProject): AngularElementData[] {
  const selector = selectorOf(diagnostic);
  if (!selector) {
    return [];
  }

  const indexed = getAngularElements(selector, runtime.indexer);
  const named = (diagnostic.elements ?? [])
    .map((element) => indexed.find((candidate) => candidate.name === element.name && candidate.path === element.path))
    .filter((element): element is AngularElementData => element !== undefined);

  return named.length > 0 ? orderElementsForSelector(selector, named) : [];
}

/**
 * The elements of one token that have to be imported *together*.
 *
 * Two elements demanding the same thing are two owners of one token and importing either
 * settles it, so only the most specific is taken. Two that demand differently are
 * separate directives Angular applies at once — on `<button foo="check">`, `[foo]`,
 * `button[foo]` and `[foo=check]` are three imports — and taking one per token would
 * leave the template still broken after the fix was applied.
 * @internal
 */
function independent(diagnostic: MissingImportDiagnostic, ranked: AngularElementData[]): AngularElementData[] {
  const demandsOf = new Map(
    (diagnostic.elements ?? []).map((element) => [`${element.name} ${element.path}`, element.demands])
  );

  const chosen: AngularElementData[] = [];
  const covered = new Set<string>();
  for (const element of ranked) {
    const demands = demandsOf.get(`${element.name} ${element.path}`);
    if (demands === undefined) {
      // A diagnostic that does not say what its elements demand cannot tell alternatives
      // from companions, so it falls back to its most specific element alone.
      if (chosen.length === 0) {
        chosen.push(element);
      }
      continue;
    }
    if (!covered.has(demands)) {
      covered.add(demands);
      chosen.push(element);
    }
  }
  return chosen;
}

/** The selector a diagnostic was reported under, out of its `missing-<type>-import:<selector>` code. @internal */
function selectorOf(diagnostic: MissingImportDiagnostic): string {
  return diagnostic.code.slice(diagnostic.code.indexOf(":") + 1);
}

/**
 * The component as it reads once the plan is applied.
 *
 * Returned whole rather than as ranges: an agent writes a file, not a patch, and
 * positions into text it did not compute are one more thing for it to get wrong. Applied
 * by the same code an editor applies them with, so that a plan reads here exactly as it
 * would after a quick fix.
 * @internal
 */
function applyEdits(componentPath: string, text: string, edits: TextEdit[]): string {
  return TextDocument.applyEdits(TextDocument.create(`file://${componentPath}`, "typescript", 1, text), edits);
}
