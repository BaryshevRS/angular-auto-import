/**
 * Routes a document URI to the project that can answer questions about it.
 *
 * Every language feature starts with the same two questions: which Angular project
 * owns this file, and which TypeScript file do its imports belong in. An external
 * HTML template answers the second differently from an inline one, and that
 * difference is the only thing separating the two cases in the handlers.
 * @module
 */

import * as path from "node:path";
import { fileUriToPath } from "../core/document";
import type { ProjectRuntime } from "./project-runtime";

/** A document resolved onto the project runtime that serves it. */
export interface RoutedDocument {
  /** Absolute path of the document itself. */
  filePath: string;
  /** Absolute path of the TypeScript file whose `imports` a template's elements go into. */
  componentFilePath: string;
  /** Whether the template lives in its own HTML file rather than in the component's decorator. */
  externalTemplate: boolean;
  runtime: ProjectRuntime;
}

export interface ProjectRouterOptions {
  /** The deepest discovered Angular root containing a file, as `ServerProjects` decides it. */
  rootForPath(filePath: string): string | undefined;
  /** The runtime serving a root, once one has been created for it. */
  runtimeForRoot(rootPath: string): ProjectRuntime | undefined;
}

/** Resolves document URIs onto project runtimes. */
export class ProjectRouter {
  constructor(private readonly options: ProjectRouterOptions) {}

  /**
   * Resolves a document URI, or returns `undefined` when it is not a file on disk, no
   * discovered project contains it, or that project's runtime is still loading.
   * @param uri The document URI to route.
   */
  resolve(uri: string): RoutedDocument | undefined {
    let filePath: string;
    try {
      filePath = fileUriToPath(uri);
    } catch {
      return undefined;
    }
    return this.resolvePath(filePath);
  }

  /**
   * Resolves an absolute filesystem path onto its project runtime.
   * @param filePath Absolute path of the file to route.
   */
  resolvePath(filePath: string): RoutedDocument | undefined {
    const rootPath = this.options.rootForPath(filePath);
    const runtime = rootPath ? this.options.runtimeForRoot(rootPath) : undefined;
    if (!runtime) {
      return undefined;
    }

    const externalTemplate = path.extname(filePath).toLowerCase() === ".html";
    return {
      filePath,
      componentFilePath: externalTemplate ? runtime.componentFileForTemplate(filePath) : filePath,
      externalTemplate,
      runtime,
    };
  }
}
