/**
 * What `git status` shows above the paths, read from the repository: where HEAD is
 * (wt_status_prepare's `s->branch`, wt_status_get_detached_from), the operations in
 * progress (wt_status_get_state: merge, am, rebase, cherry-pick, revert, bisect, sparse
 * checkout) and how the branch compares with its upstream (remote.c).
 *
 * @example
 * ```typescript
 * const header = await readStatusHeader(source, { headId, isInitial: false });
 * header.state.mergeInProgress; // true while MERGE_HEAD exists
 * ```
 */

import { isSymbolicRef, type ObjectId } from "@statewalker/vcs-core";
import type { StagingEntry } from "@statewalker/vcs-working-tree";

import type { CommandRefs } from "../git-command.js";
import type { OperationState } from "./merge-support.js";
import type { StatusHeader, StatusState } from "./status-format.js";
import {
  formatTrackingInfo,
  statTrackingInfo,
  type TrackingFormatOptions,
  type TrackingSource,
} from "./tracking-info.js";

/** What the header reads. */
export interface StatusHeaderSource {
  refs: CommandRefs;
  state: OperationState;
  tracking: TrackingSource;
  /** `repo_find_unique_abbrev(oid, DEFAULT_ABBREV)` */
  abbreviate(id: ObjectId): Promise<string>;
  /** `repo_dwim_ref`: the refs a name finds */
  dwimRef(name: string): Promise<{ id: ObjectId; ref: string }[]>;
  /** The commit an object names (a tag peeled), undefined when none */
  commitOf(id: ObjectId): Promise<ObjectId | undefined>;
  /** Whether a full hex name is an object of the repository (`repo_get_oid`) */
  objectExists(id: ObjectId): Promise<boolean>;
  /** A configuration value */
  config(key: string): string | undefined;
  /** The index entries (the sparse checkout percentage) */
  entries: readonly StagingEntry[];
  /** How git names `$GIT_DIR/rebase-merge/done` */
  rebaseDonePath?: string;
}

/** What {@link readStatusHeader} is told. */
export interface StatusHeaderOptions {
  /** The commit the index is compared with (`s->oid_commit`), undefined: initial */
  referenceId?: ObjectId;
  /** Which trackings to compute */
  tracking?: { long?: TrackingFormatOptions; short?: { quick: boolean } };
  /** wt_status_get_state's split-commit check needs these */
  amend?: boolean;
  nowarn?: boolean;
  workdirDirty?: boolean;
  /** Read the stash count */
  stash?: boolean;
}

const HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The header of a status: the branch, the state, the tracking reports. */
export async function readStatusHeader(
  source: StatusHeaderSource,
  options: StatusHeaderOptions,
): Promise<StatusHeader & { warnings: string[] }> {
  const warnings: string[] = [];
  const head = await source.refs.get("HEAD").catch(() => undefined);
  // refs_resolve_refdup("HEAD"): the branch it points to (even unborn), "HEAD" when detached
  const branch = head ? (isSymbolicRef(head) ? head.target : "HEAD") : undefined;
  const isInitial = options.referenceId === undefined;
  const state = await readStatusState(source, branch, options);
  const header: StatusHeader & { warnings: string[] } = {
    ...(branch !== undefined ? { branch } : {}),
    isInitial,
    ...(options.referenceId ? { oid: options.referenceId } : {}),
    state,
    warnings,
  };
  if (branch?.startsWith("refs/heads/")) {
    if (options.tracking?.long && !isInitial) {
      const report = await formatTrackingInfo(source.tracking, branch, options.tracking.long);
      header.trackingText = report.text;
      warnings.push(...report.warnings);
    }
    if (options.tracking?.short) {
      const stat = await statTrackingInfo(source.tracking, branch, options.tracking.short.quick);
      header.tracking = {
        ...stat,
        ...(stat.base ? { short: await source.tracking.shortenRef(stat.base) } : {}),
      };
    }
  }
  if (options.stash) {
    const log = await source.refs.getReflog?.("refs/stash");
    header.stashCount = log
      ? (await log.getReverseEntries()).length
      : (await source.refs.has("refs/stash").catch(() => false))
        ? 1
        : 0;
  }
  return header;
}

