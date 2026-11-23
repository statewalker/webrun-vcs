/**
 * git's revision syntax (`object-name.c` `get_oid_with_context`, `remote.c`
 * `branch_get_upstream` / `branch_get_push`, `refs.c` `read_ref_at`), checked against git
 * 2.43 and 2.56. Every command that takes a revision resolves it here (through
 * `GitCommand.resolveRevision` and `resolveRef`).
 *
 * @example
 * ```typescript
 * const resolver = new RevisionResolver(sources);
 * await resolver.resolve("main@{u}");        // what refs/remotes/origin/main holds
 * await resolver.resolve("HEAD@{2}");        // HEAD two moves ago (its reflog)
 * await resolver.resolve("main@{yesterday}"); // main as it was a day ago
 * await resolver.resolve(":/fix typo");      // the youngest commit whose message matches
 * await resolver.resolve("v1.0^{tree}");     // the tree of the tagged commit
 * await resolver.resolve("HEAD:src/a.ts");   // a blob of HEAD's tree
 * await resolver.resolve(":2:a.ts");         // "ours" of a conflicted path in the index
 * ```
 *
 * Supported: full object ids; ref names by git's dwim rules (`<name>`, `refs/<name>`,
 * `refs/tags/`, `refs/heads/`, `refs/remotes/`, `refs/remotes/<name>/HEAD`); `@` (HEAD);
 * `@{-N}`; `[<branch>]@{upstream}` / `@{u}`; `[<branch>]@{push}`; `[<ref>]@{<n>}` and
 * `[<ref>]@{<date>}` (git's approxidate); `<rev>~<n>`, `<rev>^<n>`; `<rev>^{<type>}`,
 * `<rev>^{}`, `<rev>^{/<regex>}`; `:/<regex>` (with git's `!-` and `!!`); `<rev>:<path>`;
 * `:<path>` and `:<n>:<path>` (`./` and `../` paths relative to {@link cwdPrefix}); abbreviated
 * object ids (`get_short_oid`: at least 4 hex digits, disambiguated by the type the context
 * needs or `core.disambiguate`, with git's `error: short object ID ... is ambiguous` and its
 * candidate list); `git describe` names (`<tag>-<n>-g<abbrev>`, the abbreviation read as a
 * commit). Regexes are POSIX extended ones run as glibc runs them (`compilePosixRegex`).
 *
 * Revision ranges and sets (`a..b`, `a...b`, `^a`, `a^@`, `a^!`, `a^-<n>`) are read by
 * `parseRevisionArgs` (`revision-range.ts`) on top of this resolver.
 */

import type { Commit, GitObjects, ObjectId, PersonIdent, Refs } from "@statewalker/vcs-core";
import {
  isSymbolicRef,
  isValidRefName,
  listObjectsWithPrefix,
  MINIMUM_ABBREV_LENGTH,
  objectFormatOf,
} from "@statewalker/vcs-core";
import { compilePosixRegex, isNullObjectId, parseGitBool } from "@statewalker/vcs-utils";
import type { Staging, WorkingCopy } from "@statewalker/vcs-working-tree";

import { RevisionError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { applyRefspecs } from "./branch-tracking.js";
import { configLoadError } from "./core-config.js";
import { approxidateCareful, formatRfc2822Date } from "./git-date.js";

/** The stores a revision is read from. */
export interface RevisionSources {
  refs: Refs;
  commits: {
    load(id: ObjectId): Promise<Commit | undefined>;
    has(id: ObjectId): Promise<boolean>;
  };
  trees: {
    has(id: ObjectId): Promise<boolean>;
    getEntry(treeId: ObjectId, name: string): Promise<{ id: ObjectId; mode: number } | undefined>;
  };
  blobs: { has(id: ObjectId): Promise<boolean> };
  tags?: {
    has(id: ObjectId): Promise<boolean>;
    load(
      id: ObjectId,
    ): Promise<{ object: ObjectId; tag?: string; tagger?: PersonIdent } | undefined>;
  };
  /**
   * The object store, for abbreviated ids (its `listPrefix`, else `list`); without it the
   * typed stores' `keys()` are listed
   */
  objects?: Pick<GitObjects, "list" | "listPrefix" | "objectFormat">;
  /**
   * The lengths git abbreviates ids to (`repo_find_unique_abbrev` with `core.abbrev`), for
   * the candidates of an ambiguous short id; 7 digits without it
   */
  abbreviate?: (ids: ObjectId[]) => Promise<Map<ObjectId, number>>;
  /** The index, for `:<path>` (undefined where there is none) */
  staging?: () => Staging | undefined;
  /** The configuration (`branch.*`, `remote.*`, `push.default`) */
  workingCopy: WorkingCopy;
  /**
   * Whether something is at `path` (from the top of the worktree) in the worktree, as git's
   * `lstat` finds it; for git's diagnostics of a misspelt `<rev>:<path>` and `:<path>`
   * (`exists on disk, but not in ...`) and `check_filename`. Absent: nothing is
   */
  fileExists?: (path: string) => Promise<boolean>;
  /** The top of the worktree as the host names it, for `'x' is outside repository at '<dir>'` */
  worktreeHostPath?: string;
}

type ObjectType = "commit" | "tree" | "blob" | "tag";

/**
 * The type a context needs of an abbreviated id (git's `GET_OID_COMMIT`, `GET_OID_COMMITTISH`,
 * `GET_OID_TREE`, `GET_OID_TREEISH`, `GET_OID_BLOB`; `core.disambiguate`'s values but "none"):
 * of several objects sharing the prefix, the one that is (or peels to) such an object wins.
 */
export type DisambiguateHint = "commit" | "committish" | "tree" | "treeish" | "blob";

/** How {@link RevisionResolver.resolve} reads a revision. */
export interface ResolveOptions {
  /** The type the caller needs (`git log` and `A..B` want committishes); default none */
  hint?: DisambiguateHint;
  /** git's `GET_OID_QUIETLY`: no `error:` lines for an ambiguous short id */
  quiet?: boolean;
  /**
   * git's `GET_OID_ONLY_TO_DIE` (`maybe_die_on_misspelt_object_name`): a `<rev>:<path>` or
   * `:<path>` that names nothing dies with git's diagnosis (`path 'x' does not exist in
   * 'HEAD'`, `path 'x' exists on disk, but not in the index`, ...); `:/<text>` is not
   * searched
   */
  onlyToDie?: boolean;
}

/** git's `get_short_oid` result. */
type ShortOid =
  | { status: "found"; id: ObjectId }
  | { status: "missing" }
  | { status: "ambiguous" }
  | { status: "invalid" };

const HEX_DIGIT = /^[0-9a-fA-F]$/;
const isHexDigit = (c: string | undefined) => c !== undefined && HEX_DIGIT.test(c);

const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/** git's `object_name_msg` advice after a 40-hex name that is also a ref. */
const OBJECT_NAME_ADVICE = [
  "Git normally never creates a ref that ends with 40 hex characters",
  "because it will be ignored when you just specify 40-hex. These refs",
  "may be created by mistake. For example,",
  "",
  "  git switch -c $br $(git rev-parse ...)",
  "",
  'where "$br" is somehow empty and a 40-hex ref is created. Please',
  "examine these refs and maybe delete them. Turn this message off by",
  'running "git config set advice.objectNameWarning false"',
].join("\n");

/** git's `ref_rev_parse_rules`. */
const REV_PARSE_RULES = [
  (n: string) => n,
  (n: string) => `refs/${n}`,
  (n: string) => `refs/tags/${n}`,
  (n: string) => `refs/heads/${n}`,
  (n: string) => `refs/remotes/${n}`,
  (n: string) => `refs/remotes/${n}/HEAD`,
];

/** git's `at_mark`: the length of the suffix `s` starts with (case-insensitive), or 0. */
function atMark(s: string, suffixes: string[]): number {
  const lower = s.toLowerCase();
  for (const suffix of suffixes) if (lower.startsWith(suffix)) return suffix.length;
  return 0;
}
const upstreamMark = (s: string) => atMark(s, ["@{upstream}", "@{u}"]);
const pushMark = (s: string) => atMark(s, ["@{push}"]);

/** git's `ambiguous_path`: a path with an empty, `.` or `..` component. */
function ambiguousPath(path: string): boolean {
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return true;
  }
  return false;
}

