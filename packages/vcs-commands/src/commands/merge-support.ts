/**
 * What `merge`, `cherry-pick`, `revert` and `rebase` share: flat trees, the operation's
 * state files (MERGE_HEAD, MERGE_MSG, sequencer/, rebase-merge/, ...), and writing a merge's
 * result to the worktree and the index as git's merge-ort does (`merge_switch_to_result`: a
 * two-way unpack-trees from HEAD to the result tree, refused before anything is written
 * where it would overwrite local changes or untracked files, then the conflicts staged).
 */

import { type Blobs, FileMode, type ObjectId, type PersonIdent } from "@statewalker/vcs-core";
import {
  attributesIndexOf,
  type Checkout,
  entryStatOf,
  type IndexEntryOptions,
  type Staging,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import type { CommandRefs, CommandTrees } from "../git-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import type { OrtConflict } from "./ort-merge.js";
import { planTreeRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** The blobs, links and gitlinks of a tree, by path (none for no tree). */
export async function flatTree(
  trees: CommandTrees,
  treeId: ObjectId | undefined,
): Promise<Map<string, CheckedEntry>> {
  const out = new Map<string, CheckedEntry>();
  if (!treeId) return out;
  const walk = async (id: ObjectId, prefix: string): Promise<void> => {
    for await (const entry of trees.loadTree(id)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) await walk(entry.id, path);
      else out.set(path, { objectId: entry.id, mode: entry.mode });
    }
  };
  await walk(treeId, "");
  return out;
}

/** Stores a flat path map as a tree. */
export async function storeFlatTree(
  trees: CommandTrees,
  entries: Map<string, CheckedEntry>,
): Promise<ObjectId> {
  type Node = Map<string, Node | CheckedEntry>;
  const root: Node = new Map();
  for (const [path, entry] of entries) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.get(part);
      if (!(next instanceof Map)) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
    node.set(parts[parts.length - 1], entry);
  }
  const store = async (node: Node): Promise<ObjectId> => {
    const list: { name: string; mode: number; id: ObjectId }[] = [];
    for (const [name, value] of node) {
      if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
      else list.push({ name, mode: value.mode, id: value.objectId });
    }
    return trees.storeTree(list);
  };
  return store(root);
}

/** The index: its stage-0 entries by path, and the paths with unmerged entries. */
export async function readIndex(
  staging: Staging,
): Promise<{ index: Map<string, CheckedEntry>; unmerged: string[] }> {
  const index = new Map<string, CheckedEntry>();
  const unmerged = new Set<string>();
  for await (const entry of staging.entries()) {
    if (entry.stage === 0) index.set(entry.path, entry);
    else unmerged.add(entry.path);
  }
  return { index, unmerged: [...unmerged].sort() };
}

/** An index entry to write: path, blob, mode, stage and the file's stat. */
export type IndexEntryInput = IndexEntryOptions;

/**
 * Rewrites the index: the entries of each path in `changes` replaced by the ones given
 * (none: the path removed, every stage), every other entry kept as it is.
 */
export async function rewriteIndex(
  staging: Staging,
  changes: Map<string, IndexEntryInput[]>,
): Promise<void> {
  const entries: IndexEntryInput[] = [];
  for await (const entry of staging.entries()) {
    if (!changes.has(entry.path)) entries.push(entry);
  }
  for (const list of changes.values()) entries.push(...list);
  const encoder = new TextEncoder();
  const key = (e: IndexEntryInput) => encoder.encode(e.path);
  const compare = (a: IndexEntryInput, b: IndexEntryInput) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length || (a.stage ?? 0) - (b.stage ?? 0);
  };
  entries.sort(compare);
  const builder = staging.createBuilder();
  for (const entry of entries) builder.add(entry);
  await builder.finish();
  await staging.write();
}

/** Whether the index holds exactly `tree` (no staged change; git's index_differs_from). */
export function indexMatches(
  index: Map<string, CheckedEntry>,
  tree: Map<string, CheckedEntry>,
): boolean {
  return indexChanges(index, tree).length === 0;
}

/** The paths where the index differs from `tree`, sorted. */
export function indexChanges(
  index: Map<string, CheckedEntry>,
  tree: Map<string, CheckedEntry>,
): string[] {
  const out: string[] = [];
  for (const path of new Set([...index.keys(), ...tree.keys()])) {
    if (!sameEntry(index.get(path), tree.get(path))) out.push(path);
  }
  return out.sort();
}

