/**
 * Git file-based Checkout implementation
 *
 * Implements the new Checkout interface using standard Git state files:
 * - HEAD: Current branch/commit
 * - MERGE_HEAD: Merge in progress
 * - rebase-merge/ or rebase-apply/: Rebase state
 * - CHERRY_PICK_HEAD: Cherry-pick in progress
 * - REVERT_HEAD: Revert in progress
 *
 * HEAD and the pseudo refs (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, ORIG_HEAD) are
 * read and written through `refs`; on git files that means under `<name>.lock`. git
 * itself locks HEAD, ORIG_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD (update_ref) but writes
 * MERGE_HEAD as a plain file (write_merge_heads); taking its lock too is harmless.
 * MERGE_MSG, MERGE_MODE and the rebase directories are plain state files.
 */

import type { ObjectId, Refs } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type {
  Checkout,
  CheckoutCherryPickState,
  CheckoutConfig,
  CheckoutMergeState,
  CheckoutOperationState,
  CheckoutRebaseState,
  CheckoutRevertState,
  CheckoutStash,
  HeadValue,
  Staging,
} from "@statewalker/vcs-working-tree";
import type { CherryPickStateFilesApi } from "../working-copy/cherry-pick-state-reader.js";
import type { MergeStateFilesApi } from "../working-copy/merge-state-reader.js";
import { type RebaseStateFilesApi, readRebaseState } from "../working-copy/rebase-state-reader.js";
import type { RevertStateFilesApi } from "../working-copy/revert-state-reader.js";

/**
 * Files API subset needed for GitCheckout
 */
export interface GitCheckoutFilesApi
  extends MergeStateFilesApi,
    RebaseStateFilesApi,
    CherryPickStateFilesApi,
    RevertStateFilesApi {
  /**
   * Write content to a file
   */
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  /**
   * Create directory
   */
  mkdir?(path: string): Promise<void>;
  /**
   * Remove a file
   */
  remove?(path: string): Promise<void>;
  /**
   * Remove a directory recursively
   */
  removeDir?(path: string): Promise<void>;
  /**
   * Create a file only if nothing is there (a FilesApi's `createExclusive`): with `remove`,
   * how a state file is written in place, as git's `fopen(..., "w")`
   */
  createExclusive?(path: string, content: Iterable<Uint8Array>): Promise<boolean>;
  /**
   * Append to a file, creating it (a FilesApi's `append`: O_APPEND, never a rewrite)
   */
  append?(path: string, content: Iterable<Uint8Array>): Promise<void>;
  /**
   * The entries of a directory (a FilesApi's `list`: names, or info objects with a name)
   */
  list?(path: string): AsyncIterable<string | { name: string }>;
}

/**
 * Options for creating a GitCheckout
 */
export interface GitCheckoutOptions {
  /** Staging interface */
  staging: Staging;
  /** Refs interface for HEAD management */
  refs: Refs;
  /** Files API for reading/writing state files */
  files: GitCheckoutFilesApi;
  /** Path to .git directory */
  gitDir: string;
  /** Optional stash */
  stash?: CheckoutStash;
  /** Optional config */
  config?: CheckoutConfig;
}

/**
 * Git file-based Checkout implementation
 */
export class GitCheckout implements Checkout {
  readonly staging: Staging;
  readonly stash?: CheckoutStash;
  readonly config?: CheckoutConfig;

  private readonly refs: Refs;
  private readonly files: GitCheckoutFilesApi;
  private readonly gitDir: string;
  private initialized = false;
  /**
   * Appends to a file under the git directory in place (O_APPEND); only when the files
   * can append (a caller without it writes the whole file).
   */
  readonly appendStateFile?: (name: string, content: Uint8Array | string) => Promise<void>;

  constructor(options: GitCheckoutOptions) {
    this.staging = options.staging;
    this.refs = options.refs;
    this.files = options.files;
    this.gitDir = options.gitDir;
    this.stash = options.stash;
    this.config = options.config;
    const append = options.files.append?.bind(options.files);
    if (append) {
      this.appendStateFile = async (name, content) => {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        await append(`${this.gitDir}/${name}`, [bytes]);
      };
    }
  }

  // ========== HEAD Management ==========

  async getHead(): Promise<HeadValue> {
    const headRef = await this.refs.get("HEAD");

    if (!headRef) {
      // No HEAD - should not happen in a valid repository
      throw new Error("HEAD not found");
    }

    if ("target" in headRef) {
      // Symbolic reference
      return { type: "symbolic", target: headRef.target };
    }

    // Direct reference (detached HEAD)
    if (!headRef.objectId) {
      throw new Error("HEAD is detached but has no commit ID");
    }
    return { type: "detached", commitId: headRef.objectId };
  }