/** wt-status.c's `get_branch`: a rebase's or bisect's branch file as status names it. */
async function getBranch(source: StatusHeaderSource, name: string): Promise<string | undefined> {
  const text = await source.state.read(name);
  if (text === undefined || text.length === 0) return undefined;
  const value = text.replace(/\n+$/, "");
  if (!value) return undefined;
  if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length);
  if (value.startsWith("refs/")) return value;
  // a SHA-256 id (64 hex digits), else a SHA-1 one
  const hex = /^[0-9a-fA-F]{64}/.test(value) ? 64 : /^[0-9a-fA-F]{40}/.test(value) ? 40 : 0;
  if (hex) return source.abbreviate(value.slice(0, hex).toLowerCase());
  if (value === "detached HEAD") return undefined;
  return value;
}

/** wt_status_get_state (and the split-commit and todo reads of the long format). */
async function readStatusState(
  source: StatusHeaderSource,
  branch: string | undefined,
  options: StatusHeaderOptions,
): Promise<StatusState> {
  const st = source.state;
  const state: StatusState = {};
  const checkRebase = async (): Promise<boolean> => {
    if (await st.exists("rebase-apply")) {
      if ((await st.read("rebase-apply/applying")) !== undefined) {
        state.amInProgress = true;
        const patch = await st.read("rebase-apply/patch");
        if (patch !== undefined && patch.length === 0) state.amEmptyPatch = true;
      } else {
        state.rebaseInProgress = true;
        const b = await getBranch(source, "rebase-apply/head-name");
        if (b !== undefined) state.branch = b;
        const o = await getBranch(source, "rebase-apply/onto");
        if (o !== undefined) state.onto = o;
      }
      return true;
    }
    if (await st.exists("rebase-merge")) {
      if ((await st.read("rebase-merge/interactive")) !== undefined) {
        state.rebaseInteractiveInProgress = true;
      } else state.rebaseInProgress = true;
      const b = await getBranch(source, "rebase-merge/head-name");
      if (b !== undefined) state.branch = b;
      const o = await getBranch(source, "rebase-merge/onto");
      if (o !== undefined) state.onto = o;
      return true;
    }
    return false;
  };
  if ((await st.read("MERGE_HEAD")) !== undefined) {
    await checkRebase();
    state.mergeInProgress = true;
  } else if (await checkRebase()) {
    // all set
  } else {
    const pick = await st.ref("CHERRY_PICK_HEAD");
    if (pick) {
      state.cherryPickInProgress = true;
      state.cherryPickHead = await source.abbreviate(pick);
    }
  }
  if ((await st.read("BISECT_LOG")) !== undefined) {
    state.bisectInProgress = true;
    const from = await getBranch(source, "BISECT_START");
    if (from !== undefined) state.bisectingFrom = from;
  }
  const revert = await st.ref("REVERT_HEAD");
  if (revert) {
    state.revertInProgress = true;
    state.revertHead = await source.abbreviate(revert);
  }
  // sequencer_get_last_command
  const todo = await st.read("sequencer/todo");
  if (todo !== undefined) {
    const bol = todo.replace(/^[ \t\r\n]+/, "");
    const m = /^(pick|p|revert)[ \t]/.exec(bol);
    if (m?.[1] === "revert") {
      if (!state.revertInProgress) state.revertInProgress = true;
    } else if (m && !state.cherryPickInProgress) state.cherryPickInProgress = true;
  }
  if (branch === "HEAD") await detachedFrom(source, state);
  // wt_status_check_sparse_checkout
  const sparse = source.config("core.sparseCheckout")?.toLowerCase();
  if (
    (sparse === "true" || sparse === "yes" || sparse === "on" || sparse === "1") &&
    source.entries.length > 0
  ) {
    let skip = 0;
    for (const e of source.entries) if (e.skipWorktree) skip++;
    state.sparseCheckoutPercentage = 100 - Math.floor((100 * skip) / source.entries.length);
  }
  if (state.rebaseInteractiveInProgress) {
    state.rebaseDone = (await todoList(source, "rebase-merge/done")) ?? [];
    const remaining = await todoList(source, "rebase-merge/git-rebase-todo");
    if (remaining !== undefined) state.rebaseTodo = remaining;
    state.rebaseDonePath = source.rebaseDonePath ?? ".git/rebase-merge/done";
  }
  if (state.rebaseInProgress || state.rebaseInteractiveInProgress) {
    state.mergeMsgExists = (await st.read("MERGE_MSG")) !== undefined;
    state.splitCommitInProgress = await splitCommitInProgress(source, branch, options);
  }
  return state;
}

