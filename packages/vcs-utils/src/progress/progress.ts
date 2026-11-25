/**
 * Progress of a long local operation (checkout, gc, repack, index-pack, fsck), reported as
 * git's progress.c reports it to a terminal: one phase at a time, named as git names it
 * ("Updating files", "Writing objects"), with a count and, for most phases, a total.
 *
 * @example
 * ```typescript
 * const seen: string[] = [];
 * await git.fsck().setProgress(({ phase, done, total, finished }) => {
 *   if (finished) seen.push(`${phase}: ${done}/${total ?? "?"}`);
 * }).call();
 * // ["Checking object directories: 256/256", "Checking objects: 15/15", ...]
 * ```
 *
 * A monitor is called synchronously from the operation. A monitor that throws cancels it: the
 * error propagates out of the command, which leaves the repository as git leaves a command
 * interrupted at that point (temporary files removed, locks released, refs untouched).
 */
export type ProgressMonitor = (update: ProgressUpdate) => void;

/** One report of a {@link ProgressMonitor}. */
export interface ProgressUpdate {
  /** The phase, git's title for it: "Counting objects", "Resolving deltas", ... */
  phase: string;
  /** Units done so far in this phase. */
  done: number;
  /** Units the phase will do; undefined for a phase that only counts ("Checking connectivity"). */
  total?: number;
  /** True for the phase's last report (git's ", done."). */
  finished: boolean;
}

/** A phase in progress (git's `struct progress`). */
export interface ProgressTask {
  /** Reports `done` units (git's `display_progress`). */
  update(done: number): void;
  /** Reports one more unit, or `n` more. */
  tick(n?: number): void;
  /**
   * Ends the phase (git's `stop_progress`): a final report with `finished`, but only when the
   * phase reported anything, as git prints nothing for a phase that never displayed.
   */
  stop(): void;
  /** Units reported so far. */
  readonly done: number;
}

const NO_PROGRESS: ProgressTask = {
  update() {},
  tick() {},
  stop() {},
  done: 0,
};

/**
 * Starts a phase (git's `start_progress`): nothing is reported until the first `update`.
 * Without a monitor a shared no-op task is returned, so callers report unconditionally.
 */
export function startProgress(
  monitor: ProgressMonitor | undefined,
  phase: string,
  total?: number,
): ProgressTask {
  if (!monitor) return NO_PROGRESS;
  let done = 0;
  let shown = false;
  let stopped = false;
  const report = (finished: boolean) =>
    monitor(total === undefined ? { phase, done, finished } : { phase, done, total, finished });
  return {
    update(n: number) {
      if (stopped) return;
      done = n;
      shown = true;
      report(false);
    },
    tick(n = 1) {
      this.update(done + n);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (shown) report(true);
    },
    get done() {
      return done;
    },
  };
}

/**
 * Runs `body` with a phase started, stopping it when the body succeeds. A body that throws
 * (a monitor cancelling, or a failure) leaves the phase unfinished, as git's die() does.
 */
export async function withProgress<T>(
  monitor: ProgressMonitor | undefined,
  phase: string,
  total: number | undefined,
  body: (task: ProgressTask) => Promise<T> | T,
): Promise<T> {
  const task = startProgress(monitor, phase, total);
  const result = await body(task);
  task.stop();
  return result;
}
