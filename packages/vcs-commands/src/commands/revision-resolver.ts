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
 * `:<path>` and `:<n>:<path>`. Regexes are POSIX extended ones run as glibc runs them
 * (`compilePosixRegex`). Not supported: abbreviated object ids and `git describe` names.
 */

import type { Commit, ObjectId, Refs } from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";
import { compilePosixRegex } from "@statewalker/vcs-utils";
import type { Staging, WorkingCopy } from "@statewalker/vcs-working-tree";

import { RevisionError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { applyRefspecs } from "./branch-tracking.js";
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
    load(id: ObjectId): Promise<{ object: ObjectId } | undefined>;
  };
  /** The index, for `:<path>` (undefined where there is none) */
  staging?: () => Staging | undefined;
  /** The configuration (`branch.*`, `remote.*`, `push.default`) */
  workingCopy: WorkingCopy;
}

type ObjectType = "commit" | "tree" | "blob" | "tag";

const ZERO_ID = "0000000000000000000000000000000000000000";
const HEX_ID = /^[0-9a-fA-F]{40}$/;

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
  private config?: RemoteConfigStore;

  constructor(
    private readonly sources: RevisionSources,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * The object `name` names, or undefined when it names none (git's `unknown revision`).
   *
   * @throws RevisionError where git dies (an `@{u}` without upstream, a reflog too short)
   */
  async resolve(name: string): Promise<ObjectId | undefined> {
    const direct = await this.oid1(name);
    if (direct !== undefined) return direct;
    if (name.startsWith(":")) {
      if (name.length > 2 && name[1] === "/") {
        return this.oneline(name.slice(2), await this.allRefCommits());
      }
      let stage = 0;
      let path = name.slice(1);
      if (name.length >= 3 && name[2] === ":" && name[1] >= "0" && name[1] <= "3") {
        stage = Number(name[1]);
        path = name.slice(3);
      }
      return this.indexEntry(normalizeRelative(path), stage);
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
        const treeish = await this.oid1(name.slice(0, i));
        if (treeish === undefined) return undefined;
        const tree = await this.peelToType(treeish, "tree");
        if (tree === undefined) return undefined;
        return this.treeEntry(tree, normalizeRelative(name.slice(i + 1)));
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
      const found = await this.dwimRefAll(src);
      dst = found.length === 1 ? found[0]?.ref : src;
    }
    if (dst === undefined) {
      throw this.fatal(revision, `upstream branch '${src}' not stored as a remote-tracking branch`);
    }
    return dst;
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
    const remote =
      config.value(`branch.${name}.pushRemote`) ??
      config.value("remote.pushDefault") ??
      config.value(`branch.${name}.remote`) ??
      (config.configuredNames().length === 1 ? config.configuredNames()[0] : "origin") ??
      "origin";
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
  private async oid1(name: string): Promise<ObjectId | undefined> {
    let cp = name.length - 1;
    while (cp >= 0 && (name[cp] ?? "") >= "0" && (name[cp] ?? "") <= "9") cp--;
    const suffix = cp >= 0 ? name[cp] : undefined;
    if (suffix === "~" || suffix === "^") {
      const digits = name.slice(cp + 1);
      let num = digits === "" ? 0 : Number(digits);
      if (!Number.isSafeInteger(num) || num > 2147483647) return undefined;
      if (num === 0 && cp === name.length - 1) num = 1;
      const base = name.slice(0, cp);
      return suffix === "^" ? this.parent(base, num) : this.nthAncestor(base, num);
    }
    const peeled = await this.peelOnion(name);
    if (peeled !== undefined) return peeled;
    return this.basic(name);
  }

  /** git's `get_parent`: `<rev>^<n>` (`^0` the commit itself). */
  private async parent(name: string, idx: number): Promise<ObjectId | undefined> {
    const id = await this.oid1(name);
    if (id === undefined) return undefined;
    const commitId = await this.peelToType(id, "commit");
    if (commitId === undefined) return undefined;
    if (idx === 0) return commitId;
    const commit = await this.sources.commits.load(commitId);
    return commit?.parents[idx - 1];
  }

  /** git's `get_nth_ancestor`: `<rev>~<n>`, first parents. */
  private async nthAncestor(name: string, generation: number): Promise<ObjectId | undefined> {
    const id = await this.oid1(name);
    if (id === undefined) return undefined;
    let commitId = await this.peelToType(id, "commit");
    for (let i = 0; commitId !== undefined && i < generation; i++) {
      const commit = await this.sources.commits.load(commitId);
      commitId = commit?.parents[0];
    }
    return commitId;
  }

  /** git's `peel_onion`: `<rev>^{<type>}`, `<rev>^{}`, `<rev>^{/<regex>}`. */
  private async peelOnion(name: string): Promise<ObjectId | undefined> {
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
    const outer = await this.oid1(name.slice(0, sp - 1));
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

  /** git's `get_oid_basic`: an object id, a ref, `<ref>@{<n>|<date>}`, `@{-N}`. */
  private async basic(str: string): Promise<ObjectId | undefined> {
    if (HEX_ID.test(str)) {
      const id = str.toLowerCase();
      return (await this.objectType(id)) ? id : undefined;
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
      if (typeof prior === "object" && HEX_ID.test(prior.value)) {
        return (await this.objectType(prior.value.toLowerCase()))
          ? prior.value.toLowerCase()
          : undefined;
      }
    }

    let found: { id: ObjectId; ref: string } | undefined;
    if (len === 0 && reflogLen > 0) found = (await this.dwimRefAll("HEAD"))[0];
    else if (reflogLen > 0) found = await this.dwimLog(base);
    else found = (await this.dwimRefAll(base))[0];
    if (!found) return undefined;
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
        this.warnings.push(
          `warning: log for '${shown}' only goes back to ${formatRfc2822Date(read.cutoffTime, read.cutoffTz)}`,
        );
      } else if (!(nth === read.cutoffCount && read.id !== ZERO_ID)) {
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
    let ooid = ZERO_ID;
    let reccnt = 0;
    let id = current;
    for (const entry of entries) {
      const timestamp = entry.who.timestamp;
      if (timestamp <= atTime || cnt === 0) {
        if (ooid !== ZERO_ID) id = entry.newId;
        else if (timestamp === atTime) id = entry.newId;
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
    if (atTime && id === ZERO_ID) id = oldest.newId;
    return {
      id,
      missing: true,
      cutoffTime: oldest.who.timestamp,
      cutoffTz: oldest.who.tzOffset,
      cutoffCount: reccnt,
    };
  }

  /** git's `repo_dwim_ref`: every ref the rules find for `name` (its branch syntax read). */
  private async dwimRefAll(name: string): Promise<{ id: ObjectId; ref: string }[]> {
    const substituted = (await this.substituteBranchName(name)) ?? name;
    const found: { id: ObjectId; ref: string }[] = [];
    for (const rule of REV_PARSE_RULES) {
      const full = rule(substituted);
      if (!isRefLike(full)) continue;
      const resolved = await this.resolveRef(full);
      if (resolved) found.push(resolved);
    }
    return found;
  }

  /** git's `repo_dwim_log`: the first ref the rules find for `name` that has a reflog. */
  private async dwimLog(name: string): Promise<{ id: ObjectId; ref: string } | undefined> {
    const substituted = (await this.substituteBranchName(name)) ?? name;
    for (const rule of REV_PARSE_RULES) {
      const full = rule(substituted);
      if (!isRefLike(full)) continue;
      const resolved = await this.resolveRef(full);
      if (!resolved) continue;
      if (await this.hasReflog(full)) return { id: resolved.id, ref: full };
      if (resolved.ref !== full && (await this.hasReflog(resolved.ref))) return resolved;
    }
    return undefined;
  }

  private async hasReflog(ref: string): Promise<boolean> {
    return (await this.sources.refs.getReflog?.(ref)) !== undefined;
  }

  /** A ref and the ref its symbolic chain ends at, resolved (`refs_resolve_ref_unsafe`). */
  private async resolveRef(name: string): Promise<{ id: ObjectId; ref: string } | undefined> {
    const resolved = await this.sources.refs.resolve(name);
    if (!resolved?.objectId) return undefined;
    let ref = name;
    for (let i = 0; i < 10; i++) {
      const value = await this.sources.refs.get(ref);
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

  /** git's `get_tree_entry`: the object at `path` in a tree (the tree itself for ""). */
  private async treeEntry(tree: ObjectId, path: string): Promise<ObjectId | undefined> {
    const parts = path.split("/").filter((p) => p !== "");
    let current = tree;
    for (const part of parts) {
      const entry = await this.sources.trees.getEntry(current, part);
      if (!entry) return undefined;
      current = entry.id;
    }
    return current;
  }

  /** `:<n>:<path>`: the index entry of `path` at `stage`. */
  private async indexEntry(path: string, stage: number): Promise<ObjectId | undefined> {
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

  // ------------------------------------------------------------------ helpers

  private remoteConfig(): RemoteConfigStore {
    this.config ??= RemoteConfigStore.from(this.sources.workingCopy);
    return this.config;
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

/** Whether git's ref lookup takes `name` as a ref (`refs/...` or a root ref like `HEAD`). */
function isRefLike(name: string): boolean {
  return name.startsWith("refs/") || /^[A-Z_]+$/.test(name);
}

/** git's `resolve_relative_path` at the top of the worktree: `./a` is `a`. */
function normalizeRelative(path: string): string {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
