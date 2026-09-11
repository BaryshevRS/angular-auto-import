/**
 * The tools an agent gets, over the Model Context Protocol.
 *
 * The editor asks "what is under the cursor"; an agent has no cursor and a different
 * question: it is about to write a template and wants to know whether it can. So the
 * tools here are not the language server's requests wrapped in another protocol — an
 * agent cannot supply a line and a column it never computed — but the answers this
 * project already knows how to compute, asked for the way an agent asks.
 *
 * A tool description is a prompt, not documentation: it is read by the model deciding
 * whether to call, and is worth editing as carefully as the code under it.
 * @module
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeElements } from "./element-api";
import { orient } from "./orient";
import { searchElements } from "./search";
import { verifyTemplate } from "./verify-template";
import { Workspace } from "./workspace";

const SERVER_VERSION = (require("../../package.json") as { version: string }).version;

/** What a tool answers with when the request names no Angular project. */
function noProject(componentPath: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [
      {
        type: "text",
        text: `No Angular project contains ${componentPath}. A project is a directory whose package.json declares @angular/core.`,
      },
    ],
    isError: true,
  };
}

/** @internal */
function answer(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Builds the server and its tools.
 * @param workspace The projects to answer from; one per process by default.
 */
export function createMcpServer(workspace: Workspace = new Workspace()): McpServer {
  const server = new McpServer({ name: "angular-auto-import", version: SERVER_VERSION });

  server.registerTool(
    "verify_template",
    {
      title: "Verify an Angular template",
      description: [
        "Check an Angular template against what its component can actually use, and get back the imports that make it work.",
        "",
        "Call this before writing or editing any Angular template, and again after changing one.",
        "Do not guess whether a component, directive or pipe is available and do not grep for it:",
        "this answers from the project's real index, including every installed library.",
        "",
        "Returns each problem with its line, the token that caused it, which classes would satisfy it",
        "and the module specifier to import each from, plus the component file rewritten with the",
        "imports added. An empty problems list means the template compiles as far as imports go.",
      ].join("\n"),
      inputSchema: {
        component: z
          .string()
          .describe("Absolute path to the component's TypeScript file, the one carrying the @Component decorator."),
        template: z
          .string()
          .describe(
            "The template to check, as HTML. This need not be the template the component currently has: pass the one you are about to write."
          ),
      },
    },
    async ({ component, template }) => {
      const componentPath = path.resolve(component);

      // Read before indexing: a path that is wrong should say so at once rather than
      // after the seconds a first index costs.
      let componentText: string;
      try {
        componentText = await fs.readFile(componentPath, "utf8");
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Could not read ${componentPath}: ${String(error)}` }],
          isError: true as const,
        };
      }

      const project = await workspace.projectFor(componentPath);
      if (!project) {
        return noProject(componentPath);
      }

      const verdict = await verifyTemplate({
        runtime: project.runtime,
        compiler: project.compiler,
        componentPath,
        componentText,
        template,
      });

      return answer(verdict);
    }
  );

  server.registerTool(
    "describe_element",
    {
      title: "What a template may write on an Angular element",
      description: [
        "Look up an Angular component, directive or pipe in this workspace and get its real public surface:",
        "the inputs it takes with their exact names and which are required, the outputs it emits,",
        "where it projects content, and the specifier to import it from.",
        "",
        "Call this before binding anything you did not declare yourself. Input names are a fact about",
        "this workspace, not about Angular: a component may take `loadingState` where every other",
        "library takes `isLoading`, and no amount of Angular knowledge will tell you which.",
        "",
        "Ask by selector or by class name, whichever you have. Covers the workspace's own elements",
        "and every installed library.",
      ].join("\n"),
      inputSchema: {
        fromFile: z
          .string()
          .describe(
            "Absolute path to any file in the project you are working in. Import specifiers are resolved relative to it."
          ),
        query: z.string().describe("A selector such as `nz-table`, or a class name such as `NzTableComponent`."),
      },
    },
    async ({ fromFile, query }) => {
      const askingFrom = path.resolve(fromFile);
      const project = await workspace.projectFor(askingFrom);
      if (!project) {
        return noProject(askingFrom);
      }

      return answer(await describeElements({ runtime: project.runtime, fromFile: askingFrom, query }));
    }
  );

  server.registerTool(
    "describe_project",
    {
      title: "What kind of Angular project this is",
      description: [
        "Get the shape of this Angular workspace before writing any of it: the installed Angular version,",
        "whether its components are standalone or NgModule-based, which UI libraries its files actually",
        "import and how widely, and the path aliases imports are written with.",
        "",
        "Call this once before your first file. None of it can be guessed from knowing Angular:",
        "a workspace with both Angular Material and ng-zorro installed uses one of them, and writing",
        "the other produces correct Angular that does not belong in this repository.",
      ].join("\n"),
      inputSchema: {
        fromFile: z.string().describe("Absolute path to any file in the project you are working in."),
      },
    },
    async ({ fromFile }) => {
      const askingFrom = path.resolve(fromFile);
      const project = await workspace.projectFor(askingFrom);
      if (!project) {
        return noProject(askingFrom);
      }

      return answer(await orient({ runtime: project.runtime }));
    }
  );

  server.registerTool(
    "find_element",
    {
      title: "Find an Angular element by what it is for",
      description: [
        "Find a component, directive or pipe in this workspace by describing what you need:",
        '"date picker", "table", "modal". Searches the workspace\'s own elements and every installed library.',
        "",
        "Results are ranked by what this repository actually writes, not by what it has installed,",
        "so the first hit is the one that belongs here. Each carries the specifier to import it from",
        "and the inputs it requires; ask describe_element for the rest of its surface.",
        "",
        "Every word must match. An empty answer means try another word for the same thing —",
        "it does not mean the workspace has nothing of the kind.",
      ].join("\n"),
      inputSchema: {
        fromFile: z.string().describe("Absolute path to any file in the project you are working in."),
        query: z.string().describe("What the element is for, in words. One or two words work better than a sentence."),
        type: z
          .enum(["component", "directive", "pipe"])
          .optional()
          .describe("Narrow the search when the intent already says which kind you need."),
      },
    },
    async ({ fromFile, query, type }) => {
      const askingFrom = path.resolve(fromFile);
      const project = await workspace.projectFor(askingFrom);
      if (!project) {
        return noProject(askingFrom);
      }

      return answer(
        await searchElements({
          runtime: project.runtime,
          fromFile: askingFrom,
          query,
          type,
          libraryUsage: await project.libraryUsage(),
        })
      );
    }
  );

  return server;
}
