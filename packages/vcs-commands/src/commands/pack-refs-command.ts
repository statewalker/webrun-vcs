import { GitCommand } from "../git-command.js";

/**
 * Result of packing refs
 */
export interface PackRefsResult {
  /** Number of refs packed */
  refsPacked: number;
  /** Whether operation succeeded */
  success: boolean;
}

/**
 * Pack loose references into packed-refs.
 *
 * Equivalent to `git pack-refs`.
 *
 * This command packs loose reference files (.git/refs/*) into the
 * single .git/packed-refs file for efficiency.
 *
 * Based on JGit's PackRefsCommand.
 *
 * @example
 * ```typescript
 * // Pack all refs
 * const result = await git.packRefs()
 *   .setAll(true)
 *   .call();
 *
 * // Pack specific refs
 * const result = await git.packRefs()
 *   .addRef("refs/heads/main")
 *   .addRef("refs/heads/feature")
 *   .call();
 * ```
 */
export class PackRefsCommand extends GitCommand<PackRefsResult> {
  private all = false;
  private refs: string[] = [];

  /**
   * Pack all loose refs.
   *
   * @param all Whether to pack all refs
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /**
   * Add a specific ref to pack.
   *
   * @param refName The ref name to pack
   */
  addRef(refName: string): this {
    this.checkCallable();
    this.refs.push(refName);
    return this;
  }

  /**
   * Execute the pack-refs command.
   *
   * @returns PackRefsResult
   */
  async call(): Promise<PackRefsResult> {
    this.checkCallable();
    this.setCallable(false);

    // Check if RefStore supports packRefs
    if (!this.refsStore.packRefs) {
      throw new Error("RefStore does not support packRefs");
    }

    let refsPacked = 0;

    if (this.all) {
      // Pack all refs - collect all ref names first
      const allRefs: string[] = [];
      for await (const ref of this.refsStore.list("refs/")) {
        allRefs.push(ref.name);
      }
      refsPacked = allRefs.length;

      if (allRefs.length > 0) {
        await this.refsStore.packRefs(allRefs, { all: true, deleteLoose: true });
      }
    } else if (this.refs.length > 0) {
      // Pack specific refs
      refsPacked = this.refs.length;
      await this.refsStore.packRefs(this.refs, { deleteLoose: true });
    }

    return {
      refsPacked,
      success: true,
    };
  }
}
