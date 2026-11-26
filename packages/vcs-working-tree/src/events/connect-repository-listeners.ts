import type { WorkingCopy } from "../working-copy.js";
import { observeRefWrites } from "./observe-ref-writes.js";
import type { RepositoryListeners } from "./repository-listeners.js";

/**
 * Connects a working copy's listeners to its stores' writes: the ref store's (every write
 * that changed a ref), the index file's (`Staging.addWriteListener`), the configuration's
 * (a config with `addChangeListener`: GitWorkingCopyConfig's saves and the `git config`
 * writes it is told about) and the worktree's files (`Worktree.addModifiedListener`).
 * The staging is the checkout's when the working copy is made: a staging a command builds
 * for itself (a temporary index) is not observed.
 */
export function connectRepositoryListeners(
  workingCopy: Pick<WorkingCopy, "history" | "checkout" | "config" | "worktree">,
  listeners: RepositoryListeners,
): void {
  // a part may be missing (no worktree in a bare repository, a test's partial stores)
  const refs = workingCopy.history?.refs;
  if (refs) observeRefWrites(refs, () => listeners.dispatch({ type: "refs-changed" }));
  workingCopy.checkout?.staging?.addWriteListener?.(() =>
    listeners.dispatch({ type: "index-changed" }),
  );
  const config = workingCopy.config as
    | { addChangeListener?: (listener: () => void) => unknown }
    | undefined;
  if (typeof config?.addChangeListener === "function") {
    config.addChangeListener(() => listeners.dispatch({ type: "config-changed" }));
  }
  workingCopy.worktree?.addModifiedListener?.((modified, deleted) =>
    listeners.dispatch({ type: "working-tree-modified", modified, deleted }),
  );
}
