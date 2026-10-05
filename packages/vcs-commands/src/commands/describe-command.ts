import type { ObjectId } from "@statewalker/vcs-core";

import { RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";

/**
 * Result of describe operation.
 */
export interface DescribeResult {
  /** The description string (tag name or tag-depth-gSHA format) */
  readonly description: string | undefined;
  /** The tag that was found (if any) */
  readonly tag?: string;
  /** Distance from the tag (number of commits) */
  readonly depth?: number;
  /** Abbreviated commit hash */
  readonly abbrevHash?: string;
}

/**
 * Given a commit, show the most recent tag that is reachable from it.
 *
 * Equivalent to `git describe`.
 *
 * Based on JGit's DescribeCommand.
 *
 * @example
 * ```typescript
 * // Describe HEAD
 * const desc = await git.describe().call();
 *
 * // Describe a specific commit
 * const desc = await git.describe()
 *   .setTarget(commitId)
 *   .call();
 *
 * // Use long format
 * const desc = await git.describe()
 *   .setLong(true)
 *   .call();
 *
 * // Include lightweight tags
 * const desc = await git.describe()
 *   .setTags(true)
 *   .call();
 *
 * // Always output something (fall back to commit hash)
 * const desc = await git.describe()
 *   .setAlways(true)
 *   .call();
 *
 * // Match specific tag patterns
 * const desc = await git.describe()
 *   .setMatch("v*")
 *   .call();
 * ```
 */
export class DescribeCommand extends GitCommand<DescribeResult> {
  private target?: ObjectId;
  private longFormat = false;
  private useTags = false;
  private useAll = false;
  private always = false;
  private abbrev = 7;
  private matchPatterns: string[] = [];
  private excludePatterns: string[] = [];
  private maxCandidates = 10;

  /**
   * Set the commit to describe.
   *
   * @param target ObjectId of commit to describe
   */
  setTarget(target: ObjectId): this {
    this.checkCallable();
    this.target = target;
    return this;
  }

  /**
   * Set the commit to describe by reference.
   *
   * @param rev Reference string (branch, tag, commit ID)
   */
  async setTargetRef(rev: string): Promise<this> {
    this.checkCallable();
    const resolved = await this.refsStore.resolve(rev);
    if (!resolved?.objectId) {
      throw new RefNotFoundError(`Cannot resolve: ${rev}`);
    }
    this.target = resolved.objectId;
    return this;
  }

  /**
   * Whether to always use long output format.
   *
   * When true, outputs tag-depth-gSHA even if commit matches a tag exactly.
   *
   * @param longFormat Whether to use long format (default: false)
   */
  setLong(longFormat: boolean): this {
    this.checkCallable();
    this.longFormat = longFormat;
    return this;
  }

  /**
   * Whether to use any tag (including lightweight tags).
   *
   * By default, only annotated tags are considered.
   *
   * @param tags Whether to include lightweight tags (default: false)
   */
  setTags(tags: boolean): this {
    this.checkCallable();
    this.useTags = tags;
    return this;
  }

  /**
   * Whether to use any ref in refs/ namespace.
   *
   * Enables matching branches and remote-tracking branches.
   *
   * @param all Whether to use all refs (default: false)
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.useAll = all;
    return this;
  }

  /**
   * Always output something, even if no tag is found.
   *
   * Falls back to abbreviated commit hash.
   *
   * @param always Whether to always output (default: false)
   */
  setAlways(always: boolean): this {
    this.checkCallable();
    this.always = always;
    return this;
  }

  /**
   * Set the abbreviation length for commit hash.
   *
   * @param abbrev Abbreviation length (default: 7)
   */
  setAbbrev(abbrev: number): this {
    this.checkCallable();
    this.abbrev = Math.max(4, Math.min(40, abbrev));
    return this;
  }

  /**
   * Get the abbreviation length.
   */
  getAbbrev(): number {
    return this.abbrev;
  }

  /**
   * Set glob patterns that tags must match.
   *
   * @param patterns Glob patterns (e.g., "v*", "release-*")
   */
  setMatch(...patterns: string[]): this {
    this.checkCallable();
    this.matchPatterns = patterns;
    return this;
  }

  /**
   * Set glob patterns to exclude tags.
   *
   * @param patterns Glob patterns to exclude
   */
  setExclude(...patterns: string[]): this {
    this.checkCallable();
    this.excludePatterns = patterns;
    return this;
  }

  /**
   * Set maximum number of tag candidates to consider.
   *
   * @param max Maximum candidates (default: 10)
   */
  setMaxCandidates(max: number): this {
    this.checkCallable();
    this.maxCandidates = max;
    return this;
  }

  /**
   * Execute the describe command.
   *
   * @returns Description result with tag name, depth, and/or commit hash
   */
  async call(): Promise<DescribeResult> {
    this.checkCallable();
    this.setCallable(false);

    // Default to HEAD if no target specified
    if (!this.target) {
      this.target = await this.resolveHead();
    }

    // Collect all tags (or refs if useAll)
    const tagMap = await this.collectTags();

    // Check if target directly matches a tag
    const directMatch = tagMap.get(this.target);
    if (directMatch && directMatch.length > 0) {
      const bestTag = this.selectBestTag(directMatch);
      if (bestTag) {
        const tagName = this.formatTagName(bestTag);
        if (!this.longFormat) {
          return {
            description: tagName,
            tag: tagName,
            depth: 0,
          };
        }
        return {
          description: this.formatLong(tagName, 0, this.target),
          tag: tagName,
          depth: 0,
          abbrevHash: this.abbreviate(this.target),
        };
      }
    }

    // Walk ancestors to find reachable tags
    const candidates = await this.findCandidates(tagMap, this.target);

    if (candidates.length === 0) {
      if (this.always) {
        const abbrev = this.abbreviate(this.target);
        return {
          description: abbrev,
          abbrevHash: abbrev,
        };
      }
      return { description: undefined };
    }

    // Select the closest tag
    const best = candidates.reduce((a, b) => (a.depth <= b.depth ? a : b));

    return {
      description: this.formatLong(best.tag, best.depth, this.target),
      tag: best.tag,
      depth: best.depth,
      abbrevHash: this.abbreviate(this.target),
    };
  }

  /**
   * Collect all tags/refs into a map by commit ID.
   */
  private async collectTags(): Promise<Map<ObjectId, string[]>> {
    const tagMap = new Map<ObjectId, string[]>();
    const prefix = this.useAll ? "refs/" : "refs/tags/";

    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith(prefix)) {
        continue;
      }

      // Skip if not matching patterns
      if (!this.matchesPatterns(ref.name)) {
        continue;
      }

      // Get the commit ID (peel annotated tags)
      let commitId: ObjectId | undefined;
      if ("objectId" in ref && ref.objectId) {
        commitId = ref.objectId;

        // Try to peel annotated tags
        if (!this.useTags && !this.useAll && ref.name.startsWith("refs/tags/")) {
          // For annotated tags, we should resolve to the commit
          // Skip lightweight tags unless useTags is set
          try {
            const tag = await this.tagsStore?.loadTag(ref.objectId);
            if (tag) {
              commitId = tag.object;
            }
          } catch {
            // Not an annotated tag - skip unless useTags
            if (!this.useTags) {
              continue;
            }
          }
        }
      }

      if (commitId) {
        const tags = tagMap.get(commitId) ?? [];
        tags.push(ref.name);
        tagMap.set(commitId, tags);
      }
    }

    return tagMap;
  }

  /**
   * Check if a ref name matches the patterns.
   */
  private matchesPatterns(refName: string): boolean {
    const tagName = this.formatTagName(refName);

    // Check exclude patterns first
    for (const pattern of this.excludePatterns) {
      if (this.globMatch(tagName, pattern)) {
        return false;
      }
    }

    // If no match patterns, accept all
    if (this.matchPatterns.length === 0) {
      return true;
    }

    // Check match patterns
    for (const pattern of this.matchPatterns) {
      if (this.globMatch(tagName, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple glob matching (supports * and ?).
   */
  private globMatch(text: string, pattern: string): boolean {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regex}$`).test(text);
  }

  /**
   * Select the best tag from multiple candidates.
   */
  private selectBestTag(tags: string[]): string | undefined {
    if (tags.length === 0) return undefined;

    // Filter and sort - prefer annotated tags, then alphabetically
    const filtered = tags.filter((t) => this.matchesPatterns(t));
    if (filtered.length === 0) return undefined;

    filtered.sort();
    return filtered[0];
  }

  /**
   * Find tag candidates by walking ancestors.
   */
  private async findCandidates(
    tagMap: Map<ObjectId, string[]>,
    target: ObjectId,
  ): Promise<Array<{ tag: string; depth: number }>> {
    const candidates: Array<{ tag: string; depth: number; commitId: ObjectId }> = [];
    const seen = new Set<ObjectId>();
    let depth = 0;

    // BFS through ancestors
    const queue: ObjectId[] = [target];

    while (queue.length > 0 && candidates.length < this.maxCandidates) {
      const nextQueue: ObjectId[] = [];

      for (const commitId of queue) {
        if (seen.has(commitId)) continue;
        seen.add(commitId);

        // Check if this commit has tags
        const tags = tagMap.get(commitId);
        if (tags && tags.length > 0) {
          const bestTag = this.selectBestTag(tags);
          if (bestTag) {
            candidates.push({
              tag: this.formatTagName(bestTag),
              depth,
              commitId,
            });
          }
        }

        // Add parents to queue
        try {
          const commit = await this.commits.load(commitId);
          if (commit) {
            for (const parentId of commit.parents) {
              if (!seen.has(parentId)) {
                nextQueue.push(parentId);
              }
            }
          }
        } catch {
          // Commit not found - skip
        }
      }

      queue.length = 0;
      queue.push(...nextQueue);
      depth++;

      // Safety limit
      if (depth > 10000) break;
    }

    return candidates;
  }

  /**
   * Format a ref name to tag name.
   */
  private formatTagName(refName: string): string {
    if (refName.startsWith("refs/tags/")) {
      return refName.slice("refs/tags/".length);
    }
    if (refName.startsWith("refs/")) {
      return refName.slice("refs/".length);
    }
    return refName;
  }

  /**
   * Format long description: tag-depth-gSHA.
   */
  private formatLong(tag: string, depth: number, commitId: ObjectId): string {
    if (this.abbrev === 0) {
      return tag;
    }
    return `${tag}-${depth}-g${this.abbreviate(commitId)}`;
  }

  /**
   * Abbreviate a commit ID.
   */
  private abbreviate(commitId: ObjectId): string {
    return commitId.slice(0, this.abbrev);
  }
}
