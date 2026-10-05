/**
 * The newAsyncGenerator function creates async generators from callback-based initialization
 * functions, providing a bridge between imperative event handling and declarative async
 * iteration patterns.
 *
 * The initialization function receives two callback functions that control the generator's
 * behavior. The `next` function yields values to consumers, while the `done` function
 * signals completion or error conditions. The initialization function can return a cleanup
 * function that will be called when the generator is closed or an error occurs.
 *
 * The generator manages an internal queue of values and completion signals, ensuring that
 * producers can yield values without overwhelming consumers. Proper backpressure is implemented
 * by having the `next` and `done` functions return promises that resolve only after the
 * consumer has processed the values. This prevents memory leaks and ensures that producers
 * are aware of whether their values were successfully handled.
 * The generator also handles cleanup by draining any remaining items in the queue and notifying
 * producers that their values were not processed if the generator is closed early. This ensures
 * that resources are properly managed and that no memory leaks occur.
 *
 * Example usage:
 * ```typescript
 * const asyncGen = newAsyncGenerator<number>((next, done) => {
 *   let count = 0;
 *   const interval = setInterval(() => {
 *     if (count < 5) {
 *       next(count++);
 *     } else {
 *       done();
 *       clearInterval(interval);
 *     }
 *   }, 1000);
 *   return () => clearInterval(interval); // Cleanup function
 * });
 * (async () => {
 *   for await (const num of asyncGen) {
 *     console.log(num); // Logs numbers 0 to 4 at 1 second intervals
 *   }
 *   console.log("Completed");
 * })();
 * ```
 * @template T The type of values yielded by the generator
 * @template E The type of errors that can be thrown; defaults to Error
 * @param init Initialization function that sets up the generator behavior with next/done callbacks;
 *  The first parameter - `next` function - is used to yield values to consumers;
 *  It returns a Promise<boolean> indicating whether the value was successfully handled;
 *  The second parameter - `done` function - is used to signal completion or error;
 *  It returns a Promise<boolean> indicating whether the completion was successfully handled;
 *  The initialization function can optionally return a cleanup function that will be called
 *  when the generator is closed or an error occurs;
 * @param skipValues If true, only the most recent value is kept in the queue,
 * skipping intermediate values (not consumed values are considered skipped);
 * This is useful for scenarios where only the latest value matters, such as UI updates.
 * Defaults to false, meaning all values are queued and processed in order.
 * @returns AsyncGenerator that properly manages backpressure and resource cleanup
 */
export async function* newAsyncGenerator<T, E = Error>(
  /**
   * Initialization function that sets up the async generator behavior.
   * @param next - Function to yield values to consumers. Returns a Promise<boolean>
   *               indicating whether the value was successfully handled.
   * @param done - Function to signal completion or error. Optional error parameter
   *               will cause the generator to throw that error.
   * @returns Optional cleanup function that will be called when the generator terminates.
   */
  init: (
    next: (value: T) => Promise<boolean>,
    done: (err?: E) => Promise<boolean>,
  ) => void | (() => void | Promise<void>),

  /**
   * Skipping queue implementation that maintains only the most recent value.
   */
  skipValues = false,
): AsyncGenerator<T> {
  /**
   * Internal queue slot type that wraps values and completion signals with resolution callbacks.
   * This enables the async generator to communicate back to producers whether their values
   * were successfully processed, enabling backpressure management.
   */
  type IterationSlot<T, E> =
    | { done: false; value: T } // Regular value slot
    | { done: true; error?: E }; // Completion/error slot
  type QueueSlot<T, E> = IterationSlot<T, E> & {
    next: QueueSlot<T, E> | undefined; // Pointer to the next slot in the queue
    resolve: (handled: boolean) => void; // Callback to signal if the value was handled
  };

  let head: QueueSlot<T, E> | undefined; // Head of the queue
  let tail: QueueSlot<T, E> | undefined; // Tail of the queue

  /** Flag to prevent new values from being queued after generator closes */
  let closed = false;

  /** Wake-up function to notify the generator loop of new items */
  let wakeUp: undefined | (() => void);

  /**
   * Drains the internal queue, notifying all pending producers that their values
   * were not processed due to generator closure. This prevents memory leaks and
   * ensures proper backpressure signaling.
   */
  const drainQueue = () => {
    for (; head; head = head.next) {
      closed = closed || head.done;
      head.resolve(false); // Notify producer that value was not handled
    }
    tail = undefined;
  };

  /**
   * Enqueues a value or completion signal with a promise that resolves when the item
   * is processed. This enables backpressure by allowing producers to know when their
   * values have been consumed.
   */
  const enqueue = (params: IterationSlot<T, E>): Promise<boolean> => {
    if (skipValues) {
      // Remove any previous value slots
      drainQueue();
    }
    return !closed
      ? new Promise<boolean>((resolve) => {
          // Add the new slot to the queue
          const next = { ...params, next: undefined, resolve };
          if (tail) {
            tail.next = next;
          }
          tail = next;
          if (!head) {
            head = tail;
          }
          // Notify the generator loop that a new item is available
          wakeUp?.();
        })
      : // If the generator is closed, immediately resolve as not handled
        Promise.resolve(false);
  };

  /**
   * Producer function to yield a value to consumers. Returns a promise that resolves
   * to true if the value was successfully processed, false if the generator is closed
   * or the value was skipped due to backpressure.
   */
  const next = (value: T): Promise<boolean> => enqueue({ done: false, value });

  /**
   * Producer function to signal completion or error. Optional error parameter will
   * cause the generator to throw that error to consumers.
   */
  const done = (error?: E): Promise<boolean> => enqueue({ done: true, error });

  // Initialize the producer by calling the init function with our control functions
  const unsubscribe = init(next, done);

  try {
    // Main async generator loop - processes queued items and yields values
    while (!closed) {
      // Try to get the next item from the queue
      if (!head) {
        // If no items available, wait for producers to add something
        await new Promise<void>((resolve) => {
          wakeUp = resolve;
        }).then(() => {
          wakeUp = undefined;
        });
        continue;
      }

      // Process the next item in the queue
      const slot = head;
      // Move head to the next item
      head = head.next;
      // If we removed the tail, clear it as well
      if (tail === slot) {
        tail = head;
      }
      try {
        // Handle completion/error signals
        if (slot.done) {
          closed = true;
          if (slot.error !== undefined) {
            throw slot.error;
          }
          break;
        }
        // Yield the value to the consumer
        yield slot.value;
      } finally {
        // Signal successful processing
        slot.resolve(true);
      }
    }
  } finally {
    /**
     * Cleanup phase - ensures proper resource management and notification of any
     * remaining producers. This runs whether the generator completes normally,
     * encounters an error, or is closed early by the consumer.
     */
    closed = true;

    // Wake up any pending operations to allow them to exit
    wakeUp?.();

    // Call the cleanup function returned by the initialization function
    if (typeof unsubscribe === "function") {
      await unsubscribe();
    }

    /**
     * Drain any remaining items in the queue and notify their producers that
     * the values were not processed. This prevents memory leaks and ensures
     * proper backpressure signaling.
     */
    drainQueue();
  }
}
