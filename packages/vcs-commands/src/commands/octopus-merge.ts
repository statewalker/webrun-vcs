/**
 * git's octopus strategy (`git merge A B C`, git-merge-octopus.sh): the heads merged one
 * after the other into the running result, each first as a trivial merge
 * (`read-tree -m --aggressive` against its merge bases), the paths that are not trivial
 * then merged file by file (`merge-index -o git-merge-one-file -a`). Only the last head may
 * leave conflicts to resolve by hand; a conflict with an earlier head makes the octopus give
 * up ("Should not be doing an octopus."), as does a dirty index.
 *
 * Computed in memory: the caller writes the outcome (index, worktree, MERGE_HEAD) or, when
 * the strategy gave up, leaves everything as it was (git's restore_state).
 */

import { type Blobs, EMPTY_BLOB_ID, type ObjectId } from "@statewalker/vcs-core";
import { type ConflictStyle, mergeLines } from "@statewalker/vcs-utils";

import type { CommandCommits, CommandTrees } from "../git-command.js";
import { isBinaryContent } from "../rename/index.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { flatTree } from "./merge-support.js";
import { type OrtConflict, readBlob } from "./ort-merge.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** A head to merge and the name git's messages give it (as the user named it). */
export interface OctopusHead {
  id: ObjectId;
  name: string;
}

/** What the octopus did. */
export interface OctopusOutcome {
  /** git-merge-octopus's exit: 0 merged, 1 conflicts left (last head), 2 gave up */
  status: 0 | 1 | 2;
  /** What it printed on stdout */
  output: string[];
  /** What it printed on stderr */
  errors: string[];
  /** The index's stage-0 entries */
  index: Map<string, CheckedEntry>;
  /** The worktree where it differs from the index (files with conflict markers) */
  worktree: Map<string, CheckedEntry>;
  /** The conflicts left, staged 1-3 */
  conflicts: OrtConflict[];
  /**
   * Per head merged (not already up to date): how much of `output` the script had printed
   * once it went for that head, and the paths that head changed in the index or worktree.
   * The script writes the worktree head by head, so a local change in the way stops it at
   * the first head that touches it.
   */
  steps: { output: number; paths: Set<string> }[];
}

/** What the octopus needs. */
export interface OctopusContext {
  commits: CommandCommits;
  trees: CommandTrees;
  blobs: Blobs;
  style?: ConflictStyle;
}

const same = (a?: CheckedEntry, b?: CheckedEntry) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;
const octal = (e?: CheckedEntry) => (e ? e.mode.toString(8) : "");

/** One path of `read-tree -m --aggressive`: merged, removed, or its stages (threeway_merge). */
type Threeway =
  | { kind: "merged"; entry: CheckedEntry }
  | { kind: "removed" }
  | { kind: "stages"; base?: CheckedEntry; ours?: CheckedEntry; theirs?: CheckedEntry };

function threeway(
  bases: (CheckedEntry | undefined)[],
  head: CheckedEntry | undefined,
  remote: CheckedEntry | undefined,
): Threeway {
  let headMatch = 0;
  let remoteMatch = 0;
  const anyAncMissing = bases.some((b) => !b);
  const noAncExists = bases.every((b) => !b);
  if (!same(remote, head)) {
    bases.forEach((b, i) => {
      if (same(b, head)) headMatch = i + 1;
      if (same(b, remote)) remoteMatch = i + 1;
    });
  }
  if (remote && headMatch && !remoteMatch) return { kind: "merged", entry: remote };
  if (head) {
    if (same(head, remote)) return { kind: "merged", entry: head };
    if (remoteMatch && !headMatch) return { kind: "merged", entry: head };
  }
  if (!head && !remote && anyAncMissing) return { kind: "removed" };
  // --aggressive: a deletion against an unchanged side, an identical addition
  if ((!head && !remote) || (!head && remote && remoteMatch) || (!remote && head && headMatch)) {
    return { kind: "removed" };
  }
  if (noAncExists && head && remote && same(head, remote)) return { kind: "merged", entry: head };
  const base = !headMatch || !remoteMatch ? bases.find((b) => b) : undefined;
  return { kind: "stages", base, ours: head, theirs: remote };
}

/**
 * Runs git-merge-octopus for `heads` on top of `headId` (the index matching HEAD's tree,
 * `indexDiffers` listing the paths where it does not).
 */
