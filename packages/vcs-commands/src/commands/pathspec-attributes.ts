/**
 * `:(attr:...)` pathspec magic for the commands that match index and worktree paths
 * (pathspec.c `parse_pathspec_attr_match`, dir.c `match_pathspec_item` calling
 * `match_pathspec_attrs`): the attributes of the paths a command is about to match, read
 * through the worktree's attribute stack (`.gitattributes` in the worktree, else the index
 * entry, `$GIT_DIR/info/attributes`, `core.attributesFile`, the system file), then looked up
 * synchronously while the paths are matched.
 */

import type { Worktree } from "@statewalker/vcs-working-tree";
import {
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
   * @throws Error when the worktree reads no attributes
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
    const attributes = filter?.attributes?.bind(filter);
    if (!attributes) throw new Error("pathspec magic 'attr' needs the attributes of a worktree");
    return new PathspecAttributes(items, (path, names) =>
      // git_check_attr of a directory's name ("d/"): the name without its slash, matched by
      // the patterns as a directory, from the stack of the directory above it (attr.c)
      path.endsWith("/")
        ? attributes(path.slice(0, -1), names, { direction: "checkin", isDirectory: true })
        : attributes(path, names, { direction: "checkin" }),
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
