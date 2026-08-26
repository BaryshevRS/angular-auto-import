/**
 * The logging surface core modules may depend on.
 *
 * Deliberately the subset the extension's own logger already implements, so the
 * Extension Host passes that logger straight through while a language server can
 * supply a connection-backed one.
 * @module
 */

/** Structured logging, with no transport or configuration of its own. */
export interface CoreLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

/** Discards everything; the default when a caller does not care about logs. */
export const silentLogger: CoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let sharedLoggerInstance: CoreLogger = silentLogger;

/**
 * Installs the logger the shared analysis helpers report through.
 *
 * Those helpers are plain functions called from every layer, so threading a logger
 * through each of them would say nothing useful. Each runtime installs its own logger
 * once at startup instead; until then the helpers stay silent rather than reaching for
 * an editor-bound one.
 * @param logger The logger to report through from now on.
 */
export function installSharedLogger(logger: CoreLogger): void {
  sharedLoggerInstance = logger;
}

/** The logger the shared analysis helpers report through. */
export function sharedLogger(): CoreLogger {
  return sharedLoggerInstance;
}

/** Process resource usage, as long-running work reports it around its phases. */
export interface PerformanceMetrics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
}

/**
 * Logging plus the timing and resource reporting that long-running work needs.
 *
 * Again the subset the extension's own logger already implements, so the Extension
 * Host passes its logger straight through.
 */
export interface InstrumentedLogger extends CoreLogger {
  startTimer(name: string): void;
  stopTimer(name: string): void;
  getPerformanceMetrics(): PerformanceMetrics;
}

/**
 * Adds timing and metrics to any logger, reporting each finished timer through it.
 * @param base The logger the timings are written to.
 */
export function withInstrumentation(base: CoreLogger): InstrumentedLogger {
  const started = new Map<string, number>();

  return {
    ...base,
    startTimer: (name) => {
      started.set(name, Date.now());
    },
    stopTimer: (name) => {
      const startedAt = started.get(name);
      if (startedAt === undefined) {
        base.warn(`Timer with name '${name}' was stopped but never started.`);
        return;
      }
      started.delete(name);
      base.info(`Execution time for '${name}': ${Date.now() - startedAt}ms`);
    },
    getPerformanceMetrics: () => ({
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
    }),
  };
}
