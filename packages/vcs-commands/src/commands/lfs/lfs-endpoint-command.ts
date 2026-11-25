/**
 * The Git LFS endpoint of an operation and remote, as git-lfs resolves it (see
 * {@link LfsConfig}), with the credentials and headers the caller may send there.
 *
 * `.lfsconfig` is repository content: whoever writes the repository chooses its `lfs.url`.
 * So static credentials and headers ({@link LfsEndpointCommand.setCredentials},
 * {@link LfsEndpointCommand.setHeaders}) go to the endpoint only when its origin is one named
 * with {@link LfsEndpointCommand.addCredentialOrigin}, or, with none named, the origin of the
 * endpoint the user's own configuration gives (the same resolution without `.lfsconfig`):
 * a `.lfsconfig` pointing the endpoint at another host gets none. Per-URL providers
 * ({@link LfsEndpointCommand.setCredentialsForUrl}) are asked with the endpoint's URL and
 * answer for its origin alone, as a credential helper does.
 *
 * @example
 * ```typescript
 * const ep = await git.lfsEndpoint().setOperation("upload")
 *   .setCredentials({ username: "u", password: "p" }).call();
 * await lfsUpload(ep.url, store, objects, resolver, { ...ep.auth });
 * ```
 */

import type { Credentials } from "@statewalker/vcs-transport";

import { GitApiError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import {
  type CredentialsForUrl,
  createSubmoduleAuthPolicy,
  type HeadersForUrl,
  strictUrlOrigin,
} from "../submodule-auth.js";
import { LfsConfig, type LfsEndpoint, type LfsEndpointOperation } from "./lfs-config.js";

/** What {@link LfsEndpointCommand.call} answers. */
export interface LfsEndpointResult extends LfsEndpoint {
  /**
   * What to send to the endpoint (structurally `LfsTransferOptions`' `credentials` and
   * `headers`): empty when the policy gives the endpoint's origin nothing
   */
  auth: { credentials?: { username: string; password: string }; headers?: Record<string, string> };
  /** The endpoint's origin is one the static credentials are for */
  trusted: boolean;
  /** What git-lfs prints reading the configuration (ignored `.lfsconfig` keys) */
  warnings: string[];
}

/** `git lfs env`'s endpoint for an operation and remote, with the credential policy applied. */
export class LfsEndpointCommand extends GitCommand<LfsEndpointResult> {
  private operation: LfsEndpointOperation = "download";
  private remote?: string;
  private credentials?: Credentials;
  private headers?: Record<string, string>;
  private credentialOrigins: string[] = [];
  private credentialsFor?: CredentialsForUrl;
  private headersFor?: HeadersForUrl;
  private compatibility?: string;

  /**
   * The git-lfs version to follow (default `LFS_DEFAULT_COMPATIBILITY`, see
   * `LfsConfigLoadOptions.compatibility`).
   */
  setCompatibility(version: string): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** `download` (default) or `upload` (`lfs.pushurl`, `lfspushurl`, `pushurl`, `pushInsteadOf`). */
  setOperation(operation: LfsEndpointOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /**
   * The remote; default git-lfs's: `branch.<name>.remote`, `remote.lfsdefault`, the only
   * remote, `origin` (for uploads `branch.<name>.pushRemote`, `remote.lfspushdefault`,
   * `remote.pushDefault` first). A URL may stand for a remote.
   */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /** Credentials for the trusted origins only (see the module notes). */
  setCredentials(credentials: Credentials): this {
    this.checkCallable();
    this.credentials = credentials;
    return this;
  }

  /** HTTP headers for the trusted origins only (see the module notes). */
  setHeaders(headers: Record<string, string>): this {
    this.checkCallable();
    this.headers = headers;
    return this;
  }

  /**
   * An origin the static credentials and headers are for; once one is named, the origin of
   * the user's own endpoint is no longer trusted by default.
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

  /** Asked with the endpoint's URL: its credentials, or undefined for the static rule. */
  setCredentialsForUrl(provider: CredentialsForUrl): this {
    this.checkCallable();
    this.credentialsFor = provider;
    return this;
  }

  /** Asked with the endpoint's URL: its headers, or undefined for the static rule. */
  setHeadersForUrl(provider: HeadersForUrl): this {
    this.checkCallable();
    this.headersFor = provider;
    return this;
  }

  async call(): Promise<LfsEndpointResult> {
    this.checkCallable();
    this.setCallable(false);
    const compat = this.compatibility !== undefined ? { compatibility: this.compatibility } : {};
    const lfs = await LfsConfig.load(this._workingCopy, compat);
    const choice =
      this.remote !== undefined
        ? { name: this.remote, fromLfsconfig: false }
        : lfs.remoteChoice(this.operation);
    const remote = choice.name;
    const endpoint = await lfs.endpoint(this.operation, remote);
    if (choice.fromLfsconfig) endpoint.fromLfsconfig = true;
    let origins = this.credentialOrigins;
    if (origins.length === 0 && (this.credentials || this.headers)) {
      // the user's own endpoint: `.lfsconfig` left out entirely, its remote choice too (it may
      // name a URL as the default remote, or turn `git://` into `http://`)
      const mine = await LfsConfig.load(this._workingCopy, { ...compat, withoutLfsconfig: true });
      const own = await mine.endpoint(
        this.operation,
        this.remote ?? mine.remoteChoice(this.operation).name,
      );
      // FETCH_HEAD is no configuration: it names whatever was fetched last (`git pull <url>`)
      const origin = own.url && own.source !== "fetch-head" ? strictUrlOrigin(own.url) : undefined;
      origins = origin !== undefined ? [origin] : [];
    }
    const policy = createSubmoduleAuthPolicy({
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
      origins,
      ...(this.credentialsFor ? { credentialsFor: this.credentialsFor } : {}),
      ...(this.headersFor ? { headersFor: this.headersFor } : {}),
    });
    const given = endpoint.url ? policy(endpoint.url) : {};
    const auth: LfsEndpointResult["auth"] = {};
    if (given.credentials) {
      const { username, password, token } = given.credentials;
      auth.credentials = {
        username: username ?? (token !== undefined ? "x-access-token" : ""),
        password: password ?? token ?? "",
      };
    }
    if (given.headers) auth.headers = given.headers;
    const origin = endpoint.url ? strictUrlOrigin(endpoint.url) : undefined;
    return {
      ...endpoint,
      auth,
      trusted: origin !== undefined && origins.includes(origin),
      warnings: [...lfs.warnings],
    };
  }
}
