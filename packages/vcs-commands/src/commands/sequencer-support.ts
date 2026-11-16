/**
 * Pieces of git's sequencer shared by `merge`, `cherry-pick`, `revert` and `rebase`:
 * `git reset --merge` / `--hard` as their `--abort` runs it, the commit message cleanup
 * their `--continue` applies, and `SQUASH_MSG`.
 */

import { formatPersonIdent, type ObjectId, type PersonIdent } from "@statewalker/vcs-core";
import { entryStatOf, type IndexEntryOptions } from "@statewalker/vcs-working-tree";

import type { CommandCommits, CommandRefs } from "../git-command.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  flatTree,
  type MergeRefusal,
  type MergeWriteContext,
  rewriteIndex,
  storeFlatTree,
} from "./merge-support.js";
import { StashApplyCommand } from "./stash-apply-command.js";
import { StashCreateCommand } from "./stash-create-command.js";
import { STASH_REF } from "./stash-list-command.js";
import { planTreeRestore, writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

/** What resetting the index and worktree needs. */
export interface SequencerContext extends MergeWriteContext {
  commits: CommandCommits;
  refs: CommandRefs;
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/**
 * git's `reset --merge <commit>` (and with `hard`, `reset --hard`) of the index and the
 * worktree: unmerged entries and entries that differ from the commit's tree take its
 * version (a file that holds unstaged changes refuses the reset, unless hard); paths the
 * index and the commit agree on keep their worktree file as it is. HEAD is not moved.
 */
export async function resetMerge(
  ctx: SequencerContext,
  targetId: ObjectId,
  label: string,
  options: { hard?: boolean } = {},
): Promise<MergeRefusal | undefined> {
  const target = await flatTree(ctx.trees, await ctx.commits.getTree(targetId));
  const index = new Map<string, CheckedEntry>();
  const unmerged = new Set<string>();
  for await (const entry of ctx.staging.entries()) {
    if (entry.stage === 0) index.set(entry.path, entry);
    else unmerged.add(entry.path);
  }
  const worktree = ctx.worktree;
  const trust = worktree ? worktreeModeTrust(ctx.workingCopy, worktree) : undefined;
  const changes: string[] = [];
  const paths = [...new Set([...index.keys(), ...unmerged, ...target.keys()])].sort();
  for (const path of paths) {
    const i = index.get(path);
    const t = target.get(path);
    const conflicted = unmerged.has(path);
    if (!conflicted && sameEntry(i, t)) {
      // reset --hard rewrites a modified file too
      if (options.hard && i && worktree && (await worktreeDiffers(worktree, path, i, trust))) {
        changes.push(path);
      }
      continue;
    }
    if (!options.hard && worktree) {
      if (!conflicted && i && (await worktreeDiffers(worktree, path, i, trust))) {
        return {
          message: `error: Entry '${path}' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision '${label}'.`,
          paths: [path],
        };
      }
      if (!conflicted && !i && t) {
        const entry = await worktree.getEntry(path);
        if (entry && !entry.isDirectory && !(await worktree.isIgnored(path))) {
          return {
            message: `error: Untracked working tree file '${path}' would be overwritten by merge.\nfatal: Could not reset index file to revision '${label}'.`,
            paths: [path],
          };
        }
      }
    }
    changes.push(path);
  }

  if (worktree) {
    for (const path of changes) {
      if (target.has(path)) continue;
      if (await worktree.exists(path)) {
        const entry = await worktree.getEntry(path);
        if (!entry?.isDirectory) {
          await worktree.remove(path);
          await pruneEmptyParents(worktree, path);
        }
      }
    }
    const writing = new Set(changes.filter((p) => target.has(p)));
    if (writing.size > 0) {
      const plan = await planTreeRestore(
        ctx.trees,
        ctx.blobs,
        await storeFlatTree(ctx.trees, target),
        "reset",
        {
          symlinks: true,
          windows: worktree.capabilities?.windowsPaths === true,
          reservedNames: worktree.capabilities?.reservedNames,
        },
      );
      await writeTreeRestorePlan(
        worktree,
        ctx.blobs,
        {
          ...plan,
          entries: plan.entries.filter((e) => writing.has(e.path)),
          gitlinks: plan.gitlinks.filter((e) => writing.has(e.path)),
        },
        "reset",
        { symlinks: trust?.symlinks ?? true, gitlinks: true, replaceInTheWay: true },
      );
    }
  }
  const edits = new Map<string, IndexEntryOptions[]>();
  for (const path of changes) {
    const t = target.get(path);
    if (!t) {
      edits.set(path, []);
      continue;
    }
    const stats = worktree ? await worktree.getEntry(path) : undefined;
    edits.set(path, [
      {
        path,
        objectId: t.objectId,
        mode: t.mode,
        ...entryStatOf(stats && !stats.isDirectory ? stats : {}),
      },
    ]);
  }
  await rewriteIndex(ctx.staging, edits);
  return undefined;
}

/**
 * git's autostash (`rebase.autoStash`, `merge.autoStash`): the local changes saved as a
 * stash commit (not on `refs/stash`), the index and worktree reset to HEAD. Undefined when
 * there is nothing to save.
 */
export async function createAutostash(
  ctx: SequencerContext,
  headId: ObjectId,
): Promise<ObjectId | undefined> {
  const id = await new StashCreateCommand(ctx.workingCopy)
    .setRef(null)
    .setMessage("autostash")
    .call();
  if (!id) return undefined;
  await resetMerge(ctx, headId, "HEAD", { hard: true });
  return id;
}

/**
 * Applies an autostash back (`Applied autostash.`); where it conflicts, the stash is kept on
 * `refs/stash` as git keeps it. Returns git's lines.
 */
export async function applyAutostash(ctx: SequencerContext, id: ObjectId): Promise<string[]> {
  try {
    const result = await new StashApplyCommand(ctx.workingCopy).setStashRef(id).call();
    if (result.status === StashApplyStatus.OK) return ["Applied autostash."];
  } catch {
    // refused: kept in the stash below
  }
  const commit = await ctx.commits.load(id);
  await ctx.refs.batch([{ name: STASH_REF, new: id }], {
    ident: commit ? formatPersonIdent(commit.committer) : undefined,
    message: "autostash",
    createReflog: true,
  });
  return [
    "Applying autostash resulted in conflicts.",
    "Your changes are safe in the stash.",
    'You can run "git stash pop" or "git stash drop" at any time.',
  ];
}

/**
 * git's commit message cleanup (`strip`, as `git commit` applies it to an edited message):
 * comment lines dropped, trailing whitespace removed, runs of blank lines collapsed, blank
 * lines at the start and end dropped, a final newline.
 */
export function cleanupMessage(message: string, commentChar = "#"): string {
  const out: string[] = [];
  let blank = false;
  for (const raw of message.split("\n")) {
    if (raw.startsWith(commentChar)) continue;
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      blank = out.length > 0;
      continue;
    }
    if (blank) out.push("");
    blank = false;
    out.push(line);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** git's default date format (`Tue Nov 14 22:13:20 2023 +0000`), in the ident's zone. */
export function formatGitDate(ident: PersonIdent): string {
  const tz = ident.tzOffset || "+0000";
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((ident.timestamp + minutes * 60) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()} ${tz}`;
}

/**
 * git's `SQUASH_MSG`: `Squashed commit of the following:` and the commits `src` has that
 * `head` has not, newest first, as `git log` prints them.
 */
export async function squashMessage(
  commits: CommandCommits,
  headId: ObjectId,
  srcId: ObjectId,
): Promise<string> {
  const reachable = new Set<ObjectId>();
  const stack = [headId];
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const commit = await commits.load(id);
    if (commit) stack.push(...commit.parents);
  }
  const listed: { id: ObjectId; time: number; order: number }[] = [];
  const seen = new Set<ObjectId>();
  const queue = [srcId];
  while (queue.length > 0) {
    const id = queue.shift() as ObjectId;
    if (seen.has(id) || reachable.has(id)) continue;
    seen.add(id);
    const commit = await commits.load(id);
    if (!commit) continue;
    listed.push({ id, time: commit.committer.timestamp, order: listed.length });
    queue.push(...commit.parents);
  }
  listed.sort((a, b) => b.time - a.time || a.order - b.order);
  let out = "Squashed commit of the following:\n";
  for (const { id } of listed) {
    const commit = await commits.load(id);
    if (!commit) continue;
    out += `\ncommit ${id}\n`;
    if (commit.parents.length > 1) {
      out += `Merge: ${commit.parents.map((p) => p.slice(0, 7)).join(" ")}\n`;
    }
    out += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    out += `Date:   ${formatGitDate(commit.author)}\n\n`;
    const body = commit.message.replace(/\n+$/, "");
    out += `${body
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}\n`;
  }
  return out;
}
