import type { ObjectId } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { collectChunks } from "@statewalker/vcs-working-tree";
import type { CommandRefs } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type NotesResult, NotesSubcommand } from "./notes-command.js";
import {
  createNotesCommit,
  expandLooseNotesRef,
  initNotes,
  type NotesContext,
  NotesError,
  readRef,
  updateNotesRef,
} from "./notes-support.js";
import {
  type CombineNotes,
  combineNotesCatSortUniq,
  combineNotesConcatenate,
  combineNotesOverwrite,
  NOTES_NULL_ID,
  type NotesTree,
  readNoteBytes,
} from "./notes-tree.js";

/** How `git notes merge` resolves a note changed on both sides (`-s`). */
export type NotesMergeStrategy = "manual" | "ours" | "theirs" | "union" | "cat_sort_uniq";

const STRATEGIES: readonly NotesMergeStrategy[] = [
  "manual",
  "ours",
  "theirs",
  "union",
  "cat_sort_uniq",
];

const WORKTREE = "NOTES_MERGE_WORKTREE";
/** notes-merge.c's `uninitialized`: no local change recorded */
const UNINITIALIZED = "f".repeat(40);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** `git notes merge` (with `--commit` / `--abort`). */
export interface NotesMergeResult extends NotesResult {
  /** The notes merged into the notes ref; false with conflicts left in NOTES_MERGE_WORKTREE */
  merged: boolean;
  /** The commit the notes ref (or NOTES_MERGE_PARTIAL) now holds */
  commit?: ObjectId;
  /** The objects whose notes conflict (left in NOTES_MERGE_WORKTREE/<id>) */
  conflicts: ObjectId[];
}

interface MergePair {
  obj: ObjectId;
  base: ObjectId;
  local: ObjectId;
  remote: ObjectId;
}

/**
 * `git notes merge [-s <strategy>] <notes-ref>`: the notes of another notes ref merged into
 * the notes ref used (a fast-forward when one contains the other; else a merge commit
 * `Merged notes from <ref> into <ref>` whose parents are the two). A note changed on both
 * sides is resolved by the strategy (`-s`, else `notes.<name>.mergeStrategy`, else
 * `notes.mergeStrategy`, else `manual`): `ours`, `theirs`, `union` (concatenated),
 * `cat_sort_uniq` (lines sorted, unique) or, with `manual`, left with conflict markers in
 * `.git/NOTES_MERGE_WORKTREE/<object>`: the partial result in NOTES_MERGE_PARTIAL, the
 * notes ref in NOTES_MERGE_REF, until `--commit` (the files there taken as the notes) or
 * `--abort`.
 *
 * @example
 * ```typescript
 * const r = await git.notes().merge().setRemoteRef("other").setStrategy("union").call();
 * ```
 */
export class NotesMergeCommand extends NotesSubcommand<NotesMergeResult> {
  private remoteRef?: string;
  private strategy?: string;
  private doCommit = false;
  private doAbort = false;
  private verbosity = 2;

  /** The notes ref merged (`x` is `refs/notes/x` unless `x` resolves as it is). */
  setRemoteRef(ref: string): this {
    this.checkCallable();
    this.remoteRef = ref;
    return this;
  }

  /** `-s <strategy>` */
  setStrategy(strategy: NotesMergeStrategy | string): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /** `--commit`: the merge left in NOTES_MERGE_WORKTREE concluded. */
  setCommit(commit: boolean): this {
    this.checkCallable();
    this.doCommit = commit;
    return this;
  }

  /** `--abort`: the merge left in NOTES_MERGE_WORKTREE dropped. */
  setAbort(abort: boolean): this {
    this.checkCallable();
    this.doAbort = abort;
    return this;
  }

  /** git's verbosity: 2 by default, each `-v` one more, each `-q` one less. */
  setVerbosity(level: number): this {
    this.checkCallable();
    this.verbosity = level;
    return this;
  }

