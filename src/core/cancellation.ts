/**
 * Cooperative cancellation for work that runs long enough to outlive its reason.
 *
 * A full index walks thousands of files; by the time it finishes, its project may have
 * left the workspace or the server may be shutting down. Long operations check the
 * signal between units of work instead of being interrupted, so the index is never
 * left half-written.
 * @module
 */

/** Reports whether the work that owns it should stop. */
export interface CancellationSignal {
  readonly isCancelled: boolean;
}

/** Hands out a signal and owns the single decision to fire it. */
export interface CancellationSource {
  readonly signal: CancellationSignal;
  /** Tells everything holding the signal to stop at its next checkpoint. */
  cancel(): void;
}

/** A signal that never fires; the default for callers that do not cancel. */
export const neverCancelled: CancellationSignal = { isCancelled: false };

/** Creates a source whose signal can be handed to long-running work. */
export function createCancellationSource(): CancellationSource {
  let cancelled = false;

  return {
    signal: {
      get isCancelled(): boolean {
        return cancelled;
      },
    },
    cancel(): void {
      cancelled = true;
    },
  };
}