/** wt_status_get_detached_from: the last `checkout: moving from X to Y` of HEAD's reflog. */
async function detachedFrom(source: StatusHeaderSource, state: StatusState): Promise<void> {
  const log = await source.refs.getReflog?.("HEAD");
  if (!log) return;
  let target: string | undefined;
  let noid: ObjectId | undefined;
  for (const entry of await log.getReverseEntries()) {
    const message = entry.comment;
    if (!message.startsWith("checkout: moving from ")) continue;
    const rest = message.slice("checkout: moving from ".length);
    const at = rest.indexOf(" to ");
    if (at < 0) continue;
    target = rest.slice(at + 4).split("\n")[0] as string;
    noid = entry.newId;
    if (target === "HEAD") target = await source.abbreviate(noid);
    break;
  }
  if (target === undefined || noid === undefined) return;
  const found = await source.dwimRef(target);
  let from: string | undefined;
  if (found.length === 1) {
    const { id, ref } = found[0] as { id: ObjectId; ref: string };
    if (id === noid || (await source.commitOf(id)) === noid) {
      from = ref.startsWith("refs/tags/")
        ? ref.slice("refs/tags/".length)
        : ref.startsWith("refs/remotes/")
          ? ref.slice("refs/remotes/".length)
          : ref;
    }
  }
  state.detachedFrom = from ?? (await source.abbreviate(noid));
  const headId = (await source.refs.resolve("HEAD").catch(() => undefined))?.objectId;
  state.detachedAt = headId === noid;
}

/** split_commit_in_progress. */
async function splitCommitInProgress(
  source: StatusHeaderSource,
  branch: string | undefined,
  options: StatusHeaderOptions,
): Promise<boolean> {
  if ((!options.amend && !options.nowarn && !options.workdirDirty) || branch !== "HEAD") {
    return false;
  }
  const head = await source.refs.get("HEAD").catch(() => undefined);
  const orig = await source.refs.get("ORIG_HEAD").catch(() => undefined);
  if (!head || !orig || isSymbolicRef(head) || isSymbolicRef(orig)) return false;
  const headId = "objectId" in head ? head.objectId : undefined;
  const origId = "objectId" in orig ? orig.objectId : undefined;
  if (!headId || !origId) return false;
  const amend = (await source.state.read("rebase-merge/amend"))?.split("\n")[0];
  const origHead = (await source.state.read("rebase-merge/orig-head"))?.split("\n")[0];
  if (amend === undefined || origHead === undefined) return false;
  if (amend === origHead) return headId !== amend;
  return origId !== origHead;
}

/**
 * read_rebase_todolist (git 2.5x's format_todo_line): the commands of a todo file, comments
 * and blank lines dropped, the object names of picks (and the like) abbreviated. Undefined
 * when the file is missing.
 */
async function todoList(source: StatusHeaderSource, name: string): Promise<string[] | undefined> {
  const text = await source.state.read(name);
  if (text === undefined) return undefined;
  const out: string[] = [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const comment = commentChar(source);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith(comment)) continue;
    out.push(await formatTodoLine(source, line));
  }
  return out;
}

/** The comment character of todo files (`core.commentChar`, default `#`). */
function commentChar(source: StatusHeaderSource): string {
  const value = source.config("core.commentChar") ?? source.config("core.commentString");
  return value && value !== "auto" ? value : "#";
}

const ABBREVIATED_COMMANDS = new Set([
  "pick",
  "p",
  "revert",
  "edit",
  "e",
  "reword",
  "r",
  "squash",
  "s",
  "drop",
  "d",
  "fixup",
  "f",
]);

/** format_todo_line: the object name after the command abbreviated where it is one. */
async function formatTodoLine(source: StatusHeaderSource, line: string): Promise<string> {
  const m = /^(\S+)([ \t]+)(.*)$/.exec(line);
  if (!m) return line;
  const command = m[1] as string;
  let rest = m[3] as string;
  let lead = "";
  if (command === "fixup" || command === "f") {
    const c = /^(-[cC])([ \t]*)/.exec(rest);
    if (c) {
      lead = c[0];
      rest = rest.slice(c[0].length);
    }
  }
  if (!ABBREVIATED_COMMANDS.has(command)) return line;
  const word = /^[^ \t]*/.exec(rest)?.[0] ?? "";
  if (!/^[0-9a-fA-F]+$/.test(word) || !HEX.test(word.toLowerCase())) return line;
  if (!(await source.objectExists(word.toLowerCase()))) return line;
  const abbrev = await source.abbreviate(word.toLowerCase());
  if (!word.startsWith(abbrev)) return line;
  return `${command}${m[2]}${lead}${abbrev}${rest.slice(word.length)}`;
}
