/**
 * Listeners of a working copy's writes, as JGit's `ListenerList`: one event after each
 * write of the refs (`RefsChangedEvent`), of the index file (`IndexChangedEvent`), of the
 * configuration (`ConfigChangedEvent`) and of the worktree's files
 * (`WorkingTreeModifiedEvent`), in the order the writes happen.
 *
 * ```ts
 * const stop = workingCopy.listeners?.addRefsChangedListener(() => refresh());
 * await git.branchCreate().setName("topic").call(); // refresh() runs once
 * stop?.();
 * ```
 *
 * Listeners run synchronously after the write has completed; one that throws does not keep
 * the others from hearing the event, and never fails the write.
 */

/** The refs changed: one committed ref transaction (or a ref store write) */
export interface RefsChangedEvent {
  readonly type: "refs-changed";
}

/** The index file was written */
export interface IndexChangedEvent {
  readonly type: "index-changed";
}

/** The configuration was written (a save, or `git config`) */
export interface ConfigChangedEvent {
  readonly type: "config-changed";
}

/**
 * Files of the worktree were written or removed: one event per worktree operation (a
 * worktree batch, or a single write outside one). Paths are worktree-relative.
 */
export interface WorkingTreeModifiedEvent {
  readonly type: "working-tree-modified";
  /** Files written (created or changed) */
  readonly modified: readonly string[];
  /** Files (or directories) removed */
  readonly deleted: readonly string[];
}

export type RepositoryEvent =
  | RefsChangedEvent
  | IndexChangedEvent
  | ConfigChangedEvent
  | WorkingTreeModifiedEvent;

export type RepositoryListener<E extends RepositoryEvent = RepositoryEvent> = (event: E) => void;

/** Removes the listener it was returned for. */
export type RemoveListener = () => void;

/** A working copy's listener registry (see the module's documentation). */
export class RepositoryListeners {
  private readonly listeners = new Set<RepositoryListener>();

  /** Hears every event. */
  addListener(listener: RepositoryListener): RemoveListener {
    // a function added twice is told twice, removed one by one
    const entry: RepositoryListener = (event) => listener(event);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  addRefsChangedListener(listener: RepositoryListener<RefsChangedEvent>): RemoveListener {
    return this.addListener((e) => e.type === "refs-changed" && listener(e));
  }

  addIndexChangedListener(listener: RepositoryListener<IndexChangedEvent>): RemoveListener {
    return this.addListener((e) => e.type === "index-changed" && listener(e));
  }

  addConfigChangedListener(listener: RepositoryListener<ConfigChangedEvent>): RemoveListener {
    return this.addListener((e) => e.type === "config-changed" && listener(e));
  }

  addWorkingTreeModifiedListener(
    listener: RepositoryListener<WorkingTreeModifiedEvent>,
  ): RemoveListener {
    return this.addListener((e) => e.type === "working-tree-modified" && listener(e));
  }

  /** Whether anyone listens (writers may skip collecting what nobody hears). */
  get size(): number {
    return this.listeners.size;
  }

  /** Tells every listener, in the order they were added. */
  dispatch(event: RepositoryEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a listener's failure is its own: the write already happened
      }
    }
  }
}
