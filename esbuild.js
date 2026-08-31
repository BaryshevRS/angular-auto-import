const esbuild = require("esbuild");
const fs = require("node:fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import("esbuild").Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",
	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			if (result.errors.length > 0) {
				for (const { text, location } of result.errors) {
					if (location) {
						console.error(`✘ [ERROR] ${text}`);
						console.error(`    ${location.file}:${location.line}:${location.column}`);
					} else {
						console.error(`✘ [ERROR] ${text}`);
					}
				}
			}
			if (result.warnings.length > 0) {
				for (const { text, location } of result.warnings) {
					if (location) {
						console.warn(`⚠ [WARN] ${text}`);
						console.warn(`    ${location.file}:${location.line}:${location.column}`);
					} else {
						console.warn(`⚠ [WARN] ${text}`);
					}
				}
			}
			console.log("[watch] build finished");
		});
	},
};

async function main() {
	const contexts = await Promise.all([
		esbuild.context({
			entryPoints: ["src/extension.ts"],
			bundle: true,
			format: "cjs",
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: "node",
			target: "node22",
			outfile: "dist/extension.js",
			logLevel: "silent",
			external: ["vscode", "*.node"],
			plugins: [esbuildProblemMatcherPlugin],
		}),
		esbuild.context({
			entryPoints: ["src/main.ts"],
			bundle: true,
			format: "cjs",
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: "node",
			target: "node20",
			outfile: "dist/server.js",
			logLevel: "silent",
			external: ["*.node"],
			plugins: [esbuildProblemMatcherPlugin],
		}),
	]);

	if (watch) {
		await Promise.all(contexts.map((context) => context.watch()));
		console.log("[watch] watching for changes...");
	} else {
		await Promise.all(contexts.map((context) => context.rebuild()));
		await Promise.all(contexts.map((context) => context.dispose()));

		// The npm package is a second distribution of the same built server. Copying the
		// bundle keeps the VSIX identity separate without compiling the seven-megabyte
		// engine twice.
		const mcpDist = "packages/mcp/dist";
		fs.mkdirSync(mcpDist, { recursive: true });
		fs.copyFileSync("dist/server.js", `${mcpDist}/server.js`);
		fs.writeFileSync(
			`${mcpDist}/mcp.js`,
			[
				"#!/usr/bin/env node",
				'// Starts the server in its agent-facing shape. See src/main.ts.',
				'process.argv.push("mcp");',
				'require("./server.js");',
				"",
			].join("\n"),
			{ mode: 0o755 }
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
