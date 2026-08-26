import type { CancellationToken } from "vscode-languageserver/node";
import type { CancellationSignal } from "../../core/cancellation";

/**
 * Adapts a request's cancellation token to the core's cooperative signal.
 *
 * Read through rather than copied: a token flips after the analysis has already
 * started, and a snapshot taken at the boundary would never see it.
 */
export function toCancellationSignal(token: CancellationToken): CancellationSignal {
  return {
    get isCancelled(): boolean {
      return token.isCancellationRequested;
    },
  };
}
