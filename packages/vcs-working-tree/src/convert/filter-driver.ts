/**
 * Filter drivers (`filter=<driver>` attribute): the host registers what git would run as
 * `filter.<driver>.clean` / `filter.<driver>.smudge` commands, since portable code runs no
 * processes.
 */

/** What a filter driver is told about the file it converts. */
export interface FilterDriverContext {
  /** The path of the file in the worktree, relative to its root */
  path: string;
  /**
   * The command git would run for this direction (`filter.<driver>.clean` /
   * `filter.<driver>.smudge`), when the configuration has one: a host that runs commands
   * runs it (its `%f` the path, quoted), others ignore it
   */
  command?: string;
  /**
   * git's checkout metadata (`struct checkout_metadata`), which it sends to a long-running
   * process filter (`filter.<driver>.process`) as `ref=`, `treeish=` and `blob=`: the ref the
   * content comes from, the commit (or tree) and the blob; given where git has them
   * (`git archive`)
   */
  metadata?: CheckoutMetadata;
}

/** git's `struct checkout_metadata`: where smudged content comes from. */
export interface CheckoutMetadata {
  /** The ref named (`refs/heads/main`), when the tree-ish was given through one */
  ref?: string;
  /** The commit, else the tree, the content belongs to */
  treeish?: string;
  /** The blob converted */
  blob?: string;
}

/**
 * Thrown by a driver that fails as git's external filter command does, with the lines git
 * prints for that failure (`external filter '<cmd>' failed <status>`, or `cannot run
 * <cmd>: ...` and `cannot fork to run external filter '<cmd>'`). A driver that is not
 * required then has them reported as `error:` lines, followed by convert.c's own
 * `external filter '<cmd>' failed`, and the content passes through unfiltered.
 *
 * @example
 * ```typescript
 * throw new FilterDriverRunError([`external filter '${command}' failed ${status}`]);
 * ```
 */
export class FilterDriverRunError extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
    this.name = "FilterDriverRunError";
  }
}

/**
 * A filter driver the host registers (git-lfs is one: `createLfsFilterDriver` in
 * `@statewalker/vcs-transport-lfs`). A missing direction, a direction whose command the
 * configuration sets empty (`git -c filter.<driver>.smudge= ...`) and a direction that
 * throws pass content through, as git does for a driver without that command or whose
 * command fails, unless the driver is required (`filter.<driver>.required`): then the
 * conversion fails with git's message ({@link FilterDriverError}), never passing the content
 * through.
 *
 * @example
 * ```typescript
 * const upper: FilterDriver = {
 *   clean: async (content) => new TextEncoder().encode(new TextDecoder().decode(content).toLowerCase()),
 *   smudge: async (content) => new TextEncoder().encode(new TextDecoder().decode(content).toUpperCase()),
 * };
 * ```
 */
export interface FilterDriver {
  /** Worktree content to repository content (`filter.<driver>.clean`) */
  clean?(content: Uint8Array, context: FilterDriverContext): Promise<Uint8Array>;
  /** Repository content to worktree content (`filter.<driver>.smudge`) */
  smudge?(content: Uint8Array, context: FilterDriverContext): Promise<Uint8Array>;
  /**
   * The driver must succeed (`filter.<driver>.required`); the configuration's value wins
   * when it has one
   */
  required?: boolean;
}

/** The filter drivers of a host, by name. */
export type FilterDriverRegistry = ReadonlyMap<string, FilterDriver> | Record<string, FilterDriver>;

/** The driver registered under `name`, if any. */
export function lookupFilterDriver(
  registry: FilterDriverRegistry | undefined,
  name: string,
): FilterDriver | undefined {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(name);
  const record = registry as Record<string, FilterDriver>;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** Thrown when a required filter driver is missing or fails, with git's message. */
export class FilterDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterDriverError";
  }
}
