import { execSync } from "node:child_process";

/**
 * Migration testing protocol checklist.
 *
 * Use this before and after each migration step.
 */
export interface MigrationCheckpoint {
  testsPassing: boolean;
  coveragePercent: number;
  benchmarkResults?: Record<string, number>;
  timestamp: Date;
  commit?: string;
}

/**
 * Run all tests and capture results.
 */
export async function runTestSuite(): Promise<{
  passing: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}> {
  try {
    const output = execSync("pnpm test --reporter=json", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const results = JSON.parse(output);
    return {
      passing: results.numFailedTests === 0,
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
    };
  } catch (_error) {
    return {
      passing: false,
      total: 0,
      passed: 0,
      failed: 1,
      skipped: 0,
    };
  }
}

/**
 * Capture current coverage.
 */
export async function captureCoverage(): Promise<number> {
  try {
    const output = execSync("pnpm coverage --reporter=json-summary", {
      encoding: "utf8",
    });
    const summary = JSON.parse(output);
    return summary.total.lines.pct;
  } catch {
    return 0;
  }
}

/**
 * Run performance benchmarks.
 */
export async function runBenchmarks(_suite: string): Promise<Record<string, number>> {
  // Implementation depends on benchmark framework
  // For now, return empty object
  return {};
}

/**
 * Create a migration checkpoint.
 */
export async function createCheckpoint(): Promise<MigrationCheckpoint> {
  const testResults = await runTestSuite();
  const coverage = await captureCoverage();

  let commit: string | undefined;
  try {
    commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // Not in a git repository
  }

  return {
    testsPassing: testResults.passing,
    coveragePercent: coverage,
    timestamp: new Date(),
    commit,
  };
}

/**
 * Compare two checkpoints for regression.
 */
export function compareCheckpoints(
  before: MigrationCheckpoint,
  after: MigrationCheckpoint,
): {
  regressions: string[];
  improvements: string[];
} {
  const regressions: string[] = [];
  const improvements: string[] = [];

  if (before.testsPassing && !after.testsPassing) {
    regressions.push("Tests are now failing");
  }

  if (after.coveragePercent < before.coveragePercent - 1) {
    regressions.push(
      `Coverage decreased from ${before.coveragePercent}% to ${after.coveragePercent}%`,
    );
  }

  if (after.coveragePercent > before.coveragePercent + 1) {
    improvements.push(
      `Coverage increased from ${before.coveragePercent}% to ${after.coveragePercent}%`,
    );
  }

  return { regressions, improvements };
}

/**
 * Assert no regressions between checkpoints.
 */
export function assertNoRegressions(before: MigrationCheckpoint, after: MigrationCheckpoint): void {
  const { regressions } = compareCheckpoints(before, after);
  if (regressions.length > 0) {
    throw new Error(`Migration regressions detected:\n${regressions.join("\n")}`);
  }
}