/**
 * The state files of an operation in progress, in git's directory: plain files through the
 * checkout (`MERGE_MSG`, `sequencer/todo`, ...), pseudo refs through the ref store
 * (`MERGE_HEAD`, `ORIG_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `AUTO_MERGE`).
 */
export class OperationState {
  constructor(
    private readonly checkout: Checkout,
    private readonly refs: CommandRefs,
  ) {}

  /** Whether the checkout can keep state files at all. */
  get supported(): boolean {
    return typeof this.checkout.writeStateFile === "function";
  }

  async read(name: string): Promise<string | undefined> {
    const bytes = await this.checkout.readStateFile?.(name);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  async write(name: string, content: string | Uint8Array): Promise<void> {
    await this.checkout.writeStateFile?.(name, content);
  }

  async remove(...names: string[]): Promise<void> {
    for (const name of names) await this.checkout.removeStateFile?.(name);
  }

  /** The names in a state directory, sorted (empty: none, or a checkout that cannot list). */
  async listDir(name: string): Promise<string[]> {
    return (await this.checkout.listStateDir?.(name)) ?? [];
  }

  async exists(name: string): Promise<boolean> {
    if ((await this.checkout.readStateFile?.(name)) !== undefined) return true;
    return ((await this.checkout.listStateDir?.(name)) ?? []).length > 0;
  }

  async ref(name: string): Promise<ObjectId | undefined> {
    const ref = await this.refs.get(name).catch(() => undefined);
    return ref && "objectId" in ref && ref.objectId ? ref.objectId : undefined;
  }

  async setRef(name: string, id: ObjectId): Promise<void> {
    await this.refs.set(name, id);
  }

  async removeRef(...names: string[]): Promise<void> {
    for (const name of names) {
      if (await this.refs.has(name).catch(() => false)) await this.refs.delete(name);
    }
  }
}

/** The parts of a command a merge's write needs. */
export interface MergeWriteContext {
  workingCopy: WorkingCopy;
  worktree?: Worktree;
  staging: Staging;
  blobs: Blobs;
  trees: CommandTrees;
}

/** Why a merge's write was refused: git's message, and the paths it lists. */
export interface MergeRefusal {
  message: string;
  paths: string[];
}

/** Whether an untracked, not ignored file or link stands at `path`. */
async function untrackedFileAt(worktree: Worktree, path: string): Promise<boolean> {
  const entry = await worktree.getEntry(path);
  if (!entry || entry.isDirectory) return false;
  return !(await worktree.isIgnored(path));
}

/**
 * git's two-way unpack-trees (`twoway_merge`, with update) from `head` to `target` on the
 * current index and worktree, as merge-ort's checkout of its result and a fast-forward
 * run it: a path the two trees agree on keeps its index entry and worktree file (local
 * edits survive); a path they differ on is switched when the index and the worktree still
 * hold `head`'s version, else everything is refused with git's messages. Then the
 * conflicts are staged at stages 1-3 (`record_conflicted_index_entries`).
 *
 * @returns the refusal (nothing written), or undefined once written
 */
export async function switchTrees(
  ctx: MergeWriteContext,
  head: Map<string, CheckedEntry>,
  target: Map<string, CheckedEntry>,
  options: {
    /** Names the operation in git's refusal messages */
    action: "merge" | "checkout";
    /** Names the operation in restore failures */
    operation: string;
    /** The conflicts to stage */
    conflicts?: Iterable<OrtConflict>;
  },
): Promise<MergeRefusal | undefined> {
  const { index } = await readIndex(ctx.staging);
  const worktree = ctx.worktree;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const ignoreCase = coreBool(ctx.workingCopy, "ignorecase", false);
  const staged: string[] = [];
  const local: string[] = [];
  const untrackedRemoved: string[] = [];
  const updates: string[] = [];
  const removes: string[] = [];
  const paths = [...new Set([...head.keys(), ...target.keys()])].sort();
  for (const path of paths) {
    const h = head.get(path);
    const t = target.get(path);
    const i = index.get(path);
    if (sameEntry(h, t)) continue;
    if (i) {
      if (t && sameEntry(i, t)) continue;
      if (!sameEntry(i, h)) {
        // a staged change the switch would lose (reject_merge)
        staged.push(path);
        continue;
      }
      if (worktree && (await worktreeDiffers(worktree, path, i, trust))) {
        local.push(path);
        continue;
      }
      (t ? updates : removes).push(path);
      continue;
    }
    if (t) {
      // a staged deletion of a path the target changes
      if (h) staged.push(path);
      else updates.push(path);
      continue;
    }
    // a deletion already staged: an untracked file there would be removed
    if (worktree && (await untrackedFileAt(worktree, path))) untrackedRemoved.push(path);
  }
  // a dirty file the target deletes is reported as a local change only (git's
  // verify_clean_subdirectory counts tracked files under a replaced directory as such)
  const deleting = [...removes, ...local.filter((p) => !target.has(p))];
  const found = worktree
    ? await findInTheWay(worktree, {
        writes: updates,
        removes: new Set(deleting),
        index,
        ignoreCase,
      })
    : { untracked: [], lostDirs: [] };
  const message = overwriteMessage(options.action, {
    staged,
    local,
    lostDirs: found.lostDirs,
    untracked: found.untracked,
    untrackedRemoved,
  });
  if (message) {
    return {
      message,
      paths: [...staged, ...local, ...found.lostDirs, ...found.untracked, ...untrackedRemoved],
    };
  }

  // the worktree: deletions first (a deleted file `d` makes way for `d/x`), then the files
  if (worktree) {
    for (const path of removes) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
    if (updates.length > 0) {
      const targetTree = await storeFlatTree(ctx.trees, target);
      const plan = await planTreeRestore(ctx.trees, ctx.blobs, targetTree, options.operation, {
        symlinks: true,
        ignoreCase,
        windows: worktree.capabilities?.windowsPaths === true,
        reservedNames: worktree.capabilities?.reservedNames,
      });
      const writing = new Set(updates);
      // the attributes of the index the switch leaves (git's o->result)
      const result = new Map<string, ObjectId>();
      for (const [path, entry] of index) result.set(path, entry.objectId);
      for (const path of removes) result.delete(path);
      for (const path of updates) result.set(path, (target.get(path) as CheckedEntry).objectId);
      await writeTreeRestorePlan(
        worktree,
        ctx.blobs,
        {
          ...plan,
          entries: plan.entries.filter((e) => writing.has(e.path)),
          gitlinks: plan.gitlinks.filter((e) => writing.has(e.path)),
        },
        options.operation,
        {
          symlinks: trust?.symlinks ?? true,
          gitlinks: true,
          replaceInTheWay: true,
          attributes: { direction: "checkout", index: attributesIndexOf(result) },
        },
      );
    }
  }

  // the index: the switched paths take the target's entries (with the stat of the files
  // just written), the conflicts their stages
  const changes = new Map<string, IndexEntryOptions[]>();
  for (const path of removes) changes.set(path, []);
  for (const path of updates) {
    const t = target.get(path) as CheckedEntry;
    const stats = worktree ? await worktree.getEntry(path) : undefined;
    changes.set(path, [
      {
        path,
        objectId: t.objectId,
        mode: t.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
      },
    ]);
  }
  for (const conflict of options.conflicts ?? []) {
    const stages: [CheckedEntry | undefined, 1 | 2 | 3][] = [
      [conflict.base, 1],
      [conflict.ours, 2],
      [conflict.theirs, 3],
    ];
    const list: IndexEntryOptions[] = [];
    for (const [entry, stage] of stages) {
      if (!entry) continue;
      list.push({
        path: conflict.stagePath,
        objectId: entry.objectId,
        mode: entry.mode,
        stage,
        size: 0,
        mtime: 0,
      });
    }
    // a stage-0 entry the switch wrote here gives way to the conflict's stages
    changes.set(conflict.stagePath, [
      ...(changes.get(conflict.stagePath) ?? []).filter((e) => (e.stage ?? 0) > 0),
      ...list,
    ]);
  }
  await rewriteIndex(ctx.staging, changes);
  return undefined;
}

/** git's `# Conflicts:` block appended to MERGE_MSG. */
export function conflictsComment(paths: string[]): string {
  if (paths.length === 0) return "";
  return `\n# Conflicts:\n${paths.map((p) => `#\t${p}\n`).join("")}`;
}

/** The current timezone offset as git writes it (`+HHMM`). */
export function timezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/** An identity for commits made without one set: `Unknown` now. */
export function defaultIdent(): PersonIdent {
  return {
    name: "Unknown",
    email: "unknown@example.com",
    timestamp: Math.floor(Date.now() / 1000),
    tzOffset: timezoneOffset(),
  };
}

/** The commit's first line (git's subject, as in `<abbrev> (<subject>)`). */
export function subjectOf(message: string): string {
  // git's format_subject: the first paragraph, lines joined with a space
  const paragraph = message.replace(/^\n+/, "").split(/\n\s*\n/)[0] ?? "";
  return paragraph
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
}

/** An abbreviated object id (git's default 7 hex digits). */
export function abbrev(id: ObjectId): string {
  return id.slice(0, 7);
}
