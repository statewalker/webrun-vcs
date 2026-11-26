/**
 * A ref store whose storage is gone: after `git refs migrate` swaps the repository's ref
 * storage (`migrateRefStorage`), the store opened on the old format would still read and
 * write the old files (loose refs, packed-refs, or `reftable/`), which the repository no
 * longer reads, so a commit made through it would be invisible and its objects lost to the
 * next gc. git runs every command in a process of its own and never meets this; here the
 * migrating code retires the store it ran on, and every later use of it throws
 * {@link RefStoreRetiredError} instead.
 *
 * @example
 * ```typescript
 * await migrateRefStorage({ files, gitDir: ".git", to: "reftable" });
 * retireRefStore(history.refs, "the ref storage was migrated to 'reftable'");
 * await history.refs.set("refs/heads/main", id); // throws RefStoreRetiredError
 * const { history: fresh } = await createGitFilesBackend({ files, gitDir: ".git" });
 * ```
 */

const RETIRED = Symbol.for("@statewalker/vcs-store-files/retired-ref-store");

/** Thrown by every method of a ref store {@link retireRefStore} retired. */
export class RefStoreRetiredError extends Error {
  constructor(readonly reason: string) {
    super(`${reason}: open the repository again`);
    this.name = "RefStoreRetiredError";
  }
}

/**
 * Makes every method of `store` (its own ones, those patched on the instance, and its
 * prototype chain's) throw {@link RefStoreRetiredError} from now on.
 */
export function retireRefStore(store: object, reason: string): void {
  const target = store as Record<string | symbol, unknown>;
  if (target[RETIRED] !== undefined) return;
  const names = new Set<string | symbol>();
  for (
    let proto: object | null = store;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Reflect.ownKeys(proto)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
  }
  const refuse = () => {
    throw new RefStoreRetiredError(reason);
  };
  for (const name of names) {
    Object.defineProperty(store, name, { value: refuse, writable: true, configurable: true });
  }
  Object.defineProperty(store, RETIRED, { value: reason });
}

/** Why {@link retireRefStore} retired `store`, or undefined while it is in use. */
export function refStoreRetirement(store: unknown): string | undefined {
  if (typeof store !== "object" || store === null) return undefined;
  return (store as Record<symbol, string | undefined>)[RETIRED];
}
