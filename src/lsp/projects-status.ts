/**
 * What the server found to work on, said plainly enough to act on.
 *
 * Discovery is allowed to find nothing — an editor window with no Angular in it is a
 * normal thing — but it must not find nothing *quietly*. From the outside, a server
 * that indexed no project and a project with nothing missing look identical: no
 * diagnostics, no completions, no sign that anything is wrong. Working out which one
 * you are looking at meant reading the extension's source.
 *
 * This module turns that state into one sentence naming the reason and the setting
 * that changes it. It is kept pure and separate from the server so the sentence can be
 * asserted without a connection.
 * @module
 */

import type { ExtensionConfig } from "../core/settings";
import type { ProjectSummary, ProjectsStatus } from "./protocol";

/** What discovery had to work with, and what came of it. */
export interface DiscoveryOutcome {
  /** The roots the server searched, after `projectPath` was applied. */
  workspaceRoots: readonly string[];
  /** The Angular projects found inside them. */
  projects: readonly ProjectSummary[];
  /** The settings in force, which decide which advice applies. */
  config: Pick<ExtensionConfig, "projectPath">;
}

/**
 * Describes the outcome of discovery, naming a reason when there is nothing to report on.
 * @param outcome What the server searched and what it found.
 */
export function describeProjectsStatus(outcome: DiscoveryOutcome): ProjectsStatus {
  const status: ProjectsStatus = {
    workspaceRoots: [...outcome.workspaceRoots],
    projects: [...outcome.projects],
  };

  const problem = describeProblem(outcome);
  return problem ? { ...status, problem } : status;
}

/**
 * The one sentence a user can act on, or nothing when there is no problem to report.
 * @internal
 */
function describeProblem(outcome: DiscoveryOutcome): string | undefined {
  if (outcome.projects.length > 0) {
    return undefined;
  }

  const configured = outcome.config.projectPath?.trim();
  if (outcome.workspaceRoots.length === 0) {
    return configured
      ? `angular-auto-import.projectPath is set to "${configured}", which is not a directory.`
      : "No folder is open, so there is nowhere to look for an Angular project.";
  }

  // Reaching here means the roots exist and were searched. Naming the rule that
  // rejected them is the whole point: in a monorepo the root manifest carries the
  // build tooling and `@angular/core` is declared per application, so the answer is
  // to point the setting at one.
  const searched = outcome.workspaceRoots.join(", ");
  return (
    `No Angular project found in ${searched}: a project is a directory whose package.json ` +
    "declares @angular/core. In a monorepo that is the application, not the workspace root — " +
    "set angular-auto-import.projectPath to it."
  );
}
