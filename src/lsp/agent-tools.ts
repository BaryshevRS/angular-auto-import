/**
 * The agent's four questions, answered from the index this server already holds.
 *
 * The editor asks what is under the cursor. An agent has no cursor: it names a file and
 * asks what it may write. Those answers are the same ones the standalone MCP server
 * publishes — this module only routes them to the project the editor has open, so a
 * workspace never indexes itself twice to serve one window.
 * @module
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describeElements, type ElementApiAnswer } from "../mcp/element-api";
import type { IndexedProject } from "../mcp/indexed-project";
import { type Orientation, orient } from "../mcp/orient";
import { type SearchAnswer, searchElements } from "../mcp/search";
import { type TemplateVerdict, verifyTemplate } from "../mcp/verify-template";
import type { AgentAnswer, AgentElementQuery, AgentFileQuery, AgentSearchQuery, AgentTemplateQuery } from "./protocol";

/** How this handler reaches an indexed project. */
export interface AgentToolsOptions {
  /**
   * The project owning a file, indexed if the editor has not reached it yet.
   * @param filePath Absolute path of the file the question names.
   */
  projectFor(filePath: string): Promise<IndexedProject | undefined>;
}

/** Answers the agent-facing requests. */
export class AgentTools {
  constructor(private readonly options: AgentToolsOptions) {}

  /** @param query The file whose project to describe. */
  async describeProject(query: AgentFileQuery): Promise<AgentAnswer<Orientation>> {
    const fromFile = path.resolve(query.fromFile);
    const project = await this.options.projectFor(fromFile);
    if (!project) {
      return noProject(fromFile);
    }
    return { answered: true, answer: await orient({ runtime: project.runtime }) };
  }

  /** @param query What the element is for, and the project to search. */
  async findElement(query: AgentSearchQuery): Promise<AgentAnswer<SearchAnswer>> {
    const fromFile = path.resolve(query.fromFile);
    const project = await this.options.projectFor(fromFile);
    if (!project) {
      return noProject(fromFile);
    }

    return {
      answered: true,
      answer: await searchElements({
        runtime: project.runtime,
        fromFile,
        query: query.query,
        type: query.type,
        libraryUsage: await project.libraryUsage(),
      }),
    };
  }

  /** @param query The selector or class name to look up, and where to resolve it from. */
  async describeElement(query: AgentElementQuery): Promise<AgentAnswer<ElementApiAnswer>> {
    const fromFile = path.resolve(query.fromFile);
    const project = await this.options.projectFor(fromFile);
    if (!project) {
      return noProject(fromFile);
    }
    return {
      answered: true,
      answer: await describeElements({ runtime: project.runtime, fromFile, query: query.query }),
    };
  }

  /** @param query The component and the template to check against it. */
  async verifyTemplate(query: AgentTemplateQuery): Promise<AgentAnswer<TemplateVerdict>> {
    const componentPath = path.resolve(query.component);

    // Read before indexing: a path that is wrong should say so at once rather than after
    // the seconds a first index costs.
    let componentText: string;
    try {
      componentText = await fs.readFile(componentPath, "utf8");
    } catch (error) {
      return { answered: false, problem: `Could not read ${componentPath}: ${String(error)}` };
    }

    const project = await this.options.projectFor(componentPath);
    if (!project) {
      return noProject(componentPath);
    }

    return {
      answered: true,
      answer: await verifyTemplate({
        runtime: project.runtime,
        compiler: project.compiler,
        componentPath,
        componentText,
        template: query.template,
      }),
    };
  }
}

/** @internal */
function noProject(filePath: string): { answered: false; problem: string } {
  return {
    answered: false,
    problem: `No Angular project contains ${filePath}. A project is a directory whose package.json declares @angular/core.`,
  };
}
