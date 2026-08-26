import * as assert from "node:assert";
import { type CoreLogger, withInstrumentation } from "../../core/logging";

function recordingLogger(): { logger: CoreLogger; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      debug: (message) => messages.push(`debug: ${message}`),
      info: (message) => messages.push(`info: ${message}`),
      warn: (message) => messages.push(`warn: ${message}`),
      error: (message) => messages.push(`error: ${message}`),
    },
  };
}

describe("Instrumented logging", () => {
  it("reports a finished timer through the logger it wraps", () => {
    const { logger, messages } = recordingLogger();
    const instrumented = withInstrumentation(logger);

    instrumented.startTimer("full index");
    instrumented.stopTimer("full index");

    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /^info: Execution time for 'full index': \d+ms$/);
  });

  it("warns about a timer that was never started, without throwing", () => {
    const { logger, messages } = recordingLogger();
    const instrumented = withInstrumentation(logger);

    instrumented.stopTimer("never started");

    assert.deepStrictEqual(messages, ["warn: Timer with name 'never started' was stopped but never started."]);
  });

  it("does not report the same timer twice", () => {
    const { logger, messages } = recordingLogger();
    const instrumented = withInstrumentation(logger);

    instrumented.startTimer("index");
    instrumented.stopTimer("index");
    instrumented.stopTimer("index");

    assert.strictEqual(messages.length, 2);
    assert.match(messages[1], /^warn: /);
  });

  it("keeps concurrent timers apart and passes plain logging through", () => {
    const { logger, messages } = recordingLogger();
    const instrumented = withInstrumentation(logger);

    instrumented.startTimer("outer");
    instrumented.startTimer("inner");
    instrumented.stopTimer("inner");
    instrumented.info("between");
    instrumented.stopTimer("outer");

    assert.strictEqual(messages.length, 3);
    assert.match(messages[0], /'inner'/);
    assert.strictEqual(messages[1], "info: between");
    assert.match(messages[2], /'outer'/);
  });

  it("reports real process metrics", () => {
    const metrics = withInstrumentation(recordingLogger().logger).getPerformanceMetrics();

    assert.ok(metrics.memoryUsage.heapUsed > 0);
    assert.ok(metrics.cpuUsage.user >= 0);
  });
});
