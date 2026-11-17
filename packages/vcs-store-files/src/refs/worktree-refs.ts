/**
 * The refs a linked worktree sees, as git's files backend lays them out: HEAD, the pseudo
 * refs (`ORIG_HEAD`, `MERGE_HEAD`, ...) and `refs/bisect/`, `refs/worktree/`,
 * `refs/rewritten/` live in the worktree's own git directory (`.git/worktrees/<id>`);
 * every other ref is the repository's.
 *
 * @example
 * ```typescript
 * const refs = createWorktreeRefs({
 *   common: history.refs,
 *   files,
 *   gitDir: ".git/worktrees/wt",
 * });
 * await refs.get("HEAD"); // .git/worktrees/wt/HEAD
 * await refs.resolve("HEAD"); // through it to refs/heads/<branch> of the repository
 * ```
 *
 * An update through the worktree's symbolic HEAD (`set` aside, which never follows a
 * symbolic ref) changes the branch in the repository and adds the line to the worktree's
 * `logs/HEAD`, as git's `split_head_update` does: also when the branch keeps its value. A batch with refs of both kinds commits
 * the repository's refs first, then the worktree's: it is atomic within each part only.
 *
 * @module
 */

import type {
  BatchOptions,
  BatchResult,
  FilesApi,
  ObjectId,
  Ref,
  RefCommand,
  RefLogOptions,
  ReflogDeleteOptions,
  ReflogReader,
  Refs,
  RefUpdateResult,
  SymbolicRef,
  SymbolicRefLogOptions,
} from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";
import { appendByRewrite, joinPath } from "@statewalker/vcs-utils/files";

import type { FilesRefBatchOptions } from "./files-ref-batch.js";
import { createFileRefStore } from "./ref-store.files.js";

/** git's symref depth limit while resolving. */
const MAX_SYMREF_DEPTH = 5;
const ZERO_ID = "0000000000000000000000000000000000000000";

/**
 * Whether `name` lives in a worktree's own git directory (git's `is_per_worktree_ref` and
 * the pseudo refs): HEAD and the names outside `refs/`, and `refs/bisect/`,
 * `refs/worktree/`, `refs/rewritten/`.
 */
export function isPerWorktreeRef(name: string): boolean {
  return (
    !name.startsWith("refs/") ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/rewritten/")
  );
}

/** Options of {@link createWorktreeRefs}. */
export interface WorktreeRefsOptions
  extends Pick<FilesRefBatchOptions, "logAllRefUpdates" | "reflogIdentity"> {
  /** The repository's refs (the main worktree's store). */
  common: Refs;
  /** The FilesApi the worktree's git directory is in. */
  files: FilesApi;
  /** The worktree's git directory (`.git/worktrees/<id>`). */
  gitDir: string;
}

/** The refs of the linked worktree whose git directory is `options.gitDir`. */
export function createWorktreeRefs(options: WorktreeRefsOptions): Refs {
  return new WorktreeRefs(options);
}

class WorktreeRefs implements Refs {
  private readonly common: Refs;
  private readonly own: Refs;

  constructor(private readonly options: WorktreeRefsOptions) {
    this.common = options.common;
    // HEAD here names a branch of the repository: its old value (compared and logged by a
    // `noDeref` update of HEAD, as `checkout --detach` or a rebase's start make) is read there
    this.own = createFileRefStore(options.files, options.gitDir, {
      logAllRefUpdates: options.logAllRefUpdates,
      reflogIdentity: options.reflogIdentity,
      resolveOutside: async (name) =>
        isPerWorktreeRef(name) ? undefined : (await this.common.resolve(name))?.objectId,
    });
  }

  private store(name: string): Refs {
    return isPerWorktreeRef(name) ? this.own : this.common;
  }

  get(name: string): Promise<Ref | SymbolicRef | undefined> {
    return this.store(name).get(name);
  }

  async resolve(name: string): Promise<Ref | undefined> {
    let current = name;
    for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
      const value = await this.get(current);
      if (!value) return undefined;
      if (!isSymbolicRef(value)) return value;
      current = value.target;
    }
    return undefined;
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    const entries: (Ref | SymbolicRef)[] = [];
    for await (const ref of this.common.list(prefix)) {
      if (!isPerWorktreeRef(ref.name)) entries.push(ref);
    }
    for await (const ref of this.own.list(prefix)) {
      if (isPerWorktreeRef(ref.name)) entries.push(ref);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    yield* entries;
  }

  async set(name: string, objectId: ObjectId, log?: RefLogOptions): Promise<void> {
    if (isPerWorktreeRef(name)) return this.own.set(name, objectId, log);
    // a batch, so the worktree's HEAD logs an update of the branch it points at
    const result = await this.batch([{ name, new: objectId, noDeref: true }], log);
    if (!result.ok) {
      throw new Error(
        `cannot update ${name}: ${result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ")}`,
      );
    }
  }

