import {
  type Credentials,
  createDefaultTransports,
  type GitTransportRegistry,
  type HttpClientSettings,
  type HttpCredentialHelper,
  type ProgressInfo,
} from "@statewalker/vcs-transport";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import {
  type BundleUriHost,
  createBundleUriHost,
  fetchBundleUri,
} from "./commands/bundle/index.js";
import { hostEnvironmentOf } from "./commands/git-ident.js";
import { httpClientSettingsOf } from "./commands/http-config.js";
import { createPromisorFetcher, promisorOf } from "./commands/promisor-remote.js";
import {
  bundleRemoteOf,
  httpSessionSettings,
  openResolvedRemote,
  type PreparedRemote,
  prepareRemote,
  protocolVersionOf,
  type RemoteSessionOptions,
  type ResolvedRemote,
  remoteContextOf,
  resolveRemote,
} from "./commands/remote-transport.js";
import { repositoryPlaceOf } from "./commands/worktree-support.js";
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
  /** Asked for HTTP credentials after a 401 (git's credential helpers) */
  protected credentialHelper?: HttpCredentialHelper;
  /** git's `warning:` lines of the HTTP client */
  protected warningCallback?: (line: string) => void;

  constructor(workingCopy: WorkingCopy) {
    super(workingCopy);
    // a partial clone's lazy fetch during the call (a clone's checkout, a pull's merge) reaches
    // the promisor remote as this command does: its transports, credentials, headers, timeout,
    // credential helper and warning sink;
    // the store's previous fetcher comes back when the call ends
    this.aroundEntryPoints(() => {
      if (
        !this.transportRegistry &&
        !this.credentials &&
        !this.headers &&
        !this.credentialHelper &&
        this.timeout === undefined
      ) {
        return undefined;
      }
      const promisor = promisorOf(this._workingCopy);
      if (!promisor) return undefined;
      const previous = promisor.fetcher;
      const fetcher = createPromisorFetcher(this._workingCopy, {
        ...this.promisorFetcherAuth(),
        ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
        // git's child fetch reads credential.helper: the helper is asked per URL, so the
        // guarded commands hand it over too
        ...(this.credentialHelper ? { credentialHelper: this.credentialHelper } : {}),
        ...(this.warningCallback ? { warningCallback: this.warningCallback } : {}),
      });
      promisor.setFetcher(fetcher);
      return () => {
        if (promisor.fetcher === fetcher) promisor.setFetcher(previous);
      };
    });
  }

  /**
   * What a lazy fetch during the call reaches the promisor remote with: this command's
   * transports, credentials and headers.
   */
  protected promisorFetcherAuth(): {
    transports?: GitTransportRegistry;
    credentials?: Credentials;
    headers?: Record<string, string>;
  } {
    return {
      ...(this.transportRegistry ? { transports: this.transportRegistry } : {}),
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
    };
  }

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
   * A credential helper, as git's `credential.helper`: asked for credentials when an HTTP
   * server answers 401 (with the `WWW-Authenticate` challenges; three tries in all), told
   * when they worked (`approve`, git's `store`) and when the server refused them (`reject`,
   * git's `erase`). Credentials from {@link setCredentials} go out with every request and are
   * never handed to it.
   *
   * @example
   * ```ts
   * await git.fetch().setCredentialHelper({
   *   fill: ({ host, wwwAuthenticate }) => vault.lookup(host, wwwAuthenticate),
   *   approve: (credentials, { host }) => vault.save(host, credentials),
   *   reject: (_credentials, { host }) => vault.forget(host),
   * }).call();
   * ```
   */
  setCredentialHelper(helper: HttpCredentialHelper): this {
    this.checkCallable();
    this.credentialHelper = helper;
    return this;
  }

  /**
   * Receives the `warning:` lines git's HTTP client prints on stderr (`rate limited, waiting
   * <n> seconds before retry`).
   */
  setWarningCallback(callback: (line: string) => void): this {
    this.checkCallable();
    this.warningCallback = callback;
    return this;
  }

  /**
   * git's `http.*` settings for a remote URL (`http.<url>.*` matched against it, the
   * `GIT_HTTP_*` variables over them), with this command's warning sink.
   */
  protected httpSettingsFor(url: string): HttpClientSettings {
    const settings = httpClientSettingsOf(
      RemoteConfigStore.from(this._workingCopy),
      url,
      hostEnvironmentOf(this._workingCopy),
      {
        compatibility: this.hooks.compatibility,
        ...(this.warningCallback ? { onWarning: this.warningCallback } : {}),
      },
    );
    return this.warningCallback ? { ...settings, onWarning: this.warningCallback } : settings;
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
    return this.givenBundle(url) ?? prepareRemote(this._workingCopy, url, this.getTransports());
  }

  /**
   * The remote at `url` is this bundle (git's bundle transport, for hosts without files, or
   * bytes already in memory): fetch, clone, pull and ls-remote of `url` read it as they read
   * a bundle file at a path, with git's checks (prerequisites, a filtered bundle's clone
   * refused). Bytes that do not read as a bundle leave `url` to its usual transport.
   *
   * @example
   * ```ts
   * await git.fetch().addBundle("repo.bundle", bytes).setRemote("repo.bundle").call();
   * ```
   */
  addBundle(url: string, bundle: Uint8Array): this {
    this.checkCallable();
    this.bundles.set(url, bundle);
    return this;
  }

  /** Bundles given by {@link addBundle}, by URL */
  protected readonly bundles = new Map<string, Uint8Array>();

  /** Whether {@link addBundle} gave bytes for `url` that read as a bundle */
  protected hasGivenBundle(url: string): boolean {
    const bytes = this.bundles.get(url);
    return bytes !== undefined && bundleRemoteOf(this._workingCopy, bytes, url) !== undefined;
  }

  /** The bundle {@link addBundle} gave for `url`, as a prepared remote */
  private givenBundle(url: string): Promise<PreparedRemote> | undefined {
    const bytes = this.bundles.get(url);
    if (!bytes) return undefined;
    const remote = bundleRemoteOf(this._workingCopy, bytes, url);
    return remote ? Promise.resolve({ kind: "bundle", url, path: url, remote }) : undefined;
  }

  /**
   * {@link prepareRemote} without opening a local repository: the transport is decided (and
   * refused in git's words) now, the repository opened later by {@link openRemote}.
   */
  protected resolveRemote(url: string): ResolvedRemote {
    if (this.hasGivenBundle(url)) return { kind: "local", url, path: url };
    return resolveRemote(url, remoteContextOf(this._workingCopy, this.getTransports()));
  }

  /** Opens the local repository of a remote {@link resolveRemote} resolved. */
  protected openRemote(resolved: ResolvedRemote): Promise<PreparedRemote> {
    const given = this.givenBundle(resolved.url);
    if (given) return given;
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
      httpSettings: (url) => this.httpSettingsFor(url),
      ...(this.credentialHelper ? { credentialHelper: this.credentialHelper } : {}),
      ...httpSessionSettings(this._workingCopy),
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
   * Gives a command this one runs (git's child `git fetch`) this command's transports,
   * credentials, headers, timeout, progress callbacks and hook session.
   */
  protected configureChild<C extends TransportCommand<unknown>>(child: C): C {
    child.shareHooksOf(this);
    child.setTransports(this.getTransports());
    for (const [url, bytes] of this.bundles) child.addBundle(url, bytes);
    if (this.credentials) child.setCredentials(this.credentials);
    if (this.headers) child.setHeaders(this.headers);
    if (this.timeout) child.setTimeout(this.timeout);
    if (this.gzipRequests !== undefined) child.setGzipRequests(this.gzipRequests);
    if (this.credentialHelper) child.setCredentialHelper(this.credentialHelper);
    if (this.warningCallback) child.setWarningCallback(this.warningCallback);
    if (this.progressCallback) child.setProgressMonitor(this.progressCallback);
    if (this.progressMessageCallback)
      child.setProgressMessageCallback(this.progressMessageCallback);
    if (this.bundleUriOverride !== undefined) child.setBundleUri(this.bundleUriOverride);
    return child;
  }

  /**
   * The repository side of bundle URIs (`fetch_bundle_uri`, `fetch_bundle_list`) for this
   * command: downloads with its HTTP settings (static credentials and headers only to
   * `remoteUrl`'s origin), unbundling into `refs/bundles/`, `fetch.bundleCreationToken` read
   * from the config and written through `setConfigValue` (default: replacing its values).
   */
  protected bundleUriHost(options: {
    remoteUrl?: string;
    compatibility: "2.43" | "2.56";
    message(line: string): void;
    setConfigValue?(key: string, value: string): Promise<void>;
    tempFileName?(): string;
  }): BundleUriHost {
    const store = RemoteConfigStore.from(this._workingCopy);
    const worktree = repositoryPlaceOf(this._workingCopy);
    return createBundleUriHost({
      workingCopy: this._workingCopy,
      setRef: (name, id, log) => this.refsStore.set(name, id, log),
      getRef: async (name) => (await this.refsStore.resolve(name).catch(() => undefined))?.objectId,
      reflogLine: (m) => this.reflogLine(m),
      compatibility: options.compatibility,
      readLocalFile: async (path) => worktree?.readLocalFile?.(path),
      ...(options.remoteUrl !== undefined ? { remoteUrl: options.remoteUrl } : {}),
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
      ...(this.credentialHelper ? { credentialHelper: this.credentialHelper } : {}),
      httpSettings: (url) => this.httpSettingsFor(url),
      configValue: (key) => store.value(key),
      setConfigValue:
        options.setConfigValue ??
        (async (key, value) => {
          store.setValues(key, [value]);
          await store.save();
        }),
      message: options.message,
      ...(options.tempFileName ? { tempFileName: options.tempFileName } : {}),
    });
  }

  /**
   * `git -c fetch.bundleURI=<uri> fetch`: the bundle URI this fetch downloads before talking
   * to the remote, over the config's `fetch.bundleURI` (`""` downloads nothing, as git's
   * children of `fetch --all` are told).
   */
  setBundleUri(uri: string): this {
    this.checkCallable();
    this.bundleUriOverride = uri;
    return this;
  }

  /** {@link setBundleUri}'s value */
  protected bundleUriOverride?: string;

  /**
   * cmd_fetch's bundle step: `fetch.bundleURI` (or {@link setBundleUri}) downloaded and applied
   * before the fetch (`fetch_bundle_uri`; a `creationToken` list only fetches bundles newer
   * than `fetch.bundleCreationToken`). Returns git's lines, `failed to fetch bundles from`
   * last when it failed.
   */
  protected async fetchConfiguredBundles(
    compatibility: "2.43" | "2.56" = this.hooks.compatibility,
  ): Promise<string[]> {
    const uri =
      this.bundleUriOverride ?? RemoteConfigStore.from(this._workingCopy).value("fetch.bundleURI");
    if (uri === undefined) return [];
    const lines: string[] = [];
    const host = this.bundleUriHost({
      compatibility,
      message: (line) => lines.push(line),
    });
    const fetched = await fetchBundleUri(host, uri);
    if (!fetched.ok) lines.push(`warning: failed to fetch bundles from '${uri}'`);
    return lines;
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