  async setHead(value: HeadValue): Promise<void> {
    if (value.type === "symbolic") {
      await this.refs.setSymbolic("HEAD", value.target);
    } else {
      await this.refs.set("HEAD", value.commitId);
    }
  }

  async getHeadCommit(): Promise<ObjectId | undefined> {
    const resolved = await this.refs.resolve("HEAD");
    return resolved?.objectId;
  }

  async getCurrentBranch(): Promise<string | undefined> {
    const headRef = await this.refs.get("HEAD");
    if (headRef && "target" in headRef) {
      const target = headRef.target;
      if (target.startsWith("refs/heads/")) {
        return target.substring("refs/heads/".length);
      }
    }
    return undefined;
  }

  async isDetached(): Promise<boolean> {
    const headRef = await this.refs.get("HEAD");
    return headRef !== undefined && !("target" in headRef);
  }

  // ========== Operation State ==========

  async getOperationState(): Promise<CheckoutOperationState | undefined> {
    const merge = await this.getMergeState();
    if (merge) return { type: "merge", state: merge };

    const rebase = await this.getRebaseState();
    if (rebase) return { type: "rebase", state: rebase };

    const cherryPick = await this.getCherryPickState();
    if (cherryPick) return { type: "cherry-pick", state: cherryPick };

    const revert = await this.getRevertState();
    if (revert) return { type: "revert", state: revert };

    return undefined;
  }

  async hasOperationInProgress(): Promise<boolean> {
    return (await this.getOperationState()) !== undefined;
  }

  // -------- Merge --------

  async getMergeState(): Promise<CheckoutMergeState | undefined> {
    const mergeHead = await this.pseudoRef("MERGE_HEAD");
    if (!mergeHead) return undefined;
    const mode = await this.readFile(`${this.gitDir}/MERGE_MODE`);

    return {
      mergeHead,
      originalHead: (await this.getOrigHead()) ?? mergeHead,
      message: await this.readFile(`${this.gitDir}/MERGE_MSG`),
      squash: mode?.includes("squash") ?? false,
    };
  }

  async setMergeState(state: CheckoutMergeState | null): Promise<void> {
    if (state === null) {
      // Clear merge state
      await this.refs.remove("MERGE_HEAD");
      await this.removeFile(`${this.gitDir}/MERGE_MSG`);
      await this.removeFile(`${this.gitDir}/MERGE_MODE`);
    } else {
      // MERGE_HEAD goes through the ref store (git writes it plainly; the lock is harmless)
      await this.refs.set("MERGE_HEAD", state.mergeHead);
      if (state.message) {
        await this.writeFile(`${this.gitDir}/MERGE_MSG`, state.message);
      }
      if (state.squash) {
        await this.writeFile(`${this.gitDir}/MERGE_MODE`, "");
      }
    }
  }

  async getMergeHead(): Promise<ObjectId | undefined> {
    const state = await this.getMergeState();
    return state?.mergeHead;
  }

  // -------- Rebase --------

  async getRebaseState(): Promise<CheckoutRebaseState | undefined> {
    const state = await readRebaseState(this.files, this.gitDir);
    if (!state) return undefined;

    return {
      type: state.type === "rebase-merge" ? "merge" : "apply",
      currentCommit: undefined, // Not directly available from reader
      onto: state.onto,
      originalBranch: undefined, // Would need to read head-name file
      originalHead: state.head,
      totalCommits: state.total,
      currentIndex: state.current,
      commits: [], // Would need to read todo file
    };
  }

  async setRebaseState(state: CheckoutRebaseState | null): Promise<void> {
    if (state === null) {
      // Clear rebase state
      await this.removeDir(`${this.gitDir}/rebase-merge`);
      await this.removeDir(`${this.gitDir}/rebase-apply`);
    } else {
      // Writing rebase state is complex - typically managed by git rebase command
      const dir = state.type === "merge" ? "rebase-merge" : "rebase-apply";
      const rebaseDir = `${this.gitDir}/${dir}`;

      await this.mkdir(rebaseDir);
      await this.writeFile(`${rebaseDir}/onto`, state.onto);
      await this.writeFile(`${rebaseDir}/orig-head`, state.originalHead);
      await this.writeFile(`${rebaseDir}/msgnum`, String(state.currentIndex));
      await this.writeFile(`${rebaseDir}/end`, String(state.totalCommits));

      if (state.originalBranch) {
        await this.writeFile(`${rebaseDir}/head-name`, `refs/heads/${state.originalBranch}`);
      }
    }
  }

