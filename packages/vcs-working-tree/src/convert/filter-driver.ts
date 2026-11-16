/**
 * Filter drivers (`filter=<driver>` attribute): the host registers what git would run as
 * `filter.<driver>.clean` / `filter.<driver>.smudge` commands, since portable code runs no
 * processes.
 */

/** What a filter driver is told about the file it converts. */
export interface FilterDriverContext {
  /** The path of the file in the worktree, relative to its root */
  path: string;
}

/**
 * A filter driver the host registers (git-lfs is one: `createLfsFilterDriver` in
 * `@statewalker/vcs-transport-lfs`). A missing direction passes content through, as git
 * does for a driver without that command.
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
