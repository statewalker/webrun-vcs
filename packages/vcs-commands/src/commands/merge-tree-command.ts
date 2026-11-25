/**
 * `git merge-tree` (builtin/merge-tree.c): merge-ort in memory, writing only the objects of
 * its result (`--write-tree`), or the old three-tree "trivial merge" that writes nothing and
 * prints what a merge would do path by path. Neither touches refs, the index or the worktree.
 *
 * @example
 * ```typescript
 * // git merge-tree --write-tree side1 side2
 * const { stdout, exitCode } = await git.mergeTree().setBranches("side1", "side2").callOutput();
 * // stdout: "<tree>\n<mode> <id> <stage>\t<path>\n...\n\nAuto-merging ...\nCONFLICT ...\n"
 * // exitCode: 0 clean, 1 conflicted
 *
 * // git merge-tree <base-tree> <branch1> <branch2> (the trivial merge)
 * await git.mergeTree().setTrivialMerge("initial", "a", "b").callOutput();
 * ```
 *
 * `--write-tree` prints the result tree's id, then (on conflicts) the conflicted index entries
 * (`<mode> <id> <stage>\t<path>`, or the paths alone with {@link setNameOnly}), then a blank
 * line and merge-ort's messages (`--messages`, on by default for a conflicted merge). With
 * `-z` ({@link setNulTerminated}) records end in NUL and each message comes as
 * `<path count>\0<paths...>\0<type>\0<message>\n\0` (merge_display_update_messages' detailed
 * form). `--stdin` ({@link setStdin}) merges one `<b1> <b2>` or `<base> -- <b1> <b2>` line
 * after another, each answer prefixed by its clean flag and followed by a NUL.
 *
 * The trivial merge (`trivial_merge_trees`) walks the three trees in step and lists each path
 * neither side alone decides (`added in remote`, `changed in both`, ...) with its stages and
 * the diff from our version to `merge_blobs`' result (markers `.our` and `.their`, xdiff's
 * default Myers diff, three lines of context).
 *
 * Version differences (`setCompatibility`): git 2.43 takes its two branches as commits even
 * with `--merge-base` (2.5x takes any tree-ish), its merge base as a commit (`could not lookup
 * commit`), has no `--quiet`, and words the `--merge-base`/`--stdin` refusal otherwise.
 */

import { type Blobs, type ObjectId, overlayMethods } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { unifiedDiff } from "@statewalker/vcs-utils/diff";
import type { Worktree } from "@statewalker/vcs-working-tree";

import { RefNotFoundError } from "../errors/index.js";
import type { CommandTrees } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import { coreBool } from "./core-config.js";
import { relativePath } from "./git-paths.js";
import { conflictStyleOf } from "./merge-config.js";
import { lowLevelMerge, ortConfigOptions } from "./merge-drivers.js";
import { parseStrategyOptions, strategyOrtOptions } from "./merge-strategy-options.js";
import { flatTree, storeFlatTree, storeFlatTreeOver } from "./merge-support.js";
import { ortResultEntries, readBlob } from "./ort-merge.js";
import { mergeBaseTree, mergeStoredTrees, storedBase } from "./ort-recursive.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";
import { remergeObjectsView } from "./remerge-diff.js";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const isDir = (mode: number) => (mode & S_IFMT) === S_IFDIR;

/** One version of a path in the trivial merge (merge-tree.c's merge_list). */
interface TrivialEntry {
  /** 0 result, 1 base, 2 ours, 3 theirs */
  stage: 0 | 1 | 2 | 3;
  mode: number;
  id: ObjectId;
  path: string;
  link?: TrivialEntry;
}

/** A tree entry of one of the three trees at a name (none: mode 0). */
interface NameEntry {
  mode: number;
  id: ObjectId;
}

const NONE: NameEntry = { mode: 0, id: "" };

/** Which merge `git merge-tree` runs. */
export type MergeTreeMode = "write-tree" | "trivial";