/** Characters consumed of a name and what they stand for (git's interpret_branch_name). */
interface Interpreted {
  used: number;
  value: string;
}

/**
 * Resolves revisions as git's `get_oid` does. Warnings git prints while resolving
 * (`warning: log for 'main' only goes back to ...`) collect in {@link warnings}; where git
 * dies a {@link RevisionError} is thrown with its message.
 */
export class RevisionResolver {
  /** What git prints while resolving: `warning: ...` and `error: ...` lines */
  readonly warnings: string[] = [];
  /**
   * The current directory below the top of the worktree (git's `prefix`, `d/sub/` or ""),
   * against which `<rev>:./<path>`, `<rev>:../<path>` and `:./<path>` are read
   */
  cwdPrefix = "";
  private config?: RemoteConfigStore;
  private disambiguateChecked = false;
  /** Refs read while resolving one revision (`HEAD~3` reads HEAD once) */
  private readonly refCache = new Map<string, Promise<{ id: ObjectId; ref: string } | undefined>>();

  constructor(
    private readonly sources: RevisionSources,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.hexLength = objectFormatOf(sources.objects).hexLength;
  }

  /** The repository's full hex id length: 40, or 64 in a SHA-256 repository (git's hexsz) */
  private readonly hexLength: number;

  /** Whether `str` is a full hex object id of the repository's format, in any case */
  private isFullHex(str: string): boolean {
    return str.length === this.hexLength && HEX_DIGITS.test(str);
  }

  /**
   * The object `name` names, or undefined when it names none (git's `unknown revision`).
   *
   * @throws RevisionError where git dies (an `@{u}` without upstream, a reflog too short)
   */
  async resolve(name: string, options: ResolveOptions = {}): Promise<ObjectId | undefined> {
    this.checkDisambiguateConfig(name);
    const direct = await this.oid1(name, options);
    if (direct !== undefined) return direct;
    if (name.startsWith(":")) {
      if (!options.onlyToDie && name.length > 2 && name[1] === "/") {
        return this.oneline(name.slice(2), await this.allRefCommits());
      }
      let stage = 0;
      let path = name.slice(1);
      if (name.length >= 3 && name[2] === ":" && name[1] >= "0" && name[1] <= "3") {
        stage = Number(name[1]);
        path = name.slice(3);
      }
      const resolved = this.relativePath(path, name);
      const found = await this.indexEntry(resolved, stage);
      if (found === undefined && options.onlyToDie && name.length > 1 && name[1] !== "/") {
        await this.diagnoseIndexPath(name, stage, resolved);
      }
      return found;
    }
    // <tree-ish>:<path>, the first `:` outside `@{...}` / `^{...}`
    let depth = 0;
    for (let i = 0; i < name.length; i++) {
      const c = name[i];
      if ((c === "@" || c === "^") && name[i + 1] === "{") {
        i++;
        depth++;
      } else if (depth > 0 && c === "}") {
        depth--;
      } else if (depth === 0 && c === ":") {
        const objectName = name.slice(0, i);
        const treeish = await this.oid1(objectName, { ...options, hint: "treeish" });
        if (treeish === undefined) {
          if (options.onlyToDie) this.die(name, `fatal: invalid object name '${objectName}'.`);
          return undefined;
        }
        const filename = this.relativePath(name.slice(i + 1), name);
        const tree = await this.peelToType(treeish, "tree");
        const found = tree === undefined ? undefined : await this.treeEntry(tree, filename);
        if (found === undefined && options.onlyToDie) {
          await this.diagnoseTreePath(name, objectName, tree, filename);
        }
        return found;
      }
    }
    return undefined;
  }

  /**
   * The branch name `name` stands for, as git's `interpret_branch_name` gives it (`@{-1}`
   * is the branch left before, `@{u}` the upstream's short name, `@` HEAD), or undefined
   * when it stands for nothing else.
   */
  async interpretBranchName(name: string): Promise<string | undefined> {
    const interpreted = await this.interpret(name);
    return typeof interpreted === "object" && interpreted.used === name.length
      ? interpreted.value
      : undefined;
  }

  /**
   * The ref `@{upstream}` of `branch` names (git's `branch_get_upstream`); the current
   * branch when undefined.
   *
   * @throws RevisionError with git's message when there is none
   */
  async upstreamOf(branch: string | undefined, revision = "@{upstream}"): Promise<string> {
    const name = branch ?? (await this.currentBranch());
    if (name === undefined) throw this.fatal(revision, "HEAD does not point to a branch");
    const config = this.remoteConfig();
    const remote = config.value(`branch.${name}.remote`);
    const merges = config.values(`branch.${name}.merge`);
    if (!remote || merges.length === 0) {
      if (!(await this.sources.refs.has(`refs/heads/${name}`))) {
        throw this.fatal(revision, `no such branch: '${name}'`);
      }
      throw this.fatal(revision, `no upstream configured for branch '${name}'`);
    }
    const src = merges[0] ?? "";
    let dst = applyRefspecs(config.configuredFetchRefspecs(remote), src);
    if (dst === undefined && remote === ".") {
      const found = await this.dwimRefAll(src, false);
      dst = found.length === 1 ? found[0]?.ref : src;
    }
    if (dst === undefined) {
      throw this.fatal(revision, `upstream branch '${src}' not stored as a remote-tracking branch`);
    }
    return dst;
  }

