/**
 * Test logging utility
 *
 * Provides console.log-like functionality that can be controlled via environment variable.
 * By default, logs are suppressed. Set DEBUG_TESTS=1 or VERBOSE_TESTS=1 to enable logging.
 *
 * Usage:
 *   import { testLog } from '../test-logger.js';
 *   testLog('Message', value);
 */

const isDebugEnabled =
  process.env.DEBUG_TESTS === "1" ||
  process.env.VERBOSE_TESTS === "1" ||
  process.env.DEBUG_TESTS === "true" ||
  process.env.VERBOSE_TESTS === "true";

/**
 * Log a message to console only if DEBUG_TESTS or VERBOSE_TESTS environment variable is set
 * @param args Arguments to pass to console.log
 */
export function testLog(...args: unknown[]): void {
  if (isDebugEnabled) {
    console.log(...args);
  }
}

/**
 * Check if test logging is enabled
 * @returns true if DEBUG_TESTS or VERBOSE_TESTS is set
 */
export function isTestLogEnabled(): boolean {
  return isDebugEnabled;
}
