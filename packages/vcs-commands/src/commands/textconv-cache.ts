/**
 * The textconv cache (`diff.<driver>.cachetextconv`), as git's notes-cache.c keeps it: the
 * output of a driver's textconv command for a blob is a note on the blob in
 * `refs/notes/textconv/<driver>`, valid while the subject of the ref's commit is the
 * command (the cache's validity). Every entry added is committed at once (a parentless
 * commit whose message is the command, the ref's reflog saying `update notes cache`), as
 * `fill_textconv` writes the cache after each conversion.
 *
 * @example
 * ```typescript
 * const cache = await TextconvCache.open(ctx, "magic", "./helper");
 * const text = (await cache?.get(blobId)) ?? (await run());
 * await cache?.put(blobId, text);
 * ```
 */
import type { ObjectId } from "@statewalker/vcs-core";

import type { TextconvRequest, TextconvRunner } from "./diff-textconv.js";
import { initNotes, type NotesContext, type NotesHandle, updateNotesRef } from "./notes-support.js";
import { combineNotesOverwrite, readNoteBytes } from "./notes-tree.js";

/** pretty.c's `%s` of a message, trimmed: its first paragraph on one line. */
function subjectOf(message: string): string {
  const lines = message.replace(/^\n+/, "").split("\n");
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") break;
    paragraph.push(line);
  }
  return paragraph.join(" ").trim();
}

export class TextconvCache {
  /** Puts in progress, one after the other (each commits the tree as it then is) */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly ctx: NotesContext,
    private readonly notes: NotesHandle,
    private readonly validity: string,
  ) {}

  /**
   * notes_cache_init: the cache of `driver`, empty unless the ref's commit was written for
   * `validity`; undefined when the ref cannot hold a cache (git then caches nothing).
   */
  static async open(
    ctx: NotesContext,
    driver: string,
    validity: string,
  ): Promise<TextconvCache | undefined> {
    const ref = `refs/notes/textconv/${driver}`;
    try {
      const id = (await ctx.refs.resolve(ref).catch(() => undefined))?.objectId ?? undefined;
      const commit = id ? await ctx.commits.load(id).catch(() => undefined) : undefined;
      const valid = commit !== undefined && subjectOf(commit.message) === validity;
      const notes = await initNotes(ctx, ref, {
        combine: combineNotesOverwrite,
        writable: true,
        empty: !valid,
      });
      return new TextconvCache(ctx, notes, validity);
    } catch {
      return undefined;
    }
  }

  /** notes_cache_get: the output cached for `blob`, if any. */
  async get(blob: ObjectId): Promise<Uint8Array | undefined> {
    await this.queue;
    try {
      const note = await this.notes.tree.get(blob);
      return note ? await readNoteBytes(this.ctx.blobs, note) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * notes_cache_put and notes_cache_write: `output` noted for `blob` and committed; errors
   * are ignored, as git ignores them (a read-only repository).
   */
  put(blob: ObjectId, output: Uint8Array): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        const note = await this.ctx.blobs.store([output]);
        await this.notes.tree.add(blob, note, combineNotesOverwrite);
        if (!this.notes.tree.dirty || !this.notes.updateRef) return;
        const tree = await this.notes.tree.write();
        const commit = await this.ctx.commits.store({
          tree,
          parents: [],
          author: this.ctx.author(),
          committer: this.ctx.committer(),
          message: this.validity,
        });
        await updateNotesRef(this.ctx, this.notes.updateRef, commit, "update notes cache");
      } catch {
        // as git: the cache is best effort
      }
    });
    return this.queue;
  }
}

/**
 * diff.c's fill_textconv over the drivers' caches of one command (git's per-process
 * caches, by driver and command): the runner's output, read from and written to the
 * driver's notes cache when it asks for one (`diff.<driver>.cachetextconv`) and the
 * content has an object id git knows (a blob of a tree or the index, never a worktree
 * file's).
 *
 * @example
 * ```typescript
 * const caches = new TextconvCaches(() => this.notesContext());
 * const text = await caches.run(runner, request, blobId);
 * ```
 */
export class TextconvCaches {
  private readonly opened = new Map<string, Promise<TextconvCache | undefined>>();

  constructor(private readonly context: () => NotesContext) {}

  async run(
    runner: TextconvRunner,
    request: TextconvRequest,
    id: ObjectId | undefined,
  ): Promise<Uint8Array> {
    if (!request.cache || id === undefined) return runner(request);
    const key = `${request.driver}\0${request.command}`;
    let opened = this.opened.get(key);
    if (!opened) {
      opened = TextconvCache.open(this.context(), request.driver, request.command);
      this.opened.set(key, opened);
    }
    const cache = await opened;
    const cached = await cache?.get(id);
    if (cached) return cached;
    const output = await runner(request);
    await cache?.put(id, output);
    return output;
  }
}
