/**
 * SQL-based Staging implementation
 *
 * Stores staging area entries in a SQL database.
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type {
  IndexBuilder,
  IndexEdit,
  IndexEditor,
  MergeStageValue,
  ReadTreeOptions,
  Staging,
  StagingEntry,
  StagingEntryOptions,
} from "@statewalker/vcs-working-tree";
import {
  EntriesAsRead,
  keepMatchingEntries,
  keepMatchingMode,
  MergeStage,
  type RacyCheck,
  RemoveStagingStages,
  smudgeRacilyClean,
  verifyTreePaths,
} from "@statewalker/vcs-working-tree";
import type { DatabaseClient } from "./database-client.js";
import { fromSqlPath, toSqlPath } from "./sql-path.js";

/**
 * Database row type for staging entry queries
 */
interface StagingRow {
  path: string;
  stage: number;
  mode: number;
  object_id: string;
  size: number;
  mtime: number;
  ctime: number | null;
  dev: number | null;
  ino: number | null;
  assume_valid: number;
  intent_to_add: number;
  skip_worktree: number;
}

/**
 * Convert database row to StagingEntry
 */
function rowToEntry(row: StagingRow): StagingEntry {
  return {
    path: fromSqlPath(row.path),
    mode: row.mode,
    objectId: row.object_id,
    stage: row.stage as MergeStageValue,
    size: row.size,
    mtime: row.mtime,
    ctime: row.ctime ?? undefined,
    dev: row.dev ?? undefined,
    ino: row.ino ?? undefined,
    assumeValid: row.assume_valid === 1,
    intentToAdd: row.intent_to_add === 1,
    skipWorktree: row.skip_worktree === 1,
  };
}

/**
 * The entries of rows in git's order of (path, stage): `ORDER BY path` is that order, but
 * for a path stored escaped (`toSqlPath`).
 */
function rowsToSortedEntries(rows: StagingRow[]): StagingEntry[] {
  const entries = rows.map(rowToEntry);
  return entries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
}

/**
 * SQL-based Staging implementation.
 */
export class SQLStaging implements Staging {
  private updateTime: number = Date.now();
  private racyCheck?: RacyCheck;
  /** The entries as last read or written: only these are checked for smudging */
  private readonly asRead = new EntriesAsRead();

  constructor(private db: DatabaseClient) {}

  // ============ Reading Operations ============

  async getEntry(path: string, stage?: MergeStageValue): Promise<StagingEntry | undefined> {
    const actualStage = stage ?? MergeStage.MERGED;
    return this.getEntryByStage(path, actualStage);
  }

  async getEntryByStage(path: string, stage: MergeStageValue): Promise<StagingEntry | undefined> {
    const rows = await this.db.query<StagingRow>(
      "SELECT * FROM staging_entry WHERE path = ? AND stage = ?",
      [toSqlPath(path), stage],
    );

    return rows.length > 0 ? rowToEntry(rows[0]) : undefined;
  }

  async getEntries(path: string): Promise<StagingEntry[]> {
    const rows = await this.db.query<StagingRow>(
      "SELECT * FROM staging_entry WHERE path = ? ORDER BY stage",
      [toSqlPath(path)],
    );

    return rows.map(rowToEntry);
  }