  setSymbolic(name: string, target: string, log?: SymbolicRefLogOptions): Promise<void> {
    return this.store(name).setSymbolic(name, target, log);
  }

  remove(name: string): Promise<boolean> {
    return this.store(name).remove(name);
  }

  /** `name` with a per-worktree symbolic ref followed into the repository's refs. */
  private async deref(name: string): Promise<{ name: string; via: string[] }> {
    const via: string[] = [];
    let current = name;
    for (let depth = 0; depth < MAX_SYMREF_DEPTH && isPerWorktreeRef(current); depth++) {
      const value = await this.own.get(current);
      if (!value || !isSymbolicRef(value)) break;
      via.push(current);
      current = value.target;
    }
    return { name: current, via };
  }

  async batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    const commonCommands: RefCommand[] = [];
    const ownCommands: RefCommand[] = [];
    const logged: { via: string[]; name: string }[] = [];
    const head = await this.own.get("HEAD").catch(() => undefined);
    const headTarget = head && isSymbolicRef(head) ? head.target : undefined;
    for (const command of commands) {
      let target = command.name;
      let via: string[] = [];
      if (!command.noDeref) ({ name: target, via } = await this.deref(command.name));
      // the worktree's HEAD logs an update through it, or of the branch it points at
      if (!isPerWorktreeRef(target) && command.new !== null) {
        if (via.length > 0) logged.push({ via, name: target });
        else if (target === headTarget) logged.push({ via: ["HEAD"], name: target });
      }
      const rewritten = target === command.name ? command : { ...command, name: target };
      (isPerWorktreeRef(target) ? ownCommands : commonCommands).push(rewritten);
    }
    const before = new Map<string, ObjectId | undefined>();
    for (const { name } of logged) before.set(name, (await this.common.resolve(name))?.objectId);
    if (commonCommands.length > 0) {
      const result = await this.common.batch(commonCommands, options);
      if (!result.ok) return result;
    }
    // the worktree's HEAD records an update made through it (split_head_update), even one
    // that leaves the branch where it was (`reset --hard` logs "reset: moving to HEAD")
    for (const { via, name } of logged) {
      const after = (await this.common.resolve(name))?.objectId;
      for (const ref of via) await this.appendLog(ref, before.get(name), after, options);
    }
    if (ownCommands.length > 0) return this.own.batch(ownCommands, options);
    return { ok: true, rejected: [] };
  }

  private async appendLog(
    name: string,
    old: ObjectId | undefined,
    next: ObjectId | undefined,
    options: BatchOptions | undefined,
  ): Promise<void> {
    const { files, gitDir, logAllRefUpdates = true } = this.options;
    const path = joinPath(gitDir, "logs", name);
    if (logAllRefUpdates === false && !(await files.exists(path))) return;
    const identity = this.options.reflogIdentity ?? { name: "webrun-vcs", email: "vcs@localhost" };
    const ident =
      options?.ident ??
      `${identity.name} <${identity.email}> ${Math.floor(Date.now() / 1000)} +0000`;
    const message = (options?.message ?? "").replace(/[\r\n]+/g, " ").trim();
    const line = `${old ?? ZERO_ID} ${next ?? ZERO_ID} ${ident}${message ? `\t${message}` : ""}\n`;
    const bytes = [new TextEncoder().encode(line)];
    if (files.append) await files.append(path, bytes);
    else await appendByRewrite(files, path, bytes);
  }

  async compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const { name: target } = await this.deref(name);
    return this.store(target).compareAndSwap(target, expected, newValue);
  }

  getShallow(): Promise<ObjectId[]> {
    return this.common.getShallow?.() ?? Promise.resolve([]);
  }

  async setShallow(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void> {
    if (!this.common.setShallow) throw new Error("this repository cannot be shallow");
    await this.common.setShallow(commits, expected);
  }

  async optimize(): Promise<void> {
    await this.common.optimize?.();
  }

  async getReflog(name: string): Promise<ReflogReader | undefined> {
    return this.store(name).getReflog?.(name);
  }

  async deleteReflogEntry(
    name: string,
    index: number,
    options?: ReflogDeleteOptions,
  ): Promise<number> {
    const store = this.store(name);
    if (!store.deleteReflogEntry) throw new Error(`cannot delete reflog entries of ${name}`);
    return store.deleteReflogEntry(name, index, options);
  }

  async packRefs(
    refNames: string[],
    options?: { all?: boolean; deleteLoose?: boolean },
  ): Promise<void> {
    await this.common.packRefs?.(refNames, options);
  }
}
