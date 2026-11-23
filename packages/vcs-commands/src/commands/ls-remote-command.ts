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
  private uploadPack?: string;
  /** The remote (name or URL) {@link remoteUrl} resolved */
  private remoteName?: string;

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
   * Set the program the remote runs for upload-pack (git's `--upload-pack`, over the
   * `remote.<name>.uploadpack` of the remote listed, given or default): what an ssh connector runs, and
   * what git:// names in its request line.
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
    // --upload-pack, else remote.<name>.uploadpack (transport_get reads it for a named remote)
    const uploadPack =
      this.uploadPack ??
      (this.remoteName !== undefined
        ? this.remoteProgram(this.remoteName, "uploadpack")
        : undefined);
    const options = {
      ...this.remoteSessionOptions(),
      ...(uploadPack !== undefined ? { program: uploadPack } : {}),
    };
    // builtin/ls-remote.c: --tags and --heads become v2 ref-prefixes (v0 lists everything,
    // filtered here). `ref-prefix HEAD` too, which git does not send: HEAD's symref gives
    // `defaultBranch` (HEAD itself is never in the refs returned)
    const prefixes = [...(this.tags ? ["refs/tags/"] : []), ...(this.heads ? ["refs/heads/"] : [])];
    if (prefixes.length > 0) prefixes.push("HEAD");
    const listRefs = async (connection: UploadPackConnection) =>
      connection.version === 2
        ? await lsRefs(connection, prefixes)
        : [...(connection.advertisedRefs ?? [])];
    const listed = await withRemoteUploadPack(remote, options, listRefs);

    const filteredRefs: RemoteRef[] = [];
    for (const ref of listed) {
      // HEAD only names the default branch; an unborn ref has no object
      if (ref.name === "HEAD" || !ref.oid) continue;
      // --heads and --tags: refs of either kind (git's REF_BRANCHES | REF_TAGS)
      const wanted =
        (!this.heads && !this.tags) ||
        (this.heads && ref.name.startsWith("refs/heads/")) ||
        (this.tags && ref.name.startsWith("refs/tags/"));
      if (!wanted) continue;
      filteredRefs.push({
        name: ref.name,
        objectId: ref.oid,
        ...(ref.peeled ? { peeledObjectId: ref.peeled } : {}),
        ...(ref.symref ? { symbolic: true, target: ref.symref } : {}),
      });
    }

    // The default branch: HEAD's symref (v2 `symref-target`, v0's `symref=HEAD:` capability),
    // else the first branch at HEAD's commit (a server that names no symref)
    let defaultBranch: string | undefined;
    const head = listed.find((r) => r.name === "HEAD");
    if (head?.symref?.startsWith("refs/heads/")) {
      defaultBranch = head.symref.slice("refs/heads/".length);
    } else if (head?.oid) {
      const match = listed.find((r) => r.name.startsWith("refs/heads/") && r.oid === head.oid);
      if (match) defaultBranch = match.name.slice("refs/heads/".length);
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
    // remote_get reads a legacy remote (.git/remotes/, .git/branches/: git 2.x) first
    if (this.remote !== undefined) {
      this.remoteName = this.remote;
      await this.loadLegacyRemote(this.remote);
      return store.remoteUrlOf(this.remote);
    }
    // remotes_remote_for_branch: an explicit branch remote is "given" (add_url_alias)
    const head = await this.refsStore.get("HEAD");
    if (head && isSymbolicRef(head) && head.target.startsWith("refs/heads/")) {
      const branch = head.target.slice("refs/heads/".length);
      const explicit = store.value(`branch.${branch}.remote`);
      if (explicit !== undefined) {
        this.remoteName = explicit;
        await this.loadLegacyRemote(explicit);
        return store.remoteUrlOf(explicit);
      }
    }
    const names = store.configuredNames();
    const name = names.length === 1 ? (names[0] ?? "origin") : "origin";
    await this.loadLegacyRemote(name);
    const url = store.urlFor(name);
    if (url === undefined) {
      throw new InvalidRemoteError(name, "fatal: No remote configured to list refs from.");
    }
    this.remoteName = name;
    return url;
  }
}
