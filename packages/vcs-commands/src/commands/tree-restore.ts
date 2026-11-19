/**
 * Writing a tree back into the working tree.
 *
 * Shared by the commands that make the working tree match a tree object -
 * `reset --hard`, `stash apply` and the checkout of `clone`. All need the
 * same two-phase shape: plan and validate the whole restore first, then write. A tree that cannot be
 * restored faithfully therefore fails with the working tree still intact,
 * rather than half-way through rewriting it.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import { FileMode, isValidWorktreePath } from "@statewalker/vcs-core";
import {
  attributesIndexOf,
  type ContentAttributesContext,
  entryStatOf,
  type Staging,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import type { CommandTrees } from "../git-command.js";

/** One file a restore plans to write back into the working tree. */
export interface RestoreEntry {
  path: string;
  objectId: ObjectId;
  mode: number;
}

/** A validated restore, ready to execute. */
export interface TreeRestorePlan {
  /** The files to write. */
  entries: RestoreEntry[];
  /**
   * Every path the tree accounts for - the files above plus the gitlinks
   * that are deliberately not written. A tracked path missing from this set
   * is one the target tree deletes.
   */
  paths: Set<string>;
  /** The gitlinks (submodules) of the tree, which are not written. */
  gitlinks: RestoreEntry[];
  /**
   * With `ignoreCase`: files whose paths differ only in case (`README`, `readme`). Both are
   * written, the last one wins, as git checks them out with its "the following paths have
   * collided" warning.
   */
  collided: string[];
}

/** Options of {@link planTreeRestore}. */
export interface TreeRestoreOptions {
  /**
   * Plan symlinks as entries to write (their blob is the link target), for a
   * worktree that writes mode `0o120000` as a link or as a file holding the
   * target, as git does. Without it a symlink fails the plan.
   */
  symlinks?: boolean;
  /**
   * Compare paths case-insensitively (`core.ignorecase`), as a case-folding filesystem
   * would: a path beneath a file, link or submodule of another case (`A` a link, `a/x`)
   * is refused, it would be written through the link; two files differing only in case
   * are both planned (the last wins) and reported in `collided`, as git does.
   */
  ignoreCase?: boolean;
  /**
   * Whether the worktree's storage folds case ({@link worktreeFoldsCase}). With `ignoreCase`
   * on storage that keeps case (false: Linux), names differing only in case are different
   * paths, as git checks them out there: a file beside a directory of another case, two
   * files in two cases, none refused or reported. Unknown (absent): taken to fold case.
   */
  foldsCase?: boolean;
  /** The worktree is on Windows (`capabilities.windowsPaths`): git's Windows path rules. */
  windows?: boolean;
  /** Top-level names the worktree's storage reserves (`capabilities.reservedNames`) */
  reservedNames?: string[];
  /**
   * Only these paths will be written: the blobs of the others are not checked (every path
   * is still validated). Absent: every blob is checked.
   */
  writing?: Set<string>;
}

/**
 * Walk a tree and plan which files to restore, validating as it goes.
 *
 * Throws on anything that cannot be restored faithfully, so the caller can
 * abort before mutating the working tree: a path git's `verify_path` refuses
 * (`.git` under any spelling, a symlinked `.gitmodules`), and two entries that
 * collide - the same path twice, a file and a directory of one name, or a path
 * beneath a planned file, symlink or submodule (which would write through the
 * link), compared case-insensitively with `ignoreCase`.
 *
 * @param trees Tree storage to walk
 * @param blobs Blob storage, checked for the content of every planned file
 * @param treeId Tree to restore
 * @param operation Names the operation in failure messages, e.g. `reset --hard`
 * @param options What else the worktree can restore
 */
export async function planTreeRestore(
  trees: CommandTrees,
  blobs: Blobs,
  treeId: ObjectId,
  operation: string,
  options: TreeRestoreOptions = {},
): Promise<TreeRestorePlan> {
  const plan: TreeRestorePlan = { entries: [], paths: new Set(), gitlinks: [], collided: [] };
  await planInto(trees, blobs, treeId, "", operation, plan, options, new Map());
  return plan;
}

