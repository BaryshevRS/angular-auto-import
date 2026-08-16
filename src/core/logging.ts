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
