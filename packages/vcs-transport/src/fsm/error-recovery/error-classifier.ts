/**
 * Error classification utility.
 *
 * Classifies runtime errors into categories for the error recovery FSM.
 */

import type { ErrorCategory } from "../../context/handler-output.js";
import type { ProcessContext } from "../../context/process-context.js";

/**
 * Error event types returned by classifyError.
 */
export type ErrorEvent =
  | "PROTOCOL_ERROR"
  | "TRANSPORT_ERROR"
  | "TIMEOUT"
  | "PACK_ERROR"
  | "VALIDATION_ERROR";

/**
 * Classifies an error and populates ctx.output.errorInfo.
 *
 * Call this in error handlers instead of just setting ctx.output.error.
 * Returns the appropriate error event for FSM transition.
 *
 * @example
 * ```ts
 * catch (e) {
 *   return classifyError(ctx, e);
 * }
 * ```
 *
 * @param ctx - Process context to update
 * @param error - The error to classify
 * @returns Error event for FSM transition
 */
export function classifyError(ctx: ProcessContext, error: unknown): ErrorEvent {
  const message = error instanceof Error ? error.message : String(error);
  ctx.output.error = message;

  // Timeout errors
  if (
    message.includes("timeout") ||
    message.includes("Timeout") ||
    message.includes("timed out") ||
    message.includes("ETIMEDOUT")
  ) {
    ctx.output.errorInfo = {
      category: "TIMEOUT" as ErrorCategory,
      message,
      recoverable: true,
      retryable: true,
    };
    return "TIMEOUT";
  }

  // Transport/connection errors
  if (
    message.includes("connection") ||
    message.includes("Connection") ||
    message.includes("ECONNRESET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("EPIPE") ||
    message.includes("socket") ||
    message.includes("network") ||
    message.includes("Network")
  ) {
    ctx.output.errorInfo = {
      category: "TRANSPORT_ERROR" as ErrorCategory,
      message,
      recoverable: true,
      retryable: ctx.config.allowReconnect ?? false,
    };
    return "TRANSPORT_ERROR";
  }

  // Pack errors
  if (
    message.includes("pack") ||
    message.includes("Pack") ||
    message.includes("corrupt") ||
    message.includes("checksum") ||
    message.includes("invalid object")
  ) {
    ctx.output.errorInfo = {
      category: "PACK_ERROR" as ErrorCategory,
      message,
      recoverable: false,
      retryable: false,
    };
    return "PACK_ERROR";
  }

  // Validation errors
  if (
    message.includes("invalid") ||
    message.includes("Invalid") ||
    message.includes("not found") ||
    message.includes("unknown ref") ||
    message.includes("rejected")
  ) {
    ctx.output.errorInfo = {
      category: "VALIDATION_ERROR" as ErrorCategory,
      message,
      recoverable: false,
      retryable: false,
    };
    return "VALIDATION_ERROR";
  }

  // Default: protocol error (not recoverable)
  ctx.output.errorInfo = {
    category: "PROTOCOL_ERROR" as ErrorCategory,
    message,
    recoverable: false,
    retryable: false,
  };
  return "PROTOCOL_ERROR";
}

/**
 * Creates an error info object without modifying context.
 *
 * Useful for testing or when you need to check error category
 * before deciding how to handle it.
 *
 * @param message - Error message to classify
 * @param allowReconnect - Whether reconnection is allowed
 * @returns Error info object
 */
export function createErrorInfo(
  message: string,
  allowReconnect = false,
): { category: ErrorCategory; event: ErrorEvent; recoverable: boolean; retryable: boolean } {
  // Timeout
  if (message.includes("timeout") || message.includes("Timeout") || message.includes("timed out")) {
    return {
      category: "TIMEOUT",
      event: "TIMEOUT",
      recoverable: true,
      retryable: true,
    };
  }

  // Transport
  if (
    message.includes("connection") ||
    message.includes("Connection") ||
    message.includes("socket") ||
    message.includes("network")
  ) {
    return {
      category: "TRANSPORT_ERROR",
      event: "TRANSPORT_ERROR",
      recoverable: true,
      retryable: allowReconnect,
    };
  }

  // Pack
  if (message.includes("pack") || message.includes("corrupt") || message.includes("checksum")) {
    return {
      category: "PACK_ERROR",
      event: "PACK_ERROR",
      recoverable: false,
      retryable: false,
    };
  }

  // Validation
  if (
    message.includes("invalid") ||
    message.includes("not found") ||
    message.includes("rejected")
  ) {
    return {
      category: "VALIDATION_ERROR",
      event: "VALIDATION_ERROR",
      recoverable: false,
      retryable: false,
    };
  }

  // Default: protocol error
  return {
    category: "PROTOCOL_ERROR",
    event: "PROTOCOL_ERROR",
    recoverable: false,
    retryable: false,
  };
}
