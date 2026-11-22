/**
 * SQL-based Refs implementation
 *
 * Stores Git references in a SQL database.
 */

import {
  type BatchOptions,
  type BatchResult,
  createReflogReaderOf,
  deleteReflogLine,
  isRefObjectId,
  isUpdatableRefName,
  isValidRefName,
  type ObjectId,
  planRefBatch,
  planReflog,
  type Ref,
  type RefCommand,
  type RefLogOptions,
  type ReflogDeleteOptions,
  ReflogEntryNotFoundError,
  type ReflogReader,
  type ReflogWrite,
  RefStorage,
  type Refs,
  type RefUpdateResult,
  type SymbolicRef,
  type SymbolicRefLogOptions,
  symrefReflogWrites,
} from "@statewalker/vcs-core";
import type { DatabaseClient } from "./database-client.js";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

/**
 * Database row type for ref queries
 */
interface RefRow {
  name: string;
  object_id: string | null;
  target: string | null;
  peeled_object_id: string | null;
  storage: string;
}

/**
 * Upper bound (exclusive) of the names starting with `prefix`: the prefix with
 * its last code point incremented. BINARY collation compares UTF-8 bytes, which
 * is code-point order, so `name >= prefix AND name < upper` is an exact,
 * case-sensitive prefix match with no LIKE wildcards.
 */
function prefixUpperBound(prefix: string): string {
  const chars = [...prefix];
  const last = chars.pop() ?? "";
  return chars.join("") + String.fromCodePoint((last.codePointAt(0) ?? 0) + 1);
}

/**
 * Reflog writes inside a transaction: a dropped log's rows deleted, a line appended
 * (to a log that exists, or one `create` allows).
 */
async function writeReflog(tx: DatabaseClient, writes: ReflogWrite[]): Promise<void> {
  for (const w of writes) {
    if (w.op === "drop") {
      await tx.execute("DELETE FROM vcs_reflog WHERE name = ?", [w.name]);
      continue;
    }
    const { name, line, create } = w;
    if (!create) {
      const rows = await tx.query("SELECT 1 FROM vcs_reflog WHERE name = ? LIMIT 1", [name]);
      if (rows.length === 0) continue;
    }
    await tx.execute(
      "INSERT INTO vcs_reflog (name, old_id, new_id, ident, message) VALUES (?, ?, ?, ?, ?)",
      [name, line.oldId, line.newId, line.ident, line.message],
    );
  }
}

/** The id `name` resolves to through symbolic refs, read with `client`. */
async function resolveId(client: DatabaseClient, name: string): Promise<ObjectId | undefined> {
  let current = name;
  for (let depth = 0; depth < MAX_SYMBOLIC_REF_DEPTH; depth++) {
    const rows = await client.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [current]);
    const row = rows[0];
    if (!row) return undefined;
    if (row.target == null) return row.object_id ?? undefined;
    current = row.target;
  }
  return undefined;
}

function rowToRef(row: RefRow): Ref | SymbolicRef {
  const storage = (row.storage as RefStorage) || RefStorage.LOOSE;
  if (row.target != null) {
    return { name: row.name, target: row.target, storage } as SymbolicRef;
  }
  return {
    name: row.name,
    objectId: row.object_id || undefined,
    storage,
    peeled: row.peeled_object_id != null,
    peeledObjectId: row.peeled_object_id || undefined,
  } as Ref;
}

/**
 * SQL-based Refs: table `vcs_ref`, batches in one transaction.
 */
export class SQLRefStore implements Refs {
  constructor(private db: DatabaseClient) {}

  /** The shallow commits (git's shallow file), table `vcs_shallow`. */
  async getShallow(): Promise<ObjectId[]> {
    const rows = await this.db.query<{ object_id: string }>(
      "SELECT object_id FROM vcs_shallow ORDER BY object_id",
    );
    return rows.map((row) => row.object_id);
  }