  async hasEntry(path: string): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM staging_entry WHERE path = ?",
      [toSqlPath(path)],
    );
    return result[0].cnt > 0;
  }

  async getEntryCount(): Promise<number> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM staging_entry",
      [],
    );
    return result[0].cnt;
  }

  async *listEntries(): AsyncIterable<StagingEntry> {
    const rows = await this.db.query<StagingRow>(
      "SELECT * FROM staging_entry ORDER BY path, stage",
      [],
    );

    for (const entry of rowsToSortedEntries(rows)) {
      yield entry;
    }
  }

  async *listEntriesUnder(prefix: string): AsyncIterable<StagingEntry> {
    const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

    // the paths under `dir/` are the range ["dir/", "dir0"): "0" follows "/", and TEXT
    // compares bytes (BINARY), case-sensitive and with no wildcard, where LIKE would fold
    // ASCII case and take `_` and `%` for wildcards. The stored form of a path starts with
    // the stored form of `dir/` (toSqlPath keeps prefixes).
    const stored = toSqlPath(dir);
    const rows = await this.db.query<StagingRow>(
      "SELECT * FROM staging_entry WHERE path = ? OR (path >= ? AND path < ?) ORDER BY path, stage",
      [toSqlPath(prefix), `${stored}/`, `${stored}0`],
    );

    for (const entry of rowsToSortedEntries(rows)) {
      yield entry;
    }
  }

  async hasConflicts(): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM staging_entry WHERE stage > 0",
      [],
    );
    return result[0].cnt > 0;
  }

  async *getConflictPaths(): AsyncIterable<string> {
    const rows = await this.db.query<{ path: string }>(
      "SELECT DISTINCT path FROM staging_entry WHERE stage > 0 ORDER BY path",
      [],
    );

    for (const path of rows.map((row) => fromSqlPath(row.path)).sort(comparePaths)) {
      yield path;
    }
  }

  async setEntry(entry: StagingEntryOptions): Promise<void> {
    const editor = this.createEditor();
    editor.upsert(entry);
    await editor.finish();
  }

  async removeEntry(path: string, stage?: MergeStageValue): Promise<boolean> {
    const editor = this.createEditor();
    if (stage === undefined) {
      // Remove all stages for this path
      const hadEntry = await this.hasEntry(path);
      editor.remove(path);
      await editor.finish();
      return hadEntry;
    } else {
      // Remove specific stage
      const hadEntry = (await this.getEntry(path, stage)) !== undefined;
      editor.remove(path, stage);
      await editor.finish();
      return hadEntry;
    }
  }

  async *entries(options?: {
    prefix?: string;
    stages?: MergeStageValue[];
  }): AsyncIterable<StagingEntry> {
    const prefix = options?.prefix;
    const stages = options?.stages;

    for await (const entry of this.listEntries()) {
      // Filter by prefix if specified
      if (prefix) {
        const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
        if (!entry.path.startsWith(normalizedPrefix) && entry.path !== prefix) {
          continue;
        }
      }

      // Filter by stages if specified
      if (stages && !stages.includes(entry.stage)) {
        continue;
      }

      yield entry;
    }
  }

  async getConflictedPaths(): Promise<string[]> {
    const rows = await this.db.query<{ path: string }>(
      "SELECT DISTINCT path FROM staging_entry WHERE stage > 0 ORDER BY path",
      [],
    );
    return rows.map((row) => fromSqlPath(row.path)).sort(comparePaths);
  }

  async resolveConflict(
    path: string,
    resolution: "ours" | "theirs" | "base" | StagingEntry,
  ): Promise<void> {
    const editor = this.createEditor();

    if (typeof resolution === "string") {
      // Resolution is a stage name
      let stage: MergeStageValue;
      switch (resolution) {
        case "base":
          stage = MergeStage.BASE;
          break;
        case "ours":
          stage = MergeStage.OURS;
          break;
        case "theirs":
          stage = MergeStage.THEIRS;
          break;
        default:
          throw new Error(`Invalid resolution: ${resolution}`);
      }

      // Find entry at the specified stage
      const entry = await this.getEntry(path, stage);
      if (!entry) {
        throw new Error(`No entry at stage ${stage} for path: ${path}`);
      }

      // Create stage 0 entry from chosen stage
      editor.upsert({
        ...entry,
        stage: MergeStage.MERGED,
      });
    } else {
      // Resolution is a complete entry
      editor.upsert({
        ...resolution,
        stage: MergeStage.MERGED,
      });
    }

    await editor.finish();
  }

  // ============ Writing Operations ============

  createBuilder(): IndexBuilder {
    return new SQLIndexBuilder(this.db, this);
  }

  createEditor(): IndexEditor {
    return new SQLIndexEditor(this.db, this);
  }

  async clear(): Promise<void> {
    await this.db.execute("DELETE FROM staging_entry", []);
    this.updateTime = Date.now();
  }

  // ============ Tree Operations ============

  async writeTree(trees: Trees): Promise<ObjectId> {
    if (await this.hasConflicts()) {
      throw new Error("Cannot write tree with unresolved conflicts");
    }

    const entries: StagingEntry[] = [];
    for await (const entry of this.listEntries()) {
      // an intent-to-add entry is no part of the tree (git's update_one skips it)
      if (entry.stage === MergeStage.MERGED && !entry.intentToAdd) {
        entries.push(entry);
      }
    }

    // never a tree with two entries of one name (git's verify_cache)
    verifyTreePaths(entries);
    return this.buildTreeRecursive(trees, entries, "");
  }

  private async buildTreeRecursive(
    trees: Trees,
    entries: StagingEntry[],
    prefix: string,
  ): Promise<ObjectId> {
    const treeEntries: TreeEntry[] = [];
    const subdirs = new Map<string, StagingEntry[]>();

    for (const entry of entries) {
      const relativePath = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
      const slashIndex = relativePath.indexOf("/");

      if (slashIndex < 0) {
        treeEntries.push({
          name: relativePath,
          mode: entry.mode,
          id: entry.objectId,
        });
      } else {
        const dirName = relativePath.slice(0, slashIndex);
        if (!subdirs.has(dirName)) {
          subdirs.set(dirName, []);
        }
        subdirs.get(dirName)?.push(entry);
      }
    }

    for (const [dirName, dirEntries] of subdirs) {
      const subPrefix = prefix ? `${prefix}/${dirName}` : dirName;
      const subtreeId = await this.buildTreeRecursive(trees, dirEntries, subPrefix);
      treeEntries.push({
        name: dirName,
        mode: FileMode.TREE,
        id: subtreeId,
      });
    }

    return trees.store(treeEntries);
  }

  async readTree(trees: Trees, treeId: ObjectId, options?: ReadTreeOptions): Promise<void> {
    const before: StagingEntry[] = [];
    if (options?.keepMatching) for await (const e of this.entries()) before.push(e);
    await this.readTreeEntries(trees, treeId, options);
    if (before.length === 0) return;
    // unpack-trees' one-way merge: unchanged entries keep their flags and stat data
    const read: StagingEntry[] = [];
    for await (const e of this.entries()) read.push(e);
    const kept = keepMatchingEntries(before, read, keepMatchingMode(options));
    for (let i = 0; i < kept.length; i++) if (kept[i] !== read[i]) await this.setEntry(kept[i]);
  }

  private async readTreeEntries(
    trees: Trees,
    treeId: ObjectId,
    options?: ReadTreeOptions,
  ): Promise<void> {
    if (!options?.keepExisting) {
      await this.clear();
    }

    const prefix = options?.prefix ?? "";
    const stage = options?.stage ?? MergeStage.MERGED;

    await this.addTreeRecursive(trees, treeId, prefix, stage);
    this.updateTime = Date.now();
  }

  private async addTreeRecursive(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue,
  ): Promise<void> {
    const treeIter = await trees.load(treeId);
    if (!treeIter) throw new Error("Tree not found");
    for await (const entry of treeIter) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.addTreeRecursive(trees, entry.id, path, stage);
      } else {
        await this.db.execute(
          `INSERT INTO staging_entry (path, stage, mode, object_id, size, mtime)
           VALUES (?, ?, ?, ?, 0, 0)`,
          [toSqlPath(path), stage, entry.mode, entry.id],
        );
      }
    }
  }

  // ============ Persistence ============

  async read(): Promise<void> {
    // the time of the last write, stored with the entries (git: the index file's mtime)
    this.updateTime = (await this.storedUpdateTime()) ?? Date.now();
    await this.rememberEntries();
  }

  async write(): Promise<void> {
    // the entries are stored as they are edited; a write smudges racily clean ones (git)
    const entries: StagingEntry[] = [];
    for await (const entry of this.listEntries()) entries.push(entry);
    const smudged = await this._smudge(entries);
    for (let i = 0; i < smudged.length; i++) {
      if (smudged[i] === entries[i]) continue;
      await this.db.execute("UPDATE staging_entry SET size = 0 WHERE path = ? AND stage = ?", [
        toSqlPath(smudged[i].path),
        smudged[i].stage,
      ]);
    }
    await this.rememberEntries(smudged);
    await this._written();
  }

  async isOutdated(): Promise<boolean> {
    return false; // SQL is always up-to-date
  }

  getUpdateTime(): number {
    return this.updateTime;
  }

  /** @internal - Used by builder */
  _setUpdateTime(time: number): void {
    this.updateTime = time;
  }

  /**
   * Sets the check every write applies to racily clean entries (git's smudging): an entry
   * kept from before the write, whose mtime second is not older than the last write and
   * whose content changed behind a matching stat, is stored with size 0.
   */
  setRacyCheck(check: RacyCheck | undefined): void {
    this.racyCheck = check;
  }

  /**
   * @internal - Used by builder/editor: `entries`, smudged where racily clean and changed
   * if they are as the store was last read or written.
   */
  async _smudge(entries: StagingEntry[]): Promise<StagingEntry[]> {
    return smudgeRacilyClean(entries, this.updateTime, this.racyCheck, (e) => this.asRead.has(e));
  }

  /** Remembers the entries as they are now (after a read or an explicit write). */
  private async rememberEntries(entries?: StagingEntry[]): Promise<void> {
    const list = entries ?? [];
    if (!entries) for await (const entry of this.listEntries()) list.push(entry);
    this.asRead.remember(list);
  }

  /**
   * @internal - Used by builder/editor: records the time of this write with the entries
   * (in `staging_meta`; a database without that table keeps it in memory only).
   */
  async _written(): Promise<void> {
    this.updateTime = Date.now();
    try {
      await this.db.execute(
        "INSERT OR REPLACE INTO staging_meta (name, value) VALUES ('update_time', ?)",
        [this.updateTime],
      );
    } catch {
      // no staging_meta table (a schema older than its migration)
    }
  }

  /** The time of the last write, as stored; undefined when none was. */
  private async storedUpdateTime(): Promise<number | undefined> {
    try {
      const rows = await this.db.query<{ value: number }>(
        "SELECT value FROM staging_meta WHERE name = 'update_time'",
        [],
      );
      const time = Number(rows[0]?.value);
      return rows.length > 0 && Number.isFinite(time) ? time : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Builder for bulk staging area modifications.
 */
class SQLIndexBuilder implements IndexBuilder {
  private entries: StagingEntry[] = [];
  private keeping: Array<{ start: number; count: number }> = [];

  constructor(
    private readonly db: DatabaseClient,
    private readonly store: SQLStaging,
  ) {}

  add(options: StagingEntryOptions): void {
    if (!options.mode) {
      throw new Error(`FileMode not set for path ${options.path}`);
    }

    const entry: StagingEntry = {
      path: options.path,
      mode: options.mode,
      objectId: options.objectId,
      stage: options.stage ?? MergeStage.MERGED,
      size: options.size ?? 0,
      mtime: options.mtime ?? Date.now(),
      ctime: options.ctime,
      dev: options.dev,
      ino: options.ino,
      mtimeNs: options.mtimeNs,
      ctimeNs: options.ctimeNs,
      uid: options.uid,
      gid: options.gid,
      assumeValid: options.assumeValid,
      intentToAdd: options.intentToAdd,
      skipWorktree: options.skipWorktree,
    };

    this.entries.push(entry);
  }

  keep(startIndex: number, count: number): void {
    this.keeping.push({ start: startIndex, count });
  }

  async addTree(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue = MergeStage.MERGED,
  ): Promise<void> {
    await this.addTreeRecursive(trees, treeId, prefix, stage);
  }

  private async addTreeRecursive(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue,
  ): Promise<void> {
    const treeIter = await trees.load(treeId);
    if (!treeIter) throw new Error("Tree not found");
    for await (const entry of treeIter) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.addTreeRecursive(trees, entry.id, path, stage);
      } else {
        this.add({
          path,
          mode: entry.mode,
          objectId: entry.id,
          stage,
        });
      }
    }
  }

  async finish(): Promise<void> {
    // Get existing entries for keeping
    if (this.keeping.length > 0) {
      const existingRows = await this.db.query<StagingRow>(
        "SELECT * FROM staging_entry ORDER BY path, stage",
        [],
      );
      const existingEntries = rowsToSortedEntries(existingRows);

      for (const { start, count } of this.keeping) {
        for (let i = 0; i < count; i++) {
          if (start + i < existingEntries.length) {
            this.entries.push(existingEntries[start + i]);
          }
        }
      }
    }

    // Sort entries by (path, stage)
    this.entries.sort((a, b) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });

    // Check for duplicates
    for (let i = 1; i < this.entries.length; i++) {
      const prev = this.entries[i - 1];
      const curr = this.entries[i];
      if (prev.path === curr.path && prev.stage === curr.stage) {
        throw new Error(`Duplicate entry: ${curr.path} stage ${curr.stage}`);
      }
    }

    // Validate stage constraints
    this.validateStages();

    // entries kept from before this write are smudged when racily clean (git)
    this.entries = await this.store._smudge(this.entries);

    // Replace all entries in a transaction
    await this.db.transaction(async (tx) => {
      await tx.execute("DELETE FROM staging_entry", []);

      for (const entry of this.entries) {
        await tx.execute(
          `INSERT INTO staging_entry (
            path, stage, mode, object_id, size, mtime,
            ctime, dev, ino, assume_valid, intent_to_add, skip_worktree
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toSqlPath(entry.path),
            entry.stage,
            entry.mode,
            entry.objectId,
            entry.size,
            entry.mtime,
            entry.ctime ?? null,
            entry.dev ?? null,
            entry.ino ?? null,
            entry.assumeValid ? 1 : 0,
            entry.intentToAdd ? 1 : 0,
            entry.skipWorktree ? 1 : 0,
          ],
        );
      }
    });

    await this.store._written();
  }

  private validateStages(): void {
    const pathStages = new Map<string, Set<MergeStageValue>>();

    for (const entry of this.entries) {
      if (!pathStages.has(entry.path)) {
        pathStages.set(entry.path, new Set());
      }
      pathStages.get(entry.path)?.add(entry.stage);
    }

    for (const [path, stages] of pathStages) {
      if (stages.has(MergeStage.MERGED) && stages.size > 1) {
        throw new Error(`Invalid stages for ${path}: stage 0 cannot coexist with other stages`);
      }
    }
  }
}

/**
 * Editor for targeted staging area modifications.
 */
class SQLIndexEditor implements IndexEditor {
  private edits: IndexEdit[] = [];

  constructor(
    private readonly db: DatabaseClient,
    private readonly store: SQLStaging,
  ) {}

  add(edit: IndexEdit): void {
    this.edits.push(edit);
  }

  remove(path: string, stage?: MergeStageValue): void {
    // every stage of the path, or only the one given
    this.edits.push(new RemoveStagingStages(path, stage));
  }

  upsert(entry: StagingEntryOptions): void {
    this.edits.push({
      path: entry.path,
      apply: () => ({
        ...entry,
        stage: entry.stage ?? MergeStage.MERGED,
        size: entry.size ?? 0,
        mtime: entry.mtime ?? Date.now(),
      }),
    });
  }

  async finish(): Promise<void> {
    // Sort edits by path
    this.edits.sort((a, b) => comparePaths(a.path, b.path));

    // Get existing entries
    const existingRows = await this.db.query<StagingRow>(
      "SELECT * FROM staging_entry ORDER BY path, stage",
      [],
    );
    const existingEntries = rowsToSortedEntries(existingRows);

    const newEntries: StagingEntry[] = [];

    let entryIndex = 0;
    let editIndex = 0;

    while (entryIndex < existingEntries.length || editIndex < this.edits.length) {
      const entry = existingEntries[entryIndex];
      const edit = this.edits[editIndex];

      if (!edit) {
        newEntries.push(entry);
        entryIndex++;
      } else if (!entry) {
        const result = edit.apply(undefined);
        if (result) newEntries.push(result);
        editIndex++;
      } else {
        const cmp = comparePaths(entry.path, edit.path);

        if (cmp < 0) {
          // Check for tree deletion
          if (isDeleteTree(edit) && entry.path.startsWith(`${edit.path}/`)) {
            entryIndex++;
          } else {
            newEntries.push(entry);
            entryIndex++;
          }
        } else if (cmp > 0) {
          const result = edit.apply(undefined);
          if (result) newEntries.push(result);
          editIndex++;
        } else {
          if (edit instanceof RemoveStagingStages) {
            // the path's stages but the removed ones
            while (
              entryIndex < existingEntries.length &&
              existingEntries[entryIndex].path === edit.path
            ) {
              if (edit.keeps(existingEntries[entryIndex])) {
                newEntries.push(existingEntries[entryIndex]);
              }
              entryIndex++;
            }
          } else if (isResolveConflict(edit)) {
            this.applyConflictResolution(existingEntries, entryIndex, edit, newEntries);
            while (
              entryIndex < existingEntries.length &&
              existingEntries[entryIndex].path === edit.path
            ) {
              entryIndex++;
            }
          } else {
            const result = edit.apply(entry);
            if (result) newEntries.push(result);
            entryIndex++;
          }
          editIndex++;
        }
      }
    }

    // entries kept from before this write are smudged when racily clean (git)
    const written = await this.store._smudge(newEntries);

    // Replace all entries in a transaction
    await this.db.transaction(async (tx) => {
      await tx.execute("DELETE FROM staging_entry", []);

      for (const entry of written) {
        await tx.execute(
          `INSERT INTO staging_entry (
            path, stage, mode, object_id, size, mtime,
            ctime, dev, ino, assume_valid, intent_to_add, skip_worktree
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toSqlPath(entry.path),
            entry.stage,
            entry.mode,
            entry.objectId,
            entry.size,
            entry.mtime,
            entry.ctime ?? null,
            entry.dev ?? null,
            entry.ino ?? null,
            entry.assumeValid ? 1 : 0,
            entry.intentToAdd ? 1 : 0,
            entry.skipWorktree ? 1 : 0,
          ],
        );
      }
    });

    await this.store._written();
  }

  private applyConflictResolution(
    entries: StagingEntry[],
    startIndex: number,
    edit: IndexEdit & { chooseStage?: MergeStageValue },
    output: StagingEntry[],
  ): void {
    let chosen: StagingEntry | undefined;
    let i = startIndex;

    while (i < entries.length && entries[i].path === edit.path) {
      if (edit.chooseStage !== undefined && entries[i].stage === edit.chooseStage) {
        chosen = entries[i];
      }
      i++;
    }

    if (chosen) {
      output.push({
        ...chosen,
        stage: MergeStage.MERGED,
      });
    }
  }
}

/**
 * Compare paths using Git's canonical ordering.
 */
function comparePaths(a: string, b: string): number {
  // the order of the paths' bytes (git's), an escaped byte of a non-UTF-8 name included
  return compareGitPaths(a, b);
}

/**
 * Type guard for DeleteStagingTree edit.
 */
function isDeleteTree(edit: IndexEdit): edit is IndexEdit & { path: string } {
  return edit.constructor.name === "DeleteStagingTree";
}

/**
 * Type guard for ResolveStagingConflict edit.
 */
function isResolveConflict(edit: IndexEdit): edit is IndexEdit & { chooseStage: MergeStageValue } {
  return "chooseStage" in edit;
}
