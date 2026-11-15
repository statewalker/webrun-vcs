import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  compareWithWorktree,
  findUntrackedFiles,
  getStageState,
  modeFromWorktree,
  type StageStateValue,
  trackedUnder,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import {
  type Status,
  type StatusCode,
  type StatusFileEntry,
  StatusImpl,
  type StatusSide,
} from "../results/status-result.js";
import { worktreeModeTrust } from "./core-config.js";

/** The porcelain `XY` of an unmerged path, by which of stages 1-3 it has. */
const UNMERGED_CODES: Record<number, [StatusCode, StatusCode]> = {
  1: ["D", "D"],
  2: ["A", "U"],
  3: ["U", "D"],
  4: ["U", "A"],
  5: ["D", "U"],
  6: ["A", "A"],
  7: ["U", "U"],
};

const S_IFMT = 0o170000;
const typeOf = (mode: number) => mode & S_IFMT;

/**
 * Shows the working tree status, as `git status`: the index against HEAD (staged changes),
 * the worktree against the index (unstaged changes: modified, deleted, type changed),
 * unmerged entries, untracked files and, on request, ignored ones.
 *
 * Worktree files are compared with the index through the stat it recorded: a file whose
 * size and modification time still match is not read, unless its entry is racily clean
 * (modified at or after the index was written), which is re-hashed as git does. Links are
 * compared as links (mode 120000), the executable bit only where `core.filemode` trusts it,
 * and the ignore rules are read afresh for each status. Untracked files are listed one by
 * one (`--untracked-files=all`). Renames are not detected.
 *
 * Without a worktree only the index is compared with HEAD.
 *
 * Based on JGit's StatusCommand.
 *
 * @example
 * ```typescript
 * const status = await git.status().call();
 * if (status.isClean()) console.log("nothing to commit, working tree clean");
 * console.log("Staged:", status.added, status.changed, status.removed);
 * console.log("Unstaged:", status.modified, status.missing);
 * console.log("Untracked:", status.untracked);
 * // the lines of `git status --porcelain`
 * console.log(formatStatusPorcelain(status));
 * ```
 */
export class StatusCommand extends GitCommand<Status> {
  private paths: string[] = [];
  private showIgnored = false;
  private showUntracked = true;

  /**
   * Add a path filter.
   *
   * Only status for paths starting with this prefix will be returned.
   *
   * @param path Path prefix to filter by
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Whether to report the ignored files the index does not track (`--ignored`). Off by
   * default.
   */
  setIgnored(ignored: boolean): this {
    this.checkCallable();
    this.showIgnored = ignored;
    return this;
  }

  /**
   * Whether to report untracked files (`--untracked-files=all`, the default, or `=no`).
   */
  setUntracked(untracked: boolean): this {
    this.checkCallable();
    this.showUntracked = untracked;
    return this;
  }

  async call(): Promise<Status> {
    this.checkCallable();
    this.setCallable(false);
    const worktree = this.worktreeAccess;
    // one operation: fresh ignore rules and one lstat cache for the whole status
    return worktree?.batch ? worktree.batch(() => this.compute(worktree)) : this.compute(worktree);
  }

