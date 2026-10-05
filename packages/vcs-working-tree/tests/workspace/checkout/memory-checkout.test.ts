/**
 * Tests for MemoryCheckout implementation
 *
 * Runs conformance tests against the in-memory Checkout implementation.
 */

import type { Checkout } from "../../../src/checkout/checkout.js";
import { MemoryCheckout } from "../../../src/checkout/memory-checkout.js";
import { createMemoryGitStaging } from "../../../src/staging/git-staging.js";
import type { Staging } from "../../../src/staging/staging.js";
import { checkoutConformanceTests } from "./checkout.conformance.test.js";

let checkout: MemoryCheckout;
let staging: Staging;

checkoutConformanceTests(
  "MemoryCheckout",
  async (): Promise<Checkout> => {
    staging = createMemoryGitStaging();
    checkout = new MemoryCheckout({
      staging,
    });
    return checkout;
  },
  async (): Promise<void> => {
    // No cleanup needed for in-memory implementation
  },
);
