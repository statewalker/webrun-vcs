import type { Credentials, GitTransportRegistry } from "@statewalker/vcs-transport";
import type { RemoteSessionOptions } from "./commands/remote-transport.js";
import {
  type CredentialsForUrl,
  createSubmoduleAuthPolicy,
  guardSubmoduleTransports,
  type HeadersForUrl,
  type SubmoduleAuthFor,
  strictUrlOrigin,
} from "./commands/submodule-auth.js";
import { GitApiError } from "./errors/index.js";
import { TransportCommand } from "./transport-command.js";

/**
 * A command that reaches several remotes in one call (`git fetch --all`, `git remote update`,
 * `git remote show <a> <b>`, `git remote prune`): the remotes' URLs come from the
 * configuration and may name any host, so credentials and headers go only where the caller
 * gave them for, as git's credential helpers match per URL.
 *
 * - {@link setCredentials} and {@link setHeaders} are for the origins (scheme, host, port)
 *   named with {@link addCredentialOrigin}; when none is named, for the origin of the default
 *   remote (the current branch's, the one configured remote, `origin`), and only while every
 *   remote the call reaches has that origin: remotes spanning several origins get none.
 * - {@link setCredentialsForUrl} and {@link setHeadersForUrl} answer per URL (after
 *   `insteadOf`), for that URL's origin alone.
 * - A URL without an origin (a path, `file:`) gets none.
 *
 * The connections go through guarded transports (`guardSubmoduleTransports`): the connectors
 * attach the credentials and headers themselves, per URL, and follow HTTP redirects by hand
 * so a redirect to another origin carries none. The commands run inside (each `git fetch`)
 * are given the guarded transports and no credentials of their own.
 */
export abstract class GuardedTransportCommand<T> extends TransportCommand<T> {
  private credentialOrigins: string[] = [];
  private credentialsFor?: CredentialsForUrl;
  private headersFor?: HeadersForUrl;
  private authPolicy?: SubmoduleAuthFor;
  private inheritedPolicy = false;
  private guarded?: GitTransportRegistry;

  /**
   * Credentials for the trusted origins only: those named with {@link addCredentialOrigin},
   * else the default remote's origin while every remote reached has it (see the class notes).
   * Use {@link setCredentialsForUrl} to decide per URL.
   */
  override setCredentials(credentials: Credentials): this {
    return super.setCredentials(credentials);
  }

  /** Username and password for the trusted origins only (as {@link setCredentials}). */
  override setCredentialsProvider(username: string, password: string): this {
    return super.setCredentialsProvider(username, password);
  }

  /** HTTP headers for the trusted origins only (as {@link setCredentials}). */
  override setHeaders(headers: Record<string, string>): this {
    return super.setHeaders(headers);
  }

  /**
   * An origin the static credentials and headers are for: a URL whose `<scheme>://<host>[:<port>]`
   * is taken (`https://git.example.com`, or any URL of that host). Once one is named, the
   * default remote is no longer trusted by default.
   *
   * @throws GitApiError for a URL without an origin (a path, `file:`)
   */
  addCredentialOrigin(url: string): this {
    this.checkCallable();
    const origin = strictUrlOrigin(url);
    if (origin === undefined) {
      throw new GitApiError(`fatal: '${url}' names no origin (scheme and host) for credentials`);
    }
    this.credentialOrigins.push(origin);
    return this;
  }

  /**
   * Asked with the URL of each remote reached (after `insteadOf`): its credentials, or
   * undefined for the static ones' rule ({@link setCredentials}).
   */
  setCredentialsForUrl(provider: CredentialsForUrl): this {
    this.checkCallable();
    this.credentialsFor = provider;
    return this;
  }

  /** Asked with the URL of each remote reached: its headers (as {@link setCredentialsForUrl}). */
  setHeadersForUrl(provider: HeadersForUrl): this {
    this.checkCallable();
    this.headersFor = provider;
    return this;
  }

  /** @internal The policy of the command running this one (a nested fetch). */
  setAuthPolicy(policy: SubmoduleAuthFor): this {
    this.checkCallable();
    this.authPolicy = policy;
    this.inheritedPolicy = true;
    return this;
  }

  /**
   * Decides who gets the static credentials and headers, from the URLs this call reaches
   * (after `insteadOf`) and the default remote's URL; call before the first connection
   * (until then nothing gets any).
   */
  protected resolveAuth(urls: readonly string[], defaultRemoteUrl: string | undefined): void {
    if (this.inheritedPolicy) return;
    let origins = this.credentialOrigins;
    if (origins.length === 0 && (this.credentials || this.headers)) {
      const reached = new Set(urls.map((url) => strictUrlOrigin(url) ?? `none:${url}`));
      const origin = defaultRemoteUrl !== undefined ? strictUrlOrigin(defaultRemoteUrl) : undefined;
      origins =
        origin !== undefined && reached.size <= 1 && (reached.size === 0 || reached.has(origin))
          ? [origin]
          : [];
    }
    this.authPolicy = createSubmoduleAuthPolicy({
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
      origins,
      ...(this.credentialsFor ? { credentialsFor: this.credentialsFor } : {}),
      ...(this.headersFor ? { headersFor: this.headersFor } : {}),
    });
  }

  /** The policy in force: what {@link resolveAuth} decided (nothing before it). */
  protected policy(): SubmoduleAuthFor {
    return this.authPolicy ?? (() => ({}));
  }

  /** The given transports, unguarded (for a nested command given this one's policy). */
  private rawTransports(): GitTransportRegistry {
    return super.getTransports();
  }

  /** The transports every connection goes through: guarded by this command's policy. */
  override getTransports(): GitTransportRegistry {
    this.guarded ??= guardSubmoduleTransports(this.rawTransports(), (url) => this.policy()(url));
    return this.guarded;
  }

  /** The session options, without credentials and headers: the guarded transports add them. */
  protected override remoteSessionOptions(): RemoteSessionOptions {
    const { credentials: _c, headers: _h, ...rest } = super.remoteSessionOptions();
    return rest;
  }

  /** A lazy fetch gets the guarded transports, and no credentials of its own. */
  protected override promisorFetcherAuth() {
    return { transports: this.getTransports() };
  }

  /**
   * A command this one runs: a guarded one gets the transports and this command's policy, any
   * other the guarded transports; neither gets the credentials or headers. The credential
   * helper and warning sink go to both (the helper is asked per URL, and the guard drops
   * whatever identifies the user on a redirect to another origin).
   */
  protected override configureChild<C extends TransportCommand<unknown>>(child: C): C {
    child.shareHooksOf(this);
    if (child instanceof GuardedTransportCommand) {
      child.setTransports(this.rawTransports());
      child.setAuthPolicy((url) => this.policy()(url));
    } else child.setTransports(this.getTransports());
    if (this.timeout) child.setTimeout(this.timeout);
    if (this.gzipRequests !== undefined) child.setGzipRequests(this.gzipRequests);
    if (this.credentialHelper) child.setCredentialHelper(this.credentialHelper);
    if (this.warningCallback) child.setWarningCallback(this.warningCallback);
    if (this.progressCallback) child.setProgressMonitor(this.progressCallback);
    if (this.progressMessageCallback)
      child.setProgressMessageCallback(this.progressMessageCallback);
    return child;
  }
}
