/**
 * The baseline the migration's performance gates are judged against.
 *
 * What is measured here is what can be measured honestly outside an editor: how long a
 * project takes to index cold and warm, what a completion and a diagnostic cost when the
 * handler is called directly and again when the same request crosses a real JSON-RPC
 * connection, and what the server process holds after indexing and after repeated
 * reindexing. The difference between the direct call and the round trip is the protocol
 * tax, which is the honest form of the "no regression in warm completion p95" gate:
 * both hosts run the same analysis, so the protocol is the only thing that is new.
 *
 * Memory is asked as two separate questions, because one number cannot answer both.
 * What the process costs is measured on a spawned `dist/server.js` — that is what a user
 * actually runs. Whether anything *leaks* is measured in this process, where a garbage
 * collection can be forced: an RSS that climbs and stays there says nothing on its own,
 * since V8 does not return freed pages to the operating system.
 *
 * Two gates are deliberately absent, because nothing outside the Extension Host can
 * measure them: activation time, and Extension Host CPU during a full index. The second
 * is the migration's whole point, and measuring it needs a run inside the editor —
 * `src/test/suite/host-cost.test.ts` does that.
 *
 * Usage: node --expose-gc scripts/benchmark.mjs [--project <path>] [--samples N]
 *          [--reindexes N] [--json]
 * Requires a compiled `out/`: run `pnpm run compile-tests` first. Without `--expose-gc`
 * the leak check is skipped and says so.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

if (!existsSync(path.join(repositoryRoot, "out", "lsp", "server.js"))) {
  console.error('No compiled output found. Run "pnpm run compile-tests" first.');
  process.exit(1);
}

const { startHarness } = await import(path.join(repositoryRoot, "out/test/node/harness/lsp-harness.js"));
const { ProjectRuntime } = await import(path.join(repositoryRoot, "out/lsp/project-runtime.js"));
const { CompletionHandler } = await import(path.join(repositoryRoot, "out/lsp/completion.js"));
const { DiagnosticsHandler } = await import(path.join(repositoryRoot, "out/lsp/diagnostics.js"));
const { ProjectRouter } = await import(path.join(repositoryRoot, "out/lsp/project-router.js"));
const { OpenDocuments } = await import(path.join(repositoryRoot, "out/lsp/open-documents.js"));
const { adoptAngularCompiler } = await import(path.join(repositoryRoot, "out/core/angular-compiler.js"));
const { DEFAULT_EXTENSION_CONFIG } = await import(path.join(repositoryRoot, "out/core/settings.js"));
const { toDocumentView } = await import(path.join(repositoryRoot, "out/adapters/lsp/document.js"));
const { TextDocument } = await import("vscode-languageserver-textdocument");
const protocol = await import("vscode-languageserver-protocol");
// The stream transports live in the package's node entry point, not its common one.
const protocolNode = await import("vscode-languageserver-protocol/node");

const options = parseArguments(process.argv.slice(2));
const project = options.project ?? path.join(repositoryRoot, "src", "e2e", "projects", "v22");
const samples = options.samples ?? 50;

if (!existsSync(project)) {
  console.error(`No project at ${project}`);
  process.exit(1);
}

/** A file with a template worth asking questions about, and where to ask them. */
const SUBJECT = {
  template: path.join(project, "apps/angular-demo/src/app/home/home.component.html"),
  completionAt: { line: 9, character: 5 },
};

const results = {};

// ── Indexing ────────────────────────────────────────────────────────────────────

const storagePath = await mkdtemp(path.join(tmpdir(), "aai-benchmark-"));
try {
  const cold = new ProjectRuntime(project, { storagePath });
  results.coldIndexMs = await timed(() => cold.load());
  results.indexedElements = cold.elementCount;
  results.sourceFiles = (await cold.listSourceFiles()).length;
  cold.dispose();

  const warm = new ProjectRuntime(project, { storagePath });
  results.warmIndexMs = await timed(() => warm.load());
  results.warmFromCache = warm.restoredFromCache;
  warm.dispose();
} finally {
  await rm(storagePath, { recursive: true, force: true });
}

