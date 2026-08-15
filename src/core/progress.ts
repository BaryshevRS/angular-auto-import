/** A single progress notification emitted by a long-running operation. */
export interface ProgressUpdate {
  /** Human-readable description of the current step. */
  message?: string;
  /** Share of the total work completed by this step, in percent (0-100). */
  increment?: number;
}

/** Receives progress notifications for an operation the host already started. */
export interface ProgressReporter {
  report(update: ProgressUpdate): void;
}

/**
 * Starts and ends progress scopes.
 *
 * Increments are relative, matching how the indexer reports work; hosts that need
 * an absolute percentage (LSP work-done progress) accumulate them in their adapter.
 */
export interface ProgressHost {
  withProgress<T>(title: string, task: (reporter: ProgressReporter) => Promise<T>): Promise<T>;
}

/** Discards every update; the default when no host wants to surface progress. */
export const silentProgressReporter: ProgressReporter = {
  report() {
    // Intentionally empty: progress is optional for callers that run headless.
  },
};

/** Runs work without surfacing progress anywhere. */
export const silentProgressHost: ProgressHost = {
  withProgress: (_title, task) => task(silentProgressReporter),
};
