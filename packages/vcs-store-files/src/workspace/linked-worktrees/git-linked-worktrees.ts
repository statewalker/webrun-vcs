/**
 * The worktrees of a git repository on files, as git's `worktree.c` keeps them.
 *
 * @example
 * ```typescript
 * const files = createNodeFilesApi({ rootDir: "/home/me/src" });
 * const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
 * const worktrees = await openGitLinkedWorktrees({ files, gitDir: "repo/.git", history });
 * const workingCopy = await worktrees.openCurrent(); // the main worktree, with `worktrees`
 * await Git.fromWorkingCopy(workingCopy).worktreeList().call();
 * ```
 *
 * Layout (git's): the main worktree is the directory above the repository (`repo` for
 * `repo/.git`), or none for a bare one. Each linked worktree has `.git/worktrees/<id>` with
 * `gitdir` (the worktree's `.git` file, an absolute host path), `commondir` (`../..`),
 * HEAD, the worktree's index, reflog and pseudo refs, and while locked `locked` (the
 * reason). The worktree's `.git` file says `gitdir: <repository>/.git/worktrees/<id>`.
 *
 * Host paths: git writes real paths. Where the FilesApi's root is on the host (`rootPath`,
 * else its `rootDirectory`) maps them; paths are compared lexically (the FilesApi resolves
 * no symbolic links, which git's `strbuf_realpath` would).
 *
 * @module
 */

import type { FilesApi, History, ObjectId, Refs } from "@statewalker/vcs-core";
import { createHistoryFromStores, isSymbolicRef } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath, parseGitBool } from "@statewalker/vcs-utils/encoding";
import { appendByRewrite, normalizePath, tryReadFile } from "@statewalker/vcs-utils/files";
import type {
  ContentFilterSetup,
  CreatedLinkedWorktree,
  CreateLinkedWorktreeOptions,
  LinkedWorktrees,
  WorkingCopy,
  WorktreeInfo,
  WorktreePathState,
  WorktreePruneCheck,
  WorktreeRepairReport,
} from "@statewalker/vcs-working-tree";

import { createWorktreeRefs } from "../../refs/index.js";
import { GitCheckout, type GitCheckoutFilesApi } from "../checkout/index.js";
import {
  HostPaths,
  hostRootOf,
  isAbsoluteGitPath,
  parseCommonDir,
  parseGitfile,
  parseWorktreeGitdir,
  sanitizeRefnameComponent,
} from "../git-dir/index.js";
import { FileStagingStore } from "../staging/index.js";
import { createGitStashStore } from "../working-copy/stash-store.files.js";
import { GitWorkingCopy, type WorkingCopyFilesApi } from "../working-copy/working-copy.files.js";
import {
  createWorkingCopyConfig,
  type GitConfigOptions,
  type GitWorkingCopyConfig,
} from "../working-copy/working-copy-config.files.js";
import { createFileWorktree } from "../worktree/index.js";

const ZERO_ID = "0000000000000000000000000000000000000000";
const GITLINK_MODE = 0o160000;

/** git's `read_gitfile_gently` error codes. */
const GITFILE_STAT_FAILED = 1;
const GITFILE_NOT_A_FILE = 2;
const GITFILE_INVALID_FORMAT = 5;
const GITFILE_NO_PATH = 6;
const GITFILE_NOT_A_REPO = 7;

/** Options of {@link openGitLinkedWorktrees}. */
export interface GitLinkedWorktreesOptions
  extends Pick<GitConfigOptions, "environment">,
    Omit<ContentFilterSetup, "environment"> {
  /** The FilesApi the repository and its worktrees are in. */
  files: FilesApi;
  /** The git directory of the current worktree: the repository's, or `.git/worktrees/<id>`. */
  gitDir: string;
  /** The repository's history (its refs are the main worktree's). */
  history: History;
  /** Where the FilesApi's root is on the host. Default: the FilesApi's `rootDirectory`. */
  rootPath?: string;
}

/**
 * The worktrees of the repository `options.gitDir` belongs to, seen from that git
 * directory (its worktree is the `current` one).
 */
