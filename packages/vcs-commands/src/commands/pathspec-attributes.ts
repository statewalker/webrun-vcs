/**
 * `:(attr:...)` pathspec magic for the commands that match index and worktree paths
 * (pathspec.c `parse_pathspec_attr_match`, dir.c `match_pathspec_item` calling
 * `match_pathspec_attrs`): the attributes of the paths a command is about to match, read
 * through the worktree's attribute stack (`.gitattributes` in the worktree, else the index
 * entry, `$GIT_DIR/info/attributes`, `core.attributesFile`, the system file), then looked up
 * synchronously while the paths are matched.
 */

import type { AttributesResolver, Worktree } from "@statewalker/vcs-working-tree";
import { GitApiError } from "../errors/index.js";
import {
  DO_MATCH_LEADING_PATHSPEC,
  matchPathspec,
  type PathspecAttributeValue,
  type PathspecItem,
  pathspecItemMayMatch,
} from "./pathspec.js";

/** Reads the attributes `names` of a path (a directory's with its trailing `/`). */
export type PathspecAttributeReader = (
  path: string,
  names: readonly string[],
) => Promise<ReadonlyMap<string, PathspecAttributeValue>>;

/**
 * The attributes of the paths a pathspec with `:(attr:...)` elements matches: bound to its
 * elements (`attrLookup`), loaded for a batch of candidate paths before they are matched.
 *
 * @example
 * ```typescript
 * const items = parsePathspec([":(attr:text)"], { attr: true });
 * const attributes = PathspecAttributes.forWorktree(items, worktree);
 * await attributes?.load(indexPaths);
 * const wanted = indexPaths.filter((p) => matchPathspec(items, p, 0) > 0);
 * ```
 */
export class PathspecAttributes {
  private readonly values = new Map<string, ReadonlyMap<string, PathspecAttributeValue>>();
  private readonly names: string[];
  private readonly attrItems: PathspecItem[];

  constructor(
    items: PathspecItem[],
    private readonly read: PathspecAttributeReader,
  ) {
    this.attrItems = items.filter((item) => item.attr);
    this.names = [
      ...new Set(this.attrItems.flatMap((item) => (item.attr ?? []).map((a) => a.name))),
    ];
    const lookup = (path: string) => this.values.get(path);
    for (const item of this.attrItems) item.attrLookup = lookup;
  }

  /**
   * The attributes of `items` bound to the worktree's attribute stack (the check-in
   * direction: the worktree's `.gitattributes` first, then the index's); undefined when no
   * element has `:(attr:...)`.
   *
   * @throws GitApiError without a worktree, or when it reads no attributes
   */
  static forWorktree(
    items: PathspecItem[],
    worktree: Worktree | undefined,
  ): PathspecAttributes | undefined {
    if (!items.some((item) => item.attr)) return undefined;
    const filter = worktree?.contentFilter as
      | {
          attributes?(
            path: string,
            names: readonly string[],
            context?: { direction: "checkin" | "checkout"; isDirectory?: boolean },
          ): Promise<Map<string, PathspecAttributeValue>>;
        }
      | undefined;
    // git reads a command's attributes from its worktree: without one, it dies (a diff of
    // trees in a bare repository reads the bare attributes instead, see `forResolver`)
    if (!worktree) throw new GitApiError("fatal: this operation must be run in a work tree");
    const attributes = filter?.attributes?.bind(filter);
    if (!attributes) {
      throw new GitApiError("fatal: pathspec magic 'attr' needs the attributes of a worktree");
    }
    return new PathspecAttributes(items, (path, names) =>
      // git_check_attr of a directory's name ("d/"): the name without its slash, matched by
      // the patterns as a directory, from the stack of the directory above it (attr.c)
      path.endsWith("/")
        ? attributes(path.slice(0, -1), names, { direction: "checkin", isDirectory: true })
        : attributes(path, names, { direction: "checkin" }),
    );
  }

  /**
   * The attributes of `items` read by an attributes resolver (a bare repository's, without
   * a worktree: builtin, system, global, `info/attributes` and an attribute source);
   * undefined when no element has `:(attr:...)`.
   */
  static forResolver(
    items: PathspecItem[],
    resolver: AttributesResolver,
  ): PathspecAttributes | undefined {
    if (!items.some((item) => item.attr)) return undefined;
    return new PathspecAttributes(items, async (path, names) =>
      path.endsWith("/")
        ? resolver.get(path.slice(0, -1), names, { isDirectory: true })
        : resolver.get(path, names),
    );
  }

  /** Loads the attributes of the paths some element may match by its path. */
  async load(paths: Iterable<string>): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const path of paths) {
      if (!this.needs(path)) continue;
      pending.push(this.loadOne(path));
      if (pending.length >= 64) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
  }

  /** Whether `path` may match an element by its path and its attributes are not loaded yet. */
  needs(path: string): boolean {
    return (
      !this.values.has(path) && this.attrItems.some((item) => pathspecItemMayMatch(item, path))
    );
  }

  /**
   * Whether dir.c's untracked walk reaches the untracked `path` (its attributes loaded on
   * the way): each untracked directory above it (one holding no index entry, so not in
   * `trackedDirs`) must match `items` as a leading path by its own name and attributes
   * (`treat_directory` with `DO_MATCH_LEADING_PATHSPEC`).
   */
  async reachable(items: PathspecItem[], path: string, trackedDirs: Set<string>): Promise<boolean> {
    const dirs: string[] = [];
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
      const dir = path.slice(0, at);
      if (!trackedDirs.has(dir)) dirs.push(`${dir}/`);
    }
    await this.load([path, `${path}/`, ...dirs]);
    return dirs.every((dir) => matchPathspec(items, dir, DO_MATCH_LEADING_PATHSPEC) > 0);
  }

  /** Loads the attributes of `path` (whether an element may match it or not). */
  async loadOne(path: string): Promise<void> {
    if (this.values.has(path)) return;
    this.values.set(path, await this.read(path, this.names));
  }
}

/**
 * The attributes of `items` for the worktree, loaded for `paths` (none: the pathspec has no
 * `:(attr:...)` element).
 */
export async function loadPathspecAttributes(
  items: PathspecItem[],
  worktree: Worktree | undefined,
  paths: Iterable<string>,
): Promise<PathspecAttributes | undefined> {
  const attributes = PathspecAttributes.forWorktree(items, worktree);
  await attributes?.load(paths);
  return attributes;
}
