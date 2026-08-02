/**
 * =================================================================================================
 * Utility Functions Tests
 * =================================================================================================
 *
 * Tests for utility functions used throughout the extension.
 */

import * as assert from "node:assert";
import { debounce } from "../../utils";

describe("Utility Functions", function () {
  // Set timeout for all tests in this suite
  this.timeout(5000);

  describe("debounce", () => {
    it("coalesces a burst into one trailing invocation", async () => {
      let calls = 0;
      const debounced = debounce(() => {
        calls++;
      }, 10);

      debounced();
      debounced();
      debounced();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.strictEqual(calls, 1);
    });

    it("can cancel a pending invocation", async () => {
      let calls = 0;
      const debounced = debounce(() => {
        calls++;
      }, 10);

      debounced();
      debounced.cancel();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.strictEqual(calls, 0);
    });
  });
});
