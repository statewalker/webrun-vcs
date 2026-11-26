/**
 * `git replay` (builtin/replay.c, replay.c): replays a range of commits onto a new base with
 * merge-ort in memory, writing only objects, then updates the refs the range named (or prints
 * `update-ref --stdin` lines). The worktree and the index are never touched, so it runs in
 * bare repositories too.
 *
 * @example
 * ```typescript
 * // git replay --ref-action=print --onto main topic1..topic2
 * const { stdout, exitCode } = await git
 *   .replay()
 *   .setOnto("main")
 *   .setRefAction("print")
 *   .addRevision("topic1..topic2")
 *   .callOutput();
 * // stdout: "update refs/heads/topic2 <new> <old>\n"; exitCode: 0 clean, 1 conflicted
 *
 * // git replay --advance main topic1..topic2 (cherry-picks onto main and moves main)
 * await git.replay().setAdvance("main").addRevision("topic1..topic2").call();
 * ```
 *
 * The modes: `--onto <newbase>` replays onto a commit and moves the branches the positive
 * revisions name (`--contained`: every local branch at a replayed commit, and a detached HEAD
 * there); `--advance <branch>` replays onto the branch and moves it; `--revert <branch>`
 * reverts the range newest first on the branch (git's `Revert "<subject>"` messages, the
 * current user as author); `--ref <ref>` moves that ref instead. `--linearize` drops merge
 * commits (without it a merge in the range dies). Commits that become empty are dropped.
 * Each replayed commit keeps the original's author, message and extra headers (not its
 * signature) with the current committer. The refs move in one transaction with reflog
 * `replay --onto <id>` / `replay --advance <branch>` / `replay --revert <branch>`, unless
 * `--ref-action=print` (or `replay.refAction=print`) prints `update <ref> <new> <old>` lines.
 * A conflict exits 1 with no output.
 *
 * Version differences (`setCompatibility`): `git replay` is 2.44+. Up to 2.52 it always
 * prints (no `--ref-action`), stops at a root commit, keeps commits that become empty,
 * updates no detached HEAD, prints the lines of the commits replayed before a conflict, and
 * words some refusals otherwise (`option --onto or --advance is mandatory`, `cannot advance
 * target with multiple sources ...`); 2.53 adds `--ref-action` and ref updates. 2.54 adds
 * `--revert`, `--ref`, root commits and dropped empty commits; 2.56 `--linearize`.
 *
 * Divergences: a non-UTF-8 commit's message is copied as stored (git re-encodes it to UTF-8
 * and keeps its `encoding` header); a detached HEAD updated with branches moves after them in
 * a transaction of its own (a batch of HEAD with other refs is not atomic in our stores).
 */

import {
  type Blobs,
  formatPersonIdent,
  isValidRefName,
  type ObjectId,
  overlayMethods,
} from "@statewalker/vcs-core";

