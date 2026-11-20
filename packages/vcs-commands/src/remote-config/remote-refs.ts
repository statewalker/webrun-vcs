/**
 * Multi-ref writes of the remote commands (`git remote remove`, `git remote rename`,
 * `git fetch --prune`), as one ref batch where the store can apply it.
 *
 * Internal to the package.
 */

import { isSymbolicRef, type OwnReflogLine, type Refs } from "@statewalker/vcs-core";

/** One ref of a {@link moveRefs}: where it goes and the reflog it takes along. */
export interface RefMove {
  from: string;
  to: string;
  /** The reflog lines of the new name, oldest first (git carries the old log over) */
  reflog?: OwnReflogLine[];
}

/**
 * Deletes `names` with their reflogs: the refs holding an object id in one atomic batch
 * (logged `message` where the store logs deletes), symbolic refs themselves (not their
 * targets) one by one, as git deletes with REF_NO_DEREF. A store with `removeAll` deletes
 * the refs holding an id as git's `delete_refs` (`legacy`: as git 2.43's files backend, see
 * `RefRemoveAllOptions`); a store that cannot batch several refs (`unsupported`) deletes
 * them one by one.
 *
 * @throws Error naming the refs when the batch is refused (nothing deleted then)
 */
export async function deleteRefs(
  refs: Refs,
  names: string[],
  message: string,
  options: { legacy?: boolean } = {},
): Promise<void> {
  const direct: string[] = [];
  const symbolic: string[] = [];
  for (const name of names) {
    const ref = await refs.get(name);
    if (!ref) continue;
    (isSymbolicRef(ref) ? symbolic : direct).push(name);
  }
  if (direct.length > 0 && refs.removeAll) {
    await refs.removeAll(direct, { message, legacy: options.legacy === true });
  } else if (direct.length > 0) {
    const result = await refs.batch(
      direct.map((name) => ({ name, new: null })),
      { message },
    );
    if (!result.ok) {
      if (!result.rejected.every((r) => r.reason === "unsupported")) throw refused(result);
      for (const name of direct) await refs.remove(name);
    }
  }
  for (const name of symbolic) await refs.remove(name);
}

/**
 * Renames refs, as `git remote rename` moves `refs/remotes/<old>/*`: the refs holding an
 * object id are deleted and created under their new names in one atomic batch, each new
 * name with the reflog lines given (the old log, carried over); symbolic refs are then
 * re-created under their new names pointing at `symbolicTarget(old target)`. A store whose
 * batch refuses several refs (`unsupported`: vcs-core's interim `kvStoreRefs`, which keeps
 * no reflogs) moves them one by one: each new name is created only if it does not exist
 * (compare-and-swap) before the old one goes, so no ref is overwritten or lost.
 *
 * @throws Error naming the refs when the batch is refused (a name conflict: nothing moved),
 *   or naming the ref whose new name exists in the one-by-one move (the refs before it moved)
 */
export async function moveRefs(
  refs: Refs,
  moves: RefMove[],
  symbolicTarget: (target: string) => string,
): Promise<void> {
  const direct: { move: RefMove; id: string }[] = [];
  const symbolic: { move: RefMove; target: string }[] = [];
  for (const move of moves) {
    const ref = await refs.get(move.from);
    if (!ref) continue;
    if (isSymbolicRef(ref)) symbolic.push({ move, target: ref.target });
    else if (ref.objectId) direct.push({ move, id: ref.objectId });
  }
  if (direct.length > 0) {
    const commands = [
      ...direct.map(({ move, id }) => ({ name: move.from, old: id, new: null })),
      // git's REF_SKIP_CREATE_REFLOG: a new name gets only the lines carried over (none
      // for a ref that had no log), never a line of its own
      ...direct.map(({ move, id }) => ({
        name: move.to,
        old: null,
        new: id,
        reflog: move.reflog ?? [],
      })),
    ];
    const result = await refs.batch(commands);
    if (!result.ok) {
      if (!result.rejected.every((r) => r.reason === "unsupported")) throw refused(result);
      for (const { move, id } of direct) {
        if (!(await refs.compareAndSwap(move.to, undefined, id)).success) {
          throw new Error(`Cannot update refs: ${move.to} exists`);
        }
        await refs.remove(move.from);
      }
    }
  }
  for (const { move, target } of symbolic) {
    if (await refs.has(move.to)) throw new Error(`Cannot update refs: ${move.to} exists`);
    // the symbolic ref's log carried over too (git's ref_transaction_update_reflog)
    await refs.setSymbolic(
      move.to,
      symbolicTarget(target),
      move.reflog ? { reflog: move.reflog } : undefined,
    );
    await refs.remove(move.from);
  }
}

function refused(result: { rejected: { name: string; reason: string }[] }): Error {
  const why = result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ");
  return new Error(`Cannot update refs: ${why}`);
}
