import type { WorkingCopy } from "../working-copy.js";
import type { Worktree } from "../worktree/index.js";
import { observeRefWrites } from "./observe-ref-writes.js";
import type { RepositoryEvent, RepositoryListeners } from "./repository-listeners.js";

/**
 * Connects a working copy's listeners to its stores' writes: the ref store's (every write
 * that changed a ref), the index file's (`Staging.addWriteListener`), the configuration's
 * (a config with `addChangeListener`: GitWorkingCopyConfig's saves and the `git config`
 * writes it is told about) and the worktree's files (`Worktree.addModifiedListener`).
 * The staging is the checkout's when the working copy is made: a staging a command builds
 * for itself (a temporary index) is not observed. Pending worktree changes are told before
 * an index or refs event, so events follow the order of the writes. Returns what
 * disconnects them all (the working copy's `close()`).
 */
export function connectRepositoryListeners(
  workingCopy: Pick<WorkingCopy, "history" | "checkout" | "config" | "worktree">,
  listeners: RepositoryListeners,
): () => void {
  const removers: Array<() => unknown> = [];
  // a part may be missing (no worktree in a bare repository, a test's partial stores)
  const worktree = workingCopy.worktree as Worktree | undefined;
  // the worktree's writes of an operation come before its index and ref writes: told first
  const dispatchAfterWorktree = (event: RepositoryEvent) => {
    worktree?.flushModified?.();
    listeners.dispatch(event);
  };
  const refs = workingCopy.history?.refs;
  if (refs) {
    removers.push(observeRefWrites(refs, () => dispatchAfterWorktree({ type: "refs-changed" })));
  }
  const staging = workingCopy.checkout?.staging;
  const stopIndex = staging?.addWriteListener?.(() =>
    dispatchAfterWorktree({ type: "index-changed" }),
  );
  if (stopIndex) removers.push(stopIndex);
  const config = workingCopy.config as
    | { addChangeListener?: (listener: () => void) => () => void }
    | undefined;
  if (typeof config?.addChangeListener === "function") {
    removers.push(config.addChangeListener(() => listeners.dispatch({ type: "config-changed" })));
  }
  const stopWorktree = worktree?.addModifiedListener?.((modified, deleted) =>
    listeners.dispatch({ type: "working-tree-modified", modified, deleted }),
  );
  if (stopWorktree) removers.push(stopWorktree);
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