export async function openGitLinkedWorktrees(
  options: GitLinkedWorktreesOptions,
): Promise<GitLinkedWorktrees> {
  const paths = new HostPaths(hostRootOf(options.files, options.rootPath));
  const gitDir = normalizePath(options.gitDir);
  const commonDir = await resolveCommonDir(options.files, paths, gitDir);
  return new GitLinkedWorktrees(options, paths, commonDir, gitDir);
}

/** git's `get_common_dir_noenv`: `commondir`, relative to the git directory unless absolute. */
async function resolveCommonDir(
  files: FilesApi,
  paths: HostPaths,
  gitDir: string,
): Promise<string> {
  const content = await readIfFile(files, `${gitDir}/commondir`);
  const text = content === undefined ? undefined : parseCommonDir(decodeGitPath(content));
  if (!text) return gitDir;
  if (isAbsoluteGitPath(text)) return normalizePath(paths.filesPath(text));
  return normalizePath(new HostPaths().normalize(`${gitDir}/${text}`));
}

/** A file's bytes; undefined unless it is a file (a FilesApi may read a missing one as empty). */
async function readIfFile(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  const kind = (await files.stats(path).catch(() => undefined))?.kind;
  if (kind !== "file") return undefined;
  return tryReadFile(files, path).catch(() => undefined);
}

