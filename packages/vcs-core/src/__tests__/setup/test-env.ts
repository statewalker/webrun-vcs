/**
 * Test environment configuration.
 *
 * This file provides environment-specific configuration for tests.
 */

/**
 * Check if we're running in test mode.
 */
export function isTestMode(): boolean {
  return process.env.VCS_TEST_MODE === "true";
}

/**
 * Get test configuration.
 */
export function getTestConfig() {
  return {
    /**
     * Whether to run tests that require native git.
     */
    enableGitInteropTests: process.env.VCS_TEST_GIT_INTEROP === "true",

    /**
     * Whether to run slow/performance tests.
     */
    enableSlowTests: process.env.VCS_TEST_SLOW === "true",

    /**
     * Test timeout in milliseconds.
     */
    testTimeout: parseInt(process.env.VCS_TEST_TIMEOUT ?? "5000", 10),

    /**
     * Whether to enable verbose test output.
     */
    verbose: process.env.VCS_TEST_VERBOSE === "true",
  };
}

/**
 * Skip test if condition is not met.
 */
export function skipIf(
  condition: boolean,
  reason: string,
): (fn: () => Promise<void>) => () => Promise<void> {
  return (fn: () => Promise<void>) => {
    return async () => {
      if (condition) {
        console.log(`Skipping: ${reason}`);
        return;
      }
      await fn();
    };
  };
}