/**
 * Whether `worktree`'s storage folds case (`README` and `readme` one file), from its
 * `foldsCase`; undefined when the worktree cannot tell. With `core.ignorecase` set, a
 * restore guards against case variants only where this is not false.
 *
 * @example
 * ```typescript
 * const plan = await planTreeRestore(trees, blobs, treeId, "checkout", {
 *   ignoreCase: true,
 *   foldsCase: await worktreeFoldsCase(worktree),
 * });
 * ```
 */
export async function worktreeFoldsCase(
  worktree: Worktree | undefined,
): Promise<boolean | undefined> {
  return worktree?.foldsCase?.().catch(() => undefined);
}

/**
 * The case options of a restore into `worktree`: `ignoreCase` (`core.ignorecase`) and, when
 * it is set, whether the worktree folds case (probed only then).
 *
 * @example
 * ```typescript
 * const plan = await planTreeRestore(trees, blobs, treeId, "reset --hard", {
 *   ...(await restoreCaseOptions(worktree, coreBool(workingCopy, "ignorecase", false))),
 * });
 * ```
 */
export async function restoreCaseOptions(
  worktree: Worktree | undefined,
  ignoreCase: boolean,
): Promise<{ ignoreCase: boolean; foldsCase?: boolean }> {
  if (!ignoreCase) return { ignoreCase };
  const foldsCase = await worktreeFoldsCase(worktree);
  return foldsCase === undefined ? { ignoreCase } : { ignoreCase, foldsCase };
}

/** What a planned path holds, by its (case-folded) key, and its first spelling. */
type PlannedKinds = Map<string, { kind: "tree" | "leaf"; path: string }>;

/**
 * Records `path` as a tree or a leaf, refusing a path that collides with a planned one in
 * a way that would write through it; two leaves differing only in case are recorded in
 * `collided` instead (case-folding filesystems keep the last one).
 */
function claim(
  planned: PlannedKinds,
  plan: TreeRestorePlan,
  path: string,
  kind: "tree" | "leaf",
  operation: string,
  options: TreeRestoreOptions,
): void {
  const key = options.ignoreCase && options.foldsCase !== false ? path.toLowerCase() : path;
  const existing = planned.get(key);
  if (existing) {
    if (existing.path === path || existing.kind !== kind) {
      throw new Error(`${operation} cannot restore ${path}: it collides with another entry`);
    }
    if (kind === "leaf") {
      if (!plan.collided.includes(existing.path)) plan.collided.push(existing.path);
      plan.collided.push(path);
    }
    return;
  }
  // every leading component must be a planned tree, never a file, link or submodule
  const parts = key.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (planned.get(parts.slice(0, i).join("/"))?.kind === "leaf") {
      throw new Error(
        `${operation} cannot restore ${path}: ${parts.slice(0, i).join("/")} is not a directory`,
      );
    }
  }
  planned.set(key, { kind, path });
}

async function planInto(
  trees: CommandTrees,
  blobs: Blobs,
  treeId: ObjectId,
  prefix: string,
  operation: string,
  plan: TreeRestorePlan,
  options: TreeRestoreOptions,
  planned: PlannedKinds,
): Promise<void> {
  for await (const entry of trees.loadTree(treeId)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      !isValidWorktreePath(path, entry.mode, { windows: options.windows === true }) ||
      // a name the storage reserves at the worktree's root (a simulated-links table)
      (prefix === "" &&
        options.reservedNames?.some(
          (name) => entry.name.normalize("NFC").toLowerCase() === name.toLowerCase(),
        ))
    ) {
      throw new Error(`${operation} cannot restore ${JSON.stringify(path)}: invalid path`);
    }

    if (entry.mode === FileMode.TREE) {
      claim(planned, plan, path, "tree", operation, options);
      await planInto(trees, blobs, entry.id, path, operation, plan, options, planned);
      continue;
    }
    claim(planned, plan, path, "leaf", operation, options);

    if (entry.mode === FileMode.GITLINK) {
      // Submodule: neither `git reset --hard` nor `git stash apply` touches
      // its contents. Record it so it is not mistaken for a path to delete.
      plan.paths.add(path);
      plan.gitlinks.push({ path, objectId: entry.id, mode: entry.mode });
      continue;
    }

    if (entry.mode === FileMode.SYMLINK && !options.symlinks) {
      // Unless the caller opts in (clone), a symlink is refused: writing the
      // target path as a regular file would silently produce a working tree
      // that does not match the tree being restored.
      throw new Error(
        `${operation} cannot restore ${path}: the worktree cannot create symbolic links`,
      );
    }

    if ((!options.writing || options.writing.has(path)) && !(await blobs.has(entry.id))) {
      throw new Error(`${operation} cannot restore ${path}: blob ${entry.id} is missing`);
    }

    plan.entries.push({ path, objectId: entry.id, mode: entry.mode });
    plan.paths.add(path);
  }
}

