import * as assert from "node:assert";
import { createCancellationSource, neverCancelled } from "../../core/cancellation";

describe("Cancellation", () => {
  it("starts uncancelled and fires once cancelled", () => {
    const source = createCancellationSource();

    assert.strictEqual(source.signal.isCancelled, false);
    source.cancel();
    assert.strictEqual(source.signal.isCancelled, true);
  });

  it("stays cancelled after repeated cancellation", () => {
    const source = createCancellationSource();

    source.cancel();
    source.cancel();

    assert.strictEqual(source.signal.isCancelled, true);
  });

  it("shares one state with everything holding the signal", () => {
    const source = createCancellationSource();
    const holder = source.signal;

    source.cancel();

    assert.strictEqual(holder.isCancelled, true, "A signal captured earlier must observe the cancellation");
  });

  it("never fires the shared no-op signal", () => {
    assert.strictEqual(neverCancelled.isCancelled, false);
  });
});
