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
 * Thrown when git would refuse a reset (`--merge`, `--keep`, a soft or keep reset in the
 * middle of a merge) before anything is changed: git's message, and the paths it names.
 */
export class ResetRefusedError extends GitApiError {
  readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = "ResetRefusedError";
    this.paths = paths;
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

/**
 * Thrown where git dies on loading its configuration, before a command runs (an unknown
 * `core.disambiguate`): git's `error:` and `fatal:` lines as the message.
 */
export class InvalidConfigError extends GitApiError {
  /** The variable git refused */
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "InvalidConfigError";
    this.key = key;
  }
}