// ── Request latency, called directly and over the wire ───────────────────────────

const runtime = new ProjectRuntime(project);
await runtime.load();
const compiler = adoptAngularCompiler(await import("@angular/compiler"));

const router = new ProjectRouter({
  rootForPath: (filePath) => (filePath.startsWith(project) ? project : undefined),
  runtimeForRoot: (rootPath) => (rootPath === project ? runtime : undefined),
});
const documents = emptyOpenDocuments();
const config = () => DEFAULT_EXTENSION_CONFIG;
const completions = new CompletionHandler({ router, documents, config });
const diagnostics = new DiagnosticsHandler({ router, documents, config, compiler: () => compiler });

// The fixture's component imports everything its template uses, so measuring it as it
// stands would time the cheap path. Strip the imports first, as the E2E corpus does, and
// put them back afterwards.
const componentPath = SUBJECT.template.replace(/\.html$/, ".ts");
const originalComponent = await readFile(componentPath, "utf8");
const { stripAngularImports } = await import(path.join(repositoryRoot, "out/e2e/helpers/strip-imports.js"));
await writeFile(componentPath, stripAngularImports(originalComponent, path.basename(SUBJECT.template)), "utf8");

const templateText = await readFile(SUBJECT.template, "utf8");
const view = toDocumentView(
  TextDocument.create(new URL(`file://${SUBJECT.template}`).toString(), "html", 1, templateText)
);

results.directCompletionMs = measure(samples, () => completions.provide(view, SUBJECT.completionAt));
results.directDiagnosticMs = measure(samples, () => diagnostics.provide(view));
results.diagnosticsReported = diagnostics.analyze(view)?.candidates.length ?? 0;
runtime.dispose();

const harness = await startHarness({ workspaceRoots: [project] });
try {
  await harness.waitForProjects();
  await harness.open(SUBJECT.template, templateText, "html");

  results.protocolCompletionMs = await measureAsync(samples, () =>
    harness.client.sendRequest(protocol.CompletionRequest.type, {
      textDocument: { uri: harness.uri(SUBJECT.template) },
      position: SUBJECT.completionAt,
    })
  );
  results.protocolDiagnosticMs = await measureAsync(samples, () =>
    harness.client.sendRequest(protocol.DocumentDiagnosticRequest.type, {
      textDocument: { uri: harness.uri(SUBJECT.template) },
    })
  );
} finally {
  await harness.dispose();
  await writeFile(componentPath, originalComponent, "utf8");
}

// ── Memory: what it costs, and whether it leaks ──────────────────────────────────

results.server = await measureServerProcess();
results.retention = await measureRetention();

// ── Packaged size ────────────────────────────────────────────────────────────────

results.bundles = bundleSizes();

// ── Report ───────────────────────────────────────────────────────────────────────

if (options.json) {
  console.log(JSON.stringify({ project, samples, results }, null, 2));
} else {
  report();
}

