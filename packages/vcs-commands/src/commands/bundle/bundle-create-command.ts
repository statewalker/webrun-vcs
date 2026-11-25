/**
 * `git bundle create` (bundle.c's `create_bundle`): the commits the rev-list arguments name,
 * their objects in a pack, behind a header listing the refs named and the boundary commits
 * the pack needs.
 *
 * @example
 * ```typescript
 * // git bundle create repo.bundle --all
 * const { bundle } = await git.bundleCreate().addArgument("--all").call();
 * // git bundle create --version=3 incr.bundle v1..main
 * await git.bundleCreate().setVersion(3).addArgument("v1..main").call();
 * // echo main | git bundle create stdin.bundle --stdin
 * await git.bundleCreate().addArgument("--stdin").setStdin("main\n").call();
 * ```
 */

import {
  historyWithoutLazyFetch,
  ObjectFilterError,
  type ObjectId,
  parseObjectFilter,
} from "@statewalker/vcs-core";
import { createRepositoryFacade } from "@statewalker/vcs-transport";

import { GitApiError, RevisionError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { approxidateCareful } from "../git-date.js";
import { RevListCommand } from "../rev-list-command.js";
import { unknownRevisionMessage } from "../revision-range.js";
import { commitSubject } from "../shortlog.js";
import {
  type BundleHeader,
  type BundlePrerequisite,
  type BundleRef,
  encodeBundleHeader,
} from "./bundle-format.js";
import type { BundleCommandResult } from "./bundle-verify.js";

/** What {@link BundleCreateCommand} made. */
export interface BundleCreateResult extends BundleCommandResult {
  /** The bundle's bytes (header and pack); undefined when git dies or fails */
  bundle?: Uint8Array;
  /** Its header */
  header?: BundleHeader;
}

const USAGE = [
  "usage: git bundle create [-q | --quiet | --progress]",
  "                         [--version=<version>] <file> <git-rev-list-args>",
].join("\n");

/**
 * `git bundle create [--version=<n>] <file> <git-rev-list-args>`: the arguments are read as
 * `setup_revisions` reads them (revisions, ranges, `--all`, `--branches`, `--tags`, `--not`,
 * `--stdin`, `--ignore-missing`, `-<n>`/`-n`/`--max-count`, `--since`/`--after`,
 * `--until`/`--before`, `--first-parent`, `--no-merges`, `--objects`, `--filter=<spec>`), the
 * walk lists the commits and its boundary (`-<id> <subject>` lines, the pack's thin bases), each
 * positive argument naming exactly one ref becomes a ref line (`HEAD` named as such, a branch by
 * its full name; a commit the rev-list options left out is skipped with git's warning, a tag
 * outside `--since`/`--until` dropped), and the pack holds what the positive arguments reach
 * but the boundary and negative ones do not. Without refs git refuses (`Refusing to create
 * empty bundle.`, exit 128).
 *
 * The version is 2 unless `setVersion(3)`, a SHA-256 repository or a filter asks for 3
 * (`@object-format=`, `@filter=`). The bundle is returned (`result.bundle`); writing it (git's
 * lock file, `-` for stdout) is the caller's. Progress (`--progress`, `-q`) is not printed.
 */
export class BundleCreateCommand extends GitCommand<BundleCreateResult> {
  private version?: number;
  private readonly args: string[] = [];
  private stdin?: string;
  private compatibility?: "2.43" | "2.56";

  /**
   * The git version to follow (default: the hook runner's, else 2.56): 2.43 drops only later
   * arguments naming the same object by the same name (`object_array_remove_duplicates`), so
   * `--all main` lists refs/heads/main twice; 2.56 writes each ref once.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** `--version=<n>`: 2 or 3; git refuses other numbers and 2 for a SHA-256 repository. */
  setVersion(version: number): this {
    this.checkCallable();
    this.version = version;
    return this;
  }

  /** One of `<git-rev-list-args>`, as on git's command line. */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /** What `--stdin` reads (git's standard input). */
  setStdin(text: string): this {
    this.checkCallable();
    this.stdin = text;
    return this;
  }

  async call(): Promise<BundleCreateResult> {
    this.checkCallable();
    this.setCallable(false);
    let stderr = "";
    const revList = new RevListCommand(this._workingCopy).setCommittish(false).setBoundary(true);
    let filter: string | undefined;
    let ignoreMissing = false;
    const revisions: (string | { stdin: string })[] = [];
    const args = this.args;
    const takeValue = (i: number, name: string): string => {
      const value = args[i + 1];
      if (value === undefined) {
        throw new GitApiError(`fatal: Option '--${name}' requires a value`, { exitCode: 128 });
      }
      return value;
    };
    const maxCount = (value: string) => {
      if (!/^-?\d+$/.test(value)) {
        throw new GitApiError(`fatal: '${value}': not an integer`, { exitCode: 128 });
      }
      revList.setMaxCount(Number.parseInt(value, 10));
    };
    const date = (value: string) => approxidateCareful(value).timestamp;
    let sinceTime: number | undefined;
    let untilTime: number | undefined;
    let endOfOptions = false;
    /** setup_revisions leaves an option it does not know in argv: git's error after the walk setup */
    let unrecognized: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (endOfOptions || !arg.startsWith("-") || arg === "-" || arg.startsWith("^")) {
        revisions.push(arg);
        continue;
      }
      /** The groups of the last pattern {@link take} matched */
      let m: string[] = [];
      const take = (re: RegExp): boolean => {
        const found = re.exec(arg);
        m = found ? [...found] : [];
        return found !== null;
      };
      if (arg === "--end-of-options") {
        endOfOptions = true;
        revisions.push(arg);
      } else if (
        arg === "--not" ||
        arg === "--all" ||
        /^--(branches|tags|remotes)(=|$)/.test(arg)
      ) {
        revisions.push(arg);
      } else if (/^--(glob|exclude)=/.test(arg)) {
        revisions.push(arg);
      } else if (arg === "--glob" || arg === "--exclude") {
        revisions.push(`${arg}=${takeValue(i, arg.slice(2))}`);
        i++;
      } else if (arg === "--stdin") {
        revisions.push({ stdin: this.stdin ?? "" });
      } else if (arg === "--ignore-missing") {
        ignoreMissing = true;
      } else if (take(/^--max-count=(.*)$/s)) {
        maxCount(m[1] as string);
      } else if (arg === "--max-count" || arg === "-n") {
        maxCount(takeValue(i, "max-count"));
        i++;
      } else if (take(/^-n(\d+)$/) || take(/^-(\d+)$/)) {
        maxCount(m[1] as string);
      } else if (take(/^--(since|after|until|before)=(.*)$/s)) {
        if (m[1] === "since" || m[1] === "after") sinceTime = date(m[2] as string);
        else untilTime = date(m[2] as string);
      } else if (take(/^--(since|after|until|before)$/)) {
        const value = takeValue(i, m[1] as string);
        i++;
        if (m[1] === "since" || m[1] === "after") sinceTime = date(value);
        else untilTime = date(value);
      } else if (take(/^--max-age=(\d+)$/)) {
        sinceTime = Number(m[1]);
      } else if (take(/^--min-age=(\d+)$/)) {
        untilTime = Number(m[1]);
      } else if (take(/^--filter=(.*)$/s)) {
        try {
          const parsed = parseObjectFilter(m[1] as string);
          // expand_list_objects_filter_spec: a blob limit in bytes
          filter = parsed.choice === "blob:limit" ? `blob:limit=${parsed.limit}` : (m[1] as string);
        } catch (error) {
          if (error instanceof ObjectFilterError) {
            throw new GitApiError(`fatal: ${error.message}`, { exitCode: 128 });
          }
          throw error;
        }
      } else if (arg === "--no-filter") {
        filter = undefined;
      } else if (arg === "--objects" || arg === "--objects-edge" || arg === "--quiet") {
        // the pack lists objects anyway
      } else if (arg === "--first-parent") {
        revList.setFirstParent(true);
      } else if (arg === "--no-merges") {
        revList.setNoMerges(true);
      } else if (arg === "--topo-order" || arg === "--date-order") {
        revList.setOrder(arg === "--topo-order" ? "topo" : "date");
      } else if (arg === "--boundary") {
        // the walk lists its boundary anyway
      } else if (arg === "--") {
        break;
      } else unrecognized ??= arg;
    }
    if (sinceTime !== undefined) revList.setSince(sinceTime);
    if (untilTime !== undefined) revList.setUntil(untilTime);

    // setup_revisions: the pending objects in order, with the names they were given
    for (const revision of revisions) {
      if (typeof revision === "string") revList.addRevision(revision);
      else revList.addStdin(revision.stdin);
    }
    revList.setIgnoreMissing(ignoreMissing);
    let entries: readonly { id: ObjectId; exclude: boolean; name?: string }[];
    try {
      entries = (await revList.resolve()).entries;
    } catch (error) {
      // a plain argument naming nothing: setup_revisions takes it for a path (none exists)
      if (
        error instanceof RevisionError &&
        typeof error.revision === "string" &&
        !error.revision.startsWith("^") &&
        !error.revision.startsWith("-") &&
        !error.revision.includes("..") &&
        error.message.endsWith(`fatal: bad revision '${error.revision}'`) &&
        revisions.includes(error.revision)
      ) {
        throw new RevisionError(error.revision, unknownRevisionMessage(error.revision));
      }
      throw error;
    }
    if (unrecognized !== undefined) {
      return { exitCode: 1, stdout: "", stderr: `error: unrecognized argument: ${unrecognized}\n` };
    }
    const format = this.objectFormat;
    const minVersion = format.name !== "sha1" || filter !== undefined ? 3 : 2;
    const version = this.version ?? minVersion;
    if (version < 2 || version > 3) {
      throw new GitApiError(`fatal: unsupported bundle version ${version}`, { exitCode: 128 });
    }
    if (version < minVersion) {
      throw new GitApiError(
        `fatal: cannot write bundle version ${version} with algorithm ${format.name}`,
        { exitCode: 128 },
      );
    }

    // the walk (revs.boundary): the commits shown, then the boundary
    const shown = new Set<ObjectId>();
    const prerequisites: BundlePrerequisite[] = [];
    const boundary: ObjectId[] = [];
    for await (const commit of await revList.call()) {
      if (commit.boundary) {
        // write_bundle_prerequisites: `-<id> <oneline subject>`
        prerequisites.push({ id: commit.id, comment: commitSubject(commit.message).trim() });
        boundary.push(commit.id);
      } else shown.add(commit.id);
    }
    stderr += revList
      .getWarnings()
      .map((w) => `${w}\n`)
      .join("");

    // write_bundle_refs over the pending objects
    const resolver = this.revisionResolver();
    const refs = this.refsStore;
    const references: BundleRef[] = [];
    const written = new Set<string>();
    const wants: ObjectId[] = [];
    const haves: ObjectId[] = [];
    const uninteresting = new Set<number>();
    const compatibility = this.compatibility ?? this.hooks.compatibility;
    if (compatibility === "2.43") {
      // object_array_remove_duplicates: the first entry of each object and name
      const seen = new Set<string>();
      entries = entries.filter((e) => {
        const key = `${e.id}\0${e.name ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    // the commits the walk marked UNINTERESTING: reachable from an excluded commit
    const excludedCommits: ObjectId[] = [];
    for (const entry of entries) {
      if (!entry.exclude) continue;
      const peeled = await resolver.peelTags(entry.id).catch(() => undefined);
      if (peeled?.type === "commit") excludedCommits.push(peeled.id);
    }
    const commits = this.walkCommits;
    const uninterestingCommit = async (id: ObjectId) => {
      for (const excluded of excludedCommits) {
        if (excluded === id) return true;
        if (await commits.isAncestor(id, excluded).catch(() => false)) return true;
      }
      return false;
    };
    for (const [index, entry] of entries.entries()) {
      if (entry.exclude) continue;
      const name = entry.name;
      if (name === undefined) continue;
      const commitItem = (await this.objectTypeOf(entry.id)) === "commit";
      if (commitItem && !shown.has(entry.id) && (await uninterestingCommit(entry.id))) continue;
      const found = await resolver.dwimRef(name).catch(() => []);
      if (found.length !== 1) continue;
      const literal = await refs.get(name).catch(() => undefined);
      const symbolic = literal !== undefined && "target" in literal;
      const display = symbolic ? name : (found[0] as { ref: string }).ref;
      if (compatibility !== "2.43" && written.has(display)) continue;
      const objectType = await this.objectTypeOf(entry.id);
      if (objectType === "tag" && !(await this.tagInDateRange(entry.id, sinceTime, untilTime))) {
        uninteresting.add(index);
        continue;
      }
      if (objectType === "commit" && !shown.has(entry.id)) {
        stderr += `warning: ref '${name}' is excluded by the rev-list options\n`;
        continue;
      }
      written.add(display);
      references.push({ id: entry.id, name: display });
    }
    if (references.length === 0) {
      throw new GitApiError(`${stderr}fatal: Refusing to create empty bundle.`, {
        exitCode: 128,
      });
    }
    for (const [index, entry] of entries.entries()) {
      if (!entry.exclude && !uninteresting.has(index)) {
        wants.push(entry.id);
        continue;
      }
      // pack-objects' `^<id>`: a tag excludes what it points at too
      haves.push(entry.id);
      const peeled = await resolver.peelTags(entry.id).catch(() => undefined);
      if (peeled && peeled.id !== entry.id) haves.push(peeled.id);
    }
    haves.push(...boundary);

    const header: BundleHeader = {
      version: version as 2 | 3,
      objectFormat: format,
      ...(version === 3 && filter !== undefined ? { filter } : {}),
      prerequisites,
      references,
    };
    // write_pack_data: pack-objects --thin --delta-base-offset over the pending objects
    const facade = createRepositoryFacade({
      history: historyWithoutLazyFetch(this._workingCopy.history),
    });
    const chunks: Uint8Array[] = [encodeBundleHeader(header)];
    for await (const chunk of facade.exportPack(new Set(wants), new Set(haves), {
      thin: true,
      ofsDelta: true,
      ...(filter !== undefined ? { filterSpec: filter } : {}),
    })) {
      chunks.push(chunk);
    }
    return { exitCode: 0, stdout: "", stderr, bundle: concat(chunks), header };
  }

  /** The type of the object `id` names. */
  private async objectTypeOf(id: ObjectId): Promise<string | undefined> {
    const peeled = await this.revisionResolver()
      .peelTags(id)
      .catch(() => undefined);
    if (peeled === undefined) return undefined;
    return peeled.id === id ? peeled.type : "tag";
  }

  /** bundle.c's `is_tag_in_date_range`: the tagger's date within `--since`/`--until`. */
  private async tagInDateRange(
    id: ObjectId,
    since: number | undefined,
    until: number | undefined,
  ): Promise<boolean> {
    if (since === undefined && until === undefined) return true;
    const tag = await this.tagsStore?.load(id).catch(() => undefined);
    const date = tag?.tagger?.timestamp;
    if (date === undefined) return true;
    return (since === undefined || since < date) && (until === undefined || until > date);
  }

  /** The usage text git prints for a bad option (exit 129). */
  static usage(): string {
    return USAGE;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