  /** Replace the shallow commits in one transaction. */
  async setShallow(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void> {
    const ids = [...new Set(commits)];
    await this.db.transaction(async (tx) => {
      if (expected) {
        const rows = await tx.query<{ object_id: string }>(
          "SELECT object_id FROM vcs_shallow ORDER BY object_id",
        );
        const want = [...new Set(expected)].sort();
        if (rows.length !== want.length || rows.some((r, i) => r.object_id !== want[i])) {
          throw new Error("shallow file has changed since we read it");
        }
      }
      await tx.execute("DELETE FROM vcs_shallow");
      for (const id of ids) {
        await tx.execute("INSERT INTO vcs_shallow (object_id) VALUES (?)", [id]);
      }
    });
  }

  /**
   * Apply all commands atomically, or none (see {@link Refs.batch}): the batch is
   * planned and written inside one transaction, with its reflog lines
   * (`options.ident`, `options.message`; table `vcs_reflog`). As in git, a
   * reflog line that cannot be written fails the batch, which then changes nothing.
   */
  async batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    if (commands.length === 0) return { ok: true, rejected: [] };
    return this.db.transaction(async (tx) => {
      const plan = await planRefBatch(commands, {
        read: async (name) => {
          const rows = await tx.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [name]);
          return rows[0] ? rowToRef(rows[0]) : undefined;
        },
        hasChildren: async (name) => {
          const rows = await tx.query<{ name: string }>(
            "SELECT name FROM vcs_ref WHERE name >= ? AND name < ? LIMIT 1",
            [`${name}/`, prefixUpperBound(`${name}/`)],
          );
          return rows.length > 0;
        },
      });
      if (!plan.ok) return { ok: false, rejected: plan.rejected };
      const now = Date.now();
      for (const u of plan.updates) {
        if (u.newValue === null) {
          await tx.execute("DELETE FROM vcs_ref WHERE name = ?", [u.name]);
        } else {
          await tx.execute(
            `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
             VALUES (?, ?, NULL, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               object_id = excluded.object_id,
               target = NULL,
               peeled_object_id = NULL,
               storage = excluded.storage,
               updated_at = excluded.updated_at`,
            [u.name, u.newValue, RefStorage.LOOSE, now],
          );
        }
      }
      await writeReflog(tx, planReflog(plan.updates, options));
      return { ok: true, rejected: [] };
    });
  }

  /** The reflog of `refName` (written by `batch`), or undefined if it has none. */
  async getReflog(refName: string): Promise<ReflogReader | undefined> {
    const rows = await this.db.query<{
      old_id: string;
      new_id: string;
      ident: string;
      message: string;
    }>("SELECT old_id, new_id, ident, message FROM vcs_reflog WHERE name = ? ORDER BY id", [
      refName,
    ]);
    if (rows.length === 0) return undefined;
    return createReflogReaderOf(
      rows.map((r) => ({ oldId: r.old_id, newId: r.new_id, ident: r.ident, message: r.message })),
    );
  }

  /**
   * Delete reflog entry `refName@{index}` (see {@link Refs.deleteReflogEntry}) in one
   * transaction: the row goes, the kept rows are relinked (`rewrite`), and the ref moves
   * to the newest kept entry (`updateRef`).
   */
  async deleteReflogEntry(
    refName: string,
    index: number,
    options: ReflogDeleteOptions = {},
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: number; old_id: string; new_id: string }>(
        "SELECT id, old_id, new_id FROM vcs_reflog WHERE name = ? ORDER BY id",
        [refName],
      );
      const lines = rows.map((r) => ({ id: r.id, oldId: r.old_id, newId: r.new_id }));
      const kept = deleteReflogLine(lines, index, options.rewrite);
      const removed = lines[lines.length - 1 - index];
      if (!kept || !removed) throw new ReflogEntryNotFoundError(refName, index);
      await tx.execute("DELETE FROM vcs_reflog WHERE id = ?", [removed.id]);
      for (const line of kept) {
        const before = lines.find((l) => l.id === line.id);
        if (before && before.oldId !== line.oldId) {
          await tx.execute("UPDATE vcs_reflog SET old_id = ? WHERE id = ?", [line.oldId, line.id]);
        }
      }
      const top = kept.at(-1);
      if (options.updateRef && top) {
        // git's rule: the ref takes the newest kept entry (created if absent), unless symbolic
        await tx.execute(
          `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             object_id = excluded.object_id,
             peeled_object_id = NULL,
             updated_at = excluded.updated_at
           WHERE vcs_ref.target IS NULL`,
          [refName, top.newId, RefStorage.LOOSE, Date.now()],
        );
      }
      return kept.length;
    });
  }

  /**
   * Read a ref by exact name.
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    const refs = await this.db.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [refName]);
    return refs[0] ? rowToRef(refs[0]) : undefined;
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs).
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    let current = refName;
    let depth = 0;

    while (depth < MAX_SYMBOLIC_REF_DEPTH) {
      const refs = await this.db.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [current]);

      if (refs.length === 0) {
        return undefined;
      }

      const row = refs[0];

      if (row.target == null) {
        // Direct ref
        return {
          name: current,
          objectId: row.object_id || undefined,
          storage: (row.storage as RefStorage) || RefStorage.LOOSE,
          peeled: row.peeled_object_id != null,
          peeledObjectId: row.peeled_object_id || undefined,
        } as Ref;
      }

      // Follow symbolic ref
      current = row.target;
      depth++;
    }

    throw new Error(`Symbolic ref chain too deep (> ${MAX_SYMBOLIC_REF_DEPTH})`);
  }

  /**
   * Check if a ref exists.
   */
  async has(refName: string): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM vcs_ref WHERE name = ?",
      [refName],
    );
    return result[0].cnt > 0;
  }

  /**
   * List all refs matching a prefix.
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    const rows = prefix
      ? await this.db.query<RefRow>(
          "SELECT * FROM vcs_ref WHERE name >= ? AND name < ? ORDER BY name",
          [prefix, prefixUpperBound(prefix)],
        )
      : await this.db.query<RefRow>("SELECT * FROM vcs_ref ORDER BY name", []);
    for (const row of rows) yield rowToRef(row);
  }

  /**
   * Set a ref to point to an object ID; with a reflog line (`log`), as a one-ref batch
   * that logs it as git does (see {@link Refs.set}).
   */
  async set(refName: string, objectId: ObjectId, log?: RefLogOptions): Promise<void> {
    // a direct value is an object id, never a name (see isRefObjectId)
    if (!isRefObjectId(objectId)) {
      throw new Error(`cannot update ${refName}: ${refName}: invalid-object-id`);
    }
    // a name git's ref transaction refuses (check_refname_format, one level allowed)
    if (!isValidRefName(refName, { allowOneLevel: true })) {
      throw new Error(`cannot update ${refName}: ${refName}: invalid-name`);
    }
    if (log && isUpdatableRefName(refName)) {
      const r = await this.batch([{ name: refName, new: objectId, noDeref: true }], log);
      if (!r.ok) {
        throw new Error(
          `cannot update ${refName}: ${r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", ")}`,
        );
      }
      return;
    }
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         object_id = excluded.object_id,
         target = NULL,
         peeled_object_id = NULL,
         storage = excluded.storage,
         updated_at = excluded.updated_at`,
      [refName, objectId, RefStorage.LOOSE, now],
    );
  }

  /**
   * Set a symbolic ref; with a `log` message, `refName`'s reflog records it as git's
   * create_symref does (see {@link Refs.setSymbolic}), in the same transaction.
   */
  async setSymbolic(refName: string, target: string, log?: SymbolicRefLogOptions): Promise<void> {
    const write = (client: DatabaseClient) =>
      client.execute(
        `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
         VALUES (?, NULL, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           object_id = NULL,
           target = excluded.target,
           updated_at = excluded.updated_at`,
        [refName, target, RefStorage.LOOSE, Date.now()],
      );
    if (log?.message === undefined && !log?.reflog) {
      await write(this.db);
      return;
    }
    await this.db.transaction(async (tx) => {
      const old = await resolveId(tx, refName);
      await write(tx);
      await writeReflog(tx, symrefReflogWrites(refName, old, await resolveId(tx, target), log));
    });
  }

  /**
   * Remove a ref.
   */
  async remove(refName: string): Promise<boolean> {
    const result = await this.db.execute("DELETE FROM vcs_ref WHERE name = ?", [refName]);
    return result.changes > 0;
  }

  /**
   * Compare-and-swap update (for concurrent safety).
   */
  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const r = await this.batch([{ name: refName, old: expectedOld ?? null, new: newValue }]);
    if (r.ok) return { success: true, previousValue: expectedOld };
    return {
      success: false,
      previousValue: (await this.resolve(refName))?.objectId,
      errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
    };
  }

  /**
   * Initialize storage structure (no-op for SQL - handled by migrations).
   */
  async initialize(): Promise<void> {
    // Schema is created by migrations
  }

  /**
   * Perform implementation-specific optimizations.
   */
  async optimize(): Promise<void> {
    // Could run ANALYZE or VACUUM here if needed
    await this.db.execute("ANALYZE vcs_ref", []);
  }
}