function report() {
  const tax = percentage(results.protocolCompletionMs.p95, results.directCompletionMs.p95);

  console.log(`\nProject: ${project}`);
  console.log(`${results.sourceFiles} source files, ${results.indexedElements} indexed elements, ${samples} samples\n`);

  console.log("Indexing");
  console.log(`  cold                ${results.coldIndexMs.toFixed(0)} ms`);
  console.log(
    `  warm                ${results.warmIndexMs.toFixed(0)} ms${results.warmFromCache ? " (from cache)" : " (cache unusable)"}`
  );

  console.log("\nCompletion (ms)          p50     p95     max");
  printLatency("  handler, direct", results.directCompletionMs);
  printLatency("  over the protocol", results.protocolCompletionMs);
  console.log(`  protocol tax        ${tax}`);

  console.log("\nDiagnostics (ms)         p50     p95     max");
  printLatency("  handler, direct", results.directDiagnosticMs);
  printLatency("  over the protocol", results.protocolDiagnosticMs);
  console.log(`  reported            ${results.diagnosticsReported} findings`);

  console.log("\nServer process (spawned from dist/server.js)");
  if (results.server.unavailable) {
    console.log(`  ${results.server.unavailable}`);
  } else {
    const trend = results.server.rssTrendMb;
    console.log(`  ready in            ${results.server.readyMs.toFixed(0)} ms`);
    console.log(`  RSS after indexing  ${trend[0]} MB`);
    console.log(`  RSS per reindex     ${trend.slice(1).join(" → ")} MB`);
    console.log(
      `  growth              ${percentage(trend[trend.length - 1], trend[0], `over ${trend.length - 1} reindexes`)}`
    );
    console.log("  (RSS is a high-water mark; V8 does not return freed pages to the OS)");
  }

  console.log("\nRetention, in this process, after a forced collection");
  if (results.retention.unavailable) {
    console.log(`  ${results.retention.unavailable}`);
  } else {
    const { collectedHeapMb, sourceFileCounts } = results.retention;
    console.log(`  heap per reindex    ${collectedHeapMb.join(" → ")} MB`);
    console.log(`  ts-morph files      ${sourceFileCounts.join(" → ")}`);
    console.log(
      `  retained            ${percentage(collectedHeapMb[collectedHeapMb.length - 1], collectedHeapMb[0], `over ${collectedHeapMb.length - 1} reindexes`)}`
    );
  }

  console.log("\nBundles");
  for (const [name, size] of Object.entries(results.bundles)) {
    console.log(`  ${name.padEnd(18)}${size} MB`);
  }

  console.log("\nNot measured here: activation time and Extension Host CPU during a full");
  console.log("index. Both need a run inside the editor; the second is the whole point of");
  console.log("the migration and cannot be inferred from these numbers.");
}

/**
 * Whether repeated reindexing retains anything, measured where a collection can be forced.
 *
 * RSS cannot answer this. V8 keeps pages it has already freed internally, so a process
 * that allocates a lot of short-lived garbage shows an RSS that climbs and stays high
 * while retaining nothing at all. What settles after a forced collection is the answer.
 */
async function measureRetention() {
  if (typeof global.gc !== "function") {
    return { unavailable: "run with --expose-gc to check for retention" };
  }

  const runtime = new ProjectRuntime(project);
  await runtime.load();

  const collectedHeapMb = [];
  const sourceFileCounts = [];
  const settled = () => {
    global.gc();
    collectedHeapMb.push(megabytes(process.memoryUsage().heapUsed));
    sourceFileCounts.push(runtime.indexer.project.getSourceFiles().length);
  };

  settled();
  for (let round = 0; round < options.reindexes; round += 1) {
    await runtime.reindex();
    settled();
  }
  runtime.dispose();

  return { collectedHeapMb, sourceFileCounts };
}

/**
 * Starts the shipped server bundle as its own process and asks it what it costs.
 *
 * The in-process harness cannot answer this: its `process.memoryUsage()` is the
 * benchmark's, which has its own ts-morph and its own index loaded. The gate is about
 * the process the user would actually be running.
 */
