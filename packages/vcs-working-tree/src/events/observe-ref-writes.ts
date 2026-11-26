import type { Refs } from "@statewalker/vcs-core";

/** The write methods of a ref store, and whether a call's result means something changed. */
const WRITES: Record<string, (result: unknown) => boolean> = {
  set: () => true,
  setSymbolic: () => true,
  remove: (removed) => removed === true,
  removeAll: () => true,
  batch: (result) => (result as { ok?: boolean } | undefined)?.ok === true,
  compareAndSwap: (result) => (result as { success?: boolean } | undefined)?.success === true,
};

const OBSERVERS = Symbol("refWriteObservers");

interface Observed {
  [OBSERVERS]?: { listeners: Set<() => void>; depth: number };
}

/**
 * Calls `listener` once after each write of `refs` that changed something (`set`,
 * `setSymbolic`, `remove`, `removeAll`, an accepted `batch`, a successful
 * `compareAndSwap`): a write made of other writes of the same store (a `set` running a
 * `batch`) is told once, when the outer one returns (writes running concurrently on one store are told
 * once, when the last returns). Every holder of the store is
 * observed, whatever reaches it. Returns what removes the listener.
 */
export function observeRefWrites(refs: Refs, listener: () => void): () => void {
  const target = refs as unknown as Observed & Record<string, unknown>;
  let observers = target[OBSERVERS];
  if (!observers) {
    const state = { listeners: new Set<() => void>(), depth: 0 };
    observers = state;
    Object.defineProperty(target, OBSERVERS, { value: state });
    for (const [name, changed] of Object.entries(WRITES)) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const wrapped = async function (this: unknown, ...args: unknown[]) {
        state.depth++;
        let result: unknown;
        try {
          result = await (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
        } finally {
          state.depth--;
        }
        if (state.depth === 0 && changed(result)) {
          for (const told of [...state.listeners]) {
            try {
              told();
            } catch {
              // a listener's failure never fails the write
            }
          }
        }
        return result;
      };
      Object.defineProperty(target, name, { value: wrapped, writable: true, configurable: true });
    }
  }
  const entry = () => listener();
  observers.listeners.add(entry);
  return () => {
    observers?.listeners.delete(entry);
  };
}
