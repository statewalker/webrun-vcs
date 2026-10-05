/**
 * Error Recovery FSM.
 *
 * Provides error handling, retry, reconnection, and cleanup capabilities.
 * These transitions can be merged with any protocol FSM to add error recovery.
 *
 * Wildcard semantics:
 * - "*" as source state: Matches any state (checked after exact match fails)
 * - "*" as target state: Return to previous state (stored in FSM.previousState)
 */

import type { ProcessContext } from "../../context/process-context.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";

/**
 * Error recovery FSM transitions.
 *
 * These transitions use wildcards to catch errors from any state.
 * Merge with protocol-specific transitions for full error handling.
 *
 * @example
 * ```ts
 * const fullTransitions = [
 *   ...clientV2Transitions,
 *   ...errorRecoveryTransitions,
 * ];
 * ```
 */
export const errorRecoveryTransitions: FsmTransition[] = [
  // Protocol error handling ("*" source = from any state)
  ["*", "PROTOCOL_ERROR", "HANDLE_PROTOCOL_ERROR"],
  ["HANDLE_PROTOCOL_ERROR", "RECOVERABLE", "RETRY_OPERATION"],
  ["HANDLE_PROTOCOL_ERROR", "FATAL", "CLEANUP"],

  // Transport error handling
  ["*", "TRANSPORT_ERROR", "HANDLE_TRANSPORT_ERROR"],
  ["HANDLE_TRANSPORT_ERROR", "RECONNECT", "ATTEMPTING_RECONNECT"],
  ["HANDLE_TRANSPORT_ERROR", "FATAL", "CLEANUP"],

  // Reconnection
  ["ATTEMPTING_RECONNECT", "CONNECTED", "RESTORE_STATE"],
  ["ATTEMPTING_RECONNECT", "FAILED", "CLEANUP"],
  ["RESTORE_STATE", "RESTORED", "*"], // Return to previous state

  // Timeout handling
  ["*", "TIMEOUT", "HANDLE_TIMEOUT"],
  ["HANDLE_TIMEOUT", "RETRY", "RETRY_OPERATION"],
  ["HANDLE_TIMEOUT", "ABORT", "CLEANUP"],

  // Pack error handling
  ["*", "PACK_ERROR", "HANDLE_PACK_ERROR"],
  ["HANDLE_PACK_ERROR", "FATAL", "CLEANUP"],

  // Validation error handling
  ["*", "VALIDATION_ERROR", "HANDLE_VALIDATION_ERROR"],
  ["HANDLE_VALIDATION_ERROR", "FATAL", "CLEANUP"],

  // Retry logic
  ["RETRY_OPERATION", "RETRY_OK", "*"], // Return to previous state
  ["RETRY_OPERATION", "MAX_RETRIES", "CLEANUP"],

  // Cleanup and exit
  ["CLEANUP", "CLEANED", ""],
];

/**
 * Error recovery FSM handlers.
 *
 * Merge with protocol-specific handlers for full error handling.
 *
 * @example
 * ```ts
 * const fullHandlers = new Map([
 *   ...clientV2Handlers,
 *   ...errorRecoveryHandlers,
 * ]);
 * ```
 */
