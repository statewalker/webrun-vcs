import {
  type Credentials,
  createDefaultTransports,
  type GitTransportRegistry,
  type ProgressInfo,
} from "@statewalker/vcs-transport";

import {
  openResolvedRemote,
  type PreparedRemote,
  prepareRemote,
  protocolVersionOf,
  type RemoteSessionOptions,
  type ResolvedRemote,
  remoteContextOf,
  resolveRemote,
} from "./commands/remote-transport.js";
import { GitCommand } from "./git-command.js";
import { RemoteConfigStore } from "./remote-config/index.js";

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
  /** Gzip large fetch request bodies (default true, as git; see `setGzipRequests`) */
  gzipRequests?: boolean;
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
  /** Gzip large fetch request bodies (undefined: the transport's default, true) */
  protected gzipRequests?: boolean;
  /** Progress callback */
  protected progressCallback?: ProgressCallback;
  /** Progress message callback */
  protected progressMessageCallback?: (message: string) => void;
  /** The transports remote URLs are reached through (undefined: the defaults) */
  private transportRegistry?: GitTransportRegistry;

  /**
   * Set the transports non-local remotes are reached through: the registry's connector for a
   * URL opens the session (default `createDefaultTransports()`: smart HTTP over the global
   * `fetch`). Paths and `file://` URLs are always git's local transport.
   *
   * @example
   * ```typescript
   * const transports = createDefaultTransports();
   * transports.register({ name: "peer", schemes: ["peer"], connect: openPeerSession });
   * await git.fetch().setRemote("peer://alice/repo").setTransports(transports).call();
   * ```
   *
   * @param transports The registry
   */
  setTransports(transports: GitTransportRegistry): this {
    this.checkCallable();
    this.transportRegistry = transports;
    return this;
  }

  /** The transports non-local remotes are reached through (see {@link setTransports}). */
  getTransports(): GitTransportRegistry {
    this.transportRegistry ??= createDefaultTransports();
    return this.transportRegistry;
  }

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
   * Send large upload-pack request bodies (a fetch's have-batches over 1024 bytes) gzipped,
   * with `Content-Encoding: gzip`, as git does (default true). Pass false for a browser behind
   * a CORS proxy that does not allow that header (it is not CORS-safelisted).
   *
   * @param gzip Whether to gzip large request bodies
   */
  setGzipRequests(gzip: boolean): this {
    this.checkCallable();
    this.gzipRequests = gzip;
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
   * Resolves a remote URL (already rewritten by `insteadOf`) to the transport that reaches it
   * and opens a local remote's repository (`resolveRemote`): git's errors for a transport
   * `protocol.allow` refuses, a URL nothing here reaches, a path holding no repository.
   */
  protected prepareRemote(url: string): Promise<PreparedRemote> {
    return prepareRemote(this._workingCopy, url, this.getTransports());
  }

  /**
   * {@link prepareRemote} without opening a local repository: the transport is decided (and
   * refused in git's words) now, the repository opened later by {@link openRemote}.
   */
  protected resolveRemote(url: string): ResolvedRemote {
    return resolveRemote(url, remoteContextOf(this._workingCopy, this.getTransports()));
  }

  /** Opens the local repository of a remote {@link resolveRemote} resolved. */
  protected openRemote(resolved: ResolvedRemote): Promise<PreparedRemote> {
    return openResolvedRemote(this._workingCopy, resolved);
  }

  /** How this command talks to a remote: its credentials, headers, timeout, `protocol.version`. */
  protected remoteSessionOptions(): RemoteSessionOptions {
    return {
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
      ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
      ...(this.gzipRequests !== undefined ? { gzipRequests: this.gzipRequests } : {}),
      protocolVersion: protocolVersionOf(RemoteConfigStore.from(this._workingCopy)),
    };
  }

  /**
   * The program a configured remote runs for a service (`remote.<name>.uploadpack` or
   * `remote.<name>.receivepack`, as git's `remote_get` reads them); undefined for a URL or when
   * unset.
   */
  protected remoteProgram(remote: string, key: "uploadpack" | "receivepack"): string | undefined {
    const store = RemoteConfigStore.from(this._workingCopy);
    if (store.urlFor(remote) === undefined) return undefined;
    return store.value(`remote.${remote}.${key}`);
  }

  /**
   * Get transport options for passing to transport operations.
   */
  protected getTransportOptions(): TransportOptions {
    return {
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      gzipRequests: this.gzipRequests,
      onProgress: this.progressCallback,
      onProgressMessage: this.progressMessageCallback,
    };
  }
}
