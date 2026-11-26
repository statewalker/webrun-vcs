/**
 * ShowBranchCommand - `git show-branch` (builtin/show-branch.c): the commit-ancestry table of
 * branches, and its other modes: `--list`, `--more=<n>`, `--independent`, `--merge-base`,
 * `--topics`, `--sparse`, `--reflog` (`-g`).
 *
 * @example
 * ```typescript
 * // git show-branch main topic
 * const { stdout } = await git.showBranch().setArguments(["main", "topic"]).call();
 * // ! [main] subject of main
 * //  * [topic] subject of topic
 * // --
 * //  * [topic] subject of topic
 * // +* [main] subject of main
 *
 * // git show-branch --merge-base main topic: exit status 1 when there is none
 * const { exitCode, stdout: base } = await git.showBranch()
 *   .setArguments(["--merge-base", "main", "topic"]).call();
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { gitConfigColorBool } from "./config-value-types.js";
import { approxidateCareful, formatRfc2822Date } from "./git-date.js";
import { GRAPH_COLUMN_COLORS_ANSI } from "./log-graph.js";
import { relativeDate } from "./pretty-format.js";
import { commitSubject } from "./shortlog.js";

const USAGE = [
  "usage: git show-branch [-a | --all] [-r | --remotes] [--topo-order | --date-order]",
  "                       [--current] [--color[=<when>] | --no-color] [--sparse]",
  "                       [--more=<n> | --list | --independent | --merge-base]",
  "                       [--no-name | --sha1-name] [--topics]",
  "                       [(<rev> | <glob>)...]",
  "   or: git show-branch (-g | --reflog)[=<n>[,<base>]] [--list] [<ref>]",
].join("\n");

/** The commit flag bits git keeps for itself before the revs' bits (UNINTERESTING is 01). */
const UNINTERESTING = 1;
const REV_SHIFT = 2;
const DEFAULT_REFLOG = 4;

/** A commit as show-branch sees it: `parents` undefined until git would parse it. */
interface Node {
  readonly id: ObjectId;
  date: number;
  parents?: Node[];
  subject?: string;
  flags: number;
  /** commit_name: which head's ancestor, how many first parents away */
  name?: { head: string; generation: number };
}

/** A git death: its lines and exit status. */
class Death extends Error {
  constructor(
    readonly lines: string,
    readonly exitCode: number,
  ) {
    super(lines);
  }
}

/** What the options of one run say (show-branch's locals). */
interface Options {
  allHeads: boolean;
  allRemotes: boolean;
  color?: boolean;
  extra: number;
  noName: boolean;
  current: boolean;
  sha1Name: boolean;
  mergeBase: boolean;
  independent: boolean;
  sortOrder: "topo" | "date";
  topics: boolean;
  sparse: boolean;
  reflog: number;
  reflogBase?: string;
}

/** The long options and whether each may be negated (parse-options' `--no-`). */
const LONG_OPTIONS: { name: string; negatable: boolean; arg?: "optional" }[] = [
  { name: "all", negatable: true },
  { name: "remotes", negatable: true },
  { name: "color", negatable: true, arg: "optional" },
  { name: "more", negatable: true, arg: "optional" },
  { name: "list", negatable: true },
  { name: "no-name", negatable: true },
  { name: "current", negatable: true },
  { name: "sha1-name", negatable: true },
  { name: "merge-base", negatable: true },
  { name: "independent", negatable: true },
  { name: "topo-order", negatable: false },
  { name: "topics", negatable: true },
  { name: "sparse", negatable: true },
  { name: "date-order", negatable: false },
  { name: "reflog", negatable: false, arg: "optional" },
];

/**
 * `git show-branch` with git's argv (`setArguments`), its output as git's process ends
 * (stdout, stderr, exit status: 129 for git's usage errors, 128 where it dies). With no
 * arguments the `showbranch.default` values are taken as the argv, as git does. Relative
 * reflog dates count from {@link setNow} (git's `GIT_TEST_DATE_NOW`), else the clock.
 */
export class ShowBranchCommand extends GitCommand<PlumbingTextOutput> {
  private args: string[] = [];
  private now?: number;
  private maxRevs = 27;
  /** git before 2.45 reads `<ref>@{<n>}` one record early (refs.c's read_ref_at) */
  private legacyReflog = false;

  /** The arguments after `git show-branch`, as git parses them. */
  setArguments(args: readonly string[]): this {
    this.checkCallable();
    this.args = [...args];
    return this;
  }

