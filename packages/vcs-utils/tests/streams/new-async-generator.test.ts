import { describe, expect, it } from "vitest";
import { newAsyncGenerator } from "../../src/streams/new-async-generator";

async function delay(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("newAsyncGenerator()", () => {
  // =============================================================================
  // Tests without cleanup callbacks
  // =============================================================================

  it("should iterate over synchronous values (sync provider)", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        for (const str of strings) {
          produced.push(str);
          next(str); // Fire and forget (no await)
        }
        done();
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
      }

      // Producer completes synchronously before consumer starts iterating
      // So produced array is complete when consumer starts
      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      // In sync case, producer finishes all production before any consumption
      expect(produced).toEqual(consumed);
    }
  });

  it("should iterate over async values without waiting for consumer", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            // Don't wait for the consumer (fire and forget)
            next(str);
            await delay(Math.random() * 10);
          }
          done();
        })();
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        expect(consumed.length).toBeLessThanOrEqual(produced.length);
        // Producer doesn't wait, so it can be ahead of consumer
        // Consumer always waits for producer (can NEVER be ahead)
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      // After completion, both should have all values
      expect(produced).toEqual(consumed);
    }
  });

  it("should iterate with async provider and async consumer", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            // Don't wait for the consumer (fire and forget)
            next(str);
            await delay(Math.random() * 10);
          }
          done();
        })();
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        // Both producer and consumer are async with random delays
        // Producer doesn't wait, so it can be ahead of or in sync with consumer
        // Consumer always waits for producer (can NEVER be ahead)
        expect(consumed.length).toBeLessThanOrEqual(produced.length);
        await delay(Math.random() * 10);
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      // After completion, both should have all values
      expect(produced).toEqual(consumed);
    }
  });

  it("should iterate with synchronization between provider and consumer", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            // Wait for the consumer to process the value
            await next(str);
            // await delay(Math.random() * 10);
          }
          await done();
        })();
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        // Check that produced and consumed are in sync
        // (Producer waits, so lengths are ALWAYS equal)
        expect(consumed.length).toBe(produced.length);
        expect(consumed).toEqual(produced);
        await delay(Math.random() * 10);
      }
      expect(consumed).toEqual(control);
    }
  });

  // =============================================================================
  // Tests with cleanup callbacks
  // =============================================================================

  it("should call cleanup callback after iteration completes (sync provider)", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      let cleaned = false;
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        for (const str of strings) {
          produced.push(str);
          next(str);
        }
        done();
        return () => {
          cleaned = true;
        };
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      expect(cleaned).toBe(true);
    }
  });

  it("should call cleanup callback after iteration completes (async provider without waiting)", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      let cleaned = false;
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            next(str); // Fire and forget
            await delay(Math.random() * 10);
          }
          done();
        })();
        return () => {
          cleaned = true;
        };
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        // Producer fires without waiting, so it can be ahead of consumer
        // Consumer always waits for producer (can NEVER be ahead)
        expect(consumed.length).toBeLessThanOrEqual(produced.length);
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      expect(cleaned).toBe(true);
    }
  });

  it("should call cleanup callback with async provider and async consumer", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      let cleaned = false;
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            next(str); // Fire and forget
            await delay(Math.random() * 10);
          }
          done();
        })();
        return () => {
          cleaned = true;
        };
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        // With random delays, producer can be ahead of or in sync with consumer
        // Consumer always waits for producer (can NEVER be ahead)
        expect(consumed.length).toBeLessThanOrEqual(produced.length);
        await delay(Math.random() * 10);
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      expect(cleaned).toBe(true);
    }
  });

  it("should call cleanup callback with synchronization between provider and consumer", async () => {
    await test([], []);
    await test([""], [""]);
    await test(["a"], ["a"]);
    await test(["a", "b", "c"], ["a", "b", "c"]);
    await test(["a", "b", "c", "d", "d"], ["a", "b", "c", "d", "d"]);

    async function test(strings: string[], control: string[]) {
      let cleaned = false;
      const produced: string[] = [];
      const gen = newAsyncGenerator<string>((next, done) => {
        (async () => {
          for (const str of strings) {
            produced.push(str);
            await next(str); // Wait for consumer
            await delay(Math.random() * 10);
          }
          await done();
        })();
        return () => {
          cleaned = true;
        };
      });

      const consumed: string[] = [];
      for await (const str of gen) {
        consumed.push(str);
        // Check that produced and consumed are in sync
        // (Producer waits, so lengths are ALWAYS equal)
        expect(consumed.length).toBe(produced.length);
        expect(consumed).toEqual(produced);
        await delay(Math.random() * 10);
      }

      expect(consumed).toEqual(control);
      expect(produced).toEqual(control);
      expect(cleaned).toBe(true);
    }
  });

  it("should call async cleanup callback", async () => {
    let cleaned = false;
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        await done();
      })();
      return async () => {
        await delay(5);
        cleaned = true;
      };
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }
    expect(list).toEqual(["a", "b"]);
    expect(cleaned).toBe(true);
  });

  // =============================================================================
  // Tests for error handling
  // =============================================================================

  it("should throw error passed to done()", async () => {
    const error = new Error("Test error");
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        await done(error);
      })();
    });

    const list = [];
    try {
      for await (const str of gen) {
        list.push(str);
      }
      expect(false).toBe(true); // Should not reach here
    } catch (err) {
      expect(err).toBe(error);
      expect(list).toEqual(["a", "b"]);
    }
  });

  it("should call cleanup callback even when error is thrown", async () => {
    let cleaned = false;
    const error = new Error("Test error");
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        await done(error);
      })();
      return () => {
        cleaned = true;
      };
    });

    const list = [];
    try {
      for await (const str of gen) {
        list.push(str);
      }
    } catch (err) {
      expect(err).toBe(error);
    }
    expect(list).toEqual(["a", "b"]);
    expect(cleaned).toBe(true);
  });

  // =============================================================================
  // Tests for early termination (consumer breaks from loop)
  // =============================================================================

  it("should handle early termination by consumer (break)", async () => {
    let cleaned = false;
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        await next("c");
        await next("d");
        await done();
      })();
      return () => {
        cleaned = true;
      };
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
      if (str === "b") {
        break;
      }
    }
    expect(list).toEqual(["a", "b"]);
    expect(cleaned).toBe(true);
  });

  it("should return false from next() when consumer terminates early", async () => {
    const results: boolean[] = [];
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        results.push(await next("a"));
        results.push(await next("b"));
        results.push(await next("c"));
        results.push(await next("d"));
        await done();
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
      if (str === "b") {
        break;
      }
    }

    // Give time for the producer to finish
    await delay(10);

    expect(list).toEqual(["a", "b"]);
    expect(results).toEqual([true, true, false, false]);
  });

  it("should return false from done() when consumer terminates early", async () => {
    let doneResult: boolean | undefined;
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        await next("c");
        doneResult = await done();
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
      if (str === "b") {
        break;
      }
    }

    // Give time for the producer to finish
    await delay(10);

    expect(list).toEqual(["a", "b"]);
    expect(doneResult).toBe(false);
  });

  // =============================================================================
  // Tests for backpressure (Promise<boolean> return values)
  // =============================================================================

  it("should return true from next() when value is successfully consumed", async () => {
    const results: boolean[] = [];
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        results.push(await next("a"));
        results.push(await next("b"));
        results.push(await next("c"));
        await done();
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }
    expect(list).toEqual(["a", "b", "c"]);
    expect(results).toEqual([true, true, true]);
  });

  it("should return true from done() when completion is successful", async () => {
    let doneResult: boolean | undefined;
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("a");
        await next("b");
        doneResult = await done();
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }
    expect(list).toEqual(["a", "b"]);
    expect(doneResult).toBe(true);
  });

  it("should return false from next() when generator is already closed", async () => {
    let secondCallResult: boolean | undefined;
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await done();
        secondCallResult = await next("should not yield");
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }

    // Give time for the producer to finish
    await delay(10);

    expect(list).toEqual([]);
    expect(secondCallResult).toBe(false);
  });

  // =============================================================================
  // Tests for skipValues flag
  // =============================================================================

  it("should keep all values when skipValues is false (default)", async () => {
    const gen = newAsyncGenerator<number>(
      (next, done) => {
        (async () => {
          for (let i = 0; i < 10; i++) {
            next(i); // Don't wait
          }
          done();
        })();
      },
      false, // skipValues = false
    );

    const list = [];
    for await (const num of gen) {
      list.push(num);
      await delay(5); // Consumer is slower
    }
    expect(list).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should skip intermediate values when skipValues is true", async () => {
    const gen = newAsyncGenerator<number>(
      (next, done) => {
        (async () => {
          await delay(5); // Give consumer time to start
          for (let i = 0; i < 50; i++) {
            next(i); // Don't wait - fire rapidly
            // Add tiny delay to ensure async processing
            if (i % 5 === 0) await delay(0);
          }
          await delay(5); // Allow consumer to catch up
          done();
        })();
      },
      true, // skipValues = true
    );

    const list = [];
    for await (const num of gen) {
      list.push(num);
      await delay(10); // Consumer is slower
    }

    // With skipValues=true, only the most recent value should be kept when producer is faster
    // The exact values depend on timing, but we should get fewer than all 50 values
    expect(list.length).toBeLessThan(50);
    expect(list.length).toBeGreaterThan(0);
    // Values should be non-decreasing (we're skipping forward)
    for (let i = 1; i < list.length; i++) {
      expect(list[i]).toBeGreaterThanOrEqual(list[i - 1]);
    }
  });

  it("should notify skipped values that they were not handled (skipValues=true)", async () => {
    const results: Promise<boolean>[] = [];
    const gen = newAsyncGenerator<number>(
      (next, done) => {
        (async () => {
          await delay(5); // Give consumer time to start
          // Fire many values rapidly WITHOUT waiting for consumption
          for (let i = 0; i < 50; i++) {
            results.push(next(i)); // Don't await - fire and forget
          }
          // Wait for all results to settle
          await Promise.all(results);
          await delay(5); // Allow consumer to catch up
          done();
        })();
      },
      true, // skipValues = true
    );

    const list = [];
    for await (const num of gen) {
      list.push(num);
      await delay(10); // Consumer is slower
    }

    // Resolve all results
    const resolvedResults = await Promise.all(results);

    // Some values should be marked as not handled (false) due to skipping
    const notHandled = resolvedResults.filter((r) => !r);
    expect(notHandled.length).toBeGreaterThan(0);

    // Some values should be marked as handled (true)
    const handled = resolvedResults.filter((r) => r);
    expect(handled.length).toBeGreaterThan(0);

    // The number consumed should match the number marked as handled
    expect(handled.length).toBe(list.length);
  });

  // =============================================================================
  // Tests for edge cases
  // =============================================================================

  it("should handle empty generator (no values, immediate done)", async () => {
    const gen = newAsyncGenerator<string>((_next, done) => {
      done();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }
    expect(list).toEqual([]);
  });

  it("should handle generator with only one value", async () => {
    const gen = newAsyncGenerator<string>((next, done) => {
      (async () => {
        await next("single");
        await done();
      })();
    });

    const list = [];
    for await (const str of gen) {
      list.push(str);
    }
    expect(list).toEqual(["single"]);
  });

  it("should handle multiple consumers of the same generator", async () => {
    const gen = newAsyncGenerator<number>((next, done) => {
      (async () => {
        for (let i = 0; i < 5; i++) {
          await next(i);
        }
        await done();
      })();
    });

    // First consumer
    const list1 = [];
    for await (const num of gen) {
      list1.push(num);
    }
    expect(list1).toEqual([0, 1, 2, 3, 4]);

    // Second consumer (should get nothing as generator is exhausted)
    const list2 = [];
    for await (const num of gen) {
      list2.push(num);
    }
    expect(list2).toEqual([]);
  });

  it("should handle rapid producer with slow consumer", async () => {
    const gen = newAsyncGenerator<number>((next, done) => {
      (async () => {
        for (let i = 0; i < 100; i++) {
          next(i); // Fire and forget
        }
        done();
      })();
    });

    const list = [];
    for await (const num of gen) {
      list.push(num);
      await delay(1);
    }
    expect(list.length).toBe(100);
    expect(list).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("should handle slow producer with fast consumer", async () => {
    const gen = newAsyncGenerator<number>((next, done) => {
      (async () => {
        for (let i = 0; i < 10; i++) {
          await next(i);
          await delay(10);
        }
        await done();
      })();
    });

    const list = [];
    for await (const num of gen) {
      list.push(num);
      // Consumer is faster (no delay)
    }
    expect(list).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
