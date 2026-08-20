import type * as vscode from "vscode";

/**
 * Describes a single diagnostic's expected position and properties.
 */
export interface DiagnosticDescriptor {
  code: string;
  severity: string;
  source: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * Expected import statement to verify after quickfix application.
 */
export interface ExpectedImport {
  className: string;
  moduleSpecifier: string;
}

/**
 * Describes a quickfix action with its expected import result.
 */
export interface QuickfixDescriptor {
  diagnosticCode: string;
  title: string;
  expectedImport: ExpectedImport;
  /**
   * Which command the action ran, in descriptors recorded before code actions carried
   * their edit directly. Nothing reads it; it survives so old descriptors still parse.
   * @deprecated
   */
  command?: string;
}

/**
 * Full test case descriptor read from descriptor.json.
 */
export interface CaseDescriptor {
  case: string;
  componentPath: string;
  templatePath: string;
  modulePath?: string;
  preserveImports?: boolean;
  diagnostics: DiagnosticDescriptor[];
  quickfixes: QuickfixDescriptor[];
}

/**
 * Configuration for a test case used by the descriptor generator.
 */
export interface CaseConfig {
  name: string;
  componentPath: string;
  templatePath: string;
  modulePath?: string;
  preserveImports?: boolean;
}

/**
 * Maps VS Code DiagnosticSeverity enum to string.
 */
export function severityToString(severity: vscode.DiagnosticSeverity): string {
  // DiagnosticSeverity: 0=Error, 1=Warning, 2=Information, 3=Hint
  switch (severity) {
    case 0:
      return "Error";
    case 1:
      return "Warning";
    case 2:
      return "Information";
    case 3:
      return "Hint";
    default:
      return "Unknown";
  }
}