  protected async execute(): Promise<NotesMergeResult> {
    await this.resolveGitDir();
    const doMerge = this.strategy !== undefined || (!this.doCommit && !this.doAbort);
    if (Number(doMerge) + Number(this.doCommit) + Number(this.doAbort) !== 1) {
      throw new NotesError("cannot mix --commit, --abort or -s/--strategy");
    }
    if (doMerge && this.remoteRef === undefined) {
      throw new NotesError("must specify a notes ref to merge");
    }
    if (this.doAbort) return this.abort([], []);
    if (this.doCommit) return this.commitMerge();
    return this.merge();
  }

  /** The git directory as git_path names it: `.git`, a linked worktree's absolute. */
  private gitDirShown = ".git";

  /**
   * git_path's directory: `.git` in the main worktree (git found it there), the absolute
   * path of the administrative directory (`.git/worktrees/<id>`, as the `.git` file names
   * it) in a linked one.
   */
  private async resolveGitDir(): Promise<void> {
    const current = (await this.workingCopy.worktrees?.list().catch(() => undefined))?.find(
      (w) => w.current,
    );
    const host = (this.workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
    if (current?.id !== undefined && host) this.gitDirShown = host;
  }

  private gitPath(name: string): string {
    return `${this.gitDirShown}/${name}`;
  }

  private get checkout() {
    return this.workingCopy.checkout;
  }

  /** merge_abort: NOTES_MERGE_PARTIAL and NOTES_MERGE_REF deleted, the worktree emptied. */
  private async abort(output: string[], errors: string[]): Promise<NotesMergeResult> {
    let ret = 0;
    const refs = this.refsStore;
    for (const name of ["NOTES_MERGE_PARTIAL", "NOTES_MERGE_REF"]) {
      try {
        if (await refs.has(name).catch(() => false)) await refs.delete(name);
        else if (await refs.get(name).catch(() => undefined)) await refs.delete(name);
      } catch {
        errors.push(`error: failed to delete ref ${name}\n`);
        ret++;
      }
    }
    if (this.verbosity >= 3)
      output.push(`Removing notes merge worktree at ${this.gitPath(WORKTREE)}/*\n`);
    try {
      for (const name of (await this.checkout.listStateDir?.(WORKTREE)) ?? []) {
        await this.checkout.removeStateFile?.(`${WORKTREE}/${name}`);
      }
    } catch {
      errors.push("error: failed to remove 'git notes merge' worktree\n");
      ret++;
    }
    return {
      exitCode: ret ? 1 : 0,
      output: output.join(""),
      errors: errors.join(""),
      merged: ret === 0,
      conflicts: [],
    };
  }

  /** The strategy: `-s`, else `notes.<short>.mergeStrategy`, `notes.mergeStrategy`, manual. */
  private resolveStrategy(localRef: string): NotesMergeStrategy {
    if (this.strategy !== undefined) {
      if (!STRATEGIES.includes(this.strategy as NotesMergeStrategy)) {
        throw new NotesError(`unknown -s/--strategy: ${this.strategy}`);
      }
      return this.strategy as NotesMergeStrategy;
    }
    const config = RemoteConfigStore.from(this.workingCopy);
    const short = localRef.slice("refs/notes/".length);
    for (const key of [`notes.${short}.mergeStrategy`, "notes.mergeStrategy"]) {
      const value = config.value(key);
      if (value === undefined) continue;
      if (!STRATEGIES.includes(value as NotesMergeStrategy)) {
        throw new NotesError(`unknown notes merge strategy ${value}`);
      }
      return value as NotesMergeStrategy;
    }
    return "manual";
  }

  /** builtin/notes.c's merge */
  private async merge(): Promise<NotesMergeResult> {
    const ctx = this.ctx;
    const notesRef = this.notesRef();
    const remoteRef = await expandLooseNotesRef(ctx, this.remoteRef as string);
    const t = await this.initCheck("merge", true);
    const strategy = this.resolveStrategy(notesRef);
    const msg = `notes: Merged notes from ${remoteRef} into ${notesRef}`;
    const run = new NotesMerge(ctx, this.workingCopy.checkout, {
      localRef: notesRef,
      remoteRef,
      strategy,
      verbosity: this.verbosity,
      commitMsg: msg.slice("notes: ".length),
    });
    let merged: { result: number; resultId: ObjectId };
    try {
      merged = await run.merge(t.tree);
    } catch (error) {
      if (error instanceof NotesError) {
        error.output = run.output.join("");
        error.errors = run.errors.join("");
      }
      throw error;
    }
    const { result, resultId } = merged;
    const output = run.output;
    const errors = run.errors;
    if (result >= 0) {
      // even when the ref already holds the result ("Already up to date."): an unchanged
      // ref gets no reflog line, a symbolic ref the REF_LOG_ONLY line of the update through it
      await updateNotesRef(ctx, notesRef, resultId, msg);
      return {
        exitCode: 0,
        output: output.join(""),
        errors: errors.join(""),
        merged: true,
        commit: resultId,
        conflicts: [],
      };
    }
    await this.refsStore.set("NOTES_MERGE_PARTIAL", resultId);
    const busy = await this.findSharedSymref(notesRef);
    if (busy !== undefined) {
      const error = new NotesError(
        `a notes merge into ${notesRef} is already in-progress at ${busy}`,
      );
      error.output = output.join("");
      error.errors = errors.join("");
      throw error;
    }
    await this.refsStore.setSymbolic("NOTES_MERGE_REF", notesRef);
    errors.push(
      `Automatic notes merge failed. Fix conflicts in ${this.gitPath(WORKTREE)} and commit the ` +
        "result with 'git notes merge --commit', or abort the merge with 'git notes merge --abort'.\n",
    );
    return {
      exitCode: 1,
      output: output.join(""),
      errors: errors.join(""),
      merged: false,
      commit: resultId,
      conflicts: run.conflicts,
    };
  }

  /** builtin/notes.c's merge_commit and notes_merge_commit */
  private async commitMerge(): Promise<NotesMergeResult> {
    const ctx = this.ctx;
    const output: string[] = [];
    const partialId = await readRef(ctx, "NOTES_MERGE_PARTIAL");
    if (!partialId) throw new NotesError("failed to read ref NOTES_MERGE_PARTIAL");
    const partial = await this.commits.load(partialId).catch(() => undefined);
    if (!partial) throw new NotesError("could not find commit from NOTES_MERGE_PARTIAL.");
    const t = await initNotes(ctx, "NOTES_MERGE_PARTIAL", { combine: combineNotesOverwrite });
    const localRef = await this.symrefTarget("NOTES_MERGE_REF");
    if (!localRef) throw new NotesError("failed to resolve NOTES_MERGE_REF");
    const msg = partial.message;
    if (msg === "") throw new NotesError("partial notes commit has empty message");
    if (this.verbosity >= 3) {
      output.push(`Committing notes in notes merge worktree at ${this.gitPath(WORKTREE)}\n`);
    }
    const names = await this.checkout.listStateDir?.(WORKTREE);
    if (names === undefined) throw new NotesError(`could not open ${this.gitPath(WORKTREE)}`);
    const errors: string[] = [];
    try {
      return await this.commitWorktree(names, t.tree, partial, localRef, output, errors);
    } catch (error) {
      if (error instanceof NotesError) {
        error.output = output.join("");
        error.errors = errors.join("");
      }
      throw error;
    }
  }

  /** notes_merge_commit's loop over NOTES_MERGE_WORKTREE, the commit and the ref update. */
  private async commitWorktree(
    names: string[],
    tree: NotesTree,
    partial: { message: string; parents: ObjectId[] },
    localRef: string,
    output: string[],
    errors: string[],
  ): Promise<NotesMergeResult> {
    const ctx = this.ctx;
    const msg = partial.message;
    for (const name of names) {
      if (!/^[0-9a-fA-F]{40}/.test(name)) {
        if (this.verbosity >= 3) {
          output.push(`Skipping non-SHA1 entry '${this.gitPath(WORKTREE)}/${name}'\n`);
        }
        continue;
      }
      const obj = name.slice(0, 40).toLowerCase();
      const blob = await this.storeResolvedNote(name, errors);
      await tree.add(obj, blob);
      if (this.verbosity >= 4) output.push(`Added resolved note for object ${obj}: ${blob}\n`);
    }
    const id = await createNotesCommit(ctx, tree, msg, { parents: partial.parents });
    if (this.verbosity >= 4) output.push(`Finalized notes merge commit: ${id}\n`);
    const subject = (partial.message.split("\n\n")[0] ?? "").replace(/\s+/g, " ").trim();
    // the partial commit's first parent is what the notes ref held when the merge began
    await updateNotesRef(ctx, localRef, id, `notes: ${subject}`, partial.parents[0]);
    const aborted = await this.abort(output, errors);
    return { ...aborted, merged: aborted.exitCode === 0, commit: id };
  }

  /**
   * notes_merge_commit's `stat` + `index_path`: the file `NOTES_MERGE_WORKTREE/<name>` (a
   * symbolic link followed, as `stat` follows it: the content of the file it points at)
   * stored as a blob as `git add` stores it, through the clean conversion of its path
   * (`core.autocrlf`, `text`/`eol`/`filter` attributes of `.git/NOTES_MERGE_WORKTREE/<name>`).
   * What `stat` refuses dies as git dies (a dangling link, a loop of links); a directory is
   * no file index_path stores (git's `does not have a commit checked out`, then `Failed to
   * write blob object`).
   */
  private async storeResolvedNote(name: string, errors: string[]): Promise<ObjectId> {
    const path = `${this.gitPath(WORKTREE)}/${name}`;
    const read = await this.readFollowingLinks(`${WORKTREE}/${name}`);
    if ("error" in read) {
      switch (read.error) {
        case "loop":
          throw new NotesError(`Failed to stat '${path}': Too many levels of symbolic links`);
        case "directory":
          errors.push(`error: '${path}' does not have a commit checked out\n`);
          throw new NotesError(`Failed to write blob object from '${path}'`);
        case "other":
          errors.push(`error: ${path}: unsupported file type\n`);
          throw new NotesError(`Failed to write blob object from '${path}'`);
        default:
          throw new NotesError(`Failed to stat '${path}': No such file or directory`);
      }
    }
    const bytes = read.bytes;
    const conversion = await this.worktreeAccess?.contentFilter?.checkin(
      `.git/${WORKTREE}/${name}`,
    );
    const cleaned = conversion
      ? await conversion.apply(bytes, {
          write: true,
          onWarning: (message) => errors.push(`warning: ${message}\n`),
        })
      : bytes;
    return this.blobs.store([cleaned], cleaned.length);
  }

  /**
   * The content of the file at `name` in git's directory, symbolic links followed as `stat`
   * and `open` follow them (40 at most, then a loop): through the checkout's `lstat` of
   * its own directory (the real git directory, also in a linked worktree where `.git` is a
   * file), a relative target taken from the link's directory, an absolute one from the
   * host path of the git directory. Else, for a checkout that cannot `lstat`, links the
   * worktree reports under `.git/`.
   */
  private async readFollowingLinks(
    name: string,
  ): Promise<{ bytes: Uint8Array } | { error: "missing" | "loop" | "directory" | "other" }> {
    const checkout = this.checkout;
    if (!checkout.lstatStateFile) {
      const bytes = await this.readThroughWorktree(`.git/${name}`);
      return bytes ? { bytes } : { error: "missing" };
    }
    const host = (this.workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
    let current = name;
    for (let hops = 0; ; hops++) {
      const stat = await checkout.lstatStateFile(current).catch(() => undefined);
      if (!stat) return { error: "missing" };
      if (stat.kind === "directory" || stat.kind === "other") return { error: stat.kind };
      if (stat.kind === "file") {
        const bytes = await checkout.readStateFile?.(current);
        return bytes ? { bytes } : { error: "missing" };
      }
      if (hops >= 40) return { error: "loop" };
      const target = stat.target ?? "";
      let next: string | undefined;
      if (target.startsWith("/")) {
        next = host ? relativeTo(host, target) : undefined;
      } else {
        next = normalizeRelative(`${current.slice(0, current.lastIndexOf("/") + 1)}${target}`);
      }
      if (next === undefined) return { error: "missing" };
      current = next;
    }
  }

  /**
   * A file read through the worktree's view of `.git/` (the main worktree's), a link the
   * worktree reports followed, relative to its directory; undefined when nothing is there.
   */
  private async readThroughWorktree(path: string): Promise<Uint8Array | undefined> {
    const worktree = this.worktreeAccess;
    let current = path;
    for (let hops = 0; hops < 40; hops++) {
      const entry = await worktree?.getEntry(current).catch(() => undefined);
      if (entry && (entry.mode & 0o170000) === 0o120000 && worktree) {
        const target = decodeGitPath(await collectChunks(worktree.readContent(current)));
        if (target.startsWith("/")) return undefined;
        const next = normalizeRelative(
          `${current.slice(0, current.lastIndexOf("/") + 1)}${target}`,
        );
        if (next === undefined || next.startsWith("../")) return undefined;
        current = next;
        continue;
      }
      if (current.startsWith(".git/")) {
        return this.checkout.readStateFile?.(current.slice(".git/".length));
      }
      if (!entry || entry.isDirectory || !worktree) return undefined;
      return collectChunks(worktree.readContent(current));
    }
    return undefined;
  }

  /**
   * worktree.c's find_shared_symref(worktrees, "NOTES_MERGE_REF", ref): the path (as git
   * prints it) of the first worktree, the main one first, whose NOTES_MERGE_REF is a
   * symbolic ref resolving to `ref` (through every link of the chain), read from each
   * worktree's refs (`LinkedWorktrees.refsOf`, else its opened working copy's); bare
   * worktrees are skipped, and so are those whose refs cannot be read. A working copy that keeps no linked
   * worktrees reads its own NOTES_MERGE_REF only, and has no path to print but `.`.
   */
  private async findSharedSymref(ref: string): Promise<string | undefined> {
    const worktrees = this.workingCopy.worktrees;
    const list = await worktrees?.list().catch(() => undefined);
    if (!worktrees || !list) {
      return (await this.mergeRefTarget(this.refsStore)) === ref ? "." : undefined;
    }
    for (const wt of list) {
      if (wt.bare) continue;
      let refs: Pick<CommandRefs, "get"> | undefined = this.refsStore;
      if (!wt.current) {
        const read = worktrees.refsOf
          ? worktrees.refsOf(wt)
          : worktrees.open(wt).then((copy) => copy.history.refs);
        refs = await read
          .then((r) => r as unknown as Pick<CommandRefs, "get">)
          .catch(() => undefined);
      }
      if (refs && (await this.mergeRefTarget(refs)) === ref) return wt.path;
    }
    return undefined;
  }

  /** The ref a worktree's NOTES_MERGE_REF resolves to, when it is a symbolic ref. */
  private async mergeRefTarget(refs: Pick<CommandRefs, "get">): Promise<string | undefined> {
    const first = await refs.get("NOTES_MERGE_REF").catch(() => undefined);
    if (!first || !("target" in first) || typeof first.target !== "string") return undefined;
    return this.symrefTarget("NOTES_MERGE_REF", refs);
  }

  /** refs_resolve_refdup of a symbolic ref: the name it ends at. */
  private async symrefTarget(
    name: string,
    refs: Pick<CommandRefs, "get"> = this.refsStore,
  ): Promise<string | undefined> {
    let current = name;
    for (let depth = 0; depth < 8; depth++) {
      const ref = await refs.get(current).catch(() => undefined);
      if (!ref) return depth === 0 ? undefined : current;
      if (!("target" in ref) || typeof ref.target !== "string") return current;
      current = ref.target;
    }
    return undefined;
  }
}

/** notes-merge.c's notes_merge_options and the merge itself. */
class NotesMerge {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly conflicts: ObjectId[] = [];
  private hasWorktree = false;
  private commitMsg: string;

  constructor(
    private readonly ctx: NotesContext,
    private readonly checkout: {
      readStateFile?(name: string): Promise<Uint8Array | undefined>;
      writeStateFile?(name: string, content: Uint8Array | string): Promise<void>;
      listStateDir?(name: string): Promise<string[]>;
    },
    private readonly o: {
      localRef: string;
      remoteRef: string;
      strategy: NotesMergeStrategy;
      verbosity: number;
      commitMsg: string;
    },
  ) {
    this.commitMsg = o.commitMsg;
  }

  private say(level: number, line: string): void {
    if (this.o.verbosity >= level) this.output.push(line);
  }

  /** notes_merge: 0 trivial, 1 merged, -1 conflicts; the commit to store. */
  async merge(localTree: NotesTree): Promise<{ result: number; resultId: ObjectId }> {
    const ctx = this.ctx;
    const o = this.o;
    const localId = await readRef(ctx, o.localRef);
    const local = localId ? await ctx.commits.load(localId).catch(() => undefined) : undefined;
    if (localId && !local) {
      throw new NotesError(`Could not parse local commit ${localId} (${o.localRef})`);
    }
    const remoteId = await ctx.resolve(o.remoteRef);
    let remote: Awaited<ReturnType<typeof ctx.commits.load>> | undefined;
    if (remoteId) {
      remote = await ctx.commits.load(remoteId).catch(() => undefined);
      if (!remote)
        throw new NotesError(`Could not parse remote commit ${remoteId} (${o.remoteRef})`);
    } else if (!isValidRefName(o.remoteRef)) {
      throw new NotesError(`Failed to resolve remote notes ref '${o.remoteRef}'`);
    }
    if (!local && !remote) {
      throw new NotesError(
        `Cannot merge empty notes ref (${o.remoteRef}) into empty notes ref (${o.localRef})`,
      );
    }
    if (!local) return { result: 0, resultId: remoteId as ObjectId };
    if (!remote) return { result: 0, resultId: localId as ObjectId };
    const l = localId as ObjectId;
    const r = remoteId as ObjectId;
    const bases = await ctx.commits.findMergeBase(l, r);
    let baseId: ObjectId;
    let baseTree: ObjectId;
    if (bases.length === 0) {
      baseId = NOTES_NULL_ID;
      baseTree = EMPTY_TREE;
      this.say(4, "No merge base found; doing history-less merge\n");
    } else {
      baseId = bases[0] as ObjectId;
      baseTree = (await ctx.commits.getTree(baseId)) as ObjectId;
      if (bases.length === 1) this.say(4, `One merge base found (${baseId.slice(0, 7)})\n`);
      else this.say(3, `Multiple merge bases found. Using the first (${baseId.slice(0, 7)})\n`);
    }
    this.say(
      4,
      `Merging remote commit ${r.slice(0, 7)} into local commit ${l.slice(0, 7)} with merge-base ${baseId.slice(0, 7)}\n`,
    );
    if (r === baseId) {
      this.say(2, "Already up to date.\n");
      return { result: 0, resultId: l };
    }
    if (l === baseId) {
      this.say(2, "Fast-forward\n");
      return { result: 0, resultId: r };
    }
    const result = await this.mergeFromDiffs(baseTree, local.tree, remote.tree, localTree);
    const resultId = await createNotesCommit(ctx, localTree, this.commitMsg, { parents: [l, r] });
    return { result, resultId };
  }

  /** The notes of a stored tree, flat (path_to_oid of each blob path). */
  private async flatNotes(tree: ObjectId): Promise<Map<ObjectId, ObjectId>> {
    const out = new Map<ObjectId, ObjectId>();
    const walk = async (id: ObjectId, prefix: string): Promise<void> => {
      for await (const e of this.ctx.trees.loadTree(id)) {
        if ((e.mode & 0o170000) === 0o040000) await walk(e.id, `${prefix}${e.name}/`);
        else {
          const hex = `${prefix}${e.name}`.replaceAll("/", "");
          if (/^[0-9a-fA-F]{40}$/.test(hex)) out.set(hex.toLowerCase(), e.id);
        }
      }
    };
    await walk(tree, "");
    return out;
  }

  /** merge_from_diffs: diff_tree_remote, diff_tree_local, merge_changes. */
  private async mergeFromDiffs(
    base: ObjectId,
    local: ObjectId,
    remote: ObjectId,
    t: NotesTree,
  ): Promise<number> {
    const b = await this.flatNotes(base);
    const l = await this.flatNotes(local);
    const r = await this.flatNotes(remote);
    const changes: MergePair[] = [];
    for (const obj of [...new Set([...b.keys(), ...r.keys()])].sort()) {
      const bv = b.get(obj) ?? NOTES_NULL_ID;
      const rv = r.get(obj) ?? NOTES_NULL_ID;
      if (bv === rv) continue;
      const lv = l.get(obj) ?? NOTES_NULL_ID;
      changes.push({ obj, base: bv, local: lv === bv ? UNINITIALIZED : lv, remote: rv });
    }
    let conflicts = 0;
    for (const p of changes) {
      if (p.base === p.remote) continue;
      if (p.local === p.remote) continue;
      if (p.local === UNINITIALIZED || p.local === p.base) {
        await t.add(p.obj, p.remote, combineNotesOverwrite);
      } else {
        conflicts += await this.mergeOneChange(p, t);
      }
    }
    this.say(
      4,
      t.dirty
        ? `Merge result: ${conflicts} unmerged notes and a dirty notes tree\n`
        : `Merge result: ${conflicts} unmerged notes and a clean notes tree\n`,
    );
    return conflicts ? -1 : 1;
  }

  /** merge_one_change */
  private async mergeOneChange(p: MergePair, t: NotesTree): Promise<number> {
    const combine = (c: CombineNotes) => t.add(p.obj, p.remote, c);
    switch (this.o.strategy) {
      case "manual":
        return this.mergeOneChangeManual(p, t);
      case "ours":
        this.say(2, `Using local notes for ${p.obj}\n`);
        return 0;
      case "theirs":
        this.say(2, `Using remote notes for ${p.obj}\n`);
        await combine(combineNotesOverwrite);
        return 0;
      case "union":
        this.say(2, `Concatenating local and remote notes for ${p.obj}\n`);
        await combine(combineNotesConcatenate);
        return 0;
      case "cat_sort_uniq":
        this.say(2, `Concatenating unique lines in local and remote notes for ${p.obj}\n`);
        await combine(combineNotesCatSortUniq);
        return 0;
    }
  }

  /** check_notes_merge_worktree */
  private async checkWorktree(): Promise<void> {
    if (this.hasWorktree) return;
    const names = (await this.checkout.listStateDir?.(WORKTREE)) ?? [];
    if (names.length > 0) {
      throw new NotesError(
        "You have not concluded your previous notes merge (.git/NOTES_MERGE_* exists).\n" +
          "Please, use 'git notes merge --commit' or 'git notes merge --abort' to commit/abort " +
          "the previous merge before you start a new notes merge.",
      );
    }
    if (!this.checkout.writeStateFile) {
      throw new NotesError(`unable to create directory .git/${WORKTREE}`);
    }
    this.hasWorktree = true;
  }

  private async writeToWorktree(obj: ObjectId, bytes: Uint8Array): Promise<void> {
    await this.checkout.writeStateFile?.(`${WORKTREE}/${obj}`, bytes);
  }

  private async readBlob(id: ObjectId): Promise<Uint8Array> {
    return (await readNoteBytes(this.ctx.blobs, id)) ?? new Uint8Array();
  }

  /** merge_one_change_manual */
  private async mergeOneChangeManual(p: MergePair, t: NotesTree): Promise<number> {
    const lref = this.o.localRef;
    const rref = this.o.remoteRef;
    if (!this.hasWorktree) this.commitMsg += "\n\nConflicts:\n";
    this.commitMsg += `\t${p.obj}\n`;
    this.say(2, `Auto-merging notes for ${p.obj}\n`);
    await this.checkWorktree();
    if (p.local === NOTES_NULL_ID) {
      this.say(
        1,
        `CONFLICT (delete/modify): Notes for object ${p.obj} deleted in ${lref} and modified in ${rref}. Version from ${rref} left in tree.\n`,
      );
      await this.writeToWorktree(p.obj, await this.readBlob(p.remote));
    } else if (p.remote === NOTES_NULL_ID) {
      this.say(
        1,
        `CONFLICT (delete/modify): Notes for object ${p.obj} deleted in ${rref} and modified in ${lref}. Version from ${lref} left in tree.\n`,
      );
      await this.writeToWorktree(p.obj, await this.readBlob(p.local));
    } else {
      const reason = p.base === NOTES_NULL_ID ? "add/add" : "content";
      this.say(1, `CONFLICT (${reason}): Merge conflict in notes for object ${p.obj}\n`);
      await this.llMerge(p);
    }
    this.conflicts.push(p.obj);
    await t.remove(p.obj);
    return 1;
  }

  /** ll_merge_in_worktree: git's default text merge (myers, zealous), labels the refs. */
  private async llMerge(p: MergePair): Promise<void> {
    const base = await this.readBlob(p.base);
    const local = await this.readBlob(p.local);
    const remote = await this.readBlob(p.remote);
    const binary = [base, local, remote].some((bytes) => bytes.subarray(0, 8000).includes(0));
    if (binary) {
      this.errors.push(
        `warning: Cannot merge binary files: ${p.obj} (${this.o.localRef} vs. ${this.o.remoteRef})\n`,
      );
      await this.writeToWorktree(p.obj, local);
      return;
    }
    const { content } = mergeLines(base, local, remote, {
      oursLabel: this.o.localRef,
      theirsLabel: this.o.remoteRef,
      algorithm: "myers",
      level: "zealous",
    });
    await this.writeToWorktree(p.obj, content);
  }
}

/** check_refname_format(name, 0) == 0, roughly: a ref name of two components or more. */
function isValidRefName(name: string): boolean {
  if (name.endsWith(".lock") || name.includes("..") || name.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git refuses control characters
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  const parts = name.split("/");
  return (
    parts.length >= 2 && parts.every((c) => c !== "" && !c.startsWith(".") && !c.endsWith("."))
  );
}

/** A relative path with `.` and `x/..` folded away; leading `..` kept (undefined when empty). */
function normalizeRelative(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

/** The absolute host path `target` relative to the absolute directory `dir`. */
function relativeTo(dir: string, target: string): string | undefined {
  const from = dir.split("/").filter((p) => p !== "" && p !== ".");
  const to = normalizeRelative(target)?.split("/") ?? [];
  if (to.includes("..")) return undefined;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return normalizeRelative([...from.slice(common).map(() => ".."), ...to.slice(common)].join("/"));
}