export async function octopusMerge(
  ctx: OctopusContext,
  headId: ObjectId,
  heads: OctopusHead[],
  indexDiffers: string[],
): Promise<OctopusOutcome> {
  const output: string[] = [];
  const errors: string[] = [];
  const outcome = (status: 0 | 1 | 2, extra: Partial<OctopusOutcome> = {}): OctopusOutcome => ({
    status,
    output,
    errors,
    index: new Map(),
    worktree: new Map(),
    conflicts: [],
    steps,
    ...extra,
  });
  const steps: OctopusOutcome["steps"] = [];
  const changed = (
    before: Map<string, CheckedEntry>,
    after: Map<string, CheckedEntry>,
    extra: Map<string, CheckedEntry> = new Map(),
  ) => {
    const paths = new Set<string>();
    for (const p of new Set([...before.keys(), ...after.keys(), ...extra.keys()])) {
      if (!same(before.get(p), extra.get(p) ?? after.get(p))) paths.add(p);
    }
    return paths;
  };
  if (indexDiffers.length > 0) {
    output.push(
      "Error: Your local changes to the following files would be overwritten by merge",
      ...indexDiffers.map((p) => `    ${p}`),
    );
    return outcome(2);
  }
  const graph = new MergeBaseGraph(
    commitsBaseSource(ctx.commits, async (id) =>
      flatTree(ctx.trees, await ctx.commits.getTree(id)),
    ),
  );
  const treeOf = async (id: ObjectId) => flatTree(ctx.trees, await ctx.commits.getTree(id));
  let mrc: ObjectId[] = [headId];
  let index = await treeOf(headId);
  let worktree = new Map<string, CheckedEntry>();
  let conflicts: OrtConflict[] = [];
  let nonFf = false;
  let failure = false;
  let temp = 0;
  const tempName = () => `.merge_file_${(++temp).toString(36).padStart(6, "0")}`;
  for (const head of heads) {
    if (failure) {
      output.push("Automated merge did not work.", "Should not be doing an octopus.");
      return outcome(2);
    }
    const common = (
      await graph.mergeBasesMany(
        graph.commit(head.id),
        mrc.map((id) => graph.commit(id)),
      )
    ).map((n) => n.id as ObjectId);
    if (common.length === 0) {
      // the script's `die` (exit 1): what is merged so far stays, as a merge with conflicts
      errors.push(`Unable to find common commit with ${head.name}`);
      return outcome(1, { index, worktree, conflicts });
    }
    if (common.includes(head.id)) {
      output.push(`Already up to date with ${head.name}`);
      continue;
    }
    if (!nonFf && common.length === 1 && mrc.length === 1 && common[0] === mrc[0]) {
      // the first head is a fast-forward: its tree is the running result
      output.push(`Fast-forwarding to: ${head.name}`);
      const ff = await treeOf(head.id);
      steps.push({ output: output.length, paths: changed(index, ff) });
      index = ff;
      mrc = [head.id];
      continue;
    }
    nonFf = true;
    output.push(`Trying simple merge with ${head.name}`);
    const step = { output: output.length, paths: new Set<string>() };
    steps.push(step);
    const bases = await Promise.all(common.map((id) => treeOf(id)));
    const remote = await treeOf(head.id);
    const paths = new Set<string>([...index.keys(), ...remote.keys()]);
    for (const b of bases) for (const p of b.keys()) paths.add(p);
    const next = new Map<string, CheckedEntry>();
    const staged: {
      path: string;
      base?: CheckedEntry;
      ours?: CheckedEntry;
      theirs?: CheckedEntry;
    }[] = [];
    for (const path of [...paths].sort()) {
      const r = threeway(
        bases.map((b) => b.get(path)),
        index.get(path),
        remote.get(path),
      );
      if (r.kind === "merged") next.set(path, r.entry);
      else if (r.kind === "stages")
        staged.push({ path, base: r.base, ours: r.ours, theirs: r.theirs });
    }
    worktree = new Map();
    conflicts = [];
    if (staged.length > 0) {
      output.push("Simple merge did not work, trying automatic merge.");
      let failed = false;
      for (const s of staged) {
        const ok = await mergeOneFile(ctx, s, next, worktree, conflicts, output, errors, tempName);
        if (!ok) failed = true;
      }
      if (failed) {
        errors.push("fatal: merge program failed");
        failure = true;
      }
    }
    step.paths = changed(index, next, worktree);
    index = next;
    mrc = [...mrc, head.id];
  }
  return outcome(failure ? 1 : 0, { index, worktree, conflicts });
}

