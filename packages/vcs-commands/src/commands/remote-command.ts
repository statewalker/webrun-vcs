import {
  MissingArgumentError,
  RemoteAlreadyExistsError,
  RemoteNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import {
  defaultFetchRefspec,
  listRemoteNames,
  type RemoteConfig,
  RemoteConfigStore,
} from "../remote-config/index.js";

export type { RemoteConfig };

/**
 * Add a remote to the repository.
 *
 * Equivalent to `git remote add`.
 *
 * Based on JGit's RemoteAddCommand.
 *
 * The remote is written to the working copy configuration as a
 * `[remote "<name>"]` section, so it survives the command that created it.
 * A remote already known from `refs/remotes/<name>/*` counts as existing even
 * without a config section.
 *
 * @example
 * ```typescript
 * await git.remoteAdd()
 *   .setName("upstream")
 *   .setUri("https://github.com/user/repo")
 *   .call();
 * ```
 */
export class RemoteAddCommand extends GitCommand<RemoteConfig> {
  private name?: string;
  private uri?: string;
  private fetchRefspec?: string;

  /**
   * Set the remote name.
   *
   * @param name Remote name
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getName(): string | undefined {
    return this.name;
  }

  /**
   * Set the remote URI.
   *
   * @param uri Remote URL
   */
  setUri(uri: string): this {
    this.checkCallable();
    this.uri = uri;
    return this;
  }

  /**
   * Get the remote URI.
   */
  getUri(): string | undefined {
    return this.uri;
  }

  /**
   * Set custom fetch refspec.
   *
   * If not set, defaults to +refs/heads/*:refs/remotes/{name}/*
   *
   * @param refspec Fetch refspec
   */
  setFetchRefspec(refspec: string): this {
    this.checkCallable();
    this.fetchRefspec = refspec;
    return this;
  }

  /**
   * Execute the remote add operation.
   *
   * @returns Remote configuration
   * @throws Error if name or URI is not set
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.name) {
      throw new MissingArgumentError("name", "Remote name must be specified");
    }
    if (!this.uri) {
      throw new MissingArgumentError("uri", "Remote URI must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);

    // A remote exists if it is configured OR if it already has tracking refs.
    if (store.isConfigured(this.name) || (await this.hasTrackingRefs(this.name))) {
      throw new RemoteAlreadyExistsError(this.name);
    }

    const config: RemoteConfig = {
      name: this.name,
      urls: [this.uri],
      pushUrls: [],
      fetchRefspecs: [this.fetchRefspec || defaultFetchRefspec(this.name)],
      pushRefspecs: [],
    };

    store.write(config);
    await store.save();

    return config;
  }

  /** Whether any `refs/remotes/<name>/*` ref exists. */
  private async hasTrackingRefs(name: string): Promise<boolean> {
    for await (const _ref of this.refsStore.list(`refs/remotes/${name}/`)) {
      return true;
    }
    return false;
  }
}

/**
 * Remove a remote from the repository.
 *
 * Equivalent to `git remote remove`.
 *
 * Based on JGit's RemoteRemoveCommand.
 *
 * @example
 * ```typescript
 * await git.remoteRemove()
 *   .setRemoteName("upstream")
 *   .call();
 * ```
 */
export class RemoteRemoveCommand extends GitCommand<RemoteConfig | undefined> {
  private remoteName?: string;

  /**
   * Set the remote name to remove.
   *
   * @param name Remote name
   */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getRemoteName(): string | undefined {
    return this.remoteName;
  }

  /**
   * Execute the remote remove operation.
   *
   * Drops both halves of a remote: its config section and its tracking refs.
   * A remote that has only one of the two is still removable.
   *
   * @returns Removed remote config, or undefined if not found
   */
  async call(): Promise<RemoteConfig | undefined> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.remoteName) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);
    const configured = store.isConfigured(this.remoteName);

    const refsToDelete: string[] = [];
    for await (const ref of this.refsStore.list(`refs/remotes/${this.remoteName}/`)) {
      refsToDelete.push(ref.name);
    }

    if (!configured && refsToDelete.length === 0) {
      return undefined;
    }

    // Read before removing: this is what we report back.
    const removed = store.read(this.remoteName);

    for (const refName of refsToDelete) {
      await this.refsStore.delete(refName);
    }

    if (configured) {
      store.remove(this.remoteName);
      await store.save();
    }

    return removed;
  }
}