  // -------- Cherry-pick --------

  async getCherryPickState(): Promise<CheckoutCherryPickState | undefined> {
    const cherryPickHead = await this.pseudoRef("CHERRY_PICK_HEAD");
    if (!cherryPickHead) return undefined;

    const origHead = await this.getOrigHead();

    return {
      commits: [cherryPickHead],
      currentIndex: 0,
      originalHead: origHead ?? cherryPickHead, // Fallback
    };
  }

  async setCherryPickState(state: CheckoutCherryPickState | null): Promise<void> {
    if (state === null) {
      await this.refs.remove("CHERRY_PICK_HEAD");
    } else {
      const currentCommit = state.commits[state.currentIndex];
      if (currentCommit) {
        await this.refs.set("CHERRY_PICK_HEAD", currentCommit);
      }
    }
  }

  // -------- Revert --------

  async getRevertState(): Promise<CheckoutRevertState | undefined> {
    const revertHead = await this.pseudoRef("REVERT_HEAD");
    if (!revertHead) return undefined;

    const origHead = await this.getOrigHead();

    return {
      commits: [revertHead],
      currentIndex: 0,
      originalHead: origHead ?? revertHead, // Fallback
    };
  }

  async setRevertState(state: CheckoutRevertState | null): Promise<void> {
    if (state === null) {
      await this.refs.remove("REVERT_HEAD");
    } else {
      const currentCommit = state.commits[state.currentIndex];
      if (currentCommit) {
        await this.refs.set("REVERT_HEAD", currentCommit);
      }
    }
  }

  // -------- Abort --------

  async abortOperation(): Promise<void> {
    const state = await this.getOperationState();
    if (!state) return;

    switch (state.type) {
      case "merge":
        await this.setMergeState(null);
        break;
      case "rebase":
        await this.setRebaseState(null);
        break;
      case "cherry-pick":
        await this.setCherryPickState(null);
        break;
      case "revert":
        await this.setRevertState(null);
        break;
    }

    // Clear staging if conflicts exist
    if (await this.staging.hasConflicts()) {
      await this.staging.clear();

      // Restore staging from HEAD
      const headCommit = await this.getHeadCommit();
      if (headCommit) {
        // Note: Would need access to Trees to properly restore staging
        // For now just clear - full abort would need WorkingCopy context
      }
    }
  }

  // ========== FETCH_HEAD ==========

  /** `.git/FETCH_HEAD`, as native git reads and writes it. */
  async readFetchHead(): Promise<string | undefined> {
    return this.readFile(`${this.gitDir}/FETCH_HEAD`);
  }

  /** Writes `.git/FETCH_HEAD` in place, as git does (no lock file: git `fopen`s it). */
  async writeFetchHead(content: string, options?: { append?: boolean }): Promise<void> {
    const before = options?.append ? ((await this.readFetchHead()) ?? "") : "";
    await this.writeFile(`${this.gitDir}/FETCH_HEAD`, `${before}${content}`);
  }

  // ========== Operation state files ==========

