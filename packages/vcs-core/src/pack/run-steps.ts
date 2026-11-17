/**
 * Synchronous-first reads. A read of an object already in memory (a loaded pack window, the
 * delta base cache) needs no I/O, yet an `async` function pays for a promise and a microtask
 * hop at each layer it passes through (pack, pack set, object store). Written as a generator
 * that yields only the promises it must wait for, a read runs to its end synchronously when
 * it yields none, and finishes asynchronously from the first promise it yields.
 *
 * @example
 * ```typescript
 * function* readSteps(id: string): Steps<Uint8Array> {
 *   let bytes = peek(id) ?? load(id); // a value, or a promise of one
 *   if (bytes instanceof Promise) bytes = (yield bytes) as Uint8Array;
 *   return bytes;
 * }
 * const r = runSteps(readSteps(id)); // Uint8Array, or Promise<Uint8Array> after I/O
 * ```
 */

/** A read written for `runSteps`: it yields the promises it waits for and gets their values. */
export type Steps<T> = Generator<Promise<unknown>, T, unknown>;

/**
 * Runs `steps` synchronously until it yields a promise, then asynchronously: the value, or a
 * promise of it. An error before the first promise is thrown here; one after it rejects the
 * promise. A rejected promise the steps wait for is thrown into them, at their `yield`.
 */
export function runSteps<T>(steps: Steps<T>): T | Promise<T> {
  const r = steps.next();
  return r.done ? r.value : finishSteps(steps, r.value);
}

async function finishSteps<T>(steps: Steps<T>, pending: Promise<unknown>): Promise<T> {
  for (;;) {
    let value: unknown;
    let failed = false;
    try {
      value = await pending;
    } catch (e) {
      failed = true;
      value = e;
    }
    const r = failed ? steps.throw(value) : steps.next(value);
    if (r.done) return r.value;
    pending = r.value;
  }
}

/** `runSteps` for an API that returns a promise: an error before any I/O rejects it. */
export function runStepsAsync<T>(steps: Steps<T>): Promise<T> {
  try {
    const r = runSteps(steps);
    return r instanceof Promise ? r : Promise.resolve(r);
  } catch (e) {
    return Promise.reject(e);
  }
}
