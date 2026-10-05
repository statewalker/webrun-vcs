/**
 * VCS Object Hash Functions
 *
 * Provides deterministic hash computation for VCS objects (commits, trees, tags).
 * Uses FNV-1a algorithm for fast, non-cryptographic hashing.
 *
 * These hashes are suitable for in-memory stores and testing.
 * Production stores typically use Git-compatible SHA-1 hashing.
 */

import { fnv1aHash } from "@statewalker/vcs-utils";
import type { ObjectId } from "../../common/id/index.js";
import type { Commit } from "../commits/commits.js";
import type { AnnotatedTag } from "../tags/tags.js";
import type { TreeEntry } from "../trees/tree-entry.js";

/**
 * Compute a deterministic hash for a commit object.
 *
 * @param commit Commit to hash
 * @returns 40-character object ID with "commit" prefix
 */
export function computeCommitHash(commit: Commit): ObjectId {
  const content = JSON.stringify({
    tree: commit.tree,
    parents: commit.parents,
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
    encoding: commit.encoding,
  });

  const hex = fnv1aHash(content);
  return `commit${hex}${"0".repeat(26)}`;
}

/**
 * Compute a deterministic hash for a tree object.
 *
 * @param entries Tree entries to hash
 * @returns 40-character object ID with "tree" prefix
 */
export function computeTreeHash(entries: TreeEntry[]): ObjectId {
  const content = entries.map((e) => `${e.mode.toString(8)} ${e.name}\0${e.id}`).join("");
  const hex = fnv1aHash(content);
  return `tree${hex}${"0".repeat(28)}`;
}

/**
 * Compute a deterministic hash for a tag object.
 *
 * @param tag Annotated tag to hash
 * @returns 40-character object ID with "tag" prefix
 */
export function computeTagHash(tag: AnnotatedTag): ObjectId {
  const content = JSON.stringify({
    object: tag.object,
    objectType: tag.objectType,
    tag: tag.tag,
    tagger: tag.tagger,
    message: tag.message,
    encoding: tag.encoding,
  });

  const hex = fnv1aHash(content);
  return `tag${hex}${"0".repeat(29)}`;
}