/** `git merge-tree`: see the module documentation. */
export class MergeTreeCommand extends PlumbingCommand {
  private mode: MergeTreeMode = "write-tree";
  private branches?: [string, string];
  private baseTree?: string;
  private messages?: boolean;
  private nameOnly = false;
  private nul = false;
  private allowUnrelated = false;
  private quiet = false;
  private mergeBase?: string;
  private stdinText?: string;
  private readonly strategyOptions: string[] = [];
  private compatibility: "2.43" | "2.56" = "2.56";
  private prefix = "";
  /** Whether an option besides the mode was given (`--trivial-merge` takes none) */
  private otherOptions = false;

  /** The two commits (or, with {@link setMergeBase} in 2.5x, tree-ishes) to merge. */
  setBranches(branch1: string, branch2: string): this {
    this.checkCallable();
    this.mode = "write-tree";
    this.branches = [branch1, branch2];
    return this;
  }

  /** `git merge-tree [--trivial-merge] <base-tree> <branch1> <branch2>`: the old mode. */
  setTrivialMerge(baseTree: string, branch1: string, branch2: string): this {
    this.checkCallable();
    this.mode = "trivial";
    this.baseTree = baseTree;
    this.branches = [branch1, branch2];
    return this;
  }

  /** `--write-tree` / `--trivial-merge` without changing the arguments. */
  setMode(mode: MergeTreeMode): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  /** `--[no-]messages` (default: shown for a conflicted merge only). */
  setMessages(messages: boolean): this {
    this.checkCallable();
    this.messages = messages;
    this.otherOptions = true;
    return this;
  }

  /** `--name-only`: conflicted paths without modes, ids and stages. */
  setNameOnly(nameOnly: boolean): this {
    this.checkCallable();
    this.nameOnly = nameOnly;
    this.otherOptions = true;
    return this;
  }

