import { describe, expect, it } from "vitest";
import { runSteps, runStepsAsync, type Steps } from "../../src/pack/index.js";

function* add(a: number | Promise<number>, b: number | Promise<number>): Steps<number> {
  const x = a instanceof Promise ? ((yield a) as number) : a;
  const y = b instanceof Promise ? ((yield b) as number) : b;
  return x + y;
}

function* recover(p: Promise<number>): Steps<string> {
  try {
    return `got ${(yield p) as number}`;
  } catch (e) {
    return `caught ${(e as Error).message}`;
  }
}

describe("runSteps", () => {
  it("returns the value when the steps wait for nothing, a promise once they wait", async () => {
    expect(runSteps(add(1, 2))).toBe(3);
    const later = runSteps(add(1, Promise.resolve(2)));
    expect(later).toBeInstanceOf(Promise);
    expect(await later).toBe(3);
    expect(await runSteps(add(Promise.resolve(1), Promise.resolve(2)))).toBe(3);
  });

  it("throws into the steps a promise's rejection, at their yield", async () => {
    expect(await runSteps(recover(Promise.reject(new Error("no"))))).toBe("caught no");
    expect(await runSteps(recover(Promise.resolve(4)))).toBe("got 4");
  });

  it("throws an error raised before any promise; runStepsAsync rejects with it", async () => {
    function* fail(late: boolean): Steps<number> {
      if (late) yield Promise.resolve();
      throw new Error(late ? "late" : "early");
    }
    expect(() => runSteps(fail(false))).toThrow("early");
    await expect(runStepsAsync(fail(false))).rejects.toThrow("early");
    await expect(runSteps(fail(true))).rejects.toThrow("late");
    await expect(runStepsAsync(add(1, 2))).resolves.toBe(3);
  });
});
