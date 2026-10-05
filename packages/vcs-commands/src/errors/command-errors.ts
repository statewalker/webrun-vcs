import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a required command argument is missing.
 */
export class MissingArgumentError extends GitApiError {
  readonly argumentName: string;

  constructor(argumentName: string, message?: string) {
    super(message ?? `Missing required argument: ${argumentName}`);
    this.name = "MissingArgumentError";
    this.argumentName = argumentName;
  }
}

/**
 * Thrown when a command argument has an invalid value.
 */
export class InvalidArgumentError extends GitApiError {
  readonly argumentName: string;
  readonly value: unknown;

  constructor(argumentName: string, value: unknown, message?: string) {
    super(message ?? `Invalid value for ${argumentName}: ${value}`);
    this.name = "InvalidArgumentError";
    this.argumentName = argumentName;
    this.value = value;
  }
}

/**
 * Thrown when incompatible command options are used together.
 */
export class IncompatibleOptionsError extends GitApiError {
  readonly options: string[];

  constructor(options: string[], message?: string) {
    super(message ?? `Cannot combine options: ${options.join(", ")}`);
    this.name = "IncompatibleOptionsError";
    this.options = options;
  }
}

/**
 * Thrown when a feature is not yet implemented.
 */
export class NotImplementedError extends GitApiError {
  readonly feature: string;

  constructor(feature: string, message?: string) {
    super(message ?? `${feature} is not yet implemented`);
    this.name = "NotImplementedError";
    this.feature = feature;
  }
}

/**
 * Thrown when a required store or service is not available.
 */
export class StoreNotAvailableError extends GitApiError {
  readonly storeName: string;

  constructor(storeName: string, message?: string) {
    super(message ?? `${storeName} is not available`);
    this.name = "StoreNotAvailableError";
    this.storeName = storeName;
  }
}