  private async compute(worktree: Worktree | undefined): Promise<Status> {
    const head = new Map<string, StatusSide>();
    const headRef = await this.refsStore.resolve("HEAD");
    if (headRef?.objectId) {
      const headCommit = await this.commits.load(headRef.objectId).catch(() => undefined);
      if (headCommit) await this.collectTreeEntries(headCommit.tree, "", head);
    }

    const added = new Set<string>();
    const changed = new Set<string>();
    const removed = new Set<string>();
    const conflicting = new Set<string>();
    const conflictingStageState = new Map<string, StageStateValue>();
    const modified = new Set<string>();
    const missing = new Set<string>();
    const untracked = new Set<string>();
    const ignored = new Set<string>();
    const files: StatusFileEntry[] = [];

    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const indexTime = this.staging.getUpdateTime();
    const tracked = new Set<string>();
    const unmerged = new Map<string, [StatusSide?, StatusSide?, StatusSide?]>();

    for await (const entry of this.staging.entries()) {
      tracked.add(entry.path);
      if (!this.matchesPath(entry.path)) continue;
      if (entry.stage !== 0) {
        const stages = unmerged.get(entry.path) ?? [undefined, undefined, undefined];
        stages[entry.stage - 1] = { mode: entry.mode, id: entry.objectId };
        unmerged.set(entry.path, stages);
        continue;
      }
      const h = head.get(entry.path);
      const staged = { mode: entry.mode, id: entry.objectId };
      let x: StatusCode = " ";
      if (!h) {
        if (!entry.intentToAdd) {
          x = "A";
          added.add(entry.path);
        }
      } else if (h.id !== entry.objectId || h.mode !== entry.mode) {
        x = typeOf(h.mode) === typeOf(entry.mode) ? "M" : "T";
        changed.add(entry.path);
      }
      let y: StatusCode = " ";
      let worktreeMode: number | undefined = entry.mode;
      if (worktree && !entry.skipWorktree && !entry.assumeValid) {
        const result = await compareWithWorktree(worktree, entry, { trust, indexTime });
        worktreeMode = result.worktreeMode;
        if (result.kind === "deleted") {
          y = "D";
          missing.add(entry.path);
        } else if (result.kind) {
          y = result.kind === "typechange" ? "T" : "M";
          modified.add(entry.path);
        } else if (entry.intentToAdd) {
          y = "A";
          added.add(entry.path);
        }
      }
      if (x !== " " || y !== " ") {
        files.push({ path: entry.path, index: x, worktree: y, head: h, staged, worktreeMode });
      }
    }

    for (const [path, stages] of unmerged) {
      conflicting.add(path);
      const [base, ours, theirs] = stages;
      conflictingStageState.set(path, getStageState(!!base, !!ours, !!theirs));
      const mask = (base ? 1 : 0) | (ours ? 2 : 0) | (theirs ? 4 : 0);
      const [x, y] = UNMERGED_CODES[mask];
      let worktreeMode: number | undefined;
      const current = worktree ? await worktree.getEntry(path) : undefined;
      if (current && !current.isDirectory && trust) {
        worktreeMode = modeFromWorktree(current.mode, (ours ?? theirs ?? base)?.mode, trust);
      }
      files.push({ path, index: x, worktree: y, worktreeMode, stages: [base, ours, theirs] });
    }

    for (const [path, h] of head) {
      if (tracked.has(path) || !this.matchesPath(path)) continue;
      removed.add(path);
      files.push({ path, index: "D", worktree: " ", head: h });
    }

    if (worktree && this.showUntracked) {
      for await (const file of findUntrackedFiles(worktree, (p) => tracked.has(p), {
        hasTrackedUnder: trackedUnder(tracked),
        includeIgnored: this.showIgnored,
        filter: (p) => this.matchesPath(p),
      })) {
        if (file.ignored) {
          ignored.add(file.path);
          files.push({ path: file.path, index: "!", worktree: "!" });
        } else {
          untracked.add(file.path);
          files.push({ path: file.path, index: "?", worktree: "?" });
        }
      }
    }

    return new StatusImpl(added, changed, removed, conflicting, {
      modified,
      missing,
      untracked,
      ignored,
      conflictingStageState,
      files,
    });
  }

  /**
   * Check if a path matches the configured path filters.
   */
  private matchesPath(path: string): boolean {
    if (this.paths.length === 0) {
      return true;
    }
    const p = path.endsWith("/") ? path.slice(0, -1) : path;
    for (const raw of this.paths) {
      const filterPath = raw.replace(/\/+$/, "");
      if (filterPath === "" || filterPath === ".") return true;
      if (p === filterPath || p.startsWith(`${filterPath}/`) || filterPath.startsWith(`${p}/`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, StatusSide>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        entries.set(path, { mode: entry.mode, id: entry.id });
      }
    }
  }
}