  /**
   * The remote `git push` pushes `branch` to (git's `pushremote_for_branch`):
   * `branch.<name>.pushRemote`, `remote.pushDefault`, `branch.<name>.remote`, the one
   * configured remote, else `origin`.
   */
  pushRemoteOf(branch: string): string {
    const config = this.remoteConfig();
    return (
      config.value(`branch.${branch}.pushRemote`) ??
      config.value("remote.pushDefault") ??
      config.value(`branch.${branch}.remote`) ??
      (config.configuredNames().length === 1 ? config.configuredNames()[0] : "origin") ??
      "origin"
    );
  }

  /**
   * The ref `@{push}` of `branch` names (git's `branch_get_push`): where `git push` would
   * push it, as the remote-tracking ref that follows it; the current branch when undefined.
   *
   * @throws RevisionError with git's message when there is none
   */
  async pushOf(branch: string | undefined, revision = "@{push}"): Promise<string> {
    const name = branch ?? (await this.currentBranch());
    if (name === undefined) throw this.fatal(revision, "HEAD does not point to a branch");
    const config = this.remoteConfig();
    const refname = `refs/heads/${name}`;
    const remote = this.pushRemoteOf(name);
    const trackingFor = (dst: string) => {
      const tracking = applyRefspecs(config.configuredFetchRefspecs(remote), dst);
      if (tracking === undefined) {
        throw this.fatal(
          revision,
          `push destination '${dst}' on remote '${remote}' has no local tracking branch`,
        );
      }
      return tracking;
    };
    const pushSpecs = config.values(`remote.${remote}.push`);
    if (pushSpecs.length > 0) {
      const dst = applyRefspecs(pushSpecs, refname);
      if (dst === undefined) {
        throw this.fatal(revision, `push refspecs for '${remote}' do not include '${name}'`);
      }
      return trackingFor(dst);
    }
    const mirror = config.value(`remote.${remote}.mirror`);
    if (mirror !== undefined && ["true", "yes", "on", "1", ""].includes(mirror.toLowerCase())) {
      return trackingFor(refname);
    }
    const mode = config.value("push.default") ?? "simple";
    switch (mode) {
      case "nothing":
        throw this.fatal(revision, "push has no destination (push.default is 'nothing')");
      case "matching":
      case "current":
        return trackingFor(refname);
      case "upstream":
      case "tracking":
        return this.upstreamOf(name, revision);
      default: {
        const up = await this.upstreamOf(name, revision);
        const cur = trackingFor(refname);
        if (cur !== up) {
          throw this.fatal(revision, "cannot resolve 'simple' push to a single destination");
        }
        return cur;
      }
    }
  }

  // ------------------------------------------------------------------ get_oid_1

  /** git's `get_oid_1`: `~<n>` / `^<n>`, then `^{...}`, then a ref or an object id. */
  private async oid1(name: string, flags: ResolveOptions = {}): Promise<ObjectId | undefined> {
    let cp = name.length - 1;
    while (cp >= 0 && (name[cp] ?? "") >= "0" && (name[cp] ?? "") <= "9") cp--;
    const suffix = cp >= 0 ? name[cp] : undefined;
    if (suffix === "~" || suffix === "^") {
      const digits = name.slice(cp + 1);
      let num = digits === "" ? 0 : Number(digits);
      if (!Number.isSafeInteger(num) || num > 2147483647) return undefined;
      if (num === 0 && cp === name.length - 1) num = 1;
      const base = name.slice(0, cp);
      return suffix === "^"
        ? this.parent(base, num, flags.quiet)
        : this.nthAncestor(base, num, flags.quiet);
    }
    const peeled = await this.peelOnion(name, flags);
    if (peeled !== undefined) return peeled;
    const basic = await this.basic(name, flags);
    if (basic !== undefined) return basic;
    // describe output, "SOMETHING-gXXXX"
    const described = await this.describeName(name);
    if (described !== undefined) return described;
    const short = await this.shortOid(name, flags);
    return short.status === "found" ? short.id : undefined;
  }

  /** git's `get_parent`: `<rev>^<n>` (`^0` the commit itself). */
  private async parent(name: string, idx: number, quiet?: boolean): Promise<ObjectId | undefined> {
    const id = await this.oid1(name, { hint: "committish", quiet });
    if (id === undefined) return undefined;
    const commitId = await this.commitReference(id);
    if (commitId === undefined) return undefined;
    if (idx === 0) return commitId;
    const commit = await this.sources.commits.load(commitId);
    return commit?.parents[idx - 1];
  }

  /** git's `get_nth_ancestor`: `<rev>~<n>`, first parents. */
  private async nthAncestor(
    name: string,
    generation: number,
    quiet?: boolean,
  ): Promise<ObjectId | undefined> {
    const id = await this.oid1(name, { hint: "committish", quiet });
    if (id === undefined) return undefined;
    let commitId = await this.commitReference(id);
    for (let i = 0; commitId !== undefined && i < generation; i++) {
      const commit = await this.sources.commits.load(commitId);
      commitId = commit?.parents[0];
    }
    return commitId;
  }

  /** git's `peel_onion`: `<rev>^{<type>}`, `<rev>^{}`, `<rev>^{/<regex>}`. */
  private async peelOnion(name: string, flags: ResolveOptions): Promise<ObjectId | undefined> {
    if (name.length < 4 || !name.endsWith("}")) return undefined;
    let sp = name.length - 1;
    for (; sp >= 0; sp--) if (name[sp] === "{" && sp > 0 && name[sp - 1] === "^") break;
    if (sp <= 0) return undefined;
    const spec = name.slice(sp + 1);
    let expected: ObjectType | "any" | "none";
    if (spec.startsWith("commit}")) expected = "commit";
    else if (spec.startsWith("tag}")) expected = "tag";
    else if (spec.startsWith("tree}")) expected = "tree";
    else if (spec.startsWith("blob}")) expected = "blob";
    else if (spec.startsWith("object}")) expected = "any";
    else if (spec.startsWith("}")) expected = "none";
    else if (spec.startsWith("/")) expected = "commit";
    else return undefined;
    // the type wanted decides an abbreviation; other peels fall back to core.disambiguate
    const hint: DisambiguateHint | undefined =
      expected === "commit" ? "committish" : expected === "tree" ? "treeish" : undefined;
    const outer = await this.oid1(name.slice(0, sp - 1), { quiet: flags.quiet, hint });
    if (outer === undefined) return undefined;
    if (expected === "none") return this.derefTags(outer);
    const id = expected === "any" ? outer : await this.peelToType(outer, expected, name);
    if (id === undefined) return undefined;
    if (spec.startsWith("/")) {
      const pattern = name.slice(sp + 2, name.length - 1);
      if (pattern === "") return id;
      return this.oneline(pattern, [id]);
    }
    return id;
  }

  // ------------------------------------------------------------------ get_oid_basic

