/**
 * KV-based Staging implementation
 *
 * Stores staging area entries using a key-value backend with JSON serialization.
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type {
  IndexBuilder,
  IndexEditor,
  MergeStageValue,
  ReadTreeOptions,
  Staging,
  StagingEdit,
  StagingEntry,
  StagingEntryOptions,
} from "@statewalker/vcs-working-tree";
import {
  EntriesAsRead,
  MergeStage,
  type RacyCheck,
  smudgeRacilyClean,
} from "@statewalker/vcs-working-tree";
import type { KVStore } from "./kv-store.js";

/**
 * Key prefix for staging entries
 */
const STAGING_PREFIX = "staging:";

/**
 * Metadata key for staging state
 */
const STAGING_META_KEY = "staging:__meta__";

/**
 * Serialized staging entry format
 */
interface SerializedEntry {
  p: string; // path
  s: number; // stage
  m: number; // mode
  o: string; // objectId
  sz: number; // size
  mt: number; // mtime
  ct?: number; // ctime
  dv?: number; // dev
  in?: number; // ino
  av?: boolean; // assumeValid
  ia?: boolean; // intentToAdd
  sw?: boolean; // skipWorktree
}

/**
 * Text encoder/decoder for JSON serialization
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Generate staging entry key
 */
function entryKey(path: string, stage: number): string {
  // Pad stage to ensure proper sorting
  return `${STAGING_PREFIX}${path}\0${stage}`;
}

/**
 * Compare paths using Git's canonical ordering.
 */
function comparePaths(a: string, b: string): number {
  // the order of the paths' bytes (git's), an escaped byte of a non-UTF-8 name included
  return compareGitPaths(a, b);
}

/**
 * KV-based Staging implementation.
 */
export class KVStaging implements Staging {
  private updateTime: number = Date.now();
  private racyCheck?: RacyCheck;
  /** The entries as last read or written: only these are checked for smudging */
  private readonly asRead = new EntriesAsRead();

  constructor(private kv: KVStore) {}

  // ============ Reading Operations ============

  async getEntry(path: string, stage?: MergeStageValue): Promise<StagingEntry | undefined> {
    const actualStage = stage ?? MergeStage.MERGED;
    return this.getEntryByStage(path, actualStage);
  }

  async getEntryByStage(path: string, stage: MergeStageValue): Promise<StagingEntry | undefined> {
    const data = await this.kv.get(entryKey(path, stage));
    if (!data) {
      return undefined;
    }

    const s: SerializedEntry = JSON.parse(decoder.decode(data));
    return deserializeEntry(s);
  }

