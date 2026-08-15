export interface Disposable {
  dispose(): void;
}

export type EventSource<T> = (listener: (event: T) => unknown) => Disposable;

const disposedSubscription: Disposable = {
  dispose() {
    // Already detached; disposal is intentionally idempotent.
  },
};

/** Small synchronous event primitive shared by the Extension Host and language server. */
export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(event: T) => unknown>();
  private isDisposed = false;

  public readonly event: EventSource<T> = (listener) => {
    if (this.isDisposed) {
      return disposedSubscription;
    }

    this.listeners.add(listener);
    let isSubscriptionDisposed = false;
    return {
      dispose: () => {
        if (isSubscriptionDisposed) {
          return;
        }
        isSubscriptionDisposed = true;
        this.listeners.delete(listener);
      },
    };
  };

  public fire(event: T): void {
    if (this.isDisposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.listeners.clear();
  }
}
