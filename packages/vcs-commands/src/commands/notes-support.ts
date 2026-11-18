import type { ObjectId, PersonIdent, RefLogOptions } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  type GitHostEnvironment,
  type WorkingCopy,
  wildmatch,
} from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import type { CommandCommits, CommandRefs, CommandTags } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";
import {
  type CombineNotes,
  combineNotesConcatenate,
  combineNotesIgnore,
  NOTES_DEFAULT_REF,
  type NotesStores,
  NotesTree,
  parseCombineNotes,
} from "./notes-tree.js";

/**
 * What git dies with in `git notes` (and the notes rewriting of `commit --amend` and
 * `rebase`): the message is git's line after `fatal: `.
 */
export class NotesError extends GitApiError {
  /** What the command printed to its standard output before it died */
  output = "";
  /** And to its standard error, before the `fatal:` line */
  errors = "";

  constructor(message: string) {
    super(message);
    this.name = "NotesError";
  }
}

/** The repository a notes operation reads and writes (see `GitCommand.notesContext`). */
export interface NotesContext extends NotesStores {
  workingCopy: WorkingCopy;
  commits: CommandCommits;
  refs: CommandRefs;
  tags?: CommandTags;
  /** The author of the notes commits (git's commit_tree: git_author_info) */
  author(): PersonIdent;
  /** Their committer */
  committer(): PersonIdent;
  /** A reflog line of the committer */
  reflogLine(message: string): RefLogOptions;
  /** repo_get_oid: undefined when `name` names nothing */
  resolve(name: string): Promise<ObjectId | undefined>;
}

/** A notes tree loaded from a ref (struct notes_tree's ref and update_ref). */
export interface NotesHandle {
  tree: NotesTree;
  ref: string;
  /** The ref a commit of the tree updates (writable trees only) */
  updateRef?: string;
}

/**
 * The notes variables of the host environment (`GIT_NOTES_REF`, `GIT_NOTES_DISPLAY_REF`,
 * `GIT_NOTES_REWRITE_REF`, `GIT_NOTES_REWRITE_MODE`).
 */
export function notesEnvironmentOf(
  workingCopy: WorkingCopy,
): Pick<
  GitHostEnvironment,
  "notesRef" | "notesDisplayRef" | "notesRewriteRef" | "notesRewriteMode"
> {
  return hostEnvironmentOf(workingCopy) ?? {};
}

/**
 * notes.c's default_notes_ref: `GIT_NOTES_REF` (`override`: what `git notes --ref` sets it
 * to), `core.notesRef`, `refs/notes/commits`; as given, not expanded.
 */
export function defaultNotesRef(workingCopy: WorkingCopy, override?: string): string {
  if (override !== undefined) return override;
  const env = notesEnvironmentOf(workingCopy).notesRef;
  if (env !== undefined) return env;
  const config = RemoteConfigStore.from(workingCopy);
  return config.value("core.notesRef") ?? NOTES_DEFAULT_REF;
}

/** notes.c's expand_notes_ref: `refs/notes/` before a name not under it (`notes/x`: `refs/`). */
export function expandNotesRef(name: string): string {
  if (name.startsWith("refs/notes/")) return name;
  if (name.startsWith("notes/")) return `refs/${name}`;
  return `refs/notes/${name}`;
}

/** expand_loose_notes_ref: the name as it is when it resolves, else expand_notes_ref. */
export async function expandLooseNotesRef(ctx: NotesContext, name: string): Promise<string> {
  return (await ctx.resolve(name)) ? name : expandNotesRef(name);
}