  async getEntries(path: string): Promise<StagingEntry[]> {
    const result: StagingEntry[] = [];
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      const entry = await this.getEntryByStage(path, stage);
      if (entry) result.push(entry);
    }
    return result;
  }

  async hasEntry(path: string): Promise<boolean> {
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      if (await this.kv.has(entryKey(path, stage))) {
        return true;
      }
    }
    return false;
  }

  async getEntryCount(): Promise<number> {
    let count = 0;
    for await (const _ of this.kv.list(STAGING_PREFIX)) {
      if (!_.endsWith("__meta__")) {
        count++;
      }
    }
    return count;
  }

  async *listEntries(): AsyncIterable<StagingEntry> {
    const entries: StagingEntry[] = [];

    for await (const key of this.kv.list(STAGING_PREFIX)) {
      if (key === STAGING_META_KEY) continue;

      const data = await this.kv.get(key);
      if (data) {
        const s: SerializedEntry = JSON.parse(decoder.decode(data));
        entries.push(deserializeEntry(s));
      }
    }

    // Sort by (path, stage)
    entries.sort((a, b) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });

    for (const entry of entries) {
      yield entry;
    }
  }

  async *listEntriesUnder(prefix: string): AsyncIterable<StagingEntry> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

    for await (const entry of this.listEntries()) {
      if (entry.path.startsWith(normalizedPrefix) || entry.path === prefix) {
        yield entry;
      }
    }
  }

  async hasConflicts(): Promise<boolean> {
    for await (const key of this.kv.list(STAGING_PREFIX)) {
      if (key === STAGING_META_KEY) continue;

      const data = await this.kv.get(key);
      if (data) {
        const s: SerializedEntry = JSON.parse(decoder.decode(data));
        if (s.s !== MergeStage.MERGED) {
          return true;
        }
      }
    }
    return false;
  }

  async *getConflictPaths(): AsyncIterable<string> {
    const seen = new Set<string>();

    for await (const entry of this.listEntries()) {
      if (entry.stage !== MergeStage.MERGED && !seen.has(entry.path)) {
        seen.add(entry.path);
        yield entry.path;
      }
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
      editor.remove(path);
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
    const paths: string[] = [];
    const seen = new Set<string>();
    for await (const entry of this.listEntries()) {
      if (entry.stage !== MergeStage.MERGED && !seen.has(entry.path)) {
        seen.add(entry.path);
        paths.push(entry.path);
      }
    }
    return paths;
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
    return new KVIndexBuilder(this.kv, this);
  }

  createEditor(): IndexEditor {
    return new KVIndexEditor(this.kv, this);
  }

  async clear(): Promise<void> {
    const keys: string[] = [];
    for await (const key of this.kv.list(STAGING_PREFIX)) {
      keys.push(key);
    }

    for (const key of keys) {
      await this.kv.delete(key);
    }

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
      if (entry.stage === MergeStage.MERGED && !(entry.intentToAdd && !entry.skipWorktree)) {
        entries.push(entry);
      }
    }

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
    const treeEntries = await trees.load(treeId);
    if (!treeEntries) return;
    for await (const entry of treeEntries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.addTreeRecursive(trees, entry.id, path, stage);
      } else {
        const serialized: SerializedEntry = {
          p: path,
          s: stage,
          m: entry.mode,
          o: entry.id,
          sz: 0,
          mt: 0,
        };
        await this.kv.set(entryKey(path, stage), encoder.encode(JSON.stringify(serialized)));
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
      await this.kv.set(
        entryKey(smudged[i].path, smudged[i].stage),
        encoder.encode(JSON.stringify(serializeEntry(smudged[i]))),
      );
    }
    await this.rememberEntries(smudged);
    await this._written();
  }

  async isOutdated(): Promise<boolean> {
    return false; // KV is always up-to-date
  }

  getUpdateTime(): number {
    return this.updateTime;
  }

  /** @internal */
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

  /** @internal - Used by builder/editor: records the time of this write with the entries. */
  async _written(): Promise<void> {
    this.updateTime = Date.now();
    await this.kv.set(
      STAGING_META_KEY,
      encoder.encode(JSON.stringify({ updateTime: this.updateTime })),
    );
  }

  /** The time of the last write, as stored; undefined when none was. */
  private async storedUpdateTime(): Promise<number | undefined> {
    const data = await this.kv.get(STAGING_META_KEY);
    if (!data) return undefined;
    try {
      const time = JSON.parse(decoder.decode(data))?.updateTime;
      return typeof time === "number" && Number.isFinite(time) ? time : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Deserialize staging entry
 */
function deserializeEntry(s: SerializedEntry): StagingEntry {
  return {
    path: s.p,
    stage: s.s as MergeStageValue,
    mode: s.m,
    objectId: s.o,
    size: s.sz,
    mtime: s.mt,
    ctime: s.ct,
    dev: s.dv,
    ino: s.in,
    assumeValid: s.av,
    intentToAdd: s.ia,
    skipWorktree: s.sw,
  };
}

/**
 * Serialize staging entry
 */
function serializeEntry(entry: StagingEntry): SerializedEntry {
  return {
    p: entry.path,
    s: entry.stage,
    m: entry.mode,
    o: entry.objectId,
    sz: entry.size,
    mt: entry.mtime,
    ct: entry.ctime,
    dv: entry.dev,
    in: entry.ino,
    av: entry.assumeValid,
    ia: entry.intentToAdd,
    sw: entry.skipWorktree,
  };
}

/**
 * Builder for bulk staging area modifications.
 */
class KVIndexBuilder implements IndexBuilder {
  private entries: StagingEntry[] = [];
  private keeping: Array<{ start: number; count: number }> = [];

  constructor(
    private readonly kv: KVStore,
    private readonly store: KVStaging,
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
    const treeEntries = await trees.load(treeId);
    if (!treeEntries) return;
    for await (const entry of treeEntries) {
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
      const existingEntries: StagingEntry[] = [];
      for await (const entry of this.store.listEntries()) {
        existingEntries.push(entry);
      }

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

    // Clear and rewrite all entries
    await this.store.clear();

    for (const entry of this.entries) {
      const serialized = serializeEntry(entry);
      await this.kv.set(
        entryKey(entry.path, entry.stage),
        encoder.encode(JSON.stringify(serialized)),
      );
    }

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
class KVIndexEditor implements IndexEditor {
  private edits: StagingEdit[] = [];

  constructor(
    private readonly kv: KVStore,
    private readonly store: KVStaging,
  ) {}

  add(edit: StagingEdit): void {
    this.edits.push(edit);
  }

  remove(path: string, _stage?: MergeStageValue): void {
    // For now, remove all stages (ignore stage parameter)
    // TODO: Implement stage-specific removal if needed
    this.edits.push({ path, apply: () => undefined });
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
    const existingEntries: StagingEntry[] = [];
    for await (const entry of this.store.listEntries()) {
      existingEntries.push(entry);
    }

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
          if (isResolveConflict(edit)) {
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

    // Clear and rewrite all entries
    await this.store.clear();

    for (const entry of written) {
      const serialized = serializeEntry(entry);
      await this.kv.set(
        entryKey(entry.path, entry.stage),
        encoder.encode(JSON.stringify(serialized)),
      );
    }

    await this.store._written();
  }

  private applyConflictResolution(
    entries: StagingEntry[],
    startIndex: number,
    edit: StagingEdit & { chooseStage?: MergeStageValue },
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
 * Type guard for DeleteStagingTree edit.
 */
function isDeleteTree(edit: StagingEdit): edit is StagingEdit & { path: string } {
  return edit.constructor.name === "DeleteStagingTree";
}

/**
 * Type guard for ResolveStagingConflict edit.
 */
function isResolveConflict(
  edit: StagingEdit,
): edit is StagingEdit & { chooseStage: MergeStageValue } {
  return "chooseStage" in edit;
}
