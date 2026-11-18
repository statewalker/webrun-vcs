/**
 * The attribute source of the commands (`$GIT_ATTR_SOURCE`, `git --attr-source`, `attr.tree`):
 * its tree-ish resolved with git's revision syntax, as `repo_get_oid_treeish` resolves it,
 * then peeled to a tree as `get_tree_entry` peels it.
 */

import type { AttributesSourceResolver } from "@statewalker/vcs-working-tree";
import type { RevisionResolver } from "./revision-resolver.js";

const FULL_ID = /^[0-9a-fA-F]{40}$/;

/**
 * Resolves attribute sources through `resolver` (a fresh one per lookup). A full object id
 * stands for itself, stored or not (git's `get_oid` does not look it up): a missing object
 * then gives no in-tree attributes, as an object that is no tree does.
 */
export function attributesSourceResolver(
  resolver: () => RevisionResolver,
): AttributesSourceResolver {
  return async (name) => {
    const revisions = resolver();
    const id = FULL_ID.test(name)
      ? name.toLowerCase()
      : await revisions.resolve(name, { hint: "treeish" });
    if (id === undefined) return undefined;
    const tree = await revisions.peelToType(id, "tree").catch(() => undefined);
    return { tree };
  };
}
