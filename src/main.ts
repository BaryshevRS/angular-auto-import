/**
 * The one process this extension starts, in whichever of its two shapes was asked for.
 *
 * Both servers answer from the same index, the same compiler and the same ts-morph
 * project, so bundling them separately would ship that engine twice — seven megabytes of
 * it — to put a second entry point in front of it. Which one a process becomes is decided
 * here, by the arguments it was started with, and nowhere else: neither server knows the
 * other exists.
 * @module
 */

/** The argument that asks for the agent-facing server rather than the editor-facing one. */
const MCP = "mcp";

// Required rather than imported: both halves start themselves on load, and `import()`
// under Node16 resolution would want the emitted `.js` extension, which is a fact about
// the shape this file is compiled to rather than about which server to be.
if (process.argv.includes(MCP)) {
  require("./mcp/main");
} else {
  require("./lsp/server-main");
}
