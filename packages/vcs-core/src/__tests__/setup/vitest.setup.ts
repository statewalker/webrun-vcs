import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { cleanupAllTempDirs } from "../utils/temp-dir.js";

// Global setup
beforeAll(async () => {
  // Ensure required polyfills
  if (typeof crypto === "undefined") {
    // Use Node.js crypto
    const { webcrypto } = await import("node:crypto");
    globalThis.crypto = webcrypto as Crypto;
  }

  // Set test environment variables
  process.env.VCS_TEST_MODE = "true";
});

// Cleanup after each test
afterEach(async () => {
  // Clear any test state
});

// Global teardown
afterAll(async () => {
  // Clean up all temp directories
  await cleanupAllTempDirs();
});

// Extend Vitest matchers
expect.extend({
  toBeValidObjectId(received) {
    const pass = typeof received === "string" && /^[0-9a-f]{40}$/.test(received);
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be a valid object ID`
          : `expected ${received} to be a valid object ID (40 hex chars)`,
    };
  },
});

// Extend TypeScript types for custom matchers
declare module "vitest" {
  interface Assertion<T = any> {
    toBeValidObjectId(): T;
  }
  interface AsymmetricMatchersContaining {
    toBeValidObjectId(): any;
  }
}
