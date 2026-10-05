import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a remote already exists.
 */
export class RemoteAlreadyExistsError extends GitApiError {
  readonly remoteName: string;

  constructor(remoteName: string, message?: string) {
    super(message ?? `Remote '${remoteName}' already exists`);
    this.name = "RemoteAlreadyExistsError";
    this.remoteName = remoteName;
  }
}

/**
 * Thrown when a remote does not exist.
 */
export class RemoteNotFoundError extends GitApiError {
  readonly remoteName: string;

  constructor(remoteName: string, message?: string) {
    super(message ?? `Remote '${remoteName}' does not exist`);
    this.name = "RemoteNotFoundError";
    this.remoteName = remoteName;
  }
}