  /**
   * git's `get_oid_basic`: an object id (taken as it is, whether the repository has the
   * object or not), a ref, `<ref>@{<n>|<date>}`, `@{-N}`.
   */
  private async basic(str: string, flags: ResolveOptions = {}): Promise<ObjectId | undefined> {
    if (this.isFullHex(str)) {
      // warn_on_object_refname_ambiguity: a ref spelled as the 40-hex
      if (this.warnAmbiguousRefs() && (await this.dwimRefAll(str)).length > 0) {
        this.warnings.push(`warning: refname '${str}' is ambiguous.`);
        const advice = parseGitBool(this.remoteConfig().value("advice.objectNameWarning"));
        if (advice !== false) this.warnings.push(OBJECT_NAME_ADVICE);
      }
      return str.toLowerCase();
    }
    let len = str.length;
    let at = 0;
    let reflogLen = 0;
    let nthPrior = false;
    if (len > 0 && str[len - 1] === "}") {
      for (at = len - 4; at >= 0; at--) {
        if (str[at] === "@" && str[at + 1] === "{") {
          if (str[at + 2] === "-") {
            // @{-N} not at the start
            if (at !== 0) return undefined;
            nthPrior = true;
            continue;
          }
          const rest = str.slice(at);
          if (!upstreamMark(rest) && !pushMark(rest)) {
            reflogLen = len - 1 - (at + 2);
            len = at;
          }
          break;
        }
      }
    }
    const base = str.slice(0, len);
    if (len > 0 && ambiguousPath(base)) return undefined;

    if (nthPrior) {
      const prior = await this.nthPriorCheckout(base);
      if (typeof prior === "object" && this.isFullHex(prior.value)) {
        return (await this.objectType(prior.value.toLowerCase()))
          ? prior.value.toLowerCase()
          : undefined;
      }
    }

    let all: { id: ObjectId; ref: string }[];
    if (len === 0 && reflogLen > 0) all = await this.dwimRefAll("HEAD");
    else if (reflogLen > 0) all = await this.dwimLog(base);
    else all = await this.dwimRefAll(base);
    const found = all[0];
    if (!found) return undefined;
    // warn_ambiguous_refs: more than one rule found a ref (or a log), or the name is also an
    // abbreviated object id
    if (
      this.warnAmbiguousRefs() &&
      !flags.quiet &&
      (all.length > 1 || (await this.shortOid(base, { quiet: true })).status === "found")
    )
      this.warnings.push(`warning: refname '${base}' is ambiguous.`);
    if (reflogLen === 0) return found.id;

    const spec = str.slice(at + 2, at + 2 + reflogLen);
    let nth = /^[0-9]+$/.test(spec) ? Number(spec) : -1;
    let atTime: number;
    if (nth >= 100000000) {
      atTime = nth;
      nth = -1;
    } else if (nth >= 0) {
      atTime = 0;
    } else {
      const parsed = approxidateCareful(spec, this.now());
      if (parsed.error) return undefined;
      atTime = parsed.timestamp;
    }
    const read = await this.readRefAt(found.ref, atTime, nth, found.id);
    if (read.missing) {
      let shown = base;
      if (len === 0) shown = found.ref.startsWith("refs/heads/") ? found.ref.slice(11) : "HEAD";
      if (atTime) {
        // GET_OID_QUIETLY keeps this one to itself
        if (!flags.quiet) {
          this.warnings.push(
            `warning: log for '${shown}' only goes back to ${formatRfc2822Date(read.cutoffTime, read.cutoffTz)}`,
          );
        }
      } else if (!(nth === read.cutoffCount && !isNullObjectId(read.id))) {
        throw this.fatal(str, `log for '${shown}' only has ${read.cutoffCount} entries`);
      }
    }
    return read.id;
  }

  /**
   * git's `read_ref_at`: the value `ref` had at `atTime` (seconds), or `nth` moves ago;
   * `missing` when the reflog does not reach that far (the oldest value given instead).
   */
  private async readRefAt(
    ref: string,
    atTime: number,
    nth: number,
    current: ObjectId,
  ): Promise<{
    id: ObjectId;
    missing: boolean;
    cutoffTime: number;
    cutoffTz: string;
    cutoffCount: number;
  }> {
    const log = await this.sources.refs.getReflog?.(ref);
    const entries = log ? await log.getReverseEntries() : [];
    let cnt = nth;
    let ooid: ObjectId | undefined;
    let reccnt = 0;
    let id = current;
    for (const entry of entries) {
      const timestamp = entry.who.timestamp;
      if (timestamp <= atTime || cnt === 0) {
        const date = formatRfc2822Date(timestamp, entry.who.tzOffset);
        if (ooid !== undefined && !isNullObjectId(ooid)) {
          id = entry.newId;
          if (ooid !== entry.newId) {
            this.warnings.push(`warning: log for ref ${ref} has gap after ${date}`);
          }
        } else if (timestamp === atTime) {
          id = entry.newId;
        } else if (entry.newId !== id) {
          this.warnings.push(`warning: log for ref ${ref} unexpectedly ended on ${date}`);
        }
        return {
          id,
          missing: false,
          cutoffTime: timestamp,
          cutoffTz: entry.who.tzOffset,
          cutoffCount: reccnt,
        };
      }
      reccnt++;
      ooid = entry.oldId;
      if (cnt > 0) cnt--;
    }
    if (reccnt === 0) {
      if (nth === 0) {
        return { id, missing: true, cutoffTime: 0, cutoffTz: "+0000", cutoffCount: 0 };
      }
      throw this.fatal(ref, `log for ${ref} is empty`);
    }
    const oldest = entries[entries.length - 1];
    if (!oldest) throw this.fatal(ref, `log for ${ref} is empty`);
    id = oldest.oldId;
    if (atTime && isNullObjectId(id)) id = oldest.newId;
    return {
      id,
      missing: true,
      cutoffTime: oldest.who.timestamp,
      cutoffTz: oldest.who.tzOffset,
      cutoffCount: reccnt,
    };
  }

  /**
   * git's `repo_dwim_ref` with `nonfatal_dangling_mark`: every ref the rules find for `name`
   * (one, unless `core.warnAmbiguousRefs` makes it try them all), its value and full name;
   * no warnings.
   *
   * @example
   * ```typescript
   * await resolver.dwimRef("v1.0"); // [{ id: "1a2b...", ref: "refs/tags/v1.0" }]
   * ```
   */
  async dwimRef(name: string): Promise<{ id: ObjectId; ref: string }[]> {
    return this.dwimRefAll(name, false);
  }

  /**
   * git's `repo_dwim_ref` (`expand_ref`): every ref the rules find for `name` (its branch
   * syntax read), git's `warn_ambiguous_refs` making it try them all. A name the rules
   * make into no valid ref name (`check_refname_format`: `HEAD:a.txt`, `a..b`) is never
   * looked up; a symref that points nowhere is `warning: ignoring dangling symref <ref>`.
   */
  private async dwimRefAll(name: string, warn = true): Promise<{ id: ObjectId; ref: string }[]> {
    const substituted = (await this.substituteBranchName(name)) ?? name;
    const found: { id: ObjectId; ref: string }[] = [];
    const all = this.warnAmbiguousRefs();
    for (const full of candidateRefs(substituted)) {
      const resolved = await this.resolveRef(full);
      if (resolved) {
        found.push(resolved);
        if (!all) break;
      } else if (warn && full !== "HEAD" && (await this.danglingSymref(full))) {
        this.warnings.push(`warning: ignoring dangling symref ${full}`);
      }
    }
    return found;
  }

