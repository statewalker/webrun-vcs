/**
 * Git LFS File Locking API wire shapes (git-lfs `docs/api/locking.md`) and the
 * store interface the server keeps its locks in.
 */

/** The owner of a lock, as the server names it. */
export interface LfsLockOwner {
  name: string;
}

/** A lock as the API sends it: `{ id, path, locked_at, owner? }`. */
export interface LfsLock {
  /** The server's id for the lock (opaque) */
  id: string;
  /** The locked path, relative to the repository root, with `/` */
  path: string;
  /** When the lock was created (RFC 3339) */
  locked_at: string;
  owner?: LfsLockOwner;
}

/** `{ name }`: the server ref locks belong to (git-lfs 2.4 and later send it). */
export interface LfsLockRef {
  name: string;
}

/** `POST /locks` request body. */
export interface LfsCreateLockRequest {
  path: string;
  ref?: LfsLockRef;
}

/** `POST /locks/verify` request body. */
export interface LfsVerifyLocksRequest {
  cursor?: string;
  limit?: number;
  ref?: LfsLockRef;
}

/** `POST /locks/:id/unlock` request body. */
export interface LfsUnlockRequest {
  force?: boolean;
  ref?: LfsLockRef;
}

/** `GET /locks` response body. */
export interface LfsListLocksResponse {
  locks: LfsLock[];
  next_cursor?: string;
}

/** `POST /locks/verify` response body: the caller's locks and everyone else's. */
export interface LfsVerifyLocksResponse {
  ours: LfsLock[];
  theirs: LfsLock[];
  next_cursor?: string;
}

/** A lock as a {@link LfsLockStore} keeps it: always with an owner, and its ref when locks are per ref. */
export interface LfsStoredLock extends LfsLock {
  owner: LfsLockOwner;
  /** The ref the lock belongs to; only set by a server with `perRef` */
  ref?: string;
}

/** What {@link LfsLockStore.list} selects, and one page of it. */
export interface LfsLockQuery {
  /** Only the lock on this (normalised) path */
  path?: string;
  /** Only the lock with this id */
  id?: string;
  /** Only locks of this ref (stores keep `ref` only for a server with `perRef`) */
  ref?: string;
  /** Where the previous page ended: its `nextCursor` */
  cursor?: string;
  /** Locks per page (at least 1) */
  limit: number;
}

/** One page of locks, and the cursor of the next page if there is one. */
export interface LfsLockPage {
  locks: LfsStoredLock[];
  nextCursor?: string;
}

/**
 * Where `serveLfs` keeps locks. A path (with its ref, when the server keeps
 * locks per ref) holds at most one lock: `create` makes it atomically, or
 * answers the lock already there. Cursors are opaque to the server, which
 * passes them through. `createMemoryLockStore` and `createFilesLockStore`
 * implement it.
 */
export interface LfsLockStore {
  /**
   * Locks `path` (for `ref`, if given) for `owner`: `{ created: true, lock }`,
   * or `{ created: false, lock }` with the lock that already holds the path.
   */
  create(input: {
    path: string;
    owner: LfsLockOwner;
    ref?: string;
  }): Promise<{ created: boolean; lock: LfsStoredLock }>;
  /** The lock with this id, if any. */
  get(id: string): Promise<LfsStoredLock | undefined>;
  /** A page of the locks `query` selects, in a stable order. */
  list(query: LfsLockQuery): Promise<LfsLockPage>;
  /** Removes the lock with this id: the lock removed, or `undefined` if there was none. */
  remove(id: string): Promise<LfsStoredLock | undefined>;
}