export const errorRecoveryHandlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Handle protocol errors
  [
    "HANDLE_PROTOCOL_ERROR",
    async (ctx) => {
      const error = ctx.output.errorInfo;

      // Log error
      ctx.config.onProgress?.(`Protocol error: ${error?.message ?? ctx.output.error}`);

      // Check if recoverable
      if (error?.recoverable && (ctx.output.retryCount ?? 0) < (ctx.config.maxRetries ?? 3)) {
        return "RECOVERABLE";
      }

      return "FATAL";
    },
  ],

  // Handle transport errors
  [
    "HANDLE_TRANSPORT_ERROR",
    async (ctx) => {
      const error = ctx.output.errorInfo;

      ctx.config.onProgress?.(`Transport error: ${error?.message ?? ctx.output.error}`);

      // Check if reconnectable
      if (ctx.config.allowReconnect && error?.retryable && ctx.config.reconnect) {
        return "RECONNECT";
      }

      return "FATAL";
    },
  ],

  // Attempt reconnection
  [
    "ATTEMPTING_RECONNECT",
    async (ctx) => {
      try {
        ctx.config.onProgress?.("Attempting to reconnect...");

        // Close old connection if possible
        if ("close" in ctx.transport && typeof ctx.transport.close === "function") {
          await (ctx.transport as { close: () => Promise<void> }).close();
        }

        // Reconnect
        const newDuplex = await ctx.config.reconnect?.();
        if (!newDuplex) {
          ctx.output.error = "Reconnection failed: no new connection";
          return "FAILED";
        }

        // Note: The caller must update ctx.transport with the new connection
        // We store the new duplex in output for the caller to use
        (ctx.output as { newDuplex?: unknown }).newDuplex = newDuplex;

        ctx.config.onProgress?.("Reconnected successfully");
        return "CONNECTED";
      } catch (e) {
        ctx.output.error = `Reconnection failed: ${e instanceof Error ? e.message : String(e)}`;
        return "FAILED";
      }
    },
  ],

  // Restore state after reconnect
  [
    "RESTORE_STATE",
    async (ctx) => {
      // Restore checkpointed state
      if (ctx.state.restoreCheckpoint()) {
        ctx.config.onProgress?.("State restored from checkpoint");
      }
      return "RESTORED";
    },
  ],

  // Handle timeouts
  [
    "HANDLE_TIMEOUT",
    async (ctx) => {
      ctx.config.onProgress?.(`Timeout: ${ctx.output.errorInfo?.message ?? ctx.output.error}`);

      if ((ctx.output.retryCount ?? 0) < (ctx.config.maxRetries ?? 3)) {
        return "RETRY";
      }
      return "ABORT";
    },
  ],

  // Handle pack errors
  [
    "HANDLE_PACK_ERROR",
    async (ctx) => {
      ctx.config.onProgress?.(`Pack error: ${ctx.output.errorInfo?.message ?? ctx.output.error}`);
      // Pack errors are generally not recoverable
      return "FATAL";
    },
  ],

  // Handle validation errors
  [
    "HANDLE_VALIDATION_ERROR",
    async (ctx) => {
      ctx.config.onProgress?.(
        `Validation error: ${ctx.output.errorInfo?.message ?? ctx.output.error}`,
      );
      // Validation errors are not recoverable
      return "FATAL";
    },
  ],

  // Retry operation
  [
    "RETRY_OPERATION",
    async (ctx) => {
      ctx.output.retryCount = (ctx.output.retryCount ?? 0) + 1;

      if (ctx.output.retryCount >= (ctx.config.maxRetries ?? 3)) {
        return "MAX_RETRIES";
      }

      // Exponential backoff with jitter
      const baseDelay = 1000;
      const maxDelay = 30000;
      const delay = Math.min(baseDelay * 2 ** ctx.output.retryCount, maxDelay);
      const jitter = Math.random() * 0.3 * delay;
      const totalDelay = delay + jitter;

      ctx.config.onProgress?.(
        `Retrying in ${Math.round(totalDelay / 1000)}s (attempt ${ctx.output.retryCount}/${ctx.config.maxRetries ?? 3})`,
      );

      await new Promise((resolve) => setTimeout(resolve, totalDelay));

      return "RETRY_OK";
    },
  ],

  // Cleanup
  [
    "CLEANUP",
    async (ctx) => {
      try {
        ctx.config.onProgress?.("Cleaning up...");

        // Run rollback if provided
        if (ctx.output.rollback) {
          await ctx.output.rollback();
        }

        // Close transport if possible
        if ("close" in ctx.transport && typeof ctx.transport.close === "function") {
          await (ctx.transport as { close: () => Promise<void> }).close();
        }

        ctx.config.onProgress?.("Cleanup complete");
        return "CLEANED";
      } catch (e) {
        // Log but don't fail - we're already cleaning up
        ctx.config.onProgress?.(`Cleanup error: ${e instanceof Error ? e.message : String(e)}`);
        return "CLEANED";
      }
    },
  ],
]);

/**
 * Merges error recovery transitions with protocol transitions.
 *
 * Protocol-specific transitions are checked first, then error recovery
 * transitions (which use wildcards).
 *
 * @param protocolTransitions - Protocol-specific transitions
 * @returns Combined transitions with error recovery
 */
export function withErrorRecovery(protocolTransitions: FsmTransition[]): FsmTransition[] {
  return [...protocolTransitions, ...errorRecoveryTransitions];
}

/**
 * Merges error recovery handlers with protocol handlers.
 *
 * @param protocolHandlers - Protocol-specific handlers
 * @returns Combined handlers with error recovery
 */
export function withErrorRecoveryHandlers(
  protocolHandlers: Map<string, FsmStateHandler<ProcessContext>>,
): Map<string, FsmStateHandler<ProcessContext>> {
  return new Map([...protocolHandlers, ...errorRecoveryHandlers]);
}