  /** `-z`: NUL-terminated records, paths unquoted, detailed messages. */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nul = nul;
    this.otherOptions = true;
    return this;
  }

  /** `--allow-unrelated-histories`: merge against the empty tree when there is no base. */
  setAllowUnrelatedHistories(allow: boolean): this {
    this.checkCallable();
    this.allowUnrelated = allow;
    this.otherOptions = true;
    return this;
  }

  /**
   * `--quiet` (2.5x): no output, only the exit status; nothing is written to the object
   * store (merge-ort's mergeability_only).
   */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    this.otherOptions = true;
    const history = this.workingCopy.history;
    if (quiet && history) this.setObjectsView(remergeObjectsView(history));
    return this;
  }

  /** `--merge-base=<tree-ish>`: merge against it instead of the computed merge bases. */
  setMergeBase(mergeBase: string): this {
    this.checkCallable();
    this.mergeBase = mergeBase;
    this.otherOptions = true;
    return this;
  }

  /** `--stdin` with its input: one merge per line. */
  setStdin(input: string): this {
    this.checkCallable();
    this.stdinText = input;
    this.otherOptions = true;
    return this;
  }

  /** `-X <option>` (merge-ort's parse_merge_opt). */
  addStrategyOption(option: string): this {
    this.checkCallable();
    this.strategyOptions.push(option);
    return this;
  }

  /**
   * The current directory below the top of the worktree (`sub/dir/`): conflicted paths are
   * printed relative to it (write_name_quoted_relative).
   */
  setPrefix(prefix: string): this {
    this.checkCallable();
    this.prefix = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    return this;
  }

  /** The git version whose behaviour to follow (default 2.5x). */
  setCompatibility(compatibility: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = compatibility;
    return this;
  }

  protected async run(): Promise<number> {
    const legacy = this.compatibility === "2.43";
    let messages = this.messages;
    // git 2.43 has no --quiet (parse_options' refusal; its usage text is not repeated)
    if (this.quiet && legacy) throw new PlumbingError("error: unknown option `quiet'", 129);
    if (this.quiet && !legacy) {
      messages ??= false;
      const incompatible = (other: string) => {
        throw new PlumbingError(`fatal: options '--quiet' and '${other}' cannot be used together`);
      };
      if (messages) incompatible("--messages");
      if (this.nameOnly) incompatible("--name-only");
      if (this.stdinText !== undefined) incompatible("--stdin");
      if (this.nul) incompatible("-z");
    }
    const trivialIncompatible = () =>
      new PlumbingError("fatal: --trivial-merge is incompatible with all other options");
    if (this.strategyOptions.length > 0 && this.mode === "trivial") throw trivialIncompatible();
    for (const option of this.strategyOptions) {
      // unknown options die before anything is merged
      parseStrategyOptionsOrDie([option]);
    }

    if (this.stdinText !== undefined) {
      if (this.mode === "trivial") throw trivialIncompatible();
      if (this.mergeBase !== undefined) {
        throw new PlumbingError(
          legacy
            ? "fatal: --merge-base is incompatible with --stdin"
            : "fatal: options '--merge-base' and '--stdin' cannot be used together",
        );
      }
      const lines = this.stdinText.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) {
        const { fields: split, printed } = splitInputLine(line, legacy);
        const malformed = () => new PlumbingError(`fatal: malformed input line: '${printed}'.`);
        if (split.length < 2) throw malformed();
        const base = split[1] === "--" ? split[0] : undefined;
        if (base !== undefined && split.length === 4) {
          await this.realMerge(base, split[2] as string, split[3] as string, messages, "\0", true);
        } else if (base === undefined && split.length === 2) {
          await this.realMerge(undefined, split[0], split[1], messages, "\0", true);
        } else {
          throw malformed();
        }
      }
      return 0;
    }

    const branches = this.branches;
    if (!branches) throw new Error("MergeTreeCommand: setBranches or setTrivialMerge first");
    if (this.mode === "trivial") {
      if (this.otherOptions) throw trivialIncompatible();
      return this.trivialMerge(this.baseTree as string, branches[0], branches[1]);
    }
    return this.realMerge(
      this.mergeBase,
      branches[0],
      branches[1],
      messages,
      this.nul ? "\0" : "\n",
      false,
    );
  }

  /** builtin/merge-tree.c's real_merge: one merge-ort merge, its tree, conflicts, messages. */
  private async realMerge(
    mergeBase: string | undefined,
    branch1: string,
    branch2: string,
    showMessagesOption: boolean | undefined,
    lt: string,
    stdin: boolean,
  ): Promise<number> {
    const legacy = this.compatibility === "2.43";
    const { trees, blobs } = this.mergeStores(legacy);
    const xopts = parseStrategyOptionsOrDie(this.strategyOptions);
    // init_merge_options: merge.* and diff.renames, git_xmerge_config's style (no
    // diff.algorithm: merge-tree's options are not the UI's)
    const worktree = this.worktreeOrNone();
    const common = {
      style: conflictStyleOf(this.workingCopy),
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      ...ortConfigOptions(this.workingCopy, worktree, {
        ...(xopts.renormalize !== undefined ? { renormalize: xopts.renormalize } : {}),
      }),
      ...strategyOrtOptions(undefined, xopts),
      ...(xopts.subtreeShift !== undefined ? { subtreeShift: xopts.subtreeShift } : {}),
    };
    // git 2.43's merge-ort detects renames whatever diff.renames, merge.renames or
    // `-X no-renames` say (its detect_renames was read and ignored)
    if (legacy) delete common.renames;

    let oursTree: ObjectId | undefined;
    let theirsTree: ObjectId | undefined;
    let base: Awaited<ReturnType<typeof mergeBaseTree>>;
    if (mergeBase !== undefined && !legacy) {
      const baseTree = await this.treeish(mergeBase);
      oursTree = await this.treeish(branch1);
      theirsTree = await this.treeish(branch2);
      base = storedBase(baseTree, mergeBase, () => flatTree(trees, baseTree));
    } else {
      const parent1 = await this.mergeParent(branch1);
      const parent2 = await this.mergeParent(branch2);
      oursTree = await this.commits.getTree(parent1);
      theirsTree = await this.commits.getTree(parent2);
      if (mergeBase !== undefined) {
        // lookup_commit_reference_by_name
        const baseCommit = await this.commitReference(mergeBase, (type, id) =>
          this.warn(`error: object ${id} is a ${type}, not a commit`),
        );
        if (baseCommit === undefined) {
          throw new PlumbingError(`fatal: could not lookup commit '${mergeBase}'`);
        }
        const baseTree = await this.commits.getTree(baseCommit);
        base = storedBase(baseTree, mergeBase, () => flatTree(trees, baseTree));
      } else {
        const bases = await this.commits.findMergeBase(parent1, parent2);
        if (bases.length === 0 && !this.allowUnrelated) {
          throw new PlumbingError("fatal: refusing to merge unrelated histories");
        }
        try {
          base = await mergeBaseTree(
            {
              commits: this.commits,
              trees,
              blobs,
              abbreviate: (id) => this.abbreviateObjectId(id),
            },
            parent1,
            parent2,
            bases,
            common,
          );
        } catch (e) {
          // a tree missing in a merge of merge bases (the virtual base) fails the merge too
          if (e instanceof MissingMergeObject && e.kind === "tree") {
            throw new PlumbingError(`error: Could not read ${e.id}\nfatal: failure to merge`);
          }
          throw e;
        }
      }
    }

    let merge: Awaited<ReturnType<typeof mergeStoredTrees>>;
    try {
      merge = await mergeStoredTrees({ trees, blobs }, base, oursTree, theirsTree, {
        ...common,
        oursLabel: branch1,
        theirsLabel: branch2,
        baseLabel: base.label,
        ...(xopts.favor ? { favor: xopts.favor } : {}),
      });
    } catch (e) {
      if (e instanceof MissingMergeObject && e.kind === "tree") {
        // collect_merge_info's failure: the tree parse_tree could not read, the three trees
        const baseId = base.stored
          ? (base.treeId ?? this.objectFormat.emptyTreeId)
          : await storeFlatTree(trees, await base.tree());
        throw new PlumbingError(
          [
            `error: Could not read ${e.id}`,
            `error: collecting merge info failed for trees ${baseId}, ${oursTree}, ${theirsTree}`,
            "fatal: failure to merge",
          ].join("\n"),
        );
      }
      throw e;
    }
    const clean = merge.clean;
    if (this.quiet && !legacy) return clean ? 0 : 1;

    const target = await ortResultEntries(blobs, merge);
    const treeId = await storeFlatTreeOver(trees, oursTree, merge.ours, target);

    const showMessages = showMessagesOption ?? !clean;
    let out = "";
    if (stdin) out += `${clean ? 1 : 0}${lt}`;
    out += `${treeId}${lt}`;
    if (!clean) {
      const entries: { path: string; stage: number; mode: number; id: ObjectId }[] = [];
      for (const conflict of merge.conflicts.values()) {
        const stages = [conflict.base, conflict.ours, conflict.theirs];
        stages.forEach((entry, i) => {
          if (entry) {
            entries.push({
              path: conflict.stagePath,
              stage: i + 1,
              mode: entry.mode,
              id: entry.objectId,
            });
          }
        });
      }
      entries.sort((a, b) => compareBytes(a.path, b.path) || a.stage - b.stage);
      const quoteFully =
        lt === "\n"
          ? (parseGitBool(
              RemoteConfigStore.from(this.workingCopy).value("core.quotePath") ?? "true",
            ) ?? true)
          : true;
      const name = (path: string) => {
        const rel = this.prefix ? relativePath(path, this.prefix) : path;
        return lt === "\0" ? rel : quotePath(rel, quoteFully);
      };
      let last: string | undefined;
      for (const e of entries) {
        if (this.nameOnly) {
          if (last === e.path) continue;
        } else {
          out += `${e.mode.toString(8).padStart(6, "0")} ${e.id} ${e.stage}\t`;
        }
        out += `${name(e.path)}${lt}`;
        last = e.path;
      }
    }
    if (showMessages) {
      out += lt;
      const detailed = lt === "\0";
      for (const m of merge.details ?? []) {
        if (detailed) {
          out += `${m.paths.length}\0${m.paths.map((p) => `${p}\0`).join("")}${m.type}\0`;
        }
        out += `${m.text}\n`;
        if (detailed) out += "\0";
      }
    }
    if (stdin) out += lt;
    await this.write(out);
    return clean ? 0 : 1;
  }

  /**
   * The stores the merge reads: a missing tree or blob is merge-ort's death in 2.5x
   * (`Could not read <tree>` with `failure to merge`, `unable to read blob object <id>`);
   * git 2.43 read a missing tree as an empty one after its `error: Could not read` line.
   */
  private mergeStores(legacy: boolean): { trees: CommandTrees; blobs: Blobs } {
    const trees = this.trees;
    const blobs = this.blobs;
    const reported = new Set<ObjectId>();
    const missingTree = async (id: ObjectId) => {
      if (await trees.has(id)) return false;
      if (!legacy) throw new MissingMergeObject("tree", id);
      if (!reported.has(id)) {
        reported.add(id);
        this.warn(`error: Could not read ${id}`);
      }
      return true;
    };
    const wrappedTrees = overlayMethods(trees, {
      loadTree: async function* (id: ObjectId) {
        if (await missingTree(id)) return;
        yield* trees.loadTree(id);
      },
    });
    if (legacy) return { trees: wrappedTrees, blobs };
    const wrappedBlobs = overlayMethods(blobs, {
      load: async (id: ObjectId) => {
        const content = await blobs.load(id);
        if (content === undefined) {
          throw new PlumbingError(`fatal: unable to read blob object ${id}`);
        }
        return content;
      },
    });
    return { trees: wrappedTrees, blobs: wrappedBlobs };
  }

  /** The worktree, none in a bare repository (its attributes are read from it). */
  private worktreeOrNone(): Worktree | undefined {
    try {
      return this.worktreeAccess;
    } catch {
      return undefined;
    }
  }

  /** repo_get_oid_treeish then parse_tree_indirect (2.5x's `--merge-base` arguments). */
  private async treeish(name: string): Promise<ObjectId | undefined> {
    let id: ObjectId;
    try {
      id = await this.resolveRevision(name, { hint: "treeish" });
    } catch (e) {
      if (e instanceof RefNotFoundError) {
        throw new PlumbingError(`fatal: could not parse as tree '${name}'`);
      }
      throw e;
    }
    const peeled = await this.revisionResolver().peelTags(id);
    if (peeled.type === "tree") return peeled.id;
    if (peeled.type === "commit") return this.commits.getTree(peeled.id);
    throw new PlumbingError(`fatal: unable to read tree (${id})`);
  }

  /**
   * get_merge_parent: the commit a name resolves to, tags peeled; anything else is
   * help_unknown_ref's death (`merge-tree: <name> - not something we can merge`, exit 1).
   */
  private async mergeParent(name: string): Promise<ObjectId> {
    const commit = await this.commitReference(name, (type) =>
      this.warn(
        `error: ${name}: expected commit type, but the object dereferences to ${type} type`,
      ),
    );
    if (commit === undefined) {
      throw new PlumbingError(`merge-tree: ${name} - not something we can merge`, 1);
    }
    return commit;
  }

  /**
   * The commit a name resolves to (tags peeled), undefined for anything else (`notCommit`
   * hears the type of an object that is no commit).
   */
  private async commitReference(
    name: string,
    notCommit: (type: string, id: ObjectId) => void,
  ): Promise<ObjectId | undefined> {
    let id: ObjectId;
    try {
      id = await this.resolveRevision(name, { hint: "committish" });
    } catch (e) {
      if (e instanceof RefNotFoundError) return undefined;
      throw e;
    }
    const peeled = await this.revisionResolver().peelTags(id);
    if (peeled.type === "commit") return peeled.id;
    if (peeled.type !== undefined) notCommit(peeled.type, peeled.id);
    return undefined;
  }

  /** builtin/merge-tree.c's trivial_merge: the three trees walked in step, then shown. */
  private async trivialMerge(base: string, branch1: string, branch2: string): Promise<number> {
    const trees: (ObjectId | undefined)[] = [];
    for (const rev of [base, branch1, branch2]) {
      let id: ObjectId;
      try {
        id = await this.resolveRevision(rev);
      } catch (e) {
        if (e instanceof RefNotFoundError) throw new PlumbingError(`fatal: unknown rev ${rev}`);
        throw e;
      }
      const peeled = await this.revisionResolver().peelTags(id);
      if (peeled.type === "tree") trees.push(peeled.id);
      else if (peeled.type === "commit") trees.push(await this.commits.getTree(peeled.id));
      else throw new PlumbingError(`fatal: ${rev} is not a tree`);
    }
    const list: TrivialEntry[] = [];
    await this.trivialMergeTrees(trees as [ObjectId, ObjectId, ObjectId], "", list);
    const attributes = ortConfigOptions(this.workingCopy, this.worktreeOrNone()).attributes;
    for (const entry of list) {
      let text = `${explanation(entry)}\n`;
      const desc = ["result", "base", "our", "their"];
      for (let e: TrivialEntry | undefined = entry; e; e = e.link) {
        text += `  ${(desc[e.stage] as string).padEnd(6)} ${e.mode.toString(8)} ${e.id} ${e.path}\n`;
      }
      await this.write(text);
      const ours = await this.origin(entry);
      const result = await this.result(entry, attributes);
      const diff = unifiedDiff(ours, result, {
        context: 3,
        algorithm: "myers",
        findFunction: () => undefined,
      });
      await this.write(diff);
    }
    return 0;
  }

  /** traverse_trees over three trees (missing ones read as empty) with threeway_callback. */
  private async trivialMergeTrees(
    ids: [ObjectId | undefined, ObjectId | undefined, ObjectId | undefined],
    prefix: string,
    out: TrivialEntry[],
  ): Promise<void> {
    const levels = await Promise.all(
      ids.map(async (id) => {
        const map = new Map<string, NameEntry>();
        if (id === undefined) return map;
        for await (const e of this.trees.loadTree(id)) map.set(e.name, { mode: e.mode, id: e.id });
        return map;
      }),
    );
    const names = new Set<string>();
    for (const level of levels) for (const name of level.keys()) names.add(name);
    for (const name of [...names].sort(compareBytes)) {
      const n = levels.map((l) => l.get(name) ?? NONE) as [NameEntry, NameEntry, NameEntry];
      await this.threeway(n, prefix ? `${prefix}/${name}` : name, out);
    }
  }

  /** merge-tree.c's threeway_callback for the entries of one name. */
  private async threeway(
    n: [NameEntry, NameEntry, NameEntry],
    path: string,
    out: TrivialEntry[],
  ): Promise<void> {
    const same = (a: NameEntry, b: NameEntry) =>
      a.id !== "" && b.id !== "" && a.id === b.id && a.mode === b.mode;
    const bothEmpty = (a: NameEntry, b: NameEntry) => a.id === "" && b.id === "";
    const [o, a, b] = n;
    if (same(a, b) || bothEmpty(a, b)) return;
    if (same(o, a) && b.id !== "" && !isDir(b.mode)) {
      // we did not touch it, they changed it: theirs, shown against ours
      out.push({
        stage: 0,
        mode: b.mode,
        id: b.id,
        path,
        link: { stage: 2, mode: a.mode, id: a.id, path },
      });
      return;
    }
    if (same(o, b) || bothEmpty(o, b)) return;
    // unresolved: a tree among them is merged first, then the files
    if (n.some((e) => e.mode !== 0 && isDir(e.mode))) {
      const dirId = (e: NameEntry) => (e.mode !== 0 && isDir(e.mode) ? e.id : undefined);
      await this.trivialMergeTrees([dirId(o), dirId(a), dirId(b)], path, out);
    }
    if (n.every((e) => e.mode === 0 || isDir(e.mode))) return;
    let entry: TrivialEntry | undefined;
    for (const [stage, e] of [
      [3, b],
      [2, a],
      [1, o],
    ] as const) {
      if (e.mode !== 0 && !isDir(e.mode))
        entry = { stage, mode: e.mode, id: e.id, path, link: entry };
    }
    if (entry) out.push(entry);
  }

  /** A blob's content, nothing when it cannot be read (a gitlink). */
  private async content(id: ObjectId): Promise<Uint8Array> {
    if (!(await this.blobs.has(id))) return new Uint8Array(0);
    return readBlob(this.blobs, id);
  }

  /** merge-tree.c's origin: our version (stage 2), else nothing. */
  private async origin(entry: TrivialEntry): Promise<Uint8Array> {
    for (let e: TrivialEntry | undefined = entry; e; e = e.link) {
      if (e.stage === 2) return this.content(e.id);
    }
    return new Uint8Array(0);
  }

  /** merge-tree.c's result: the merged version, merge_blobs for a conflict. */
  private async result(
    entry: TrivialEntry,
    attributes: ReturnType<typeof ortConfigOptions>["attributes"],
  ): Promise<Uint8Array> {
    if (entry.stage === 0) return this.content(entry.id);
    let e: TrivialEntry | undefined = entry;
    let base: TrivialEntry | undefined;
    let ours: TrivialEntry | undefined;
    let theirs: TrivialEntry | undefined;
    if (e.stage === 1) {
      base = e;
      e = e.link;
    }
    if (e && e.stage === 2) {
      ours = e;
      e = e.link;
    }
    if (e) theirs = e;
    // merge_blobs: removed on a side, nothing; added on one side alone, that version
    if (!ours || !theirs) {
      if (base) return new Uint8Array(0);
      return this.content((ours ?? theirs)?.id as ObjectId);
    }
    const merged = await lowLevelMerge(
      {
        path: entry.path,
        base: base ? await this.content(base.id) : new Uint8Array(0),
        ours: await this.content(ours.id),
        theirs: await this.content(theirs.id),
        oursLabel: ".our",
        theirsLabel: ".their",
        baseLabel: "",
      },
      {
        algorithm: "myers",
        attributes: attributes ? await attributes(entry.path) : {},
      },
    );
    if (merged.status === "binary") {
      this.warn(`warning: Cannot merge binary files: ${entry.path} (.our vs. .their)`);
    }
    return merged.content;
  }
}

