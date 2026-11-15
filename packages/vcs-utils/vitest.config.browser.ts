import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Vitest browser mode configuration for vcs-utils
 *
 * Runs a subset of tests in a real browser environment to verify
 * WinterTC/WinterCG compliance (Web Platform API compatibility).
 *
 * Run with: pnpm test:browser
 */
export default defineConfig({
  test: {
    browser: {
      enabled: true,
      // No display on CI runners (nor in containers): a headed browser exits at launch.
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
    include: ["tests/browser/**/*.test.ts"],
  },
});