  /** A file under the git directory (`MERGE_MSG`, `sequencer/todo`, ...). */
  async readStateFile(name: string): Promise<Uint8Array | undefined> {
    try {
      const stats = await this.files.stats(`${this.gitDir}/${name}`);
      if (stats?.isDirectory) return undefined;
      return (await this.files.read(`${this.gitDir}/${name}`)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes a file under the git directory as git writes it. The small files git writes with
   * `write_file` (`O_TRUNC` in place: `msgnum`, `end`, `head-name`, `onto`, `MERGE_MODE`,
   * ...) are replaced in place: the old file removed and the new one created holding the
   * content, where the files can create exclusively. Every other file (`git-rebase-todo`,
   * `sequencer/todo`, `message`, `author-script`, `MERGE_MSG`, `SQUASH_MSG`, ...) git writes
   * through a lock file renamed into place, so a crash never leaves it missing or partial:
   * those go through the files' `write`, which writes a temporary and renames it over.
   */
  async writeStateFile(name: string, content: Uint8Array | string): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const path = `${this.gitDir}/${name}`;
    if (this.files.createExclusive && this.files.remove && isWriteFileStyle(name)) {
      const stats = await this.files.stats(path).catch(() => undefined);
      if (!stats?.isDirectory) {
        if (stats) await this.files.remove(path);
        if (await this.files.createExclusive(path, [bytes]).catch(() => false)) return;
      }
    }
    const slash = name.lastIndexOf("/");
    try {
      await this.files.write(path, [bytes]);
    } catch (error) {
      if (slash <= 0) throw error;
      await this.mkdir(`${this.gitDir}/${name.slice(0, slash)}`);
      await this.files.write(path, [bytes]);
    }
  }

  /** Removes a file or directory (recursively) under the git directory. */
  async removeStateFile(name: string): Promise<void> {
    const path = `${this.gitDir}/${name}`;
    const stats = await this.files.stats(path).catch(() => undefined);
    if (!stats) return;
    if (stats.isDirectory && this.files.removeDir) await this.removeDir(path);
    else await this.removeFile(path);
  }

  /** The names in a directory under the git directory, sorted. */
  async listStateDir(name: string): Promise<string[]> {
    if (!this.files.list) return [];
    const names: string[] = [];
    try {
      for await (const entry of this.files.list(`${this.gitDir}/${name}`)) {
        const entryName = typeof entry === "string" ? entry : entry.name;
        names.push(entryName.slice(entryName.lastIndexOf("/") + 1));
      }
    } catch {
      return [];
    }
    return names.sort();
  }

  // ========== Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Read staging
    await this.staging.read();

    // Initialize refs if supported
    if (this.refs.initialize) {
      await this.refs.initialize();
    }

    this.initialized = true;
  }

  async refresh(): Promise<void> {
    await this.staging.read();
  }

  async close(): Promise<void> {
    // Write any pending staging changes
    await this.staging.write();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ========== Internal Helpers ==========

  private getOrigHead(): Promise<ObjectId | undefined> {
    return this.pseudoRef("ORIG_HEAD");
  }

  /**
   * The id a pseudo ref (MERGE_HEAD, CHERRY_PICK_HEAD, ORIG_HEAD, …) holds. Pseudo refs
   * live in the ref store (on git files, written under `<name>.lock`).
   */
  private async pseudoRef(name: string): Promise<ObjectId | undefined> {
    const ref = await this.refs.get(name).catch(() => undefined);
    return ref && "objectId" in ref && ref.objectId ? ref.objectId : undefined;
  }

  private async readFile(path: string): Promise<string | undefined> {
    try {
      const content = await this.files.read(path);
      if (!content) return undefined;
      return decodeGitPath(content); // bytes survive: FETCH_HEAD URLs, MERGE_MSG in latin-1
    } catch {
      return undefined;
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    await this.files.write(path, [encodeGitPath(content)]);
  }

  private async removeFile(path: string): Promise<void> {
    if (this.files.remove) {
      try {
        await this.files.remove(path);
      } catch {
        // Ignore if file doesn't exist
      }
    }
  }

  private async removeDir(path: string): Promise<void> {
    if (this.files.removeDir) {
      try {
        await this.files.removeDir(path);
      } catch {
        // Ignore if directory doesn't exist
      }
    }
  }

  private async mkdir(path: string): Promise<void> {
    if ("mkdir" in this.files && typeof this.files.mkdir === "function") {
      await this.files.mkdir(path);
    }
  }
}

/**
 * Factory function to create a GitCheckout
 */
export function createGitCheckout(options: GitCheckoutOptions): Checkout {
  return new GitCheckout(options);
}

/**
 * The state files git writes with `write_file` (`O_CREAT|O_TRUNC`, no lock file): small
 * one-line files whose loss after a crash git tolerates. Everything else is written as
 * git's `write_message` does, through a lock file renamed into place.
 */
const WRITE_FILE_STYLE = new Set([
  "msgnum",
  "end",
  "head-name",
  "onto",
  "orig-head",
  "interactive",
  "quiet",
  "verbose",
  "stopped-sha",
  "abort-safety",
  "head",
  "autostash",
  "MERGE_MODE",
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "drop_redundant_commits",
  "keep_redundant_commits",
  "reschedule-failed-exec",
  "no-reschedule-failed-exec",
  "strategy",
  "strategy_opts",
  "allow_rerere_autoupdate",
  "gpg_sign_opt",
  "signoff",
  "amend",
  "allow_empty_message",
]);

function isWriteFileStyle(name: string): boolean {
  return WRITE_FILE_STYLE.has(name.slice(name.lastIndexOf("/") + 1));
}