/** A tree or blob the merge needed and the store lacks. */
class MissingMergeObject extends Error {
  constructor(
    readonly kind: "tree" | "blob",
    readonly id: ObjectId,
  ) {
    super(`missing ${kind} ${id}`);
    this.name = "MissingMergeObject";
  }
}

/** merge-tree.c's explanation of a path's versions. */
function explanation(entry: TrivialEntry): string {
  switch (entry.stage) {
    case 0:
      return "merged";
    case 3:
      return "added in remote";
    case 2:
      return entry.link ? "added in both" : "added in local";
  }
  const next = entry.link;
  if (!next) return "removed in both";
  if (next.link) return "changed in both";
  return next.stage === 3 ? "removed in local" : "removed in remote";
}

/** The `-X` options, an unknown one git's death (exit 128). */
function parseStrategyOptionsOrDie(list: readonly string[]) {
  try {
    return parseStrategyOptions(list);
  } catch (e) {
    if (e instanceof Error && e.name === "UnknownStrategyOptionError") {
      throw new PlumbingError(e.message);
    }
    throw e;
  }
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * A `--stdin` line split on spaces, and the line as git's `malformed input line` prints it.
 * 2.5x: string_list_split_in_place_f with STRING_LIST_SPLIT_TRIM (each field's leading
 * whitespace skipped before the next space is looked for, its trailing whitespace cut by the
 * NUL that also ends the printed line at the first field). 2.43: strbuf_split (a piece after
 * each space, none after a trailing one), the pieces' ends trimmed, the line printed whole.
 */
function splitInputLine(line: string, legacy: boolean): { fields: string[]; printed: string } {
  const fields: string[] = [];
  if (legacy) {
    let start = 0;
    while (start < line.length) {
      const space = line.indexOf(" ", start);
      const end = space < 0 ? line.length : space + 1;
      let e = end;
      while (e > start && isSpace(line[e - 1])) e--;
      fields.push(line.slice(start, e));
      start = end;
    }
    return { fields, printed: line };
  }
  let printedEnd = line.length;
  let p = 0;
  for (;;) {
    while (p < line.length && isSpace(line[p])) p++;
    const space = line.indexOf(" ", p);
    let e = space < 0 ? line.length : space;
    while (e > p && isSpace(line[e - 1])) e--;
    fields.push(line.slice(p, e));
    printedEnd = Math.min(printedEnd, e);
    if (space < 0) break;
    p = space + 1;
  }
  return { fields, printed: line.slice(0, printedEnd) };
}

/** strcmp on the paths' bytes (git's order). */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