import type { CommandTrees } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { coreBool } from "./core-config.js";
import { authorIdentOf, committerIdentOf } from "./git-ident.js";
import { conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import { flatTree, storeFlatTreeOver } from "./merge-support.js";
import { ortResultEntries } from "./ort-merge.js";
import { mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";
import { RevListCommand } from "./rev-list-command.js";

/** The git versions whose `git replay` ours follows (see the module documentation). */
export type ReplayCompatibility = "2.52" | "2.53" | "2.56";

/** `--ref-action`: update the refs (one transaction) or print `update-ref --stdin` lines. */
export type ReplayRefAction = "update" | "print";

/** One ref the replay moves (replay_ref_update). */
interface RefUpdate {
  name: string;
  old: ObjectId;
  new: ObjectId;
}

/** A tree the merge needed and the store lacks (merge-ort's `Could not read`). */
class MissingTree extends Error {
  constructor(readonly id: ObjectId) {
    super(`missing tree ${id}`);
    this.name = "MissingTree";
  }
}

const usage = (line: string) => new PlumbingError(line, 129);
const die = (line: string) => new PlumbingError(`fatal: ${line}`);
const error = (line: string) => new PlumbingError(`error: ${line}`);

/** `git replay`: see the module documentation. */
export class ReplayCommand extends PlumbingCommand {
  private onto?: string;
  private advance?: string;
  private revert?: string;
  private ref?: string;
  private refAction?: string;
  private contained = false;
  private linearize = false;
  private readonly revisions: string[] = [];
  private readonly walkSteps: ((walk: RevListCommand) => void)[] = [];
  private compatibility: ReplayCompatibility = "2.56";

  /** `--onto <newbase>`: replay onto this commit-ish, moving the branches of the range. */
  setOnto(revision: string): this {
    this.checkCallable();
    this.onto = revision;
    return this;
  }

  /** `--advance <branch>`: replay onto the branch and move it to the result. */
  setAdvance(branch: string): this {
    this.checkCallable();
    this.advance = branch;
    return this;
  }

  /** `--revert <branch>` (2.54+): revert the range, newest first, on the branch. */
  setRevert(branch: string): this {
    this.checkCallable();
    this.revert = branch;
    return this;
  }

  /** `--ref <ref>` (2.54+): the fully qualified ref to move instead. */
  setRef(ref: string): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /** `--ref-action <mode>` (2.53+): `update` (the default) or `print`; others die. */
  setRefAction(mode: ReplayRefAction | string): this {
    this.checkCallable();
    this.refAction = mode;
    return this;
  }

  /** `--contained`: move every branch at a replayed commit (with `--onto` only). */
  setContained(contained: boolean): this {
    this.checkCallable();
    this.contained = contained;
    return this;
  }

  /** `--linearize` (2.56+): drop merge commits, replaying the rest as one line. */
  setLinearize(linearize: boolean): this {
    this.checkCallable();
    this.linearize = linearize;
    return this;
  }

  /**
   * A revision argument (`a..b`, `^a`, `a^!`, `--branches`, `--not`...), as
   * `git rev-list` reads it.
   */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisions.push(revision);
    return this;
  }

  /** Other rev-list options of the walk (`--ancestry-path=<commit>`: `addAncestryPath`). */
  configureWalk(step: (walk: RevListCommand) => void): this {
    this.checkCallable();
    this.walkSteps.push(step);
    return this;
  }

  /** The git version to follow (default 2.56; see the module documentation). */
  setCompatibility(version: ReplayCompatibility): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  protected async run(): Promise<number> {
    const v = this.compatibility;
    const modern = v === "2.56";
    // parse_options: options a version lacks are left for setup_revisions, which refuses them
    if (!modern) {
      const unknown =
        this.revert !== undefined
          ? `--revert=${this.revert}`
          : this.ref !== undefined
            ? `--ref=${this.ref}`
            : this.linearize
              ? "--linearize"
              : v === "2.52" && this.refAction !== undefined
                ? `--ref-action=${this.refAction}`
                : undefined;
      if (this.onto === undefined && this.advance === undefined) {
        throw usage("error: option --onto or --advance is mandatory");
      }
      if (this.advance !== undefined && this.contained) {
        throw die("options '--advance' and '--contained' cannot be used together");
      }
      if (unknown !== undefined) throw error(`unrecognized argument: ${unknown}`);
    } else {
      if (this.onto === undefined && this.advance === undefined && this.revert === undefined) {
        throw usage("error: exactly one of --onto, --advance, or --revert is required");
      }
      incompatible([
        [this.onto !== undefined, "--onto"],
        [this.advance !== undefined, "--advance"],
        [this.revert !== undefined, "--revert"],
      ]);
      incompatible([
        [this.advance !== undefined, "--advance"],
        [this.contained, "--contained"],
      ]);
      incompatible([
        [this.revert !== undefined, "--revert"],
        [this.contained, "--contained"],
      ]);
      incompatible([
        [this.ref !== undefined, "--ref"],
        [this.contained, "--contained"],
      ]);
      incompatible([
        [this.linearize, "--linearize"],
        [this.contained, "--contained"],
      ]);
    }
    const print = v === "2.52" || this.refActionMode() === "print";

    // setup_revisions, then the replay's mode from the command line's revisions
    const walk = new RevListCommand(this._workingCopy);
    for (const step of this.walkSteps) step(walk);
    for (const revision of this.revisions) walk.addRevision(revision);
    const reverting = modern && this.revert !== undefined;
    walk.setOrder("topo").setReverse(!reverting).setFullHistory(true);
    const { entries } = await walk.resolve();

    const resolver = this.revisionResolver();
    const positiveRefs = new Set<string>();
    let positive = 0;
    for (const entry of entries) {
      if (entry.exclude) continue;
      positive++;
      const name = entry.name ?? entry.id;
      const found = await resolver.dwimRef(name).catch(() => []);
      if (found.length === 1) positiveRefs.add((found[0] as { ref: string }).ref);
    }
    const head = await this.refsStore.get("HEAD").catch(() => undefined);
    const detachedHead = !(head !== undefined && "target" in head);
    if (positive === 0) throw die("need some commits to replay");

    let onto: ObjectId | undefined;
    let branch: string | undefined;
    let updateRefs: Set<string> | undefined;
    if (!modern && this.onto !== undefined && this.advance !== undefined) {
      throw die("options '--onto' and '--advance' cannot be used together");
    }
    if (this.onto !== undefined) {
      onto = await this.peelCommittish(this.onto, "--onto");
      updateRefs = positiveRefs;
    } else {
      const option = this.advance !== undefined ? "--advance" : "--revert";
      const name = (this.advance ?? this.revert) as string;
      const found = await resolver.dwimRef(name).catch(() => []);
      if (v === "2.52") onto = await this.peelCommittish(name, option);
      if (found.length !== 1) throw die(`argument to ${option} must be a reference`);
      branch = (found[0] as { ref: string }).ref;
      if (v !== "2.52") onto = await this.peelCommittish(branch, option);
      if (positive > 1) {
        throw die(
          modern
            ? `'${option}' cannot be used with multiple revision ranges because the ordering would be ill-defined`
            : "cannot advance target with multiple sources because ordering would be ill-defined",
        );
      }
    }
    if (onto === undefined) throw die("Replaying down to root commit is not supported yet!");

    let ref: string | undefined = branch;
    let refOld: ObjectId = onto;
    if (modern) {
      if (this.linearize && updateRefs && updateRefs.size > 1) {
        throw error("'--linearize' cannot be used with multiple branches");
      }
      if (this.ref !== undefined) {
        if (updateRefs && updateRefs.size > 1) {
          throw error("'--ref' cannot be used with multiple revision ranges");
        }
        if (!isValidRefName(this.ref) || !this.ref.startsWith("refs/")) {
          throw error(`'${this.ref}' is not a valid refname`);
        }
        ref = this.ref;
        const current = await this.refsStore.resolve(this.ref).catch(() => undefined);
        refOld = current?.objectId ?? this.objectFormat.nullId;
      }
    }

    // the walk
    const decorations = await this.localDecorations(modern && detachedHead);
    const replayed = new Map<ObjectId, ObjectId>();
    const updates: RefUpdate[] = [];
    let last: ObjectId | undefined = onto;
    let clean = true;
    const stores = this.mergeStores();
    const log = await walk.call();
    for await (const commit of log) {
      const parents = commit.parents;
      if (!modern && parents.length === 0) {
        throw die(
          v === "2.52"
            ? "replaying down to root commit is not supported yet!"
            : "replaying down from root commit is not supported yet!",
        );
      }
      if (parents.length > 1) {
        if (!this.linearize) throw die("replaying merge commits is not supported yet!");
      } else {
        const parent = parents[0];
        let base = (parent !== undefined ? replayed.get(parent) : undefined) ?? onto;
        if (this.linearize || reverting) base = last as ObjectId;
        last = await this.pick(stores, commit.id, parent, base, reverting);
      }
      if (last === undefined) {
        clean = false;
        break;
      }
      replayed.set(commit.id, last);
      if (ref !== undefined) continue;
      for (const name of decorations.get(commit.id) ?? []) {
        if (!this.contained && !updateRefs?.has(name)) continue;
        const update = { name, old: commit.id, new: last };
        // git 2.52 prints as it goes, 2.53 in its print mode too
        if (!modern && print) await this.write(updateLine(update));
        else updates.push(update);
      }
    }
    if (!clean) return 1;
    if (ref !== undefined) {
      const update = { name: ref, old: refOld, new: last as ObjectId };
      if (!modern && print) await this.write(updateLine(update));
      else updates.push(update);
    }

    if (print) {
      for (const update of updates) await this.write(updateLine(update));
      return 0;
    }
    let message: string;
    if (reverting) message = `replay --revert ${this.revert}`;
    else if (this.advance !== undefined) message = `replay --advance ${this.advance}`;
    else message = `replay --onto ${onto}`;
    await this.applyUpdates(updates, message);
    return 0;
  }

  /** get_ref_action_mode: the option, else `replay.refAction`, else `update`. */
  private refActionMode(): ReplayRefAction {
    const parse = (value: string, source: string): ReplayRefAction => {
      if (value === "update" || value === "print") return value;
      throw die(`invalid ${source} value: '${value}'`);
    };
    if (this.refAction !== undefined) return parse(this.refAction, "--ref-action");
    const value = RemoteConfigStore.from(this._workingCopy).value("replay.refAction");
    if (value !== undefined) return parse(value, "replay.refAction");
    return "update";
  }

  /** peel_committish: the commit a commit-ish names, or git's death for the option. */
  private async peelCommittish(name: string, option: string): Promise<ObjectId | undefined> {
    const resolver = this.revisionResolver();
    const id = await resolver.resolve(name).catch(() => undefined);
    if (id === undefined) {
      // git 2.52 left onto unset (its later death: no root commits)
      if (this.compatibility === "2.52") return undefined;
      throw die(`'${name}' is not a valid commit-ish for ${option}`);
    }
    const commit = await resolver.commitReference(id).catch(() => undefined);
    if (commit === undefined) {
      if (this.compatibility === "2.52") return undefined;
      throw die(`'${name}' does not point to a commit for ${option}`);
    }
    return commit;
  }

  /**
   * get_name_decoration for each commit, the local branches and (`withHead`, a detached HEAD)
   * HEAD: load_ref_decorations adds refs in name order, then HEAD, each in front of the
   * commit's list.
   */
  private async localDecorations(withHead: boolean): Promise<Map<ObjectId, string[]>> {
    const out = new Map<ObjectId, string[]>();
    const add = (id: ObjectId, name: string) => {
      const list = out.get(id);
      if (list) list.unshift(name);
      else out.set(id, [name]);
    };
    const names: string[] = [];
    for await (const ref of this.refsStore.list("refs/heads/")) names.push(ref.name);
    names.sort(compareBytes);
    for (const name of names) {
      const resolved = await this.refsStore.resolve(name).catch(() => undefined);
      const id = resolved?.objectId;
      if (id === undefined) continue;
      const commit = await this.revisionResolver()
        .commitReference(id)
        .catch(() => undefined);
      if (commit === id) add(id, name);
    }
    if (withHead) {
      const id = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
      if (id !== undefined) add(id, "HEAD");
    }
    return out;
  }

  /**
   * pick_regular_commit: merges the commit's change onto `base` (reverted: its inverse) and
   * writes the result commit; undefined on a conflict, `base` itself when the change is
   * already there (2.54+).
   */
  private async pick(
    stores: { trees: CommandTrees; blobs: Blobs },
    id: ObjectId,
    parent: ObjectId | undefined,
    base: ObjectId,
    reverting: boolean,
  ): Promise<ObjectId | undefined> {
    const { trees, blobs } = stores;
    const pickTree = await this.commits.getTree(id);
    const parentTree =
      parent !== undefined ? await this.commits.getTree(parent) : this.objectFormat.emptyTreeId;
    const baseTree = await this.commits.getTree(base);
    const pickName = await this.abbreviateObjectId(id);
    const baseName = await this.abbreviateObjectId(base);
    const worktree = this.worktreeOrNone();
    const common = {
      style: conflictStyleOf(this.workingCopy),
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      ...ortConfigOptions(this.workingCopy, worktree),
    };
    const [ancestorTree, theirsTree, ancestorLabel, theirsLabel] = reverting
      ? [pickTree, parentTree, pickName, `parent of ${pickName}`]
      : [
          parentTree,
          pickTree,
          parent !== undefined ? `parent of ${pickName}` : "empty tree",
          pickName,
        ];
    let merge: Awaited<ReturnType<typeof mergeStoredTrees>>;
    try {
      merge = await mergeStoredTrees(
        { trees, blobs },
        storedBase(ancestorTree, ancestorLabel, () => flatTree(trees, ancestorTree)),
        baseTree,
        theirsTree,
        { ...common, oursLabel: baseName, theirsLabel, baseLabel: ancestorLabel },
      );
    } catch (e) {
      if (e instanceof MissingTree) {
        throw new PlumbingError(
          [
            `error: Could not read ${e.id}`,
            `error: collecting merge info failed for trees ${ancestorTree}, ${baseTree}, ${theirsTree}`,
            `error: merge of ${id} onto ${base} failed`,
          ].join("\n"),
        );
      }
      throw e;
    }
    // merge-ort writes its result tree (and conflicted blobs) whether clean or not
    const target = await ortResultEntries(blobs, merge);
    const resultTree = await storeFlatTreeOver(trees, baseTree, merge.ours, target);
    if (!merge.clean) return undefined;
    if (this.compatibility === "2.56" && resultTree === baseTree && pickTree !== parentTree) {
      return base;
    }
    return this.createCommit(id, resultTree, base, reverting);
  }

  /** create_commit: the original's author, message and extra headers on the new tree. */
  private async createCommit(
    id: ObjectId,
    tree: ObjectId,
    parent: ObjectId,
    reverting: boolean,
  ): Promise<ObjectId> {
    const objects = this._workingCopy.history?.objects;
    if (!objects) throw new Error("WorkingCopy.history.objects is required for git replay");
    const raw = latin1(await this.readObject(id));
    const split = raw.indexOf("\n\n");
    const headerText = split >= 0 ? raw.slice(0, split) : raw;
    const lines = headerText.split("\n");
    const excluded = new Set(["tree", "parent", "author", "committer", "gpgsig"]);
    if (this.compatibility !== "2.52") excluded.add("gpgsig-sha256");
    let author: string | undefined;
    let extra = "";
    let keep = false;
    for (const line of lines) {
      if (line.startsWith(" ")) {
        if (keep) extra += `${line}\n`;
        continue;
      }
      const space = line.indexOf(" ");
      const key = space >= 0 ? line.slice(0, space) : line;
      if (key === "author" && author === undefined) author = line.slice(space + 1);
      keep = !excluded.has(key);
      if (keep) extra += `${line}\n`;
    }
    const now = Math.floor(Date.now() / 1000);
    let message: string;
    const body = split >= 0 ? skipBlankLines(raw, split + 2) : "";
    if (reverting) {
      const subject = body.slice(0, body.indexOf("\n") >= 0 ? body.indexOf("\n") : body.length);
      let text: string;
      if (subject.startsWith('Revert "') && !subject.slice(8).startsWith('Revert "')) {
        text = `Reapply "${subject.slice(8)}\n`;
      } else {
        text = `Revert "${subject}"\n`;
      }
      message = `${text}\nThis reverts commit ${id}.\n`;
      author = latin1(utf8(formatPersonIdent(authorIdentOf(this._workingCopy, { now }))));
    } else {
      message = body;
    }
    const committer = latin1(utf8(formatPersonIdent(committerIdentOf(this._workingCopy, { now }))));
    const text =
      `tree ${tree}\nparent ${parent}\nauthor ${author ?? ""}\ncommitter ${committer}\n` +
      `${extra}\n${message}`;
    const bytes = latin1Bytes(text);
    return objects.put("commit", bytes.length, [bytes]);
  }

  /** The object's content as stored. */
  private async readObject(id: ObjectId): Promise<Uint8Array> {
    const objects = this._workingCopy.history?.objects;
    const object = await objects?.get(id);
    if (!object) throw die(`unable to read ${id}`);
    if (object.bytes) return object.bytes;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of object.content) {
      chunks.push(c);
      size += c.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /** The refs moved in one transaction (a detached HEAD in a second one: see the module). */
  private async applyUpdates(updates: RefUpdate[], message: string): Promise<void> {
    if (updates.length === 0) return;
    const nullId = this.objectFormat.nullId;
    const command = (u: RefUpdate) => ({
      name: u.name,
      old: u.old === nullId ? null : u.old,
      new: u.new,
      ...(u.name === "HEAD" ? { noDeref: true } : {}),
    });
    const refsFirst = updates.filter((u) => u.name.startsWith("refs/"));
    const others = updates.filter((u) => !u.name.startsWith("refs/"));
    const batches = refsFirst.length > 0 && others.length > 0 ? [refsFirst, others] : [updates];
    for (const batch of batches) {
      const result = await this.refsStore.batch(batch.map(command), this.reflogLine(message));
      if (!result.ok) {
        const rejected = result.rejected[0];
        const name = rejected?.name ?? (batch[0] as RefUpdate).name;
        const update = batch.find((u) => u.name === name);
        let reason = `cannot lock ref '${name}'`;
        if (rejected?.reason === "mismatch" && update) {
          const current = await this.refsStore.resolve(name).catch(() => undefined);
          reason += current?.objectId
            ? `: is at ${current.objectId} but expected ${update.old}`
            : `: unable to resolve reference '${name}'`;
        }
        throw error(`failed to commit ref transaction: ${reason}`);
      }
    }
  }

  /** The stores the merge reads: a missing tree is merge-ort's `Could not read`. */
  private mergeStores(): { trees: CommandTrees; blobs: Blobs } {
    const trees = this.trees;
    const wrapped = overlayMethods(trees, {
      loadTree: async function* (id: ObjectId) {
        if (!(await trees.has(id))) throw new MissingTree(id);
        yield* trees.loadTree(id);
      },
    });
    return { trees: wrapped, blobs: this.blobs };
  }

  /** The worktree, none in a bare repository (its attributes are read from it). */
  private worktreeOrNone() {
    try {
      return this.worktreeAccess;
    } catch {
      return undefined;
    }
  }
}

/** die_for_incompatible_opt4's message for the options set. */
function incompatible(options: [boolean, string][]): void {
  const set = options.filter(([on]) => on).map(([, name]) => `'${name}'`);
  if (set.length < 2) return;
  if (set.length === 2) throw die(`options ${set[0]} and ${set[1]} cannot be used together`);
  throw die(
    `options ${set.slice(0, -1).join(", ")}, and ${set[set.length - 1]} cannot be used together`,
  );
}

const updateLine = (u: RefUpdate) => `update ${u.name} ${u.new} ${u.old}\n`;

/** commit.c's skip_blank_lines from `at`: lines of whitespace alone are dropped. */
function skipBlankLines(text: string, at: number): string {
  let p = at;
  for (;;) {
    let q = p;
    while (q < text.length && text[q] !== "\n" && /\s/.test(text[q] as string)) q++;
    if (q < text.length && text[q] === "\n") p = q + 1;
    else break;
  }
  return text.slice(p);
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bytes as a string of one character per byte. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
