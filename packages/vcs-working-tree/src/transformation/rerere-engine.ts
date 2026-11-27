/**
 * RerereEngine - git's rerere as a resolution store uses it
 *
 * A store does not compute conflict ids or write `rr-cache/` itself: git reads that
 * directory (and `MERGE_RR`) as its own records, so only an implementation of rerere.c
 * may write there. `@statewalker/vcs-commands` gives one (`rerereEngineOf`,
 * `git.rerere().engine()`).
 *
 * @example
 * ```typescript
 * const store = createResolutionStore(files, staging, blobs, ".git", "", git.rerere().engine());
 * // the user resolved `f` in the worktree, its stages are still in the index
 * await store.recordResolution("f"); // the conflict id, as `git rerere` records it
 * ```
 */

/** A recorded resolution replayed onto a path's conflict. */
export interface RerereReplay {
  /** The conflict id: the name of its `rr-cache/` directory */
  readonly signature: string;
  /** The variant used (`preimage` for 0, `preimage.<n>` else) */
  readonly variant: number;
  /** The recorded preimage (the conflict normalised) */
  readonly preimage: Uint8Array;
  /** The recorded postimage (its resolution) */
  readonly postimage: Uint8Array;
  /** The resolution replayed onto the conflict as it is now (git's `try_merge`) */
  readonly content: Uint8Array;
}

/** rerere over one repository's index, worktree and `rr-cache/`. */
export interface RerereEngine {
  /**
   * Records the worktree's resolution of `path`, still conflicted in the index, as `git
   * rerere` records it: the preimage recreated from the stages (`handle_cache`), the
   * postimage the worktree file. Undefined where git records nothing (rerere off, no
   * three-staged conflict, conflict markers left in the file).
   */
  record(path: string): Promise<string | undefined>;
  /**
   * The recorded resolution that applies cleanly to the conflicted worktree file at `path`
   * (git's replay in `do_rerere_one_path`); with `apply`, written to the worktree as git
   * writes it (the postimage freshened, `MERGE_RR` updated).
   */
  replay(path: string, options?: { apply?: boolean }): Promise<RerereReplay | undefined>;
}