/**
 * List remotes in the repository.
 *
 * Equivalent to `git remote -v`.
 *
 * Based on JGit's RemoteListCommand.
 *
 * @example
 * ```typescript
 * const remotes = await git.remoteList().call();
 * for (const remote of remotes) {
 *   console.log(remote.name, remote.urls[0]);
 * }
 * ```
 */
export class RemoteListCommand extends GitCommand<RemoteConfig[]> {
  /**
   * Execute the remote list operation.
   *
   * Lists the union of the configured remotes and the names appearing under
   * `refs/remotes/`; a remote with no config section is reported with no URLs
   * and the default fetch refspec.
   *
   * @returns List of remote configurations
   */
  async call(): Promise<RemoteConfig[]> {
    this.checkCallable();
    this.setCallable(false);

    const store = RemoteConfigStore.from(this.workingCopy);
    const names = await listRemoteNames(store, this.refsStore);
    return names.map((name) => store.read(name));
  }
}

/**
 * Set URL for a remote.
 *
 * Equivalent to `git remote set-url`.
 *
 * Based on JGit's RemoteSetUrlCommand.
 *
 * @example
 * ```typescript
 * await git.remoteSetUrl()
 *   .setRemoteName("origin")
 *   .setRemoteUri("https://github.com/user/repo")
 *   .call();
 * ```
 */
export class RemoteSetUrlCommand extends GitCommand<RemoteConfig> {
  private remoteName?: string;
  private remoteUri?: string;
  private pushUri = false;
  private oldUri?: string;

  /**
   * Set the remote name.
   *
   * @param name Remote name
   */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getRemoteName(): string | undefined {
    return this.remoteName;
  }

  /**
   * Set the new remote URI.
   *
   * @param uri New remote URL
   */
  setRemoteUri(uri: string): this {
    this.checkCallable();
    this.remoteUri = uri;
    return this;
  }

  /**
   * Get the new remote URI.
   */
  getRemoteUri(): string | undefined {
    return this.remoteUri;
  }

  /**
   * Set whether this is a push URL.
   *
   * @param push Whether to set push URL
   */
  setPush(push: boolean): this {
    this.checkCallable();
    this.pushUri = push;
    return this;
  }

  /**
   * Whether this is a push URL.
   */
  isPush(): boolean {
    return this.pushUri;
  }

  /**
   * Set the URL to replace.
   *
   * Only this URL is replaced, leaving the remote's other URLs alone — the
   * `<oldurl>` argument of `git remote set-url <name> <newurl> <oldurl>`.
   * Without it, the new URL replaces all of them.
   *
   * @param uri Old URI to replace
   */
  setOldUri(uri: string): this {
    this.checkCallable();
    this.oldUri = uri;
    return this;
  }

  /**
   * Execute the remote set-url operation.
   *
   * The URL is written to the working copy configuration, so it survives the
   * command. The remote may be known from its config section or from its
   * tracking refs; in the latter case, this is what first gives it a URL.
   *
   * @returns Updated remote configuration
   * @throws MissingArgumentError if remote name or URI is not set
   * @throws RemoteNotFoundError if the remote is neither configured nor tracked
   * @throws InvalidArgumentError if {@link setOldUri} names a URL the remote does not have
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.remoteName) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }
    if (!this.remoteUri) {
      throw new MissingArgumentError("remoteUri", "Remote URI must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfigured(this.remoteName) && !(await this.hasTrackingRefs(this.remoteName))) {
      throw new RemoteNotFoundError(this.remoteName);
    }

    store.setUrl(this.remoteName, this.remoteUri, {
      push: this.pushUri,
      oldUrl: this.oldUri,
    });
    await store.save();

    return store.read(this.remoteName);
  }

  /** Whether any `refs/remotes/<name>/*` ref exists. */
  private async hasTrackingRefs(name: string): Promise<boolean> {
    for await (const _ref of this.refsStore.list(`refs/remotes/${name}/`)) {
      return true;
    }
    return false;
  }
}
