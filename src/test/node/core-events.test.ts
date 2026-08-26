import * as assert from "node:assert";
import { Emitter } from "../../core/events";

describe("core events", () => {
  it("notifies active listeners in subscription order", () => {
    const emitter = new Emitter<number>();
    const received: string[] = [];

    emitter.event((value) => received.push(`first:${value}`));
    emitter.event((value) => received.push(`second:${value}`));
    emitter.fire(7);

    assert.deepStrictEqual(received, ["first:7", "second:7"]);
  });

  it("stops notifying a disposed subscription", () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    const subscription = emitter.event(() => calls++);

    subscription.dispose();
    emitter.fire();

    assert.strictEqual(calls, 0);
  });

  it("clears every subscription when the emitter is disposed", () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    emitter.event(() => calls++);

    emitter.dispose();
    emitter.fire();
    emitter.event(() => calls++);
    emitter.fire();

    assert.strictEqual(calls, 0);
  });
});
