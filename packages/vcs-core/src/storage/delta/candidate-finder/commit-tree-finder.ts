/**
 * CommitTreeCandidateFinder - Find delta candidates for commits and trees
 *
 * For Git-native storage where commits and trees are also deltified.
 * Uses commit relationships (parents) and tree structure to find candidates.
 */

import type { ObjectId } from "../../../common/id/object-id.js";
import type { Commits } from "../../../history/commits/commits.js";
import { ObjectType, type ObjectTypeCode } from "../../../history/objects/object-types.js";
import type { Trees } from "../../../history/trees/trees.js";
import type {
  CandidateFinder,
  CandidateFinderOptions,
  DeltaCandidate,
  DeltaTarget,
} from "../candidate-finder.js";

/**
 * Options specific to CommitTreeCandidateFinder
 */
export interface CommitTreeFinderOptions extends CandidateFinderOptions {
  /**
   * Recent commit IDs to use as starting points for tree candidate search.
   * When provided, the finder walks ancestry from these commits to find
   * trees at the same path as the target tree.
   */
  recentCommitIds?: ObjectId[];
}

/**
 * CommitTreeCandidateFinder implementation
 *
 * Finds delta candidates based on commit/tree relationships:
 * - For commits: parent commits are best candidates
 * - For trees: trees at the same path in ancestor commits
 */
export class CommitTreeCandidateFinder implements CandidateFinder {
  constructor(
    private readonly commits: Commits,
    private readonly trees: Trees,
    private readonly options: CommitTreeFinderOptions = {},
  ) {}

  async *findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    if (target.type === ObjectType.COMMIT) {
      yield* this.findCommitCandidates(target);
    } else if (target.type === ObjectType.TREE) {
      yield* this.findTreeCandidates(target);
    }
    // Blobs are handled by PathBasedCandidateFinder
  }

  private async *findCommitCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    const maxCandidates = this.options.maxCandidates ?? 10;
    let count = 0;

    try {
      // Parent commits are the best candidates for commit deltification
      const commit = await this.commits.load(target.id);
      if (!commit) return;

      for (const parentId of commit.parents) {
        if (count >= maxCandidates) return;

        const parent = await this.commits.load(parentId);
        if (!parent) continue;

        const estimatedSize = target.size;

        yield {
          id: parentId,
          type: ObjectType.COMMIT as ObjectTypeCode,
          size: estimatedSize,
          similarity: 0.95,
          reason: "parent-commit",
        };
        count++;
      }
    } catch {
      // If commit can't be loaded, skip
    }
  }

  private async *findTreeCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    const maxCandidates = this.options.maxCandidates ?? 10;
    let count = 0;

    // Strategy 1: If we have a path and recent commit context, walk commits
    // and find trees at the same path — highest-quality candidates.
    if (target.path && this.options.recentCommitIds?.length) {
      for await (const candidate of this.findTreesByPath(target, maxCandidates)) {
        if (count >= maxCandidates) return;
        yield candidate;
        count++;
      }
      if (count > 0) return;
    }

    // Strategy 2 (fallback): Look at subtrees of the target tree itself.
    // Sibling trees sometimes share structure (e.g., src/ and test/ mirrors).
    try {
      const treeEntries = await this.trees.load(target.id);
      if (!treeEntries) return;
      for await (const entry of treeEntries) {
        if (count >= maxCandidates) return;

        if (entry.mode === 0o040000) {
          yield {
            id: entry.id,
            type: ObjectType.TREE as ObjectTypeCode,
            size: target.size,
            similarity: 0.3,
            reason: "same-tree",
          };
          count++;
        }
      }
    } catch {
      // If tree can't be loaded, skip
    }
  }

  /**
   * Walk recent commits and find the tree at the same path.
   *
   * Given a target tree at path "src/utils", this navigates each
   * ancestor commit's root tree down to "src/utils" and yields
   * the matching tree as a candidate.
   */
  private async *findTreesByPath(
    target: DeltaTarget,
    maxCandidates: number,
  ): AsyncIterable<DeltaCandidate> {
    if (!target.path || !this.options.recentCommitIds?.length) return;

    const pathSegments = target.path.split("/").filter(Boolean);
    let count = 0;
    const seen = new Set<string>();

    for (const startCommitId of this.options.recentCommitIds) {
      // Walk ancestry from each recent commit (limit per commit)
      for await (const commitId of this.commits.walkAncestry(startCommitId, { limit: 10 })) {
        if (count >= maxCandidates) return;

        const rootTreeId = await this.commits.getTree(commitId);
        if (!rootTreeId) continue;

        // Navigate to the tree at the target's path
        const treeId =
          pathSegments.length > 0
            ? await this.resolveTreePath(rootTreeId, pathSegments)
            : rootTreeId;
        if (!treeId || treeId === target.id || seen.has(treeId)) continue;

        seen.add(treeId);

        yield {
          id: treeId,
          type: ObjectType.TREE as ObjectTypeCode,
          size: target.size,
          similarity: 0.85,
          reason: "same-tree",
        };
        count++;
      }
    }
  }

  /**
   * Navigate a tree path to find a subtree ID.
   *
   * Given root tree and path ["src", "utils"], looks up entry "src" in root,
   * then entry "utils" in the resulting tree.
   */
  private async resolveTreePath(
    rootTreeId: string,
    pathSegments: string[],
  ): Promise<string | undefined> {
    let currentId = rootTreeId;

    for (const segment of pathSegments) {
      const entry = await this.trees.getEntry(currentId, segment);
      if (!entry || entry.mode !== 0o040000) return undefined;
      currentId = entry.id;
    }

    return currentId;
  }
}
