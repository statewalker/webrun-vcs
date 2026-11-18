/**
 * The tree the in-tree attributes files are read from instead of the worktree and the index,
 * as git's `default_attr_source` picks it: `$GIT_ATTR_SOURCE` (which `git --attr-source=<tree-ish>`
 * sets), else the `attr.tree` setting.
 *
 * ```typescript
 * const setting = attributesSourceSetting(environment?.attrSource, config.get("attr.tree"));
 * const source = setting && (await resolveAttributesSource(setting, resolveTreeish));
 * if (source) content = await readTreeAttributesFile(trees, blobs, source.tree, "a/.gitattributes");
 * ```
 *
 * A name that does not resolve is fatal when it comes from the environment (`bad --attr-source
 * or GIT_ATTR_SOURCE`); from `attr.tree` it is ignored, and the attributes are read as without
 * it. A name that resolves to an object that is no tree (and does not peel to one) leaves no
 * in-tree attributes at all. With a source, every attribute lookup reads it, in a bare
 * repository and in one with a worktree, whichever way the content goes; a bare repository
 * reads no in-tree file without one (git 2.45 and later; 2.43 and 2.44 read HEAD's).
 */

import type { Blobs, ObjectId, Trees } from "@statewalker/vcs-core";

/** git's message when `$GIT_ATTR_SOURCE` (or `--attr-source`) names nothing. */
export class AttributesSourceError extends Error {
  constructor() {
    super("bad --attr-source or GIT_ATTR_SOURCE");
    this.name = "AttributesSourceError";
  }
}

/** Which attribute source applies, by name, and whether a bad one is ignored (`attr.tree`). */
export interface AttributesSourceSetting {
  name: string;
  /** From `attr.tree`: a name that resolves to nothing is ignored */
  fromConfig: boolean;
}

/** What an attribute source resolved to: the tree (undefined when the object is no tree). */
export interface AttributesSourceTree {
  tree: ObjectId | undefined;
}

/**
 * Resolves a tree-ish (git's `repo_get_oid_treeish`, then the peel `get_tree_entry` makes):
 * undefined when it names nothing, `{ tree: undefined }` when it names an object that is not
 * (and does not peel to) a tree.
 */
export type AttributesSourceResolver = (name: string) => Promise<AttributesSourceTree | undefined>;

/**
 * The attribute source in effect: `$GIT_ATTR_SOURCE` (`environmentValue`) over `attr.tree`
 * (`configValue`); undefined when neither is set.
 */
export function attributesSourceSetting(
  environmentValue: string | undefined,
  configValue: unknown,
): AttributesSourceSetting | undefined {
  if (environmentValue !== undefined) return { name: environmentValue, fromConfig: false };
  if (typeof configValue === "string") return { name: configValue, fromConfig: true };
  return undefined;
}

const FULL_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * The tree of an attribute source: resolved through `resolve` (a full object id stands for
 * itself without one), undefined when an `attr.tree` that names nothing is ignored.
 *
 * @throws AttributesSourceError when `$GIT_ATTR_SOURCE` names nothing
 */
export async function resolveAttributesSource(
  setting: AttributesSourceSetting,
  resolve: AttributesSourceResolver | undefined,
): Promise<AttributesSourceTree | undefined> {
  let found: AttributesSourceTree | undefined;
  try {
    if (resolve) found = await resolve(setting.name);
    else if (FULL_ID.test(setting.name)) found = { tree: setting.name };
  } catch {
    found = undefined;
  }
  if (found) return found;
  if (setting.fromConfig) return undefined;
  throw new AttributesSourceError();
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * The attributes file at `path` (`<dir>/.gitattributes`) of `tree`, as git's
 * `read_attr_from_blob` reads it: the object at that path when it is a blob (a symbolic
 * link's target included), else undefined.
 */
export async function readTreeAttributesFile(
  trees: Pick<Trees, "getEntry">,
  blobs: Pick<Blobs, "load">,
  tree: ObjectId | undefined,
  path: string,
): Promise<{ id: ObjectId; content: Uint8Array } | undefined> {
  if (!tree) return undefined;
  const parts = path.split("/");
  let at: ObjectId = tree;
  try {
    for (let i = 0; i < parts.length; i++) {
      const entry = await trees.getEntry(at, parts[i] as string);
      if (!entry) return undefined;
      const isDir = (entry.mode & S_IFMT) === S_IFDIR;
      if (i < parts.length - 1) {
        if (!isDir) return undefined;
        at = entry.id;
        continue;
      }
      if (isDir) return undefined;
      const content = await blobs.load(entry.id);
      if (!content) return undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of content) {
        chunks.push(c);
        size += c.length;
      }
      const out = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return { id: entry.id, content: out };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
