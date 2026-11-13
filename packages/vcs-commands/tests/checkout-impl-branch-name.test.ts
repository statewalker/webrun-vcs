import { describe, expect, it } from "vitest";
import { CheckoutCommand, type CheckoutCommandOptions } from "../src/core-commands/index.js";
import { InvalidRefNameError } from "../src/errors/index.js";

describe("core CheckoutCommand createBranch", () => {
  it("refuses a branch name git refuses before touching any store", async () => {
    // Every store throws if used: the name check must come first.
    const untouchable = new Proxy(
      {},
      {
        get: (_t, prop) => {
          throw new Error(`store used: ${String(prop)}`);
        },
      },
    );
    const checkout = new CheckoutCommand(
      new Proxy({} as CheckoutCommandOptions, { get: () => untouchable }),
    );
    for (const name of ["a/.hidden", "HEAD", "-x"]) {
      await expect(checkout.checkout("main", { createBranch: name }), name).rejects.toThrow(
        InvalidRefNameError,
      );
    }
  });
});