/** git-merge-one-file for one unmerged path; false when it is left unmerged. */
async function mergeOneFile(
  ctx: OctopusContext,
  s: { path: string; base?: CheckedEntry; ours?: CheckedEntry; theirs?: CheckedEntry },
  index: Map<string, CheckedEntry>,
  worktree: Map<string, CheckedEntry>,
  conflicts: OrtConflict[],
  output: string[],
  errors: string[],
  tempName: () => string,
): Promise<boolean> {
  const { path, base: o, ours: a, theirs: b } = s;
  const leave = () => {
    conflicts.push({
      stagePath: path,
      mode: (a ?? b ?? o)?.mode ?? 0,
      ...(o ? { base: o } : {}),
      ...(a ? { ours: a } : {}),
      ...(b ? { theirs: b } : {}),
      ...(a ? { tree: a } : {}),
    });
    // the worktree keeps what it had (ours)
    if (a) worktree.set(path, a);
    return false;
  };
  const [m1, m2, m3] = [octal(o), octal(a), octal(b)];
  // deleted in both, or deleted in one and unchanged in the other
  if (
    o &&
    ((!a && !b) || (!a && b?.objectId === o.objectId) || (!b && a?.objectId === o.objectId))
  ) {
    if ((!a && m1 !== m3) || (!b && m1 !== m2)) {
      errors.push(
        `ERROR: File ${path} deleted on one branch but had its`,
        "ERROR: permissions changed on the other.",
      );
      return leave();
    }
    if (a) output.push(`Removing ${path}`);
    return true;
  }
  if (!o && a && !b) {
    index.set(path, a);
    return true;
  }
  if (!o && !a && b) {
    output.push(`Adding ${path}`);
    index.set(path, b);
    return true;
  }
  if (!o && a && b && a.objectId === b.objectId) {
    if (m2 !== m3) {
      errors.push(
        `ERROR: File ${path} added identically in both branches,`,
        `ERROR: but permissions conflict ${m2}->${m3}.`,
      );
      return leave();
    }
    output.push(`Adding ${path}`);
    index.set(path, a);
    return true;
  }
  if (a && b) {
    if (m2 === "120000" || m3 === "120000") {
      errors.push(`ERROR: ${path}: Not merging symbolic link changes.`);
      return leave();
    }
    if (m2 === "160000" || m3 === "160000") {
      errors.push(`ERROR: ${path}: Not merging conflicting submodule changes.`);
      return leave();
    }
    const [n1, n2] = [tempName(), tempName()];
    output.push(o ? `Auto-merging ${path}` : `Added ${path} in both, but differently.`);
    if (!o && !(await ctx.blobs.has(EMPTY_BLOB_ID))) {
      // the script's base is the empty blob, which `hash-object` never stored: unpack-file
      // and merge-file fail, ours stays in the worktree
      errors.push(
        `fatal: unable to read blob object ${EMPTY_BLOB_ID}`,
        "error: Could not stat : No such file or directory",
        `ERROR: content conflict in ${path}`,
      );
      return leave();
    }
    const nO = tempName();
    const contents = {
      ours: await readBlob(ctx.blobs, a.objectId),
      base: o ? await readBlob(ctx.blobs, o.objectId) : new Uint8Array(0),
      theirs: await readBlob(ctx.blobs, b.objectId),
    };
    // `git merge-file` reads its three files in order and stops at the first binary one
    // ("Cannot merge binary files: <its temporary name>"), leaving ours in the worktree
    const binary = (
      [
        [contents.ours, n1],
        [contents.base, nO],
        [contents.theirs, n2],
      ] as const
    ).find(([content]) => isBinaryContent(content));
    if (binary) {
      errors.push(`error: Cannot merge binary files: ${binary[1]}`);
      let msg = "content conflict";
      if (m2 !== m3) msg = `${msg}, permissions conflict: ${m1}->${m2},${m3}`;
      errors.push(`ERROR: ${msg} in ${path}`);
      conflicts.push({
        stagePath: path,
        mode: a.mode,
        ...(o ? { base: o } : {}),
        ours: a,
        theirs: b,
        tree: a,
      });
      worktree.set(path, a);
      return false;
    }
    const merged = mergeLines(contents.base, contents.ours, contents.theirs, {
      oursLabel: n1,
      baseLabel: nO,
      theirsLabel: n2,
      style: ctx.style,
      algorithm: "myers",
      level: "zealous-alnum",
    });
    const objectId = await ctx.blobs.store([merged.content]);
    // the worktree file: ours (its mode), holding the merge's result
    const result = { objectId, mode: a.mode };
    let msg = merged.conflicts > 0 || !o ? "content conflict" : "";
    if (m2 !== m3) msg = `${msg ? `${msg}, ` : ""}permissions conflict: ${m1}->${m2},${m3}`;
    if (msg) {
      errors.push(`ERROR: ${msg} in ${path}`);
      conflicts.push({
        stagePath: path,
        mode: a.mode,
        ...(o ? { base: o } : {}),
        ours: a,
        theirs: b,
        tree: result,
      });
      worktree.set(path, result);
      return false;
    }
    index.set(path, result);
    return true;
  }
  errors.push(
    `ERROR: ${path}: Not handling case ${o?.objectId ?? ""} -> ${a?.objectId ?? ""} -> ${b?.objectId ?? ""}`,
  );
  return leave();
}