/** dir.c's has_glob_specials */
export function hasGlobSpecials(text: string): boolean {
  return /[*?[\\]/.test(text);
}

/**
 * string_list_add_refs_by_glob: the refs a glob matches (with `refs/` before a glob not
 * under it, matched as `refs_for_each_ref` matches: wildmatch without WM_PATHNAME), else
 * the name itself (warned of when it does not resolve). Names already listed are skipped.
 */
export async function addRefsByGlob(
  ctx: NotesContext,
  list: string[],
  glob: string,
  warnings?: string[],
): Promise<void> {
  if (hasGlobSpecials(glob)) {
    const pattern = glob.startsWith("refs/") ? glob : `refs/${glob}`;
    const names: string[] = [];
    for await (const ref of ctx.refs.list("refs/")) {
      if (wildmatch(pattern, ref.name)) names.push(ref.name);
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) if (!list.includes(name)) list.push(name);
    return;
  }
  if (!(await ctx.resolve(glob))) warnings?.push(`warning: notes ref ${glob} is invalid`);
  if (!list.includes(glob)) list.push(glob);
}

/** string_list_add_refs_from_colon_sep */
export async function addRefsFromColonSep(
  ctx: NotesContext,
  list: string[],
  globs: string,
  warnings?: string[],
): Promise<void> {
  for (const glob of globs.split(":")) {
    if (glob !== "") await addRefsByGlob(ctx, list, glob, warnings);
  }
}

/** The tree of a tree-ish: a commit's (tags peeled), or a tree itself. */
async function treeOfTreeish(ctx: NotesContext, id: ObjectId): Promise<ObjectId | undefined> {
  let current = id;
  for (let depth = 0; depth < 32; depth++) {
    const commit = await ctx.commits.load(current).catch(() => undefined);
    if (commit) return commit.tree;
    if (await ctx.trees.has(current).catch(() => false)) return current;
    const tag = await ctx.tags?.loadTag(current).catch(() => undefined);
    if (!tag) return undefined;
    current = tag.object;
  }
  return undefined;
}

/** The id a ref holds (symbolic refs followed), undefined when it holds none. */
export async function readRef(ctx: NotesContext, name: string): Promise<ObjectId | undefined> {
  const ref = await ctx.refs.resolve(name).catch(() => undefined);
  return ref?.objectId ?? undefined;
}

/**
 * init_notes: the notes tree of `ref` (empty when it names nothing, or with `empty`);
 * a writable tree's ref must be a ref.
 */
export async function initNotes(
  ctx: NotesContext,
  ref: string,
  options: { combine?: CombineNotes; writable?: boolean; empty?: boolean } = {},
): Promise<NotesHandle> {
  const combine = options.combine ?? combineNotesConcatenate;
  const handle = (tree: NotesTree): NotesHandle => ({
    tree,
    ref,
    ...(options.writable ? { updateRef: ref } : {}),
  });
  if (options.empty) return handle(await NotesTree.load(ctx, undefined, combine));
  const id = (await readRef(ctx, ref)) ?? (await ctx.resolve(ref));
  if (!id) return handle(await NotesTree.load(ctx, undefined, combine));
  if (options.writable && !(await readRef(ctx, ref))) {
    throw new NotesError(`Cannot use notes ref ${ref}`);
  }
  const tree = await treeOfTreeish(ctx, id);
  if (!tree) {
    throw new NotesError(`Failed to read notes tree referenced by ${ref} (${id})`);
  }
  return handle(await NotesTree.load(ctx, tree, combine));
}

/** git's copy_reflog_msg: whitespace runs as one space, none at either end. */
function reflogMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * notes-utils.c's create_notes_commit: the tree written and committed with `parents`
 * (default: the commit `ref` holds, none when it holds none) and `message` as given.
 */
export async function createNotesCommit(
  ctx: NotesContext,
  tree: NotesTree,
  message: string,
  options: { parents?: ObjectId[]; ref?: string } = {},
): Promise<ObjectId> {
  const treeId = await tree.write();
  let parents = options.parents;
  if (!parents) {
    const parent = options.ref ? await readRef(ctx, options.ref) : undefined;
    parents = parent ? [parent] : [];
  }
  return ctx.commits.store({
    tree: treeId,
    parents,
    author: ctx.author(),
    committer: ctx.committer(),
    message,
  });
}

/**
 * notes-utils.c's commit_notes: a changed tree committed on its ref with `message` (its
 * line ended), the ref updated with `notes: <message>` in its reflog.
 */
export async function commitNotes(
  ctx: NotesContext,
  t: NotesHandle,
  message: string,
): Promise<void> {
  if (!t.updateRef) throw new NotesError("Cannot commit uninitialized/unreferenced notes tree");
  if (!t.tree.dirty) return;
  const msg = message.endsWith("\n") ? message : `${message}\n`;
  const id = await createNotesCommit(ctx, t.tree, msg, { ref: t.updateRef });
  await ctx.refs.set(t.updateRef, id, ctx.reflogLine(reflogMessage(`notes: ${msg}`)));
}

/** The notes trees a rewrite copies notes in (notes-utils.h's struct notes_rewrite_cfg). */
export interface NotesRewriteConfig {
  trees: NotesHandle[];
  combine?: CombineNotes;
}

/**
 * init_copy_notes_for_rewrite: the notes refs a rewrite by `cmd` (`amend`, `rebase`) copies
 * notes in — `GIT_NOTES_REWRITE_REF` (colon-separated globs), else `notes.rewriteRef` (no
 * default: none, nothing is copied) — and how a copied note combines with one there
 * (`GIT_NOTES_REWRITE_MODE`, else `notes.rewriteMode`, default `concatenate`); undefined
 * when there is nothing to do (no refs, or `notes.rewrite.<cmd>` false).
 */
export async function initCopyNotesForRewrite(
  ctx: NotesContext,
  cmd: string,
  messages: string[] = [],
): Promise<NotesRewriteConfig | undefined> {
  const env = notesEnvironmentOf(ctx.workingCopy);
  const config = RemoteConfigStore.from(ctx.workingCopy);
  let enabled = true;
  let combine: CombineNotes | undefined = combineNotesConcatenate;
  const refs: string[] = [];
  if (env.notesRewriteMode !== undefined) {
    combine = parseCombineNotes(env.notesRewriteMode);
    if (!combine) {
      messages.push(`error: Bad GIT_NOTES_REWRITE_MODE value: '${env.notesRewriteMode}'`);
    }
  }
  if (env.notesRewriteRef !== undefined) {
    await addRefsFromColonSep(ctx, refs, env.notesRewriteRef, messages);
  }
  const enabledValues = config.values(`notes.rewrite.${cmd}`);
  if (enabledValues.length > 0) {
    enabled = parseGitBool(enabledValues[enabledValues.length - 1] as string) ?? true;
  }
  if (env.notesRewriteMode === undefined) {
    for (const value of config.values("notes.rewriteMode")) {
      combine = parseCombineNotes(value);
      if (!combine) messages.push(`error: Bad notes.rewriteMode value: '${value}'`);
    }
  }
  if (env.notesRewriteRef === undefined) {
    for (const value of config.values("notes.rewriteRef")) {
      if (value.startsWith("refs/notes/")) await addRefsByGlob(ctx, refs, value, messages);
      else {
        messages.push(`warning: Refusing to rewrite notes in ${value} (outside of refs/notes/)`);
      }
    }
  }
  if (!enabled || refs.length === 0) return undefined;
  const trees: NotesHandle[] = [];
  for (const ref of refs) {
    trees.push(await initNotes(ctx, ref, { combine: combineNotesIgnore, writable: true }));
  }
  return { trees, ...(combine ? { combine } : {}) };
}

/** copy_note_for_rewrite: the note of `from` copied to `to` in each tree (forced). */
export async function copyNoteForRewrite(
  c: NotesRewriteConfig,
  from: ObjectId,
  to: ObjectId,
): Promise<void> {
  for (const t of c.trees) await t.tree.copy(from, to, true, c.combine);
}

/** finish_copy_notes_for_rewrite: each changed tree committed with `message`. */
export async function finishCopyNotesForRewrite(
  ctx: NotesContext,
  c: NotesRewriteConfig,
  message: string,
): Promise<void> {
  for (const t of c.trees) await commitNotes(ctx, t, message);
}

/**
 * sequencer.c's commit_post_rewrite's notes part: after `commit --amend` (and the
 * sequencer's amends), the notes of the amended commit copied to the new one; `author` the
 * notes commit's author where git has exported the amend's (`git commit --amend`).
 */
export async function copyNotesForAmend(
  ctx0: NotesContext,
  oldHead: ObjectId,
  newHead: ObjectId,
  author?: PersonIdent,
): Promise<void> {
  const ctx = author ? { ...ctx0, author: () => author } : ctx0;
  const cfg = await initCopyNotesForRewrite(ctx, "amend");
  if (!cfg) return;
  await copyNoteForRewrite(cfg, oldHead, newHead);
  await finishCopyNotesForRewrite(ctx, cfg, "Notes added by 'git commit --amend'");
}

/**
 * The end of `git rebase` (sequencer.c's pick_commits): `git notes copy
 * --for-rewrite=rebase` fed `rewritten-list` (`<old> <new>` lines); its failures ignored,
 * as git ignores them.
 */
export async function copyNotesForRebase(ctx: NotesContext, rewrittenList: string): Promise<void> {
  try {
    const cfg = await initCopyNotesForRewrite(ctx, "rebase");
    if (!cfg) return;
    for (const line of rewrittenList.split("\n")) {
      if (line === "") continue;
      const parts = line.split(" ").map((p) => p.trim());
      if (parts.length < 2) return;
      const from = await ctx.resolve(parts[0] as string);
      const to = await ctx.resolve(parts[1] as string);
      if (!from || !to) return;
      await copyNoteForRewrite(cfg, from, to);
    }
    await finishCopyNotesForRewrite(ctx, cfg, "Notes added by 'git notes copy'");
  } catch {
    // run_command's result is not looked at
  }
}