async function measureServerProcess() {
  const bundle = path.join(repositoryRoot, "dist", "server.js");
  if (!existsSync(bundle)) {
    return { unavailable: 'no dist/server.js; run "pnpm run compile"' };
  }

  const { ReindexRequest, PerformanceMetricsRequest } = await import(path.join(repositoryRoot, "out/lsp/protocol.js"));
  const child = spawn(process.execPath, [bundle, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  const connection = protocolNode.createProtocolConnection(
    new protocolNode.StreamMessageReader(child.stdout),
    new protocolNode.StreamMessageWriter(child.stdin)
  );

  connection.onRequest("client/registerCapability", () => null);
  connection.onRequest("workspace/configuration", (params) => params.items.map(() => ({})));
  connection.onRequest("workspace/diagnostic/refresh", () => null);
  connection.listen();

  const storage = await mkdtemp(path.join(tmpdir(), "aai-benchmark-server-"));
  try {
    const started = process.hrtime.bigint();
    await connection.sendRequest(protocol.InitializeRequest.type, {
      // Null on purpose: a process id makes the server watch its parent forever.
      processId: null,
      rootUri: null,
      capabilities: { workspace: { workspaceFolders: true } },
      workspaceFolders: [{ uri: pathToFileURL(project).toString(), name: "benchmark" }],
      initializationOptions: { storagePath: storage },
    });
    await connection.sendNotification(protocol.InitializedNotification.type, {});

    let metrics = await connection.sendRequest(PerformanceMetricsRequest);
    while (!metrics.analysisReady || (metrics.projects[0]?.elementCount ?? 0) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      metrics = await connection.sendRequest(PerformanceMetricsRequest);
    }
    const readyMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A trend, not two points: the gate is about growth that does not stop, and two
    // measurements cannot tell a leak from a heap that simply has not been collected.
    const rssTrendMb = [megabytes(metrics.memory.rss)];
    for (let round = 0; round < options.reindexes; round += 1) {
      await connection.sendRequest(ReindexRequest, {});
      rssTrendMb.push(megabytes((await connection.sendRequest(PerformanceMetricsRequest)).memory.rss));
    }

    return { readyMs, rssTrendMb };
  } finally {
    connection.dispose();
    child.kill();
    await rm(storage, { recursive: true, force: true });
  }
}

function printLatency(label, stats) {
  console.log(
    `${label.padEnd(23)}${stats.p50.toFixed(1).padStart(6)}  ${stats.p95.toFixed(1).padStart(6)}  ${stats.max.toFixed(1).padStart(6)}`
  );
}

/** Runs a synchronous operation repeatedly and summarizes how long it took. */
function measure(count, run) {
  // One untimed pass, so the first run's lazy work is not charged to the measurement.
  run();
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const started = process.hrtime.bigint();
    run();
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return summarize(durations);
}

/** The same, for an operation that has to be awaited. */
async function measureAsync(count, run) {
  await run();
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const started = process.hrtime.bigint();
    await run();
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return summarize(durations);
}

function summarize(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
}

async function timed(run) {
  const started = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function percentage(value, baseline, unit = "on p95") {
  if (!baseline) {
    return "n/a";
  }
  const ratio = ((value - baseline) / baseline) * 100;
  return `${ratio >= 0 ? "+" : ""}${ratio.toFixed(0)}% ${unit}`;
}

function megabytes(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

function bundleSizes() {
  const distinct = {};
  const dist = path.join(repositoryRoot, "dist");
  if (existsSync(dist)) {
    for (const name of readdirSync(dist).filter((file) => file.endsWith(".js"))) {
      distinct[name] = (statSync(path.join(dist, name)).size / 1024 / 1024).toFixed(1);
    }
  }
  for (const name of readdirSync(repositoryRoot).filter((file) => file.endsWith(".vsix"))) {
    distinct[name] = (statSync(path.join(repositoryRoot, name)).size / 1024 / 1024).toFixed(1);
  }
  return distinct;
}

/** A document store with nothing open; every file is read from disk. */
function emptyOpenDocuments() {
  const store = new OpenDocuments({
    get: () => undefined,
    all: () => [],
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
  store.listen();
  return store;
}

function parseArguments(argv) {
  const parsed = { json: false, reindexes: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project") {
      parsed.project = path.resolve(argv[++index]);
    } else if (argv[index] === "--samples") {
      parsed.samples = Number(argv[++index]);
    } else if (argv[index] === "--reindexes") {
      parsed.reindexes = Number(argv[++index]);
    } else if (argv[index] === "--json") {
      parsed.json = true;
    }
  }
  return parsed;
}