/**
 * Execute a plan produced by {@link planTreeRestore}, writing every file.
 *
 * @param worktree Working tree to write into
 * @param blobs Blob storage to read content from
 * @param plan The validated plan
 * @param operation Names the operation in failure messages
 */
export async function writeTreeRestorePlan(
  worktree: Worktree,
  blobs: Blobs,
  plan: TreeRestorePlan,
  operation: string,
  options: TreeWriteOptions = {},
): Promise<void> {
  // one batch: the worktree may cache directories verified not to be links meanwhile
  const run = () => writePlan(worktree, blobs, plan, operation, options);
  await (worktree.batch ? worktree.batch(run) : run());
}

async function writePlan(
  worktree: Worktree,
  blobs: Blobs,
  plan: TreeRestorePlan,
  operation: string,
  options: TreeWriteOptions,
): Promise<void> {
  // git's check_updates: every file smudged with the attributes of the index the restore
  // leaves behind (by default the plan's tree), whatever order they are written in
  const attributes: ContentAttributesContext | undefined =
    options.attributes === false
      ? undefined
      : (options.attributes ?? {
          direction: "checkout",
          index: attributesIndexOf(plan.entries.map((e) => [e.path, e.objectId] as const)),
        });
  for (const { path, objectId, mode } of plan.entries) {
    const content = await blobs.load(objectId);
    if (!content) {
      throw new Error(`${operation} cannot restore ${path}: blob ${objectId} is missing`);
    }

    // without symlinks (core.symlinks=false) a link is a file holding its target
    const written =
      mode === FileMode.SYMLINK && options.symlinks === false ? FileMode.REGULAR_FILE : mode;
    // the blob streams into the file; it is never held whole in memory. A link written as
    // a file holds its target as it is: git never converts it (smudge is for files)
    await worktree.writeContent(path, content, {
      mode: written,
      ...(written !== mode ? { raw: true } : {}),
      ...(attributes ? { attributes } : {}),
      createParents: true,
      ...(options.replaceInTheWay ? { replaceInTheWay: true } : {}),
      ...(options.discardUntracked ? { discardUntracked: true } : {}),
    });
  }
  // a submodule is an empty directory, as git checks out an unpopulated one
  if (options.gitlinks) {
    for (const { path } of plan.gitlinks) await worktree.mkdir(path);
  }
}

/** Options of {@link writeTreeRestorePlan}. */
export interface TreeWriteOptions {
  /** Write symlinks as links (default); false writes them as files holding the target. */
  symlinks?: boolean;
  /** A forced checkout: unlink a file or link standing where a directory must go. */
  replaceInTheWay?: boolean;
  /**
   * With `replaceInTheWay`, a directory where a file goes is removed whatever it holds
   * (`reset --hard`, `checkout -f`); without it, only one holding nothing but ignored files.
   */
  discardUntracked?: boolean;
  /** Create an empty directory for each gitlink (submodule). */
  gitlinks?: boolean;
  /**
   * Where the files' attributes are read: by default the plan's own tree (the index a
   * `reset --hard` or `clone` leaves, git's GIT_ATTR_CHECKOUT); an operation that writes
   * part of a tree passes the index it leaves behind; `false` reads them as a path checkout
   * does (`checkout-index`: the worktree's, then the current index's).
   */
  attributes?: ContentAttributesContext | false;
}

