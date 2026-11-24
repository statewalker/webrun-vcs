/**
 * `git fmt-merge-msg` (fmt-merge-msg.c) as a library command: the message git's merge and
 * pull write for a merge, from FETCH_HEAD-style lines or from the names of merged heads.
 *
 * ```typescript
 * // the lines `git fetch` wrote, as `git fmt-merge-msg <.git/FETCH_HEAD`
 * const message = await git.fmtMergeMsg().setInput(fetchHeadText).setLog(true).call();
 * // "Merge branch 'left'\n\n# By A U Thor\n* left:\n  Left #2\n  Left #1\n"
 *
 * // the heads a `git merge left v1` names
 * await git.fmtMergeMsg().addHead("left").addHead("v1").call();
 * // "Merge branch 'left', tag 'v1'\n"
 * ```
 */

import type { Commit, ObjectId } from "@statewalker/vcs-core";
import { parseGitInt } from "@statewalker/vcs-utils";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { GitApiError, NotACommitError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { subjectOf } from "./merge-support.js";
import { commentPrefixOf } from "./message-cleanup.js";
import { commentLines } from "./rebase-todo.js";

/** git's `DEFAULT_MERGE_LOG_LEN`: `--log` and `merge.log=true` list at most this many commits. */
export const DEFAULT_MERGE_LOG_LENGTH = 20;

/**
 * The message for a merge, as `git fmt-merge-msg [-m <message>] [--log[=<n>] | --no-log]
 * [--into-name <name>]` writes it on its stdout.
 *
 * The input is FETCH_HEAD's format ({@link setInput}: `<id>\t\t<description>` per merged
 * head, `<id>\tnot-for-merge\t...` lines skipped) or the heads `git merge` is given
 * ({@link addHead}), each described as builtin/merge.c's `merge_name` describes it (`branch
 * 'x' of .`, `tag 'v1' of .`, `remote-tracking branch 'o/x' of .`, `branch 'x' (early part)
 * of .`, `tag '<id>'`, `commit '<name>'`). Heads HEAD or another head already contains are
 * left out (reduce_heads). The title (`Merge branches 'a' and 'b' into topic`) leaves out
 * the target branch when `merge.suppressDest` matches it (default `main` and `master`); an
 * annotated tag's message follows it; with a log length (`--log`, `merge.log`, or its old
 * name `merge.summary`), each head's shortlog follows: `* <name>:` and the subjects of the
 * commits HEAD lacks, newest first, at most that many (`* <name>: (<n> commits)` and `...`
 * when there are more), the branch's description first under `merge.branchdesc`, and
 * (unless {@link setCreditPeople} turns it off, as `git merge` without an editor does)
 * `# By` / `# Via` lines naming the authors and committers who are not you.
 *
 * Not done: a signed tag's signature is not verified, so its `# gpg: ...` lines are missing.
 */
export class FmtMergeMsgCommand extends GitCommand<string> {
  private input = "";
  private heads: string[] = [];
  private message?: string;
  private log?: number;
  private intoName?: string;
  private creditPeople = true;
  private headId?: ObjectId;

  /** FETCH_HEAD-style input (git's stdin or `-F <file>`). */
  setInput(input: string): this {
    this.checkCallable();
    this.input = input;
    return this;
  }

  /**
   * A head as `git merge` names it (a branch, tag, remote-tracking branch, `x~2`, an object
   * id): described as git's merge describes it, after the input's lines.
   */
  addHead(name: string): this {
    this.checkCallable();
    this.heads.push(name);
    return this;
  }

  /** `-m <message>`: the start of the message, given instead of the title. */
  setMessage(message: string | undefined): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * `--log[=<n>]` (true: {@link DEFAULT_MERGE_LOG_LENGTH}), `--no-log` (false or 0); undefined
   * (the default) takes `merge.log` / `merge.summary`.
   */
  setLog(log: boolean | number | undefined): this {
    this.checkCallable();
    this.log = log === true ? DEFAULT_MERGE_LOG_LENGTH : log === false ? 0 : log;
    return this;
  }

  /** `--into-name <name>`: the title names this branch instead of HEAD's. */
  setIntoName(name: string | undefined): this {
    this.checkCallable();
    this.intoName = name;
    return this;
  }

  /**
   * Whether the shortlog credits people (`# By`, `# Via`): `git fmt-merge-msg` does (the
   * default), `git merge` only when it runs an editor.
   */
  setCreditPeople(credit: boolean): this {
    this.checkCallable();
    this.creditPeople = credit;
    return this;
  }

  /**
   * The commit the merge goes into (default: HEAD's).
   *
   * @internal
   */
  setHead(id: ObjectId): this {
    this.checkCallable();
    this.headId = id;
    return this;
  }

  /**
   * The message, ended by a newline (empty when nothing is left to merge).
   *
   * @throws GitApiError git's `fatal: error in line <n>: <line>` for a line that is not
   *   FETCH_HEAD's format, `fatal: No current branch` without a HEAD commit, and the
   *   configuration's deaths (a negative `merge.log`, a valueless `merge.suppressDest`)
   */
  async call(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const config = fmtMergeMsgConfigOf(RemoteConfigStore.from(this.workingCopy));
    const log = this.log ?? (config.log > 0 ? config.log : 0);
    let input = this.input;
    if (input.length > 0 && !input.endsWith("\n") && this.heads.length > 0) input += "\n";
    for (const head of this.heads) input += await this.mergeName(head);
    return this.format(input, config, log);
  }

  private async format(input: string, config: FmtMergeMsgConfig, log: number): Promise<string> {
    const headRef = await this.refsStore.resolve("HEAD").catch(() => undefined);
    const headId = this.headId ?? headRef?.objectId;
    if (!headId) throw new GitApiError("fatal: No current branch", { exitCode: 128 });
    let current = headRef?.name ?? "HEAD";
    if (this.intoName !== undefined) current = this.intoName;
    else if (current.startsWith("refs/heads/")) current = current.slice("refs/heads/".length);

    const hexLength = this.objectFormat.hexLength;
    const lines = splitLines(input);
    const parents = await this.findMergeParents(lines, headId, hexLength);

    const sources: { name: string; data: SourceData }[] = [];
    const origins: Origin[] = [];
    lines.forEach((line, k) => {
      const code = handleLine(line, parents, hexLength, sources, origins);
      if (code !== 0) {
        throw new GitApiError(`fatal: error in line ${k + 1}: ${line}`, { exitCode: 128 });
      }
    });

    let out = this.message ?? "";
    if (this.message === undefined && sources.length > 0) {
      out += mergeTitle(sources, current, config.suppressDest);
    }
    if (origins.length > 0) out += await this.tagMessages(origins);
    if (log > 0) {
      out = completeLine(out);
      const comment = commentPrefixOf(this.workingCopy);
      for (const origin of origins)
        out += await this.shortlog(origin, headId, log, comment, config);
    }
    return completeLine(out);
  }

  /** find_merge_parents: each line's (given, commit) pair, kept when reduce_heads keeps the commit. */
  private async findMergeParents(
    lines: string[],
    headId: ObjectId,
    hexLength: number,
  ): Promise<{ given: ObjectId; commit: ObjectId }[]> {
    const resolver = this.revisionResolver();
    const table: { given: ObjectId; commit: ObjectId }[] = [];
    for (const line of lines) {
      const hex = line.slice(0, hexLength);
      if (!isHexId(hex, hexLength) || line[hexLength] !== "\t" || line[hexLength + 1] !== "\t") {
        continue;
      }
      const given = hex.toLowerCase() as ObjectId;
      const peeled = await resolver.peelTags(given).catch(() => undefined);
      if (peeled?.type !== "commit") continue;
      if (!table.some((p) => p.given === given && p.commit === peeled.id)) {
        table.push({ given, commit: peeled.id });
      }
    }
    const candidates = [...new Set([headId, ...table.map((p) => p.commit)])];
    const independent = new Set<ObjectId>();
    for (const c of candidates) {
      let reachable = false;
      for (const other of candidates) {
        if (other !== c && (await this.commits.isAncestor(c, other))) {
          reachable = true;
          break;
        }
      }
      if (!reachable) independent.add(c);
    }
    return table.filter((p) => independent.has(p.commit));
  }

  /** fmt_merge_msg_sigs: the messages of the annotated tags merged. */
  private async tagMessages(origins: Origin[]): Promise<string> {
    const resolver = this.revisionResolver();
    let tagbuf = "";
    let count = 0;
    let first = 0;
    for (const [i, origin] of origins.entries()) {
      if ((await resolver.objectType(origin.id).catch(() => undefined)) !== "tag") continue;
      const tag = await this.tagsStore?.load(origin.id);
      if (!tag) continue;
      const body = completeLine(tag.message);
      const comment = commentPrefixOf(this.workingCopy);
      if (count++ === 0) {
        tagbuf += body;
        first = i;
      } else {
        if (count === 2) {
          tagbuf = `${commentLines("\n", origins[first]?.name ?? "", comment)}${tagbuf}`;
        }
        tagbuf = commentLines(`${tagbuf}\n`, origin.name, comment);
        tagbuf += body;
      }
    }
    return tagbuf.length > 0 ? `\n${tagbuf}` : "";
  }

  /** fmt-merge-msg.c's shortlog: `* <name>:` and the subjects of `<head> ^HEAD`. */
  private async shortlog(
    origin: Origin,
    headId: ObjectId,
    limit: number,
    comment: string,
    config: FmtMergeMsgConfig,
  ): Promise<string> {
    const resolver = this.revisionResolver();
    const peeled = await resolver.peelTags(origin.id).catch(() => undefined);
    if (peeled?.type !== "commit") return "";
    const subjects: string[] = [];
    const authors = new Map<string, number>();
    const committers = new Map<string, number>();
    const record = (people: Map<string, number>, name: string | undefined) => {
      if (name === undefined) return;
      people.set(name, (people.get(name) ?? 0) + 1);
    };
    let count = 0;
    for (const { id, commit } of await this.walk(peeled.id, headId)) {
      if (commit.parents.length > 1) {
        // a merge is not listed, its committer counted
        if (this.creditPeople) record(committers, personName(commit, "committer"));
        continue;
      }
      // the tip's committer
      if (count === 0 && this.creditPeople) record(committers, personName(commit, "committer"));
      if (this.creditPeople) record(authors, personName(commit, "author"));
      count++;
      if (subjects.length > limit) continue;
      const subject = subjectOf(commit.message).replace(/^[\t\n\v\f\r ]+/, "");
      subjects.push(subject.length > 0 ? subject : id);
    }

    let out = "";
    if (this.creditPeople) out += this.creditLines(authors, committers, comment);
    out += count > limit ? `\n* ${origin.name}: (${count} commits)\n` : `\n* ${origin.name}:\n`;
    if (origin.isLocalBranch && config.branchDesc) {
      const description = RemoteConfigStore.from(this.workingCopy).value(
        `branch.${origin.name}.description`,
      );
      if (description !== undefined) {
        for (const line of description.split(/(?<=\n)/)) {
          if (line.length > 0) out += `  : ${line}`;
        }
        out = completeLine(out);
      }
    }
    subjects.forEach((subject, i) => {
      out += i >= limit ? "  ...\n" : `  ${subject}\n`;
    });
    return out;
  }

  /** add_people_info: `# By <authors>` and `# Via <committers>`, unless only you. */
  private creditLines(
    authors: Map<string, number>,
    committers: Map<string, number>,
    comment: string,
  ): string {
    // git_author_info / git_committer_info (IDENT_NO_DATE): unknown when not resolvable
    const nameOf = (resolve: () => { name: string }) => {
      try {
        return resolve().name;
      } catch {
        return undefined;
      }
    };
    const me = {
      author: nameOf(() => this.resolveAuthor()),
      committer: nameOf(() => this.resolveCommitter()),
    };
    let out = "";
    for (const [label, people, mine] of [
      ["By", authors, me.author],
      ["Via", committers, me.committer],
    ] as const) {
      // string_list sorted by name, then a stable sort by count, highest first
      const sorted = [...people.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .sort(([, a], [, b]) => b - a);
      if (sorted.length === 0) continue;
      if (sorted.length === 1 && sorted[0]?.[0] === mine) continue;
      out += `\n${comment} ${label} `;
      const [first, second] = sorted;
      if (sorted.length === 1) out += first?.[0];
      else if (sorted.length === 2) {
        out += `${first?.[0]} (${first?.[1]}) and ${second?.[0]} (${second?.[1]})`;
      } else out += `${first?.[0]} (${first?.[1]}) and others`;
    }
    return out;
  }

  /**
   * `rev-list <tip> ^<head>` in git's default order (limit_list): a queue by committer date,
   * newest first, ties in the order queued; a commit HEAD reaches is left out, also when
   * that is found only after it was queued.
   */
  private async walk(tip: ObjectId, headId: ObjectId): Promise<{ id: ObjectId; commit: Commit }[]> {
    const loaded = new Map<ObjectId, Commit | undefined>();
    const load = async (id: ObjectId) => {
      if (!loaded.has(id)) loaded.set(id, await this.commits.load(id).catch(() => undefined));
      return loaded.get(id);
    };
    const uninteresting = new Set<ObjectId>();
    const seen = new Set<ObjectId>();
    const queue: { id: ObjectId; time: number; seq: number }[] = [];
    let seq = 0;
    const push = async (id: ObjectId) => {
      const commit = await load(id);
      const entry = { id, time: commit?.committer.timestamp ?? 0, seq: seq++ };
      // commit_list_insert_by_date: before the first older entry
      let at = queue.findIndex((e) => e.time < entry.time);
      if (at < 0) at = queue.length;
      queue.splice(at, 0, entry);
    };
    // mark_parents_uninteresting: through every commit already parsed
    const markUninteresting = (id: ObjectId) => {
      const stack = [id];
      while (stack.length > 0) {
        const next = stack.pop() as ObjectId;
        for (const parent of loaded.get(next)?.parents ?? []) {
          if (uninteresting.has(parent)) continue;
          uninteresting.add(parent);
          if (loaded.has(parent)) stack.push(parent);
        }
      }
    };
    uninteresting.add(headId);
    for (const id of [tip, headId]) {
      if (seen.has(id)) continue;
      seen.add(id);
      await push(id);
    }
    const listed: ObjectId[] = [];
    while (queue.length > 0) {
      if (queue.every((e) => uninteresting.has(e.id))) break;
      const { id } = queue.shift() as { id: ObjectId };
      const commit = await load(id);
      if (!commit) continue;
      const boring = uninteresting.has(id);
      for (const parent of commit.parents) {
        if (boring) uninteresting.add(parent);
        if (seen.has(parent)) continue;
        seen.add(parent);
        await push(parent);
      }
      if (boring) {
        markUninteresting(id);
        continue;
      }
      listed.push(id);
    }
    const out: { id: ObjectId; commit: Commit }[] = [];
    for (const id of listed) {
      const commit = loaded.get(id);
      if (commit && !uninteresting.has(id)) out.push({ id, commit });
    }
    return out;
  }

  /** builtin/merge.c's merge_name: the FETCH_HEAD-style line describing a merged head. */
  private async mergeName(given: string): Promise<string> {
    const name = await this.expandPriorCheckout(given);
    const resolver = this.revisionResolver();
    const objectId = await resolver.resolve(name).catch(() => undefined);
    const head = objectId ? await resolver.peelTags(objectId) : undefined;
    if (!objectId || head?.type !== "commit") {
      const type = head?.type === "commit" ? undefined : head?.type;
      throw new NotACommitError(
        name,
        objectId ?? "",
        type,
        `fatal: '${name}' does not point to a commit`,
      );
    }
    // dwim_ref: the first ref the name stands for, named as resolved
    for (const candidate of dwimCandidates(name)) {
      const ref = await this.refsStore.resolve(candidate).catch(() => undefined);
      if (!ref?.objectId) continue;
      for (const [prefix, kind] of [
        ["refs/heads/", "branch"],
        ["refs/tags/", "tag"],
        ["refs/remotes/", "remote-tracking branch"],
      ] as const) {
        if (ref.name.startsWith(prefix)) return `${ref.objectId}\t\t${kind} '${name}' of .\n`;
      }
      break;
    }
    // <name>^^^ or <name>~<number> of a local branch: its early part
    let len = 0;
    let early = false;
    let end = name.length;
    while (end > 0 && name[end - 1] === "^") {
      end--;
      len++;
    }
    if (len > 0) early = true;
    else {
      const tilde = name.lastIndexOf("~");
      if (tilde >= 0) {
        const digits = name.slice(tilde + 1);
        if (/^\d*$/.test(digits)) {
          len = digits.length + 1;
          early = /[1-9]/.test(digits) || len === 1;
        }
      }
    }
    if (len > 0) {
      const branch = name.slice(0, name.length - len);
      if (await this.refsStore.has(`refs/heads/${branch}`)) {
        return `${head.id}\t\tbranch '${branch}'${early ? " (early part)" : ""} of .\n`;
      }
    }
    if ((await resolver.objectType(objectId).catch(() => undefined)) === "tag") {
      return `${objectId}\t\ttag '${name}'\n`;
    }
    return `${head.id}\t\tcommit '${name}'\n`;
  }
}

/** The `merge.*` settings fmt-merge-msg reads (fmt_merge_msg_config). */
export interface FmtMergeMsgConfig {
  /** `merge.log` / `merge.summary`, whichever comes last: a length, 0 for none */
  log: number;
  /** `merge.branchdesc` */
  branchDesc: boolean;
  /** `merge.suppressDest` patterns (an empty value clears them; default main, master) */
  suppressDest: string[];
}

const BOOL_TEXT: Record<string, boolean> = {
  true: true,
  yes: true,
  on: true,
  false: false,
  no: false,
  off: false,
  "": false,
};

/** fmt_merge_msg_config over a repository's configuration, in its order. */
export function fmtMergeMsgConfigOf(config: RemoteConfigStore): FmtMergeMsgConfig {
  const entries = config.entriesWithPrefix("merge.") ?? [
    ...(config.lastValueOf(["merge.log", "merge.summary"]) !== undefined
      ? [{ key: "merge.log", value: config.lastValueOf(["merge.log", "merge.summary"]) }]
      : []),
    ...config.values("merge.branchdesc").map((value) => ({ key: "merge.branchdesc", value })),
    ...config.values("merge.suppressdest").map((value) => ({ key: "merge.suppressdest", value })),
  ];
  const out: FmtMergeMsgConfig = { log: -1, branchDesc: false, suppressDest: [] };
  let suppressSeen = false;
  for (const { key, value } of entries) {
    if (key === "merge.log" || key === "merge.summary") {
      // git_config_bool_or_int: a boolean is the default length, a number itself
      const bool = value === undefined ? true : BOOL_TEXT[value.toLowerCase()];
      if (bool !== undefined) out.log = bool ? DEFAULT_MERGE_LOG_LENGTH : 0;
      else {
        const n = parseGitInt(value);
        if (n === undefined) {
          throw new GitApiError(`fatal: bad numeric config value '${value}' for '${key}'`, {
            exitCode: 128,
          });
        }
        if (n < 0) {
          throw new GitApiError(`error: ${key}: negative length ${value}`, { exitCode: 128 });
        }
        out.log = n;
      }
    } else if (key === "merge.branchdesc") {
      out.branchDesc =
        value === undefined ? true : (BOOL_TEXT[value.toLowerCase()] ?? Number(value) !== 0);
    } else if (key === "merge.suppressdest") {
      if (value === undefined) {
        throw new GitApiError(`error: missing value for '${key}'`, { exitCode: 128 });
      }
      if (value === "") out.suppressDest = [];
      else out.suppressDest.push(value);
      suppressSeen = true;
    }
  }
  if (!suppressSeen) out.suppressDest = ["main", "master"];
  return out;
}

interface SourceData {
  branch: string[];
  tag: string[];
  rBranch: string[];
  generic: string[];
  headStatus: number;
}

interface Origin {
  name: string;
  id: ObjectId;
  isLocalBranch: boolean;
}

/** handle_line: one FETCH_HEAD line into its source's lists and the origins. */
function handleLine(
  line: string,
  parents: { given: ObjectId; commit: ObjectId }[],
  hexLength: number,
  sources: { name: string; data: SourceData }[],
  origins: Origin[],
): number {
  if (line.length < hexLength + 3 || line[hexLength] !== "\t") return 1;
  if (line.startsWith("not-for-merge", hexLength + 1)) return 0;
  if (line[hexLength + 1] !== "\t") return 2;
  const hex = line.slice(0, hexLength);
  if (!isHexId(hex, hexLength)) return 3;
  const id = hex.toLowerCase() as ObjectId;
  // subsumed by other parents
  if (!parents.some((p) => p.given === id)) return 0;

  let text = line.slice(hexLength + 2);
  let src: string;
  let pullingHead: boolean;
  const of = text.indexOf(" of ");
  if (of >= 0) {
    src = text.slice(of + 4);
    text = text.slice(0, of);
    pullingHead = false;
  } else {
    src = text;
    pullingHead = true;
  }
  let source = sources.find((s) => s.name === src);
  if (!source) {
    source = {
      name: src,
      data: { branch: [], tag: [], rBranch: [], generic: [], headStatus: 0 },
    };
    sources.push(source);
  }
  const data = source.data;
  let origin: string;
  let isLocalBranch = false;
  if (pullingHead) {
    origin = src;
    data.headStatus |= 1;
  } else if (text.startsWith("branch ")) {
    origin = text.slice("branch ".length);
    isLocalBranch = true;
    data.branch.push(origin);
    data.headStatus |= 2;
  } else if (text.startsWith("tag ")) {
    origin = text;
    data.tag.push(text.slice("tag ".length));
    data.headStatus |= 2;
  } else if (text.startsWith("remote-tracking branch ")) {
    origin = text.slice("remote-tracking branch ".length);
    data.rBranch.push(origin);
    data.headStatus |= 2;
  } else {
    origin = src;
    data.generic.push(text);
    data.headStatus |= 2;
  }
  if (src === "." || src === origin) {
    if (origin.length >= 2 && origin.startsWith("'") && origin.endsWith("'")) {
      origin = origin.slice(1, -1);
    }
  } else origin = `${origin} of ${src}`;
  if (src !== ".") isLocalBranch = false;
  origins.push({ name: origin, id, isLocalBranch });
  return 0;
}

/** fmt_merge_msg_title: `Merge <what> [of <src>][; ...] [into <branch>]`. */
function mergeTitle(
  sources: { name: string; data: SourceData }[],
  current: string,
  suppressDest: string[],
): string {
  let out = "Merge ";
  let sep = "";
  for (const { name, data } of sources) {
    out += sep;
    sep = "; ";
    if (data.headStatus === 1) {
      out += name;
      continue;
    }
    let subsep = "";
    if (data.headStatus === 3) {
      subsep = ", ";
      out += "HEAD";
    }
    for (const [list, singular, plural] of [
      [data.branch, "branch ", "branches "],
      [data.rBranch, "remote-tracking branch ", "remote-tracking branches "],
      [data.tag, "tag ", "tags "],
      [data.generic, "commit ", "commits "],
    ] as const) {
      if (list.length === 0) continue;
      out += subsep;
      subsep = ", ";
      out += joined(singular, plural, list);
    }
    if (name !== ".") out += ` of ${name}`;
  }
  if (!suppressDest.some((p) => wildmatch(p, current, { pathname: true }))) {
    out += ` into ${current}`;
  }
  return `${out}\n`;
}

/** print_joined: `branch 'a'`, `branches 'a', 'b' and 'c'`. */
function joined(singular: string, plural: string, list: readonly string[]): string {
  if (list.length === 1) return `${singular}${list[0]}`;
  return `${plural}${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** dwim_ref's rules (refs.c `ref_rev_parse_rules`) for a name. */
function dwimCandidates(name: string): string[] {
  // the name itself only where git would read it as a ref (`refs/...`, a root ref)
  const itself = name.startsWith("refs/") || /^[A-Z_]+$/.test(name) ? [name] : [];
  return [
    ...itself,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
}

/** record_person_from_buf: an ident's name as the commit stores it. */
function personName(commit: Commit, which: "author" | "committer"): string | undefined {
  const name = commit[which]?.name.replace(/[\t\n\v\f\r ]+$/, "");
  return name ? name : undefined;
}

function isHexId(text: string, length: number): boolean {
  return text.length === length && /^[0-9a-fA-F]+$/.test(text);
}

/** The input's lines, as fmt_merge_msg cuts them (no empty line after a last newline). */
function splitLines(input: string): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos < input.length) {
    const nl = input.indexOf("\n", pos);
    const end = nl < 0 ? input.length : nl;
    lines.push(input.slice(pos, end));
    pos = nl < 0 ? input.length : nl + 1;
  }
  return lines;
}

/** strbuf_complete_line */
function completeLine(text: string): string {
  return text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
}