  /**
   * git's `repo_dwim_log`: every ref the rules find for `name` that has a reflog (its own,
   * or that of the ref it points to), the first one's value and log first.
   */
  private async dwimLog(name: string): Promise<{ id: ObjectId; ref: string }[]> {
    const substituted = (await this.substituteBranchName(name)) ?? name;
    const found: { id: ObjectId; ref: string }[] = [];
    for (const full of candidateRefs(substituted)) {
      const resolved = await this.resolveRef(full);
      if (!resolved) continue;
      if (await this.hasReflog(full)) found.push({ id: resolved.id, ref: full });
      else if (resolved.ref !== full && (await this.hasReflog(resolved.ref))) found.push(resolved);
      else continue;
      if (!this.warnAmbiguousRefs()) break;
    }
    return found;
  }

  /** Whether `name` is a symbolic ref (a chain of them) that ends at no ref. */
  private async danglingSymref(name: string): Promise<boolean> {
    const value = await safe(() => this.sources.refs.get(name));
    return value !== undefined && isSymbolicRef(value);
  }

  private async hasReflog(ref: string): Promise<boolean> {
    return (await this.sources.refs.getReflog?.(ref)) !== undefined;
  }

  /** A ref and the ref its symbolic chain ends at, resolved (`refs_resolve_ref_unsafe`). */
  private async resolveRef(name: string): Promise<{ id: ObjectId; ref: string } | undefined> {
    const cached = this.refCache.get(name);
    if (cached) return cached;
    const promise = this.lookupRef(name);
    this.refCache.set(name, promise);
    return promise;
  }

  private async lookupRef(name: string): Promise<{ id: ObjectId; ref: string } | undefined> {
    const first = await safe(() => this.sources.refs.get(name));
    if (!first) return undefined;
    if (!isSymbolicRef(first)) {
      return first.objectId ? { id: first.objectId, ref: name } : undefined;
    }
    const resolved = await safe(() => this.sources.refs.resolve(name));
    if (!resolved?.objectId) return undefined;
    let ref = first.target;
    for (let i = 0; i < 10; i++) {
      const value = await safe(() => this.sources.refs.get(ref));
      if (!value || !isSymbolicRef(value)) break;
      ref = value.target;
    }
    return { id: resolved.objectId, ref };
  }

  // ------------------------------------------------------------------ branch syntax

  /** git's `substitute_branch_name`: the name `name` stands for when all of it is read. */
  private async substituteBranchName(name: string): Promise<string | undefined> {
    const interpreted = await this.interpret(name);
    if (typeof interpreted === "object" && interpreted.used === name.length) {
      return interpreted.value;
    }
    return undefined;
  }

  /** git's `repo_interpret_branch_name`: 0 for `@{-N}` beyond the reflog, -1 for nothing. */
  private async interpret(name: string): Promise<Interpreted | number> {
    const prior = await this.nthPriorCheckout(name);
    if (prior === 0) return 0;
    if (typeof prior === "object") {
      if (prior.used === name.length) return prior;
      return this.reinterpret(name, prior);
    }
    for (let at = name.indexOf("@"); at >= 0; at = name.indexOf("@", at + 1)) {
      if (interpretEmptyAt(name, at)) return this.reinterpret(name, { used: 1, value: "HEAD" });
      const upstream = await this.branchMark(name, at, upstreamMark, (b, rev) =>
        this.upstreamOf(b, rev),
      );
      if (upstream) return upstream;
      const push = await this.branchMark(name, at, pushMark, (b, rev) => this.pushOf(b, rev));
      if (push) return push;
    }
    return -1;
  }

  /** git's `reinterpret`: what follows an expanded prefix, read again. */
  private async reinterpret(name: string, prefix: Interpreted): Promise<Interpreted> {
    const combined = prefix.value + name.slice(prefix.used);
    const again = await this.interpret(combined);
    if (typeof again !== "object") return prefix;
    return { used: again.used - prefix.value.length + prefix.used, value: again.value };
  }

  /** git's `interpret_branch_mark`: `[<branch>]@{u}` or `@{push}` at `at`. */
  private async branchMark(
    name: string,
    at: number,
    mark: (s: string) => number,
    data: (branch: string | undefined, revision: string) => Promise<string>,
  ): Promise<Interpreted | undefined> {
    const len = mark(name.slice(at));
    if (!len) return undefined;
    const prefix = name.slice(0, at);
    if (prefix.includes(":")) return undefined;
    const branch = prefix === "" || prefix === "HEAD" ? undefined : prefix;
    const value = await data(branch, name);
    return { used: len + at, value };
  }

  /** git's `interpret_nth_prior_checkout`: `@{-N}` at the start of `name`. */
  private async nthPriorCheckout(name: string): Promise<Interpreted | number> {
    if (name.length < 4 || !name.startsWith("@{-")) return -1;
    const brace = name.indexOf("}");
    if (brace < 0) return -1;
    const digits = name.slice(3, brace);
    if (!/^[0-9]+$/.test(digits)) return -1;
    const nth = Number(digits);
    if (!(nth > 0)) return -1;
    const log = await this.sources.refs.getReflog?.("HEAD");
    let remaining = nth;
    for (const entry of log ? await log.getReverseEntries() : []) {
      const prefix = "checkout: moving from ";
      if (!entry.comment.startsWith(prefix)) continue;
      const rest = entry.comment.slice(prefix.length);
      const to = rest.indexOf(" to ");
      if (to < 0) continue;
      if (--remaining === 0) return { used: brace + 1, value: rest.slice(0, to) };
    }
    return 0;
  }

  private async currentBranch(): Promise<string | undefined> {
    const head = await this.sources.refs.get("HEAD");
    if (head && isSymbolicRef(head) && head.target.startsWith("refs/heads/")) {
      return head.target.slice("refs/heads/".length);
    }
    return undefined;
  }

  // ------------------------------------------------------------------ objects

  /** The type of an object, undefined when the repository does not have it. */
  async objectType(id: ObjectId): Promise<ObjectType | undefined> {
    const { commits, tags, trees, blobs } = this.sources;
    if (await safe(() => commits.has(id))) return "commit";
    if (tags && (await safe(() => tags.has(id)))) return "tag";
    if (await safe(() => trees.has(id))) return "tree";
    if (await safe(() => blobs.has(id))) return "blob";
    return undefined;
  }