/** `write_file`'s text: a line end added when missing, an empty text an empty file. */
function lineText(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** The files backend's {@link LinkedWorktrees}. */
export class GitLinkedWorktrees implements LinkedWorktrees {
  private readonly files: FilesApi;
  private readonly history: History;
  private config?: GitWorkingCopyConfig;
  private readonly refsByDir = new Map<string, Refs>();

  constructor(
    private readonly options: GitLinkedWorktreesOptions,
    private readonly paths: HostPaths,
    /** The repository directory (a FilesApi path). */
    readonly commonDir: string,
    /** The current worktree's git directory (a FilesApi path). */
    readonly gitDir: string,
  ) {
    this.files = options.files;
    this.history = options.history;
  }

  // ----------------------------------------------------------------- paths

  hostPath(path: string): string {
    return this.paths.hostPath(this.toFiles(path));
  }

  /**
   * A path given by the caller in this FilesApi: an absolute host path below the root is
   * mapped, anything else is taken as a FilesApi path.
   */
  private toFiles(path: string): string {
    if (this.paths.known && isAbsoluteGitPath(path) && this.paths.inside(path)) {
      return normalizePath(this.paths.filesPath(path));
    }
    return normalizePath(new HostPaths().normalize(path));
  }

  /** The FilesApi path of a host path git wrote (undefined: beyond the FilesApi's root). */
  private fromHost(hostPath: string): string | undefined {
    if (!this.paths.known) return normalizePath(new HostPaths().normalize(hostPath));
    if (!this.paths.inside(hostPath)) return undefined;
    return normalizePath(this.paths.filesPath(hostPath));
  }

  private adminDir(id: string): string {
    return `${this.commonDir}/worktrees/${id}`;
  }

  /** The main worktree's directory (a FilesApi path): the repository's parent for `.git`. */
  private mainPath(): string {
    return this.commonDir.endsWith("/.git")
      ? this.commonDir.slice(0, -"/.git".length) || "/"
      : this.commonDir;
  }

  commonDirPath(): string {
    return this.paths.hostPath(this.commonDir);
  }

  // ----------------------------------------------------------------- reading

  /** A file's text (its bytes kept, `decodeGitPath`); undefined unless it is a file. */
  private async readText(path: string): Promise<string | undefined> {
    const content = await readIfFile(this.files, path);
    return content === undefined ? undefined : decodeGitPath(content);
  }

  private async kind(path: string | undefined): Promise<"file" | "directory" | undefined> {
    if (path === undefined) return undefined;
    return (await this.files.stats(path).catch(() => undefined))?.kind;
  }

  private async repositoryConfig(): Promise<GitWorkingCopyConfig> {
    if (!this.config) {
      this.config = await createWorkingCopyConfig(this.configFiles(), this.commonDir);
    }
    return this.config;
  }

  private configFiles() {
    return {
      read: (path: string) => readIfFile(this.files, path),
      write: (path: string, content: Uint8Array) => this.files.write(path, [content]),
    };
  }

  private async reflogSettings(): Promise<{
    logAllRefUpdates: boolean | "always";
    identity: { name: string; email: string };
  }> {
    const config = await this.repositoryConfig();
    const setting = config.get("core.logAllRefUpdates");
    const logAllRefUpdates =
      typeof setting === "string" && setting.toLowerCase() === "always"
        ? "always"
        : (parseGitBool(setting) ?? !(parseGitBool(config.get("core.bare")) ?? false));
    const name = config.get("user.name");
    const email = config.get("user.email");
    return {
      logAllRefUpdates,
      identity: {
        name: typeof name === "string" ? name : "webrun-vcs",
        email: typeof email === "string" ? email : "vcs@localhost",
      },
    };
  }

  /** The refs a worktree's git directory sees (the repository's own for the main worktree). */
  private async refsOf(gitDir: string): Promise<Refs> {
    if (gitDir === this.commonDir) return this.history.refs;
    let refs = this.refsByDir.get(gitDir);
    if (!refs) {
      const { logAllRefUpdates, identity } = await this.reflogSettings();
      refs = createWorktreeRefs({
        common: this.history.refs,
        files: this.files,
        gitDir,
        logAllRefUpdates,
        reflogIdentity: identity,
      });
      this.refsByDir.set(gitDir, refs);
    }
    return refs;
  }

  /** git's `add_head_info`, and the rebase or bisect a worktree is in (`wt_status_check_*`). */
  private async headInfo(gitDir: string) {
    const out: {
      head?: ObjectId;
      headRef?: string;
      detached: boolean;
      rebasing?: string;
      bisecting?: string;
    } = { detached: false };
    try {
      const refs = await this.refsOf(gitDir);
      const head = await refs.get("HEAD");
      if (head && isSymbolicRef(head)) {
        out.headRef = head.target;
        out.head = (await refs.resolve("HEAD"))?.objectId;
      } else if (head?.objectId) {
        out.detached = true;
        out.head = head.objectId;
      }
    } catch {
      // an unreadable HEAD: neither branch nor commit, as git's failed resolve
    }
    const branchAt = async (path: string) => {
      const text = (await this.readText(path))?.trim();
      if (!text) return undefined;
      if (text.startsWith("refs/heads/")) return text;
      if (text.startsWith("refs/") || /^[0-9a-f]{40}$/.test(text) || text === "detached HEAD") {
        return undefined;
      }
      return `refs/heads/${text}`;
    };
    if ((await this.kind(`${gitDir}/rebase-merge`)) === "directory") {
      out.rebasing = await branchAt(`${gitDir}/rebase-merge/head-name`);
    } else if (
      (await this.kind(`${gitDir}/rebase-apply`)) === "directory" &&
      (await this.kind(`${gitDir}/rebase-apply/applying`)) === undefined
    ) {
      out.rebasing = await branchAt(`${gitDir}/rebase-apply/head-name`);
    }
    out.bisecting = await branchAt(`${gitDir}/BISECT_START`);
    return out;
  }

  private async mainEntry(): Promise<WorktreeInfo> {
    const config = await this.repositoryConfig();
    const bare = parseGitBool(config.get("core.bare")) === true;
    return {
      path: this.paths.hostPath(this.mainPath()),
      bare,
      current: this.gitDir === this.commonDir,
      ...(await this.headInfo(this.commonDir)),
    };
  }

  /** git's `get_linked_worktree`: undefined when its `gitdir` file is missing or empty. */
  private async linkedEntry(id: string): Promise<WorktreeInfo | undefined> {
    const admin = this.adminDir(id);
    const content = await this.readText(`${admin}/gitdir`);
    if (!content) return undefined;
    let path = parseWorktreeGitdir(content);
    if (path.endsWith("/.git")) path = path.slice(0, -"/.git".length);
    if (!isAbsoluteGitPath(path)) {
      // a relative gitdir (worktree.useRelativePaths): relative to the admin directory
      path = this.paths.normalize(`${this.paths.hostPath(admin)}/${path}`);
    }
    const locked = await this.readText(`${admin}/locked`);
    return {
      id,
      path,
      bare: false,
      current: this.gitDir === admin,
      ...(locked !== undefined ? { lockReason: locked.trim() } : {}),
      ...(await this.headInfo(admin)),
    };
  }

  async adminIds(): Promise<string[]> {
    const root = `${this.commonDir}/worktrees`;
    if ((await this.kind(root)) !== "directory") return [];
    const ids: string[] = [];
    for await (const entry of this.files.list(root)) ids.push(entry.name);
    return ids;
  }

  async list(): Promise<WorktreeInfo[]> {
    const out: WorktreeInfo[] = [await this.mainEntry()];
    for (const id of await this.adminIds()) {
      const entry = await this.linkedEntry(id);
      if (entry) out.push(entry);
    }
    return out;
  }

  async find(arg: string): Promise<WorktreeInfo | undefined> {
    const list = await this.list();
    // find_worktree_by_suffix: a unique worktree whose path ends with `arg` at a separator
    if (arg !== "") {
      const found = list.filter((wt) => {
        const start = wt.path.length - arg.length;
        if (start < 0 || !this.samePath(wt.path.slice(start), arg)) return false;
        return start === 0 || wt.path[start - 1] === "/";
      });
      if (found.length === 1) return found[0];
    }
    return this.byPath(list, arg);
  }

  async findByPath(path: string): Promise<WorktreeInfo | undefined> {
    return this.byPath(await this.list(), path);
  }

  private samePath(a: string, b: string): boolean {
    return this.paths.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private byPath(list: WorktreeInfo[], path: string): WorktreeInfo | undefined {
    const host = this.hostPath(path);
    return list.find((wt) => this.paths.same(wt.path, host));
  }

  async pathState(path: string): Promise<WorktreePathState> {
    const at = this.toFiles(path);
    const kind = await this.kind(at);
    if (kind === undefined) return "missing";
    if (kind === "file") return "file";
    for await (const _ of this.files.list(at)) return "directory";
    return "empty-directory";
  }

  async pruneCheck(id: string, expire: number): Promise<WorktreePruneCheck> {
    const admin = this.adminDir(id);
    if ((await this.kind(admin)) !== "directory") return { reason: "not a valid directory" };
    if ((await this.kind(`${admin}/locked`)) !== undefined) return {};
    if ((await this.kind(`${admin}/gitdir`)) === undefined) {
      return { reason: "gitdir file does not exist" };
    }
    const content = await this.readText(`${admin}/gitdir`);
    if (content === undefined) return { reason: "unable to read gitdir file" };
    let end = content.length;
    while (end > 0 && (content[end - 1] === "\n" || content[end - 1] === "\r")) end--;
    if (end === 0) return { reason: "invalid gitdir file" };
    const gitdirPath = content.slice(0, end);
    const target = isAbsoluteGitPath(gitdirPath)
      ? gitdirPath
      : this.paths.normalize(`${this.paths.hostPath(admin)}/${gitdirPath}`);
    if ((await this.kind(this.fromHost(target))) === undefined) {
      const index = await this.files.stats(`${admin}/index`).catch(() => undefined);
      const mtime = index?.lastModified;
      if (mtime === undefined || Math.floor(mtime / 1000) <= expire) {
        return { reason: "gitdir file points to non-existent location" };
      }
    }
    return { gitdirPath };
  }

  /** git's `read_gitfile_gently` of the `.git` file at the FilesApi path `dotGit`. */
  private async readGitfile(dotGit: string): Promise<{ error?: number; target?: string }> {
    const kind = await this.kind(dotGit);
    if (kind === undefined) return { error: GITFILE_STAT_FAILED };
    if (kind === "directory") return { error: GITFILE_NOT_A_FILE };
    const content = (await this.readText(dotGit)) ?? "";
    if (!content.startsWith("gitdir: ")) return { error: GITFILE_INVALID_FORMAT };
    const written = parseGitfile(content);
    if (written === undefined) return { error: GITFILE_NO_PATH };
    const dir = this.paths.hostPath(dotGit.slice(0, dotGit.lastIndexOf("/")) || "/");
    const target = isAbsoluteGitPath(written)
      ? this.paths.normalize(written)
      : this.paths.normalize(`${dir}/${written}`);
    if (!(await this.isGitDirectory(this.fromHost(target)))) {
      return { error: GITFILE_NOT_A_REPO, target };
    }
    return { target };
  }

  /** git's `is_git_directory`: a HEAD, and objects (here or through `commondir`). */
  private async isGitDirectory(dir: string | undefined): Promise<boolean> {
    if (dir === undefined) return false;
    if ((await this.kind(`${dir}/HEAD`)) !== "file") return false;
    if ((await this.kind(`${dir}/commondir`)) === "file") return true;
    return (await this.kind(`${dir}/objects`)) === "directory";
  }

  async validate(
    entry: WorktreeInfo,
    options: { missingOk?: boolean } = {},
  ): Promise<string | undefined> {
    const dotGit = `${entry.path}/.git`;
    if (entry.id === undefined) {
      if ((await this.kind(this.fromHost(dotGit))) === "directory") return undefined;
      return `'${dotGit}' at main working tree is not the repository directory`;
    }
    const admin = this.paths.hostPath(this.adminDir(entry.id));
    if (!isAbsoluteGitPath(entry.path)) {
      return `'${admin}/gitdir' file does not contain absolute path to the working tree location`;
    }
    if (options.missingOk && (await this.kind(this.fromHost(entry.path))) === undefined) {
      return undefined;
    }
    if ((await this.kind(this.fromHost(dotGit))) === undefined) return `'${dotGit}' does not exist`;
    const dotGitFiles = this.fromHost(dotGit);
    const read = dotGitFiles ? await this.readGitfile(dotGitFiles) : { error: GITFILE_STAT_FAILED };
    if (read.error !== undefined || read.target === undefined) {
      return `'${dotGit}' is not a .git file, error code ${read.error}`;
    }
    if (!this.paths.same(read.target, admin)) {
      return `'${entry.path}' does not point back to '${admin}'`;
    }
    return undefined;
  }

  async hasSubmodules(entry: WorktreeInfo): Promise<boolean> {
    const gitDir = entry.id === undefined ? this.commonDir : this.adminDir(entry.id);
    if ((await this.kind(`${gitDir}/modules`)) === "directory") return true;
    if ((await this.kind(`${gitDir}/index`)) !== "file") return false;
    const staging = new FileStagingStore(this.files, `${gitDir}/index`);
    try {
      await staging.read();
    } catch {
      return false;
    }
    const root = this.fromHost(entry.path);
    if (root === undefined) return false;
    for await (const e of staging.entries()) {
      if (e.mode !== GITLINK_MODE) continue;
      // is_submodule_populated_gently: the submodule's .git leads to a repository
      const dotGit = `${root}/${e.path}/.git`;
      const kind = await this.kind(dotGit);
      if (kind === "directory" && (await this.isGitDirectory(dotGit))) return true;
      if (kind === "file" && (await this.readGitfile(dotGit)).error === undefined) return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- writing

  private async writeText(path: string, text: string): Promise<void> {
    await this.files.write(path, [encodeGitPath(text)]);
  }

  async create(options: CreateLinkedWorktreeOptions): Promise<CreatedLinkedWorktree> {
    const path = this.toFiles(options.path);
    // worktree_basename: the last component, trailing separators aside
    const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
    if (base === "") throw new Error(`invalid path '${options.path}'`);
    const name = sanitizeRefnameComponent(base);
    if (name === "" || name.includes("/")) throw new Error(`invalid path '${options.path}'`);

    // the head as HEAD will name it, resolved before anything is written
    const headId =
      "id" in options.head
        ? options.head.id
        : (await this.history.refs.resolve(options.head.ref).catch(() => undefined))?.objectId;

    // worktrees/<name>, numbered when taken (add_worktree's mkdir loop)
    const root = `${this.commonDir}/worktrees`;
    let id = name;
    for (let counter = 1; (await this.kind(`${root}/${id}`)) !== undefined; counter++) {
      id = `${name}${counter}`;
    }
    const admin = `${root}/${id}`;
    const existed = (await this.kind(path)) !== undefined;
    const created: CreatedLinkedWorktree = { id, createdDirectory: !existed };
    try {
      await this.files.mkdir(admin);
      // locked while it is set up, so a concurrent prune keeps it
      await this.writeText(`${admin}/locked`, lineText(options.lockReason ?? "initializing"));
      await this.files.mkdir(path);
      await this.writeText(`${admin}/gitdir`, `${this.paths.hostPath(`${path}/.git`)}\n`);
      await this.writeText(`${path}/.git`, `gitdir: ${this.paths.hostPath(admin)}\n`);
      const head = "id" in options.head ? options.head.id : `ref: ${options.head.ref}`;
      await this.writeText(`${admin}/HEAD`, `${head}\n`);
      await this.writeText(`${admin}/commondir`, "../..\n");
      // update-ref / symbolic-ref log the new HEAD: no message, from the zero id
      if (headId) await this.appendHeadLog(admin, ZERO_ID, headId, options.ident, "");
    } catch (error) {
      await this.discardCreate(created, path).catch(() => undefined);
      throw error;
    }
    return created;
  }

  /** A line of `<gitDir>/logs/HEAD`, as core.logAllRefUpdates allows. */
  async appendHeadLog(
    gitDir: string,
    oldId: ObjectId,
    newId: ObjectId,
    ident: string | undefined,
    message: string,
  ): Promise<void> {
    const { logAllRefUpdates, identity } = await this.reflogSettings();
    const path = `${gitDir}/logs/HEAD`;
    if (logAllRefUpdates === false && (await this.kind(path)) === undefined) return;
    const who =
      ident ?? `${identity.name} <${identity.email}> ${Math.floor(Date.now() / 1000)} +0000`;
    const line = `${oldId} ${newId} ${who}${message ? `\t${message}` : ""}\n`;
    const bytes = [new TextEncoder().encode(line)];
    if (this.files.append) await this.files.append(path, bytes);
    else await appendByRewrite(this.files, path, bytes);
  }

  async finishCreate(id: string, keepLocked: boolean): Promise<void> {
    if (!keepLocked) await this.files.remove(`${this.adminDir(id)}/locked`);
  }

  async discardCreate(created: CreatedLinkedWorktree, path: string): Promise<void> {
    await this.files.remove(this.adminDir(created.id)).catch(() => false);
    if (created.createdDirectory) await this.files.remove(this.toFiles(path)).catch(() => false);
  }

  async lock(entry: WorktreeInfo, reason: string): Promise<void> {
    if (entry.id === undefined)
      throw new Error("The main working tree cannot be locked or unlocked");
    await this.writeText(`${this.adminDir(entry.id)}/locked`, lineText(reason));
  }

  async unlock(entry: WorktreeInfo): Promise<void> {
    if (entry.id === undefined)
      throw new Error("The main working tree cannot be locked or unlocked");
    await this.files.remove(`${this.adminDir(entry.id)}/locked`);
  }

  async deleteAdminDir(id: string): Promise<void> {
    await this.files.remove(this.adminDir(id));
  }

  async deleteAdminRootIfEmpty(): Promise<void> {
    const root = `${this.commonDir}/worktrees`;
    if ((await this.kind(root)) !== "directory") return;
    for await (const _ of this.files.list(root)) return;
    await this.files.remove(root);
  }

  async deleteWorkTree(entry: WorktreeInfo): Promise<void> {
    const path = this.fromHost(entry.path);
    if (path === undefined) throw new Error(`failed to delete '${entry.path}'`);
    await this.files.remove(path);
  }

  async move(entry: WorktreeInfo, destination: string): Promise<void> {
    if (entry.id === undefined) throw new Error("can't relocate main worktree");
    const from = this.fromHost(entry.path);
    const to = this.toFiles(destination);
    if (from === undefined || !(await this.files.move(from, to))) {
      throw new Error(`failed to move '${entry.path}' to '${this.paths.hostPath(to)}'`);
    }
    // update_worktree_location: both link files name the new place
    const admin = this.adminDir(entry.id);
    if (!this.paths.same(entry.path, this.paths.hostPath(to))) {
      await this.writeText(`${to}/.git`, `gitdir: ${this.paths.hostPath(admin)}\n`);
      await this.writeText(`${admin}/gitdir`, `${this.paths.hostPath(`${to}/.git`)}\n`);
    }
  }

  async repair(paths: string[]): Promise<WorktreeRepairReport[]> {
    const reports: WorktreeRepairReport[] = [];
    for (const path of paths) await this.repairAtPath(path, reports);
    const list = await this.list();
    for (const wt of list.slice(1)) await this.repairGitfile(wt, reports);
    return reports;
  }

  /** git's `repair_worktree_at_path`: the `gitdir` back-link of the worktree at `path`. */
  private async repairAtPath(path: string, reports: WorktreeRepairReport[]): Promise<void> {
    const at = this.toFiles(path);
    if (this.paths.same(this.paths.hostPath(at), this.paths.hostPath(this.mainPath()))) return;
    const dotGit = `${at}/.git`;
    const hostDotGit = this.paths.hostPath(dotGit);
    if ((await this.kind(dotGit)) === undefined) {
      reports.push({ error: true, path, message: "not a valid path" });
      return;
    }
    const read = await this.readGitfile(dotGit);
    let backlink: string | undefined = read.target;
    const inferred = await this.inferBacklink(dotGit);
    if (read.error === GITFILE_NOT_A_FILE) {
      reports.push({
        error: true,
        path: hostDotGit,
        message: "unable to locate repository; .git is not a file",
      });
      return;
    }
    if (read.error === GITFILE_NOT_A_REPO) {
      if (!inferred) {
        reports.push({
          error: true,
          path: hostDotGit,
          message: "unable to locate repository; .git file does not reference a repository",
        });
        return;
      }
      backlink = inferred;
    } else if (read.error !== undefined || backlink === undefined) {
      reports.push({
        error: true,
        path: hostDotGit,
        message: "unable to locate repository; .git file broken",
      });
      return;
    }
    // a copied repository: the worktree's .git file names the original's admin directory
    if (inferred && !this.paths.same(backlink, inferred)) backlink = inferred;
    const admin = this.fromHost(backlink);
    if (admin === undefined) return;
    const gitdir = `${admin}/gitdir`;
    const old = await this.readText(gitdir);
    let message: string | undefined;
    if (old === undefined) message = "gitdir unreadable";
    else if (!this.paths.same(parseWorktreeGitdir(old), hostDotGit)) message = "gitdir incorrect";
    if (message) {
      reports.push({ error: false, path: this.paths.hostPath(gitdir), message });
      await this.writeText(gitdir, `${hostDotGit}\n`);
    }
  }

  /** git's `infer_backlink`: `worktrees/<id>` of this repository for the id the `.git` file names. */
  private async inferBacklink(dotGit: string): Promise<string | undefined> {
    const content = await this.readText(dotGit);
    if (!content?.startsWith("gitdir:")) return undefined;
    const trimmed = content.trim();
    const slash = trimmed.lastIndexOf("/");
    if (slash < 0) return undefined;
    const id = trimmed.slice(slash + 1);
    if (id === "") return undefined;
    const admin = this.adminDir(id);
    return (await this.kind(admin)) === "directory" ? this.paths.hostPath(admin) : undefined;
  }

  /** git's `repair_gitfile`: a linked worktree's `.git` file. */
  private async repairGitfile(wt: WorktreeInfo, reports: WorktreeRepairReport[]): Promise<void> {
    if (wt.id === undefined) return;
    const root = this.fromHost(wt.path);
    const kind = await this.kind(root);
    if (kind === undefined || root === undefined) return;
    if (kind !== "directory") {
      reports.push({ error: true, path: wt.path, message: "not a directory" });
      return;
    }
    const admin = this.paths.hostPath(this.adminDir(wt.id));
    const dotGit = `${root}/.git`;
    const read = await this.readGitfile(dotGit);
    let message: string | undefined;
    if (read.error === GITFILE_NOT_A_FILE) {
      reports.push({ error: true, path: wt.path, message: ".git is not a file" });
      return;
    }
    if (read.error !== undefined) {
      message = ".git file broken";
    } else if (read.target === undefined || !this.paths.same(read.target, admin)) {
      message = ".git file incorrect";
    }
    if (message) {
      reports.push({ error: false, path: wt.path, message });
      await this.writeText(dotGit, `gitdir: ${admin}\n`);
    }
  }

  // ----------------------------------------------------------------- working copies

  /** The working copy of the current worktree. */
  async openCurrent(): Promise<WorkingCopy> {
    const current = (await this.list()).find((wt) => wt.current);
    if (current) return this.open(current);
    // the current git directory is not listed (its gitdir file is gone): open it anyway
    const id = this.gitDir.slice(this.gitDir.lastIndexOf("/") + 1);
    return this.open({
      id,
      path: this.paths.hostPath(this.mainPath()),
      bare: false,
      detached: false,
      current: true,
    });
  }

  async open(entry: WorktreeInfo): Promise<WorkingCopy> {
    const gitDir = entry.id === undefined ? this.commonDir : this.adminDir(entry.id);
    const root = this.fromHost(entry.path);
    if (root === undefined) throw new Error(`'${entry.path}' is beyond this storage`);
    const refs = await this.refsOf(gitDir);
    const base = this.history;
    const history =
      refs === base.refs
        ? base
        : createHistoryFromStores({
            blobs: base.blobs,
            trees: base.trees,
            commits: base.commits,
            tags: base.tags,
            refs,
            objects: base.objects,
            packs: base.packs,
          });
    const staging = new FileStagingStore(this.files, `${gitDir}/index`);
    await staging.read();
    const checkout = new GitCheckout({
      staging,
      refs,
      files: this.checkoutFiles(),
      gitDir,
    });
    const worktree = createFileWorktree({
      files: this.files,
      rootPath: root,
      gitDir: this.commonDir,
      blobs: history.blobs,
      trees: history.trees,
    });
    const stash = createGitStashStore({
      history,
      staging,
      worktree,
      getHead: async () => checkout.getHeadCommit(),
      getBranch: async () => checkout.getCurrentBranch(),
    });
    const configOptions: GitConfigOptions = {
      ...(this.options.environment ? { environment: this.options.environment } : {}),
      gitDirPath: this.paths.hostPath(gitDir),
    };
    if (gitDir !== this.commonDir) {
      configOptions.worktreeConfigPath = `${gitDir}/config.worktree`;
      configOptions.readHead = async () => {
        const text = (await this.readText(`${gitDir}/HEAD`))?.trim();
        return text?.startsWith("ref: ") ? text.slice(5).trim() : undefined;
      };
    }
    const config = await createWorkingCopyConfig(
      this.configFiles(),
      this.commonDir,
      undefined,
      configOptions,
    );
    const worktrees = new GitLinkedWorktrees(this.options, this.paths, this.commonDir, gitDir);
    const {
      files: _files,
      gitDir: _gitDir,
      history: _history,
      rootPath: _root,
      ...setup
    } = this.options;
    return new GitWorkingCopy({
      history,
      checkout,
      worktree,
      stash,
      config,
      files: this.workingCopyFiles(),
      ...setup,
      gitDir,
      worktrees,
    });
  }

  private workingCopyFiles(): WorkingCopyFilesApi {
    return {
      read: (path: string) => readIfFile(this.files, path),
      exists: (path: string) => this.files.exists(path),
      stats: async (path: string) => {
        const kind = await this.kind(path);
        return kind === undefined ? undefined : { isDirectory: kind === "directory" };
      },
    } as WorkingCopyFilesApi;
  }

  private checkoutFiles(): GitCheckoutFilesApi {
    const files = this.files;
    return {
      read: (path: string) => readIfFile(files, path),
      exists: (path: string) => files.exists(path),
      stats: async (path: string) => {
        const kind = await this.kind(path);
        return kind === undefined ? undefined : { isDirectory: kind === "directory" };
      },
      write: (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) =>
        files.write(path, content),
      mkdir: (path: string) => files.mkdir(path),
      remove: async (path: string) => {
        await files.remove(path);
      },
      removeDir: async (path: string) => {
        await files.remove(path);
      },
      ...(files.createExclusive ? { createExclusive: files.createExclusive.bind(files) } : {}),
      ...(files.append ? { append: files.append.bind(files) } : {}),
      list: (path: string) => files.list(path),
    } as unknown as GitCheckoutFilesApi;
  }
}