  /** The time relative reflog dates are counted from, in seconds (git's `GIT_TEST_DATE_NOW`). */
  setNow(now: number): this {
    this.checkCallable();
    this.now = now;
    return this;
  }

  /**
   * The git version followed (`git version 2.43.0`, default the newest): before 2.54 git
   * keeps one flag bit fewer, so it handles 26 refs at once instead of 27; before 2.45 its
   * reflog reads show `<ref>@{<n>}` (n > 0) with the message and date of the newer entry.
   */
  setVersionString(version: string): this {
    this.checkCallable();
    const m = /(\d+)\.(\d+)/.exec(version);
    const major = Number(m?.[1] ?? 2);
    const minor = Number(m?.[2] ?? 99);
    this.maxRevs = major < 2 || (major === 2 && minor < 54) ? 26 : 27;
    this.legacyReflog = major < 2 || (major === 2 && minor < 45);
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    const out: string[] = [];
    const err: string[] = [];
    try {
      const exitCode = await this.run(out, err);
      return { exitCode, stdout: out.join(""), stderr: err.join("") };
    } catch (e) {
      if (e instanceof Death) {
        return {
          exitCode: e.exitCode,
          stdout: out.join(""),
          stderr: `${err.join("")}${e.lines}\n`,
        };
      }
      if (e instanceof RevisionError) {
        return { exitCode: 128, stdout: out.join(""), stderr: `${err.join("")}${e.message}\n` };
      }
      throw e;
    }
  }

