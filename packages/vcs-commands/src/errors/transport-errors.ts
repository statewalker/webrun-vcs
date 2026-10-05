import { GitApiError } from "./git-api-error.js";

/**
 * Error thrown when a remote cannot be resolved.
 *
 * Based on JGit's InvalidRemoteException.
 */
export class InvalidRemoteError extends GitApiError {
  readonly remote: string;

  constructor(remote: string, message?: string) {
    super(message ?? `Invalid remote: ${remote}`);
    this.name = "InvalidRemoteError";
    this.remote = remote;
  }
}

/**
 * Error thrown when a transport operation fails.
 *
 * Based on JGit's TransportException.
 */
export class TransportError extends GitApiError {
  readonly uri?: string;

  constructor(message: string, uri?: string) {
    super(uri ? `${uri}: ${message}` : message);
    this.name = "TransportError";
    this.uri = uri;
  }
}

/**
 * Error thrown when authentication fails.
 */
export class AuthenticationError extends TransportError {
  constructor(uri: string, message?: string) {
    super(message ?? "Authentication failed", uri);
    this.name = "AuthenticationError";
  }
}

/**
 * Error thrown when a push is rejected.
 *
 * Based on JGit's RejectedCommandException.
 */
export class PushRejectedException extends TransportError {
  readonly refName: string;
  readonly reason: string;

  constructor(refName: string, reason: string, uri?: string) {
    super(`${refName}: ${reason}`, uri);
    this.name = "PushRejectedException";
    this.refName = refName;
    this.reason = reason;
  }
}

/**
 * Error thrown when push is not allowed (non-fast-forward without force).
 */
export class NonFastForwardError extends PushRejectedException {
  constructor(refName: string, uri?: string) {
    super(refName, "non-fast-forward update rejected", uri);
    this.name = "NonFastForwardError";
  }
}
