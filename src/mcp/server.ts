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
import { verifyTemplate } from "./verify-template";
import { Workspace } from "./workspace";

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
  const server = new McpServer({ name: "angular-auto-import", version: "3.0.0" });

  server.registerTool(
    "verify_angular_template",
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
    "angular_element_api",
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

  return server;
}