/**
 * A restore plan of only the paths in `writing`, from a flat path map of a tree (`target`,
 * whose paths cannot collide, a tree being their source): each path validated as
 * {@link planTreeRestore} validates it and its blob checked, without walking the tree.
 * Case collisions are not looked for (plan the whole tree with `ignoreCase` instead).
 */
export async function planFlatRestore(
  blobs: Blobs,
  target: Map<string, { objectId: ObjectId; mode: number }>,
  writing: Set<string>,
  operation: string,
  options: Omit<TreeRestoreOptions, "ignoreCase" | "foldsCase" | "writing"> = {},
): Promise<TreeRestorePlan> {
  const plan: TreeRestorePlan = { entries: [], paths: new Set(), gitlinks: [], collided: [] };
  for (const path of [...writing].sort()) {
    const entry = target.get(path);
    if (!entry) continue;
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
    if (
      !isValidWorktreePath(path, entry.mode, { windows: options.windows === true }) ||
      options.reservedNames?.some(
        (name) => top.normalize("NFC").toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error(`${operation} cannot restore ${JSON.stringify(path)}: invalid path`);
    }
    const restore = { path, objectId: entry.objectId, mode: entry.mode };
    plan.paths.add(path);
    if (entry.mode === FileMode.GITLINK) {
      plan.gitlinks.push(restore);
      continue;
    }
    if (entry.mode === FileMode.SYMLINK && !options.symlinks) {
      throw new Error(
        `${operation} cannot restore ${path}: the worktree cannot create symbolic links`,
      );
    }
    if (!(await blobs.has(entry.objectId))) {
      throw new Error(`${operation} cannot restore ${path}: blob ${entry.objectId} is missing`);
    }
    plan.entries.push(restore);
  }
  return plan;
}

/** What {@link checkoutFreshTree} writes into. */
export interface FreshCheckoutTarget {
  trees: CommandTrees;
  blobs: Blobs;
  staging: Staging;
  /** None for a bare repository: only the index is written. */
  worktree?: Worktree;
  /** Whether links are written as links (`core.symlinks` and the worktree allow it). */
  symlinks: boolean;
  /** `core.ignorecase`. */
  ignoreCase: boolean;
  /**
   * Which paths are written (a sparse checkout's patterns: an entry outside them is new and
   * stays out of the worktree, as unpack-trees' loop #2 marks it); default every path.
   */
  writes?: (path: string) => boolean;
}

/**
 * A tree checked out into an empty worktree and index, as `git clone` and
 * `git worktree add` do it: every path checked first (verify_path, collisions), then the
 * files written (links where the worktree makes them, an empty directory per submodule),
 * then the index with each file's stat data, so native git sees the files unchanged.
 *
 * @returns The paths that collided (ignoreCase), as git warns about them.
 */
export async function checkoutFreshTree(
  target: FreshCheckoutTarget,
  treeId: ObjectId,
  operation: string,
): Promise<string[]> {
  const { trees, blobs, staging, worktree } = target;
  if (!worktree) {
    await staging.readTree(trees, treeId);
    await staging.write();
    return [];
  }
  const fullPlan = await planTreeRestore(trees, blobs, treeId, operation, {
    symlinks: true,
    ...(await restoreCaseOptions(worktree, target.ignoreCase)),
    windows: worktree.capabilities?.windowsPaths === true,
    reservedNames: worktree.capabilities?.reservedNames,
  });
  const writes = target.writes;
  const plan = writes
    ? {
        ...fullPlan,
        entries: fullPlan.entries.filter((e) => writes(e.path)),
        gitlinks: fullPlan.gitlinks.filter((e) => writes(e.path)),
      }
    : fullPlan;
  await writeTreeRestorePlan(worktree, blobs, plan, operation, {
    symlinks: target.symlinks,
    gitlinks: true,
  });
  // the index records what was written (the worktree's stat of each file, a link's own
  // when the worktree can lstat)
  await staging.readTree(trees, treeId);
  const editor = staging.createEditor();
  for (const { path, objectId, mode } of plan.entries) {
    const stats = await worktree.getEntry(path);
    if (stats) editor.upsert({ path, objectId, mode, ...entryStatOf(stats) });
  }
  await editor.finish();
  await staging.write();
  return plan.collided;
}