  private async run(out: string[], err: string[]): Promise<number> {
    const config = RemoteConfigStore.from(this.workingCopy);
    let argv = this.args;
    if (argv.length === 0) argv = config.values("showbranch.default");
    const configColor = config.value("color.showbranch") ?? config.value("color.ui");
    const o: Options = {
      allHeads: false,
      allRemotes: false,
      extra: 0,
      noName: false,
      current: false,
      sha1Name: false,
      mergeBase: false,
      independent: false,
      sortOrder: "topo",
      topics: false,
      sparse: false,
      reflog: 0,
    };
    let av = parseArguments(argv, o);
    if (o.allHeads) o.allRemotes = true;
    const useColor =
      o.color ??
      (configColor !== undefined && gitConfigColorBool("color", configColor) === "always");

    if (o.extra || o.reflog) {
      if (o.independent || o.mergeBase) throw new Death(USAGE, 129);
      if (o.reflog && (o.extra > 0 || o.allHeads || o.allRemotes)) {
        throw new Death(
          "fatal: options '--reflog' and '--all/--remotes/--independent/--merge-base' cannot be used together",
          128,
        );
      }
    }
    if (o.current && o.reflog) {
      throw new Death("fatal: options '--reflog' and '--current' cannot be used together", 128);
    }
    if (av.length <= (o.topics ? 1 : 0) && !o.allHeads && !o.allRemotes) o.allHeads = true;

    const resolver = this.revisionResolver();
    const flushWarnings = () => {
      for (const w of resolver.warnings.splice(0)) err.push(`${w}\n`);
    };
    /** repo_get_oid: the object a name gives, undefined where git's lookup fails */
    const getOid = async (name: string): Promise<ObjectId | undefined> => {
      try {
        return await resolver.resolve(name);
      } catch (e) {
        if (e instanceof RevisionError) throw e;
        return undefined;
      } finally {
        flushWarnings();
      }
    };
    const maxRevs = this.maxRevs;
    const refNames: string[] = [];
    const refCommits: ObjectId[] = [];
    /** append_ref: refs that peel to no commit are skipped silently */
    const appendRef = async (name: string, id: ObjectId, allowDups: boolean) => {
      const peeled = await resolver.peelTags(id).catch(() => undefined);
      if (peeled?.type !== "commit") return;
      if (!allowDups && refNames.includes(name)) return;
      if (refNames.length >= maxRevs) {
        err.push(`warning: ignoring ${name}; cannot handle more than ${maxRevs} refs\n`);
        return;
      }
      refNames.push(name);
      refCommits.push(peeled.id);
    };
    const sortRange = (from: number) => {
      const pairs = refNames.slice(from).map((n, i) => [n, refCommits[from + i]] as const);
      pairs.sort((a, b) => versionCmp(a[0], b[0]));
      pairs.forEach(([n, c], i) => {
        refNames[from + i] = n;
        refCommits[from + i] = c as ObjectId;
      });
    };
    const allRefs = async (): Promise<{ name: string; id: ObjectId }[]> => {
      const refs: { name: string; id: ObjectId }[] = [];
      for await (const ref of this.refsStore.list("refs/")) {
        if (!ref.name.startsWith("refs/")) continue;
        const id =
          "objectId" in ref && ref.objectId && !("target" in ref && ref.target)
            ? ref.objectId
            : (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
        if (id) refs.push({ name: ref.name, id });
      }
      refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return refs;
    };
    /** append_head_ref / append_remote_ref: `heads/foo` when `foo` names something else */
    const appendShortRef = async (name: string, id: ObjectId, prefix: string) => {
      const short = name.slice(prefix.length);
      const ofs = (await getOid(short)) === id ? prefix.length : 5;
      await appendRef(name.slice(ofs), id, false);
    };
    const appendMatchingRef = async (ref: { name: string; id: ObjectId }, pattern: string) => {
      let slash = countSlashes(ref.name);
      const wanted = countSlashes(pattern);
      let tail = 0;
      while (tail < ref.name.length && wanted < slash) {
        if (ref.name[tail++] === "/") slash--;
      }
      if (tail >= ref.name.length) return;
      if (!wildmatch(pattern, ref.name.slice(tail))) return;
      if (ref.name.startsWith("refs/heads/")) await appendShortRef(ref.name, ref.id, "refs/heads/");
      else if (ref.name.startsWith("refs/tags/")) await appendRef(ref.name.slice(5), ref.id, false);
      else await appendRef(ref.name, ref.id, false);
    };
    const appendOneRev = async (name: string) => {
      const id = await getOid(name);
      if (id !== undefined) {
        await appendRef(name, id, false);
        return;
      }
      if (/[*?[]/.test(name)) {
        const saved = refNames.length;
        for (const ref of await allRefs()) await appendMatchingRef(ref, name);
        if (saved === refNames.length && refNames.length < maxRevs) {
          err.push(`error: no matching refs with ${name}\n`);
        }
        sortRange(saved);
        return;
      }
      throw new Death(`fatal: bad sha1 reference ${name}`, 128);
    };

    const head = await this.readHead();
    const reflogMsg: string[] = [];
    if (o.reflog) {
      if (av.length === 0) {
        if (!head) throw new Death("fatal: no branches given, and HEAD is not valid", 128);
        av = [head.name];
      }
      if (av.length !== 1) throw new Death("fatal: --reflog option needs one branch name", 128);
      if (maxRevs < o.reflog) {
        throw new Death(`fatal: only ${maxRevs} entries can be shown at one time.`, 128);
      }
      const name = av[0] as string;
      const found = (await resolver.dwimRef(name).catch(() => []))[0];
      flushWarnings();
      if (!found) throw new Death(`fatal: no such ref ${name}`, 128);
      const log = await this.refsStore.getReflog?.(found.ref);
      const entries = (await log?.getReverseEntries()) ?? [];
      let base = 0;
      if (o.reflogBase !== undefined) {
        const n = parseUnsigned(o.reflogBase);
        if (n.rest.length === 0) base = n.value;
        else {
          // a date: the count of the newest entry at or before it (read_ref_at's cutoff_cnt)
          const at = approxidateCareful(o.reflogBase, this.nowSeconds()).timestamp;
          if (entries.length === 0) throw new Death(`fatal: log for ${found.ref} is empty`, 128);
          const k = entries.findIndex((e) => e.who.timestamp <= at);
          base = k < 0 ? entries.length : k;
          if (k >= 0) this.gapWarning(entries, k, found.ref, found.id, err);
        }
      }
      let oid = found.id;
      for (let i = 0; i < o.reflog; i++) {
        const k = base + i;
        if (entries.length === 0 && k > 0) {
          throw new Death(`fatal: log for ${found.ref} is empty`, 128);
        }
        let at = k;
        if (this.legacyReflog && k > 0) {
          // git before 2.45 stops a record early: the newer entry's message and its old id
          at = k - 1;
          while (at < entries.length && isNullId((entries[at] as (typeof entries)[number]).oldId)) {
            at++;
          }
        }
        const entry = entries[at];
        if (!entry) {
          o.reflog = i;
          break;
        }
        if (this.legacyReflog && k > 0) {
          const newer = at > 0 ? entries[at - 1] : undefined;
          if (newer && !isNullId(newer.oldId) && newer.oldId !== entry.newId) {
            err.push(
              `warning: log for ref ${found.ref} has gap after ${formatRfc2822Date(entry.who.timestamp, entry.who.tzOffset)}\n`,
            );
          }
          oid = entry.oldId;
        } else oid = this.gapWarning(entries, k, found.ref, oid, err);
        const line = entry.comment.split("\n")[0] ?? "";
        const msg = line === "" ? "(none)" : line;
        reflogMsg[i] = `(${relativeDate(entry.who.timestamp, this.nowSeconds())}) ${msg}`;
        await appendRef(`${name}@{${base + i}}`, oid, true);
      }
    } else {
      for (const name of av) await appendOneRev(name);
      if (o.allHeads) {
        const from = refNames.length;
        for (const ref of await allRefs()) {
          if (ref.name.startsWith("refs/heads/")) {
            await appendShortRef(ref.name, ref.id, "refs/heads/");
          }
        }
        sortRange(from);
      }
      if (o.allRemotes) {
        const from = refNames.length;
        for (const ref of await allRefs()) {
          if (ref.name.startsWith("refs/remotes/")) {
            await appendShortRef(ref.name, ref.id, "refs/remotes/");
          }
        }
        sortRange(from);
      }
    }

    if (o.current && head) {
      if (!refNames.some((n) => revIsHead(head.name, n))) {
        await appendOneRev(head.name.startsWith("refs/heads/") ? head.name.slice(11) : head.name);
      }
    }

    if (refNames.length === 0) {
      err.push("No revs to be shown.\n");
      return 0;
    }

    const nodes = new Map<ObjectId, Node>();
    const node = (id: ObjectId): Node => {
      let n = nodes.get(id);
      if (!n) {
        n = { id, date: 0, flags: 0 };
        nodes.set(id, n);
      }
      return n;
    };
    const parse = async (n: Node) => {
      if (n.parents) return;
      const commit = await this.walkCommits.load(n.id);
      if (!commit) {
        n.parents = [];
        return;
      }
      n.date = commit.committer.timestamp;
      n.subject = commitSubject(commit.message);
      n.parents = commit.parents.map(node);
    };

    const numRev = refNames.length;
    // git looks every name up again (repo_get_oid, lookup_commit_reference): `HEAD@{n}`
    // reads HEAD's own reflog, and an ambiguous name warns once more
    for (let i = 0; i < numRev; i++) {
      const name = refNames[i] as string;
      const id = await getOid(name);
      if (id === undefined) throw new Death(`fatal: '${name}' is not a valid ref.`, 128);
      const peeled = await resolver.peelTags(id).catch(() => undefined);
      if (peeled?.type !== "commit") {
        throw new Death(`fatal: cannot find commit ${name} (${id})`, 128);
      }
      refCommits[i] = peeled.id;
    }
    const rev: Node[] = [];
    const seen: Node[] = [];
    /** mark_seen: commit_list_insert, so the list is newest-inserted first */
    const markSeen = (n: Node): boolean => {
      if (n.flags) return false;
      seen.unshift(n);
      return true;
    };
    const queue = new DateQueue<Node>();
    for (let i = 0; i < numRev; i++) {
      const flag = 1 << (i + REV_SHIFT);
      const commit = node(refCommits[i] as ObjectId);
      await parse(commit);
      markSeen(commit);
      commit.flags |= flag;
      if (commit.flags === flag) queue.put(commit, commit.date);
      rev.push(commit);
    }
    const revMask = rev.map((c) => c.flags);
    const allMask = (1 << (REV_SHIFT + numRev)) - 1;
    const allRevs = allMask & ~((1 << REV_SHIFT) - 1);

    if (o.extra >= 0) {
      // join_revs
      let extra = o.extra;
      for (let commit = queue.peek(); commit; commit = queue.peek()) {
        const stillInteresting = queue.items().some((c) => !(c.flags & UNINTERESTING));
        let flags = commit.flags & allMask;
        if (!stillInteresting && extra <= 0) break;
        queue.get();
        markSeen(commit);
        if ((flags & allRevs) === allRevs) flags |= UNINTERESTING;
        for (const p of commit.parents ?? []) {
          if ((p.flags & flags) === flags) continue;
          await parse(p);
          if (markSeen(p) && !stillInteresting) extra--;
          p.flags |= flags;
          queue.put(p, p.date);
        }
      }
      for (;;) {
        let changed = false;
        for (const c of seen) {
          if ((c.flags & allRevs) !== allRevs && !(c.flags & UNINTERESTING)) continue;
          for (const p of c.parents ?? []) {
            if (!(p.flags & UNINTERESTING)) {
              p.flags |= UNINTERESTING;
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
    }

    // commit_list_sort_by_date (stable)
    const indexed = seen.map((n, i) => [n, i] as const);
    indexed.sort((a, b) => b[0].date - a[0].date || a[1] - b[1]);
    let sorted = indexed.map(([n]) => n);

    if (o.mergeBase) {
      let status = 1;
      for (const c of sorted) {
        const flags = c.flags & allMask;
        if (!(flags & UNINTERESTING) && (flags & allRevs) === allRevs) {
          out.push(`${c.id}\n`);
          status = 0;
          c.flags |= UNINTERESTING;
        }
      }
      return status;
    }

    if (o.independent) {
      for (let i = 0; i < numRev; i++) {
        const c = rev[i] as Node;
        if (c.flags === revMask[i]) out.push(`${c.id}\n`);
        c.flags |= UNINTERESTING;
      }
      return 0;
    }

    const color = (i: number) => (useColor ? (GRAPH_COLUMN_COLORS_ANSI[i % 12] as string) : "");
    const reset = useColor ? "\x1b[m" : "";
    const showOneCommit = async (c: Node, noName: boolean) => {
      const pretty = c.parents && c.subject !== undefined ? c.subject : "(unavailable)";
      const text = pretty.startsWith("[PATCH] ") ? pretty.slice(8) : pretty;
      let prefix = "";
      if (!noName) {
        if (c.name?.head !== undefined) {
          const g = c.name.generation;
          prefix = `[${c.name.head}${g === 0 ? "" : g === 1 ? "^" : `~${g}`}] `;
        } else {
          prefix = `[${await this.abbreviateObjectId(c.id)}] `;
        }
      }
      out.push(`${prefix}${text}\n`);
    };

    let headAt = -1;
    if (numRev > 1 || o.extra < 0) {
      for (let i = 0; i < numRev; i++) {
        const name = refNames[i] as string;
        const isHead =
          head !== undefined && revIsHead(head.name, name) && head.id === (rev[i] as Node).id;
        if (o.extra < 0) out.push(`${isHead ? "*" : " "} [${name}] `);
        else out.push(`${" ".repeat(i)}${color(i)}${isHead ? "*" : "!"}${reset} [${name}] `);
        if (!o.reflog) await showOneCommit(rev[i] as Node, true);
        else out.push(`${reflogMsg[i]}\n`);
        if (isHead) headAt = i;
      }
      if (o.extra >= 0) out.push(`${"-".repeat(numRev)}\n`);
    }
    if (o.extra < 0) return 0;

    sorted = sortInTopologicalOrder(sorted, o.sortOrder);
    if (!o.sha1Name && !o.noName) nameCommits(sorted, rev, refNames);

    let extra = o.extra;
    let shownMergePoint = false;
    for (const c of sorted) {
      const thisFlag = c.flags;
      const isMergePoint = (thisFlag & allRevs) === allRevs;
      shownMergePoint ||= isMergePoint;
      if (numRev > 1) {
        const isMerge = (c.parents?.length ?? 0) > 1;
        if (o.topics && !isMergePoint && thisFlag & (1 << REV_SHIFT)) continue;
        if (!o.sparse && isMerge && omitInDense(c, rev)) continue;
        let marks = "";
        for (let i = 0; i < numRev; i++) {
          if (!(thisFlag & (1 << (i + REV_SHIFT)))) marks += " ";
          else marks += `${color(i)}${isMerge ? "-" : i === headAt ? "*" : "+"}${reset}`;
        }
        out.push(`${marks} `);
      }
      await showOneCommit(c, o.noName);
      if (shownMergePoint && --extra < 0) break;
    }
    return 0;
  }

  /**
   * read_ref_at's choice of the id of reflog entry `k` (newest first): the entry's new id
   * when a newer entry exists (with git's warning when it does not follow on), else the
   * ref's value `current` (with git's warning when the newest entry differs).
   */
  private gapWarning(
    entries: { oldId: ObjectId; newId: ObjectId; who: { timestamp: number; tzOffset: string } }[],
    k: number,
    ref: string,
    current: ObjectId | undefined,
    err: string[],
  ): ObjectId {
    const entry = entries[k] as (typeof entries)[number];
    const date = () => formatRfc2822Date(entry.who.timestamp, entry.who.tzOffset);
    const newer = k > 0 ? entries[k - 1] : undefined;
    if (newer && !isNullId(newer.oldId)) {
      if (newer.oldId !== entry.newId)
        err.push(`warning: log for ref ${ref} has gap after ${date()}\n`);
      return entry.newId;
    }
    if (current !== undefined && entry.newId !== current) {
      err.push(`warning: log for ref ${ref} unexpectedly ended on ${date()}\n`);
      return current;
    }
    return current ?? entry.newId;
  }

  private nowSeconds(): number {
    return this.now ?? Math.floor(Date.now() / 1000);
  }

  /** refs_resolve_refdup("HEAD", RESOLVE_REF_READING): the ref HEAD ends at, and its value. */
  private async readHead(): Promise<{ name: string; id: ObjectId } | undefined> {
    let name = "HEAD";
    for (let depth = 0; depth < 5; depth++) {
      const ref = await this.refsStore.get(name).catch(() => undefined);
      if (!ref) return undefined;
      if ("target" in ref && ref.target) {
        name = ref.target;
        continue;
      }
      const id = "objectId" in ref ? ref.objectId : undefined;
      return id ? { name, id } : undefined;
    }
    return undefined;
  }
}

/** parse-options over show-branch's options (PARSE_OPT_STOP_AT_NON_OPTION): the rest. */
function parseArguments(argv: readonly string[], o: Options): string[] {
  const usageError = (line: string): never => {
    throw new Death(line, 129);
  };
  const setReflog = (arg: string | undefined) => {
    const n = parseUnsigned(arg ?? "");
    o.reflog = n.value;
    if (n.rest.startsWith(",")) o.reflogBase = n.rest.slice(1);
    else if (n.rest.length > 0) usageError(`error: unrecognized reflog param '${arg}'`);
    else o.reflogBase = undefined;
    if (o.reflog <= 0) o.reflog = DEFAULT_REFLOG;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-h") throw new Death(USAGE, 129);
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const word = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq < 0 ? undefined : arg.slice(eq + 1);
      const { option, unset } = findLongOption(word, arg, usageError);
      if (value !== undefined && (unset || !option.arg)) {
        usageError(`error: option \`${unset ? `no-${option.name}` : option.name}' takes no value`);
      }
      switch (option.name) {
        case "all":
          o.allHeads = !unset;
          break;
        case "remotes":
          o.allRemotes = !unset;
          break;
        case "color":
          if (unset) o.color = false;
          else if (value === undefined) o.color = true;
          else {
            const v = value.toLowerCase();
            if (["always", "yes", "true", "on", "force"].includes(v)) o.color = true;
            else if (["never", "no", "false", "off", "none"].includes(v)) o.color = false;
            else if (["auto", "tty", "if-tty"].includes(v)) o.color = false;
            else usageError(`error: option \`color' expects "always", "auto", or "never"`);
          }
          break;
        case "more":
          if (unset) o.extra = 0;
          else if (value === undefined) o.extra = 1;
          else {
            if (!/^-?\d+$/.test(value)) {
              usageError(
                `error: option \`more' expects an integer value with an optional k/m/g suffix`,
              );
            }
            o.extra = Number.parseInt(value, 10);
          }
          break;
        case "list":
          o.extra = unset ? 0 : -1;
          break;
        case "no-name":
          o.noName = !unset;
          break;
        case "current":
          o.current = !unset;
          break;
        case "sha1-name":
          o.sha1Name = !unset;
          break;
        case "merge-base":
          o.mergeBase = !unset;
          break;
        case "independent":
          o.independent = !unset;
          break;
        case "topo-order":
          o.sortOrder = "topo";
          break;
        case "topics":
          o.topics = !unset;
          break;
        case "sparse":
          o.sparse = !unset;
          break;
        case "date-order":
          o.sortOrder = "date";
          break;
        case "reflog":
          setReflog(value);
          break;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const c = arg[k] as string;
        if (c === "a") o.allHeads = true;
        else if (c === "r") o.allRemotes = true;
        else if (c === "h") throw new Death(USAGE, 129);
        else if (c === "g") {
          const rest = arg.slice(k + 1);
          setReflog(rest.length > 0 ? rest : undefined);
          break;
        } else usageError(`error: unknown switch \`${c}'`);
      }
      continue;
    }
    break;
  }
  return argv.slice(i);
}

/** parse_long_opt: an exact name, `no-<name>`, `<name>` for a `no-` option, or a unique prefix. */
function findLongOption(
  word: string,
  arg: string,
  usageError: (line: string) => never,
): { option: (typeof LONG_OPTIONS)[number]; unset: boolean } {
  const candidates: { option: (typeof LONG_OPTIONS)[number]; unset: boolean }[] = [];
  for (const option of LONG_OPTIONS) {
    const forms: { text: string; unset: boolean }[] = [{ text: option.name, unset: false }];
    if (option.name.startsWith("no-")) forms.push({ text: option.name.slice(3), unset: true });
    else forms.push({ text: `no-${option.name}`, unset: true });
    for (const form of forms) {
      if (form.text === word) {
        if (form.unset && !option.negatable) usageError(`error: unknown option \`${word}'`);
        return { option, unset: form.unset };
      }
    }
    for (const form of forms) {
      if (word.length > 0 && form.text.startsWith(word) && (option.negatable || !form.unset)) {
        candidates.push({ option, unset: form.unset });
        break;
      }
    }
  }
  if (candidates.length === 1) return candidates[0] as (typeof candidates)[number];
  if (candidates.length > 1) {
    const [a, b] = candidates as [(typeof candidates)[number], (typeof candidates)[number]];
    const label = (c: (typeof candidates)[number]) =>
      c.unset
        ? c.option.name.startsWith("no-")
          ? c.option.name.slice(3)
          : `no-${c.option.name}`
        : c.option.name;
    usageError(`error: ambiguous option: ${word} (could be --${label(a)} or --${label(b)})`);
  }
  return usageError(`error: unknown option \`${arg.slice(2).split("=")[0]}'`);
}

/** strtoul's digits: the value and what follows them. */
function parseUnsigned(text: string): { value: number; rest: string } {
  const m = /^\s*\+?(\d*)/.exec(text) as RegExpExecArray;
  const digits = m[1] ?? "";
  if (digits.length === 0) return { value: 0, rest: text };
  return { value: Number.parseInt(digits, 10), rest: text.slice(m[0].length) };
}

/** An all-zero object id (a creation's old id). */
const isNullId = (id: string) => /^0+$/.test(id);

function countSlashes(s: string): number {
  let n = 0;
  for (const c of s) if (c === "/") n++;
  return n;
}

/** show-branch.c's version_cmp: runs of digits compared as numbers, the rest by byte. */
export function versionCmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  const digitAt = (s: string, k: number) => {
    const c = s.charCodeAt(k);
    return c >= 0x30 && c <= 0x39;
  };
  for (;;) {
    let va = 0;
    let vb = 0;
    while (i < a.length && digitAt(a, i)) va = va * 10 + a.charCodeAt(i++) - 0x30;
    while (j < b.length && digitAt(b, j)) vb = vb * 10 + b.charCodeAt(j++) - 0x30;
    if (va !== vb) return va - vb;
    for (;;) {
      const ca = i < a.length && !digitAt(a, i) ? a.charCodeAt(i) : 0;
      const cb = j < b.length && !digitAt(b, j) ? b.charCodeAt(j) : 0;
      if (ca !== cb) return ca - cb;
      if (!ca) break;
      i++;
      j++;
    }
    if (i >= a.length && j >= b.length) return 0;
  }
}

/** rev_is_head: whether a rev's name is the branch HEAD is at. */
function revIsHead(head: string, name: string): boolean {
  const h = head.startsWith("refs/heads/") ? head.slice(11) : head;
  const n = name.startsWith("refs/heads/")
    ? name.slice(11)
    : name.startsWith("heads/")
      ? name.slice(6)
      : name;
  return h === n;
}

/** omit_in_dense: a merge (not a tip) reachable from only one tip. */
function omitInDense(c: Node, rev: Node[]): boolean {
  if (rev.includes(c)) return false;
  let count = 0;
  for (let i = 0; i < rev.length; i++) if (c.flags & (1 << (i + REV_SHIFT))) count++;
  return count === 1;
}

/** name_commits: tips, their first-parent chains, then the other parents (`x^2`, `x~3^`). */
function nameCommits(list: Node[], rev: Node[], refNames: string[]): void {
  const nameParent = (c: Node, p: Node) => {
    if (!c.name) return;
    if (!p.name || c.name.generation + 1 < p.name.generation) {
      p.name = { head: c.name.head, generation: c.name.generation + 1 };
    }
  };
  const nameFirstParentChain = (start: Node): number => {
    let i = 0;
    let c: Node | undefined = start;
    while (c) {
      if (!c.name) break;
      const p: Node | undefined = c.parents?.[0];
      if (!p) break;
      if (p.name) break;
      nameParent(c, p);
      i++;
      c = p;
    }
    return i;
  };
  for (const c of list) {
    if (c.name) continue;
    const i = rev.indexOf(c);
    if (i >= 0) c.name = { head: refNames[i] as string, generation: 0 };
  }
  let named: number;
  do {
    named = 0;
    for (const c of list) named += nameFirstParentChain(c);
  } while (named);
  do {
    named = 0;
    for (const c of list) {
      const n = c.name;
      if (!n) continue;
      let nth = 0;
      for (const p of c.parents ?? []) {
        nth++;
        if (p.name) continue;
        let name =
          n.generation === 0
            ? n.head
            : n.generation === 1
              ? `${n.head}^`
              : `${n.head}~${n.generation}`;
        name += nth === 1 ? "^" : `^${nth}`;
        p.name = { head: name, generation: 0 };
        named++;
        nameFirstParentChain(p);
      }
    }
  } while (named);
}

/** commit.c's sort_in_topological_order over parsed parents (graph order or commit date). */
function sortInTopologicalOrder(list: Node[], order: "topo" | "date"): Node[] {
  if (list.length === 0) return list;
  const indegree = new Map<Node, number>();
  for (const n of list) indegree.set(n, 1);
  for (const n of list) {
    for (const p of n.parents ?? []) {
      const d = indegree.get(p);
      if (d) indegree.set(p, d + 1);
    }
  }
  let put: (n: Node) => void;
  let get: () => Node | undefined;
  if (order === "topo") {
    const stack: Node[] = [];
    for (const n of list) if (indegree.get(n) === 1) stack.push(n);
    stack.reverse();
    put = (n) => stack.push(n);
    get = () => stack.pop();
  } else {
    const queue = new DateQueue<Node>();
    put = (n) => queue.put(n, n.date);
    get = () => queue.get();
    for (const n of list) if (indegree.get(n) === 1) put(n);
  }
  const out: Node[] = [];
  for (let n = get(); n !== undefined; n = get()) {
    for (const p of n.parents ?? []) {
      const d = indegree.get(p);
      if (!d) continue;
      indegree.set(p, d - 1);
      if (d - 1 === 1) put(p);
    }
    indegree.set(n, 0);
    out.push(n);
  }
  return out;
}

/**
 * git's prio_queue with compare_commits_by_commit_date: the newest first, entries of one date
 * in the order they were put. A binary heap, so `items()` is prio_queue_for_each's order.
 */
class DateQueue<T> {
  private readonly heap: { item: T; date: number; ctr: number }[] = [];
  private ctr = 0;

  put(item: T, date: number): void {
    const h = this.heap;
    h.push({ item, date, ctr: this.ctr++ });
    let ix = h.length - 1;
    while (ix > 0) {
      const parent = (ix - 1) >> 1;
      if (this.before(parent, ix)) break;
      [h[parent], h[ix]] = [h[ix] as (typeof h)[number], h[parent] as (typeof h)[number]];
      ix = parent;
    }
  }

  get(): T | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0] as (typeof h)[number];
    const last = h.pop() as (typeof h)[number];
    if (h.length > 0) {
      h[0] = last;
      let ix = 0;
      for (;;) {
        let child = 2 * ix + 1;
        if (child >= h.length) break;
        if (child + 1 < h.length && this.before(child + 1, child)) child++;
        if (this.before(ix, child)) break;
        [h[ix], h[child]] = [h[child] as (typeof h)[number], h[ix] as (typeof h)[number]];
        ix = child;
      }
    }
    return top.item;
  }

  peek(): T | undefined {
    return this.heap[0]?.item;
  }

  items(): T[] {
    return this.heap.map((e) => e.item);
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a] as (typeof this.heap)[number];
    const y = this.heap[b] as (typeof this.heap)[number];
    if (x.date !== y.date) return x.date > y.date;
    return x.ctr < y.ctr;
  }
}
