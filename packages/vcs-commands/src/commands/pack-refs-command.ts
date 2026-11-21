import { GitCommand } from "../git-command.js";

/**
 * Result of packing refs
 */
export interface PackRefsResult {
  /** Number of refs packed */
  refsPacked: number;
  /** Whether operation succeeded */
  success: boolean;
  /**
   * git's error lines (stderr), also in the hook output: a loose ref whose object is missing
   * stays loose (`error: <ref> does not point to a valid object!`), a ref changed before its
   * prune keeps its loose file (`error: cannot lock ref ...`)
   */
  errors: string[];
}

/**
 * Pack loose references into packed-refs.
 *
 * Equivalent to `git pack-refs`.
 *
 * This command packs loose reference files (.git/refs/*) into the
 * single .git/packed-refs file for efficiency.
 *
 * Without {@link setAll} or refs named, the loose tags are packed (git's default
 * `refs/tags/*`). The reference-transaction hook runs as in git: once for the packed-refs
 * transaction (every loose ref packed, as `<zero> <id> <ref>`), then once per loose ref
 * pruned; a refusal throws `RefTransactionAbortedError` (git dies there). {@link setAuto} is
 * git 2.5x's `--auto`: nothing happens unless enough loose refs wait.
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
  private auto = false;
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
   * git 2.5x's `pack-refs --auto` (files-backend.c `should_pack_refs`): pack only when at
   * least `max(16, log2(<packed-refs size> / 100) * 5)` loose refs could be packed.
   *
   * @param auto Whether to pack only when needed
   */
  setAuto(auto: boolean): this {
    this.checkCallable();
    this.auto = auto;
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

    // Check if the ref store supports packRefs
    if (!this.refsStore.packRefs) {
      throw new Error("This ref store does not support packRefs");
    }

    const errors: string[] = [];
    const onError = (line: string) => {
      errors.push(line);
      this.hooks.append(`${line}\n`);
    };
    const common = { deleteLoose: true, onError, ...(this.auto ? { auto: true } : {}) };
    // run with nothing to pack too: git's reference-transaction hook hears an empty one
    const refsPacked = this.all
      ? await this.refsStore.packRefs([], { ...common, all: true })
      : this.refs.length > 0
        ? await this.refsStore.packRefs(this.refs, common)
        : // git's default: the loose tags
          await this.refsStore.packRefs([], { ...common, prefixes: ["refs/tags/"] });

    return { refsPacked, success: true, errors };
  }
}
