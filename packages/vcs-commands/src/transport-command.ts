import type { Credentials, ProgressInfo } from "@statewalker/vcs-transport";

import { GitCommand } from "./git-command.js";

/**
 * Progress callback type for transport operations.
 */
export type ProgressCallback = (info: ProgressInfo) => void;

/**
 * Options for transport operations.
 */
export interface TransportOptions {
  /** Authentication credentials */
  auth?: Credentials;
  /** Custom HTTP headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Progress callback */
  onProgress?: ProgressCallback;
  /** Raw progress message callback */
  onProgressMessage?: (message: string) => void;
}

/**
 * Base class for commands that require network transport.
 *
 * Adds authentication, timeout, and progress support on top of GitCommand.
 * Based on JGit's TransportCommand<C, R>.
 *
 * @typeParam T - The return type of the command's call() method
 */
export abstract class TransportCommand<T> extends GitCommand<T> {
  /** Authentication credentials */
  protected credentials?: Credentials;
  /** Request timeout in milliseconds */
  protected timeout?: number;
  /** Custom HTTP headers */
  protected headers?: Record<string, string>;
  /** Progress callback */
  protected progressCallback?: ProgressCallback;
  /** Progress message callback */
  protected progressMessageCallback?: (message: string) => void;

  /**
   * Set authentication credentials.
   *
   * @param credentials Username/password or token credentials
   */
  setCredentials(credentials: Credentials): this {
    this.checkCallable();
    this.credentials = credentials;
    return this;
  }

  /**
   * Set authentication using username and password.
   *
   * @param username Username
   * @param password Password
   */
  setCredentialsProvider(username: string, password: string): this {
    this.checkCallable();
    this.credentials = { username, password };
    return this;
  }

  /**
   * Set request timeout.
   *
   * @param timeout Timeout in milliseconds
   */
  setTimeout(timeout: number): this {
    this.checkCallable();
    this.timeout = timeout;
    return this;
  }

  /**
   * Set custom HTTP headers.
   *
   * @param headers Custom headers
   */
  setHeaders(headers: Record<string, string>): this {
    this.checkCallable();
    this.headers = headers;
    return this;
  }

  /**
   * Set progress callback.
   *
   * @param callback Progress callback function
   */
  setProgressMonitor(callback: ProgressCallback): this {
    this.checkCallable();
    this.progressCallback = callback;
    return this;
  }

  /**
   * Set progress message callback.
   *
   * @param callback Progress message callback function
   */
  setProgressMessageCallback(callback: (message: string) => void): this {
    this.checkCallable();
    this.progressMessageCallback = callback;
    return this;
  }

  /**
   * Get transport options for passing to transport operations.
   */
  protected getTransportOptions(): TransportOptions {
    return {
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      onProgress: this.progressCallback,
      onProgressMessage: this.progressMessageCallback,
    };
  }
}