  /** git's `peel_to_type`: tags followed, a commit's tree taken, until `type`. */
  async peelToType(id: ObjectId, type: ObjectType, name?: string): Promise<ObjectId | undefined> {
    let current: ObjectId | undefined = id;
    for (let i = 0; current !== undefined && i < 64; i++) {
      const actual = await this.objectType(current);
      if (actual === undefined) return undefined;
      if (actual === type) return current;
      if (actual === "tag") current = (await this.sources.tags?.load(current))?.object;
      else if (actual === "commit") current = (await this.sources.commits.load(current))?.tree;
      else {
        if (name !== undefined) {
          this.warnings.push(
            `error: ${name}: expected ${type} type, but the object dereferences to ${actual} type`,
          );
        }
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * git's `deref_tag` as `lookup_commit_reference` uses it: tags followed; the object
   * they end at and its type (undefined when the repository lacks it).
   */
  async peelTags(id: ObjectId): Promise<{ id: ObjectId; type: ObjectType | undefined }> {
    let current = id;
    for (let i = 0; i < 64; i++) {
      const type = await this.objectType(current);
      if (type !== "tag") return { id: current, type };
      const next = (await this.sources.tags?.load(current))?.object;
      if (next === undefined) return { id: current, type };
      current = next;
    }
    return { id: current, type: "tag" };
  }

  /**
   * git's `lookup_commit_reference`: the commit `id` is or its tags end at; for another
   * object git's `error: object <id> is a <type>, not a commit` (printed whether the caller
   * is quiet or not, as git prints it) and undefined; undefined, silently, for an object
   * the repository lacks.
   */
  async commitReference(id: ObjectId): Promise<ObjectId | undefined> {
    const peeled = await this.peelTags(id);
    if (peeled.type === "commit") return peeled.id;
    if (peeled.type !== undefined) {
      this.warnings.push(`error: object ${peeled.id} is a ${peeled.type}, not a commit`);
    }
    return undefined;
  }

  /** The parents of a commit, undefined when it cannot be read. */
  async parentsOf(id: ObjectId): Promise<ObjectId[] | undefined> {
    return (await safe(() => this.sources.commits.load(id)))?.parents;
  }

  /** git's `deref_tag`: tags followed to what they point at. */
  private async derefTags(id: ObjectId): Promise<ObjectId | undefined> {
    let current: ObjectId | undefined = id;
    for (let i = 0; current !== undefined && i < 64; i++) {
      const actual = await this.objectType(current);
      if (actual === undefined) return undefined;
      if (actual !== "tag") return current;
      current = (await this.sources.tags?.load(current))?.object;
    }
    return undefined;
  }

  /**
   * git's `get_tree_entry` / `find_tree_entry`: the object at `path` in a tree (the tree
   * itself for ""). Components are matched exactly: an empty one (`/a`, `d//b`) names
   * nothing, and a trailing `/` only follows a directory (`d/` is d, `a.txt/` nothing).
   */
  private async treeEntry(tree: ObjectId, path: string): Promise<ObjectId | undefined> {
    if (path === "") return tree;
    let current = tree;
    let rest = path;
    for (;;) {
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name === "") return undefined;
      const entry = await safe(() => this.sources.trees.getEntry(current, name));
      if (!entry) return undefined;
      if (slash < 0) return entry.id;
      if ((entry.mode & 0o170000) !== 0o040000) return undefined;
      rest = rest.slice(slash + 1);
      if (rest === "") return entry.id;
      current = entry.id;
    }
  }

  /** `:<n>:<path>`: the index entry of `path` at `stage`. */
  private indexEntry(path: string, stage: number): Promise<ObjectId | undefined> {
    return this.indexEntryAt(path, stage);
  }

  private async indexEntryAt(path: string, stage: number): Promise<ObjectId | undefined> {
    let staging: Staging | undefined;
    try {
      staging = this.sources.staging?.();
    } catch {
      return undefined;
    }
    if (!staging) return undefined;
    const entry = await staging.getEntry(path, stage as 0 | 1 | 2 | 3);
    return entry?.objectId;
  }

  /** The commits every ref (then HEAD) points at, as `:/` searches from them. */
  private async allRefCommits(): Promise<ObjectId[]> {
    const names: string[] = [];
    for await (const entry of this.sources.refs.list("refs/")) names.push(entry.name);
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    names.push("HEAD");
    const out: ObjectId[] = [];
    for (const name of names) {
      const resolved = await this.sources.refs.resolve(name);
      if (!resolved?.objectId) continue;
      const commit = await this.peelTagsToCommit(resolved.objectId);
      if (commit !== undefined) out.push(commit);
    }
    // commit_list_insert prepends: the queue takes them last ref first
    return out.reverse();
  }

  private async peelTagsToCommit(id: ObjectId): Promise<ObjectId | undefined> {
    const target = await this.derefTags(id);
    if (target === undefined) return undefined;
    return (await this.objectType(target)) === "commit" ? target : undefined;
  }

  /**
   * git's `get_oid_oneline`: from `starts`, youngest commit first (commit date, ties in
   * the order queued), the first whose message matches the POSIX extended regex `prefix`
   * (`!-<re>`: the first that does not match; `!!` a literal `!`).
   */
  private async oneline(prefix: string, starts: ObjectId[]): Promise<ObjectId | undefined> {
    let pattern = prefix;
    let negative = false;
    if (pattern.startsWith("!")) {
      pattern = pattern.slice(1);
      if (pattern.startsWith("-")) {
        pattern = pattern.slice(1);
        negative = true;
      } else if (!pattern.startsWith("!")) {
        return undefined;
      }
    }
    let regex: ReturnType<typeof compilePosixRegex>;
    try {
      regex = compilePosixRegex(pattern, { extended: true });
    } catch {
      return undefined;
    }
    const queue: { id: ObjectId; date: number; ctr: number }[] = [];
    let ctr = 0;
    const seen = new Set<ObjectId>();
    const cache = new Map<ObjectId, Commit | undefined>();
    const load = async (id: ObjectId) => {
      if (!cache.has(id)) cache.set(id, await safe(() => this.sources.commits.load(id)));
      return cache.get(id);
    };
    const put = async (id: ObjectId) => {
      const commit = await load(id);
      queue.push({ id, date: commit?.committer.timestamp ?? 0, ctr: ctr++ });
    };
    for (const id of starts) {
      seen.add(id);
      await put(id);
    }
    const encoder = new TextEncoder();
    while (queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i];
        const b = queue[best];
        if (!a || !b) continue;
        if (a.date > b.date || (a.date === b.date && a.ctr < b.ctr)) best = i;
      }
      const [next] = queue.splice(best, 1);
      if (!next) break;
      const commit = await load(next.id);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        await put(parent);
      }
      const matches = negative !== regex.test(encoder.encode(commit.message));
      if (matches) return next.id;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ short ids

  /**
   * git's `get_short_oid`: the one stored object whose id starts with `name` (4 to 40 hex, 64 in a SHA-256 repository,
   * digits, any case). Of several, the one the hint (`flags.hint`, else `core.disambiguate`)
   * accepts, when it accepts exactly one. An ambiguity is reported, unless quiet, as git
   * reports it: `error: short object ID <prefix> is ambiguous` and `hint:` lines listing the
   * candidates (tags, commits, trees, blobs; by id within a type), only those the hint accepts
   * when it accepts several.
   */
  private async shortOid(name: string, flags: ResolveOptions = {}): Promise<ShortOid> {
    if (
      name.length < MINIMUM_ABBREV_LENGTH ||
      name.length > this.hexLength ||
      !HEX_DIGITS.test(name)
    ) {
      return { status: "invalid" };
    }
    const prefix = name.toLowerCase();
    const candidates = await this.objectsWithPrefix(prefix);
    if (candidates.length === 0) return { status: "missing" };
    const hint = flags.hint ?? this.defaultHint();
    let status: ShortOid;
    let listedHint = hint;
    if (candidates.length === 1) {
      status = { status: "found", id: candidates[0] as ObjectId };
    } else if (hint === undefined) {
      status = { status: "ambiguous" };
    } else {
      const accepted: ObjectId[] = [];
      for (const id of candidates) if (await this.satisfies(id, hint)) accepted.push(id);
      if (accepted.length === 1) status = { status: "found", id: accepted[0] as ObjectId };
      else {
        status = { status: "ambiguous" };
        // none accepted: git lists them all (it drops the hint)
        if (accepted.length === 0) listedHint = undefined;
      }
    }
    if (status.status === "ambiguous" && !flags.quiet) {
      await this.reportAmbiguous(prefix, candidates, listedHint);
    }
    return status;
  }

  /** git's `show_ambiguous_object` for each candidate, sorted as `sort_ambiguous` sorts them. */
  private async reportAmbiguous(
    prefix: string,
    candidates: ObjectId[],
    hint: DisambiguateHint | undefined,
  ): Promise<void> {
    const typed: { id: ObjectId; type: ObjectType | undefined }[] = [];
    for (const id of candidates) typed.push({ id, type: await this.objectType(id) });
    // tags, commits, trees, blobs (git's type % 4); by id within a type
    const rank = (t: ObjectType | undefined) =>
      t === "tag" ? 0 : t === "commit" ? 1 : t === "tree" ? 2 : t === "blob" ? 3 : -1;
    typed.sort((a, b) =>
      rank(a.type) !== rank(b.type) ? rank(a.type) - rank(b.type) : a.id < b.id ? -1 : 1,
    );
    const shown: typeof typed = [];
    for (const c of typed)
      if (hint === undefined || (await this.satisfies(c.id, hint))) shown.push(c);
    const lengths =
      (await safe(async () => this.sources.abbreviate?.(shown.map((c) => c.id)))) ?? undefined;
    const lines = [`error: short object ID ${prefix} is ambiguous`, "hint: The candidates are:"];
    for (const { id, type } of shown) {
      const hash = id.slice(0, lengths?.get(id) ?? 7);
      let line: string;
      if (type === "commit") {
        const commit = await safe(() => this.sources.commits.load(id));
        line = commit
          ? `${hash} commit ${shortDate(commit.author.timestamp, commit.author.tzOffset)} - ${formatSubject(commit.message)}`
          : `${hash} commit  - `;
      } else if (type === "tag") {
        const tag = await safe(async () => this.sources.tags?.load(id));
        line =
          tag?.tag !== undefined
            ? `${hash} tag ${shortDate(tag.tagger?.timestamp ?? 0, "+0000")} - ${tag.tag}`
            : `${hash} [bad tag, could not parse it]`;
      } else if (type === "tree" || type === "blob") {
        line = `${hash} ${type}`;
      } else {
        line = `${hash} [bad object]`;
      }
      lines.push(`hint:   ${line}`);
    }
    this.warnings.push(lines.join("\n"));
  }

  /** The stored ids that start with `prefix` (git's `repo_for_each_abbrev`), sorted. */
  private async objectsWithPrefix(prefix: string): Promise<ObjectId[]> {
    const found = new Set<ObjectId>();
    const { objects } = this.sources;
    if (objects) {
      for await (const id of listObjectsWithPrefix(objects, prefix)) found.add(id);
    } else {
      const { commits, trees, blobs, tags } = this.sources;
      for (const store of [commits, trees, blobs, tags] as { keys?(): AsyncIterable<ObjectId> }[]) {
        if (!store?.keys) continue;
        for await (const id of store.keys()) if (id.startsWith(prefix)) found.add(id);
      }
    }
    return [...found].sort();
  }

  /**
   * git's `set_disambiguate_hint_config` as its config loading runs it, before any revision
   * is read (see {@link configLoadError}). Commands check it when they start, as every git
   * command does; checked here too, once per resolver, for a resolver used on its own.
   */
  private checkDisambiguateConfig(name: string): void {
    if (this.disambiguateChecked) return;
    this.disambiguateChecked = true;
    const failure = configLoadError(this.sources.workingCopy);
    if (failure) throw new RevisionError(name, [...this.warnings, failure.message].join("\n"));
  }

  /** `core.disambiguate` (git's `default_disambiguate_hint`); "none" and unset are no hint. */
  private defaultHint(): DisambiguateHint | undefined {
    const value = this.remoteConfig().value("core.disambiguate")?.toLowerCase();
    switch (value) {
      case "commit":
      case "committish":
      case "tree":
      case "treeish":
      case "blob":
        return value;
      default:
        return undefined;
    }
  }

  /** git's `disambiguate_<hint>_only`: whether the object is, or peels to, what `hint` wants. */
  private async satisfies(id: ObjectId, hint: DisambiguateHint): Promise<boolean> {
    const type = await this.objectType(id);
    switch (hint) {
      case "commit":
        return type === "commit";
      case "tree":
        return type === "tree";
      case "blob":
        return type === "blob";
      case "committish":
      case "treeish": {
        const wanted = (t: ObjectType | undefined) =>
          t === "commit" || (hint === "treeish" && t === "tree");
        if (wanted(type)) return true;
        if (type !== "tag") return false;
        return wanted((await this.peelTags(id)).type);
      }
    }
  }

  /**
   * git's `get_describe_name`: `<ref>-<count>-g<abbrev>`, the abbreviation read quietly as a
   * commit, when what precedes `-g` is a valid ref name, a dash and (hex) digits.
   */
  private async describeName(name: string): Promise<ObjectId | undefined> {
    for (let cp = name.length - 1; cp >= 2; cp--) {
      const ch = name[cp];
      if (isHexDigit(ch)) continue;
      if (ch === "g" && name[cp - 1] === "-" && refAndCountPartsValid(name, cp - 1)) {
        const short = await this.shortOid(name.slice(cp + 1), { hint: "commit", quiet: true });
        return short.status === "found" ? short.id : undefined;
      }
    }
    return undefined;
  }

  /**
   * git's `resolve_relative_path`: a path starting with `./` or `../` read against
   * {@link cwdPrefix} and normalized; other paths as given.
   *
   * @throws RevisionError with git's message for a path outside the worktree
   */
  private relativePath(path: string, revision: string): string {
    if (!path.startsWith("./") && !path.startsWith("../")) return path;
    const normalized = normalizePath(this.cwdPrefix + path);
    if (normalized === undefined) {
      // prefix_path's die: the worktree named as the host names it
      const top = this.sources.worktreeHostPath;
      const at = top === undefined ? "" : ` at '${top}'`;
      const error = new RevisionError(revision, `fatal: '${path}' is outside repository${at}`);
      this.diagnoses.add(error);
      throw error;
    }
    return normalized;
  }

  /**
   * git's `maybe_die_on_misspelt_object_name`: `name` read again quietly with
   * `GET_OID_ONLY_TO_DIE`, for its better diagnosis of a `<rev>:<path>` or `:<path>` that
   * names nothing (thrown); where git's read just fails (or dies of something it would not
   * print quietly) this returns, for the caller's general message.
   *
   * @throws RevisionError with git's diagnosis (`fatal: path 'x' does not exist in 'HEAD'`,
   *   `fatal: '../x' is outside repository at '/repo'`, ...)
   */
  async dieOnMisspeltObjectName(name: string): Promise<void> {
    try {
      await this.resolve(name, { quiet: true, onlyToDie: true });
    } catch (error) {
      if (error instanceof RevisionError && this.diagnoses.has(error)) throw error;
    }
  }

  /** The errors {@link dieOnMisspeltObjectName} passes on. */
  private readonly diagnoses = new WeakSet<RevisionError>();

  private die(revision: string, message: string): never {
    const error = new RevisionError(revision, [...this.warnings, message].join("\n"));
    this.diagnoses.add(error);
    throw error;
  }

  /**
   * Whether something is at `path` on disk, from the top of the worktree: git's `file_exists`
   * runs after setup moved to the top, whatever the current directory was.
   */
  private async onDisk(path: string): Promise<boolean> {
    const exists = this.sources.fileExists;
    // git's file_exists: lstat of the path as written (`a.txt/` is no file)
    return exists ? exists(path) : false;
  }

  /** git's `diagnose_invalid_oid_path`: `<objectName>:<filename>` named nothing. */
  private async diagnoseTreePath(
    name: string,
    objectName: string,
    tree: ObjectId | undefined,
    filename: string,
  ): Promise<never> {
    if (await this.onDisk(filename)) {
      this.die(name, `fatal: path '${filename}' exists on disk, but not in '${objectName}'`);
    }
    const fullname = `${this.cwdPrefix}${filename}`;
    if (tree !== undefined && (await this.treeEntry(tree, fullname)) !== undefined) {
      this.die(
        name,
        `fatal: path '${fullname}' exists, but not '${filename}'\n` +
          `hint: Did you mean '${objectName}:${fullname}' aka '${objectName}:./${filename}'?`,
      );
    }
    this.die(name, `fatal: path '${filename}' does not exist in '${objectName}'`);
  }

  /** git's `diagnose_invalid_index_path`: `:<stage>:<filename>` named nothing. */
  private async diagnoseIndexPath(name: string, stage: number, filename: string): Promise<never> {
    const stageOf = async (path: string): Promise<number | undefined> => {
      for (const n of [0, 1, 2, 3] as const) {
        if ((await this.indexEntryAt(path, n)) !== undefined) return n;
      }
      return undefined;
    };
    const atStage = await stageOf(filename);
    if (atStage !== undefined) {
      this.die(
        name,
        `fatal: path '${filename}' is in the index, but not at stage ${stage}\n` +
          `hint: Did you mean ':${atStage}:${filename}'?`,
      );
    }
    const fullname = `${this.cwdPrefix}${filename}`;
    const fullStage = await stageOf(fullname);
    if (fullStage !== undefined) {
      this.die(
        name,
        `fatal: path '${fullname}' is in the index, but not '${filename}'\n` +
          `hint: Did you mean ':${fullStage}:${fullname}' aka ':${fullStage}:./${filename}'?`,
      );
    }
    if (await this.onDisk(filename)) {
      this.die(name, `fatal: path '${filename}' exists on disk, but not in the index`);
    }
    this.die(name, `fatal: path '${filename}' does not exist (neither on disk nor in the index)`);
  }

  // ------------------------------------------------------------------ helpers

  private remoteConfig(): RemoteConfigStore {
    this.config ??= RemoteConfigStore.from(this.sources.workingCopy);
    return this.config;
  }

  /** `core.warnAmbiguousRefs` (default true): every dwim rule tried, ambiguity warned. */
  private warnAmbiguousRefs(): boolean {
    return parseGitBool(this.remoteConfig().value("core.warnAmbiguousRefs")) ?? true;
  }

  private fatal(revision: string, message: string): RevisionError {
    return new RevisionError(revision, `fatal: ${message}`);
  }
}

/** git's `interpret_empty_at`: `@` alone, or followed by `@{...}`, is HEAD. */
function interpretEmptyAt(name: string, at: number): boolean {
  if (at !== 0 || name[1] === "{") return false;
  const next = name.indexOf("@", 1);
  if (next >= 0 && name[next + 1] !== "{") return false;
  return (next < 0 ? name.length : next) === 1;
}

/**
 * The full names git's `ref_rev_parse_rules` make of `name`, those its ref lookup would
 * read: valid ref names (`check_refname_format`, one level allowed) that are `refs/...` or
 * a root ref like `HEAD`.
 */
function candidateRefs(name: string): string[] {
  const out: string[] = [];
  for (const rule of REV_PARSE_RULES) {
    const full = rule(name);
    if (isRefLike(full) && isValidRefName(full, { allowOneLevel: true })) out.push(full);
  }
  return out;
}

/** Whether git's ref lookup takes `name` as a ref (`refs/...` or a root ref like `HEAD`). */
function isRefLike(name: string): boolean {
  return name.startsWith("refs/") || /^[A-Z_]+$/.test(name);
}

/**
 * git's `normalize_path_copy`: `//` collapsed, `.` components dropped, `..` taking the
 * component before it away; undefined when it climbs above the top. A trailing `/` stays.
 */
function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  const parts = path.split("/");
  const trailing = parts.length > 1 && parts[parts.length - 1] === "";
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return trailing && joined !== "" ? `${joined}/` : joined;
}

/**
 * git's `ref_and_count_parts_valid`: `name[len]` is the `-` before `g`; before it come hex
 * digits (at least one), a `-`, and a valid ref name (one level allowed).
 */
function refAndCountPartsValid(name: string, len: number): boolean {
  if (!isHexDigit(name[len - 1])) return false;
  let cp = len - 2;
  for (; cp > 0; cp--) {
    if (name[cp] === "-") break;
    if (!isHexDigit(name[cp])) return false;
  }
  if (cp < 0 || name[cp] !== "-") return false;
  return isValidRefName(name.slice(0, cp), { allowOneLevel: true });
}

/** git's `DATE_SHORT`: the day `timestamp` falls on in the zone `tz` (`+HHMM`). */
function shortDate(timestamp: number, tz: string): string {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(tz);
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60 : 0;
  const d = new Date((timestamp + offset) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** git's `format_subject` (`%s`): the first paragraph, its lines joined with a space. */
function formatSubject(message: string): string {
  const lines = message.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  const out: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join(" ");
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
