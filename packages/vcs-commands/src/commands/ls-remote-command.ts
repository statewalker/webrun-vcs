import { isSymbolicRef, type ObjectId } from "@statewalker/vcs-core";
import { lsRefs, type UploadPackConnection } from "@statewalker/vcs-transport";

import { InvalidRemoteError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { TransportCommand } from "../transport-command.js";
import { withRemoteUploadPack } from "./remote-transport.js";

/**
 * A remote ref entry.
 *
 * Based on JGit's Ref with additional remote context.
 */
export interface RemoteRef {
  /** Full ref name (e.g., "refs/heads/main") */
  name: string;
  /** Object ID the ref points to */
  objectId: ObjectId;
  /** Peeled object ID for tags (if applicable) */
  peeledObjectId?: ObjectId;
  /** Whether this is a symbolic ref */
  symbolic?: boolean;
  /** Target of symbolic ref */
  target?: string;
}

/**
 * Result of ls-remote operation.
 */
export interface LsRemoteResult {
  /** URI that was queried */
  uri: string;
  /** Remote refs */
  refs: RemoteRef[];
  /** Default branch (from HEAD symref) */
  defaultBranch?: string;
}

/**
 * List references in a remote repository.
 *
 * Equivalent to `git ls-remote`.
 *
 * Based on JGit's LsRemoteCommand.
 *
 * @example
 * ```typescript
 * // List all refs
 * const result = await git.lsRemote()
 *   .setRemote("https://github.com/user/repo")
 *   .call();
 *
 * // List only heads
 * const result = await git.lsRemote()
 *   .setRemote("origin")
 *   .setHeads(true)
 *   .call();
 *
 * // List only tags
 * const result = await git.lsRemote()
 *   .setRemote("origin")
 *   .setTags(true)
 *   .call();
 * ```
 */
export class LsRemoteCommand extends TransportCommand<LsRemoteResult> {
  private remote?: string;
  private heads = false;
  private tags = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: API placeholder for transport layer
  private uploadPack?: string;

  /**
   * Set the remote to query.
   *
   * Can be either a remote name (e.g., "origin") or a URL.
   *
   * @param remote Remote name or URL
   */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /**
   * Get the remote being queried.
   */
  getRemote(): string | undefined {
    return this.remote;
  }

  /**
   * Set whether to show only refs under refs/heads.
   *
   * @param heads Whether to show only heads
   */
  setHeads(heads: boolean): this {
    this.checkCallable();
    this.heads = heads;
    return this;
  }

  /**
   * Whether to show only heads.
   */
  isHeads(): boolean {
    return this.heads;
  }

  /**
   * Set whether to show only refs under refs/tags.
   *
   * @param tags Whether to show only tags
   */
  setTags(tags: boolean): this {
    this.checkCallable();
    this.tags = tags;
    return this;
  }

  /**
   * Whether to show only tags.
   */
  isTags(): boolean {
    return this.tags;
  }

  /**
   * Set custom upload-pack path for the remote.
   *
   * @param uploadPack Path to git-upload-pack on remote
   */
  setUploadPack(uploadPack: string): this {
    this.checkCallable();
    this.uploadPack = uploadPack;
    return this;
  }

  /**
   * Execute the ls-remote operation.
   *
   * @returns Refs from the remote repository
   * @throws InvalidRemoteError git's "No remote configured to list refs from." when no remote
   *   is given and git's default one has no URL
   */
  async call(): Promise<LsRemoteResult> {
    this.checkCallable();
    this.setCallable(false);

    // remote_get: the remote given, or git's default one (see callGetUrl)
    const remoteUrl = await this.remoteUrl();

    // transport_get: git's local transport (upload-pack of the repository at the path, in
    // process), or the connector the transport registry names (smart HTTP or a native
    // session); either lists with ls-refs over v2, else reads the v0/v1 advertisement, as
    // protocol.version asks; anything else fails in git's words
    const remote = await this.prepareRemote(remoteUrl);
    const options = this.remoteSessionOptions();
    const listRefs = async (connection: UploadPackConnection) => {
      const listed = new Map<string, ObjectId>();
      const refs =
        connection.version === 2 ? await lsRefs(connection, []) : (connection.advertisedRefs ?? []);
      for (const ref of refs) {
        if (ref.oid) listed.set(ref.name, ref.oid);
      }
      return listed;
    };
    const refs = await withRemoteUploadPack(remote, options, listRefs);

    // Filter refs based on heads/tags settings
    const filteredRefs: RemoteRef[] = [];
    let defaultBranch: string | undefined;

    for (const [refName, objectIdHex] of refs) {
      // Handle HEAD specially
      if (refName === "HEAD") {
        continue; // We'll use it for defaultBranch detection but not include in results
      }

      // Apply filters
      if (this.heads && !refName.startsWith("refs/heads/")) {
        continue;
      }
      if (this.tags && !refName.startsWith("refs/tags/")) {
        continue;
      }

      filteredRefs.push({
        name: refName,
        objectId: objectIdHex,
      });
    }

    // Try to determine default branch
    const headRef = refs.get("HEAD");
    if (headRef) {
      // Check if HEAD points to a known branch
      for (const [refName, objectIdHex] of refs) {
        if (refName.startsWith("refs/heads/") && objectIdHex === headRef) {
          defaultBranch = refName.slice("refs/heads/".length);
          break;
        }
      }
    }

    return {
      uri: remoteUrl,
      refs: filteredRefs,
      defaultBranch,
    };
  }

  /**
   * Call and return just the refs map.
   *
   * Convenience method for simple use cases.
   */
  async callAsMap(): Promise<Map<string, ObjectId>> {
    const result = await this.call();
    const map = new Map<string, ObjectId>();
    for (const ref of result.refs) {
      map.set(ref.name, ref.objectId);
    }
    return map;
  }

  /**
   * The URL a remote resolves to, without contacting it: `git ls-remote --get-url
   * [<remote>]` (the remote's first URL, or the URL given, with `insteadOf` applied). Without
   * a remote, git's `remote_get(NULL)`: the current branch's `branch.<name>.remote` (read as a
   * URL when no such remote has one), else the only configured remote, else `origin`; when
   * that names no remote with a URL, git's "No remote configured to list refs from.".
   *
   * @example
   * ```typescript
   * // [url "https://example.com/"] insteadOf = ex:
   * await git.lsRemote().setRemote("ex:repo.git").callGetUrl(); // "https://example.com/repo.git"
   * ```
   *
   * @throws InvalidRemoteError "fatal: No remote configured to list refs from." (exit 128)
   */
  async callGetUrl(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    return this.remoteUrl();
  }

  /** The URL of the remote given, or of git's default remote (see {@link callGetUrl}). */
  private async remoteUrl(): Promise<string> {
    const store = RemoteConfigStore.from(this.workingCopy);
    if (this.remote !== undefined) return store.remoteUrlOf(this.remote);
    // remotes_remote_for_branch: an explicit branch remote is "given" (add_url_alias)
    const head = await this.refsStore.get("HEAD");
    if (head && isSymbolicRef(head) && head.target.startsWith("refs/heads/")) {
      const branch = head.target.slice("refs/heads/".length);
      const explicit = store.value(`branch.${branch}.remote`);
      if (explicit !== undefined) return store.remoteUrlOf(explicit);
    }
    const names = store.configuredNames();
    const name = names.length === 1 ? (names[0] ?? "origin") : "origin";
    const url = store.urlFor(name);
    if (url === undefined) {
      throw new InvalidRemoteError(name, "fatal: No remote configured to list refs from.");
    }
    return url;
  }
}
