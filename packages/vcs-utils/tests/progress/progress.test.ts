/**
 * `startProgress`, the phase reporter behind `GitCommand.setProgress`: scenarios after JGit's
 * TextProgressMonitorTest (a task with a total, an unbounded task, nothing shown for a task
 * that never updates) and ThreadSafeProgressMonitorTest (updates after the end are ignored),
 * with git's progress.c rule that a phase never displayed prints nothing at its end.
 */
import { describe, expect, it } from "vitest";
import { type ProgressUpdate, startProgress, withProgress } from "../../src/progress/index.js";

function recorder() {
  const updates: ProgressUpdate[] = [];
  return { updates, monitor: (u: ProgressUpdate) => void updates.push(u) };
}

describe("startProgress", () => {
  it("TextProgressMonitorTest: a task with a total counts up to its total, then ends", () => {
    const { updates, monitor } = recorder();
    const task = startProgress(monitor, "Writing objects", 3);
    task.tick();
    task.tick(2);
    task.stop();
    expect(updates).toEqual([
      { phase: "Writing objects", done: 1, total: 3, finished: false },
      { phase: "Writing objects", done: 3, total: 3, finished: false },
      { phase: "Writing objects", done: 3, total: 3, finished: true },
    ]);
    expect(task.done).toBe(3);
  });

  it("TextProgressMonitorTest: an unbounded task, a counter has no total", () => {
    const { updates, monitor } = recorder();
    const task = startProgress(monitor, "Checking connectivity");
    task.update(5);
    task.stop();
    expect(updates).toEqual([
      { phase: "Checking connectivity", done: 5, finished: false },
      { phase: "Checking connectivity", done: 5, finished: true },
    ]);
  });

  it("TextProgressMonitorTest: a phase never updated reports nothing", () => {
    const { updates, monitor } = recorder();
    startProgress(monitor, "Checking objects", 0).stop();
    expect(updates).toEqual([]);
  });

  it("ThreadSafeProgressMonitorTest: nothing after stop", () => {
    const { updates, monitor } = recorder();
    const task = startProgress(monitor, "Resolving deltas", 2);
    task.tick();
    task.stop();
    task.tick();
    task.stop();
    expect(updates.map((u) => [u.done, u.finished])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it("works without a monitor", () => {
    const task = startProgress(undefined, "Counting objects", 3);
    task.tick();
    task.stop();
    expect(task.done).toBe(0);
  });

  it("a monitor that throws cancels the operation; the phase is never finished", async () => {
    const { updates, monitor } = recorder();
    const cancelling = (u: ProgressUpdate) => {
      monitor(u);
      if (u.done === 2) throw new Error("cancelled");
    };
    await expect(
      withProgress(cancelling, "Updating files", 4, (task) => {
        for (let i = 0; i < 4; i++) task.tick();
      }),
    ).rejects.toThrow("cancelled");
    expect(updates.map((u) => u.done)).toEqual([1, 2]);
    expect(updates.some((u) => u.finished)).toBe(false);
  });
});
