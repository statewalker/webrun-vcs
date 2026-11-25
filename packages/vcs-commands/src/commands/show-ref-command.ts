/**
 * `git show-ref` (builtin/show-ref.c): the refs and their ids, matched by patterns, checked by
 * exact name (`--verify`), tested for existence (`--exists`), or the lines of a remote's
 * listing the repository lacks (`--exclude-existing`).
 *
 * @example
 * ```typescript
 * // git show-ref --tags -d
 * const { stdout } = await git.showRef().setTags(true).setDereference(true).callOutput();
 * // git show-ref --verify -q refs/heads/main
 * const { exitCode } = await git.showRef().setVerify(true).setQuiet(true).addPattern("refs/heads/main").call();
 * ```
 */

import {
  compareRefNames,
  isSymbolicRef,
  isValidRefName,
  type ObjectId,
} from "@statewalker/vcs-core";

import { RemoteConfigStore } from "../remote-config/index.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

/** git's MINIMUM_ABBREV */
const MINIMUM_ABBREV = 4;
/** DEFAULT_ABBREV: the automatic length (`core.abbrev`) */
const DEFAULT_ABBREV = -1;

/** A listed ref and the id it resolves to. */
interface ListedRef {
  name: string;
  id: ObjectId;
  /** What packed-refs says it peels to */
  peeled?: ObjectId;
}

/**
 * `git show-ref`. Results are git's stdout ({@link setStdout}, {@link callOutput}), stderr
 * and exit status: 1 when no ref matched (or `--verify -q` missed), 2 for `--exists` of a
 * missing ref; deaths (`fatal:` lines, exit 128) are thrown as {@link PlumbingError}.
 *
 * Version differences (`setCompatibility`): the refusal of two sub-modes at once is 2.43's
 * `only one of ... can be given`, 2.5x's `options ... cannot be used together`; 2.43's
 * `--verify` reads only `refs/...` and HEAD (2.5x also other uppercase names, `ORIG_HEAD`); 2.43's `--exists`
 * of a missing FETCH_HEAD or MERGE_HEAD says `failed to look up reference: Success` (exit 1).
 * `--branches` is 2.46's name of `--heads` (both are {@link setBranches}).
 */
export class ShowRefCommand extends PlumbingCommand {
  private readonly patterns: string[] = [];
  private head = false;
  private branches = false;
  private tags = false;
  private deref = false;
  private hashOnly = false;
  private abbrev = 0;
  private quiet = false;
  private verify = false;
  private exists = false;
  private excludeExisting = false;
  private excludePattern?: string;
  private stdin = "";
  private compatibility: "2.43" | "2.56" = "2.56";

  /** Patterns (tail-matched on whole components), or the refs of `--verify`/`--exists`. */
  addPattern(...patterns: string[]): this {
    this.checkCallable();
    this.patterns.push(...patterns);
    return this;
  }

  /** `--head`: HEAD listed first, whatever the patterns. */
  setHead(head: boolean): this {
    this.checkCallable();
    this.head = head;
    return this;
  }

  /** `--branches` (2.46+; `--heads` before): only `refs/heads/`, with tags if asked too. */
  setBranches(branches: boolean): this {
    this.checkCallable();
    this.branches = branches;
    return this;
  }

  /** `--heads`, the name of {@link setBranches} before git 2.46. */
  setHeads(heads: boolean): this {
    return this.setBranches(heads);
  }

  /** `--tags`: only `refs/tags/`, with branches if asked too. */
  setTags(tags: boolean): this {
    this.checkCallable();
    this.tags = tags;
    return this;
  }

  /** `-d`/`--dereference`: a `<ref>^{}` line with what an annotated tag peels to. */
  setDereference(deref: boolean): this {
    this.checkCallable();
    this.deref = deref;
    return this;
  }

  /**
   * `-s`/`--hash[=<n>]`: ids alone, abbreviated to `n` digits when given (0: whole; less than 4
   * is 4).
   */
  setHash(length?: number): this {
    this.checkCallable();
    this.hashOnly = true;
    if (length !== undefined) this.abbrev = clampAbbrev(length);
    return this;
  }

  /** `--abbrev[=<n>]`: ids abbreviated (no length: `core.abbrev`'s); `0` is `--no-abbrev`. */
  setAbbrev(length?: number): this {
    this.checkCallable();
    this.abbrev = length === undefined ? DEFAULT_ABBREV : clampAbbrev(length);
    return this;
  }

  /** `-q`/`--quiet`: nothing on stdout. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** `--verify`: the patterns are full ref names (or HEAD and other root refs). */
  setVerify(verify: boolean): this {
    this.checkCallable();
    this.verify = verify;
    return this;
  }

  /** `--exists`: whether the one ref given exists, without resolving it. */
  setExists(exists: boolean): this {
    this.checkCallable();
    this.exists = exists;
    return this;
  }

  /**
   * `--exclude-existing[=<pattern>]`: the {@link setStdin} lines whose ref the repository
   * lacks, only refs starting with `pattern` when given.
   */
  setExcludeExisting(pattern?: string): this {
    this.checkCallable();
    this.excludeExisting = true;
    this.excludePattern = pattern;
    return this;
  }

  /** git's stdin (`--exclude-existing`'s lines). */
  setStdin(text: string): this {
    this.checkCallable();
    this.stdin = text;
    return this;
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** It reads objects only: ids are abbreviated over cached listings. */
  protected override writesNoObjects(): boolean {
    return true;
  }

  protected async run(): Promise<number> {
    const modes: string[] = [];
    if (this.excludeExisting) modes.push("--exclude-existing");
    if (this.verify) modes.push("--verify");
    if (this.exists) modes.push("--exists");
    if (modes.length > 1) {
      if (this.compatibility === "2.43") {
        throw new PlumbingError(
          "fatal: only one of '--exclude-existing', '--verify' or '--exists' can be given",
        );
      }
      const quoted = modes.map((m) => `'${m}'`);
      const list =
        quoted.length === 2
          ? `${quoted[0]} and ${quoted[1]}`
          : `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
      throw new PlumbingError(`fatal: options ${list} cannot be used together`);
    }
    if (this.excludeExisting) return this.runExcludeExisting();
    if (this.verify) return this.runVerify();
    if (this.exists) return this.runExists();
    return this.runPatterns();
  }

  /** cmd_show_ref__patterns */
  private async runPatterns(): Promise<number> {
    let found = 0;
    if (this.head) {
      const id = await this.resolveName("HEAD");
      if (id) {
        found++;
        await this.showOne({ name: "HEAD", id });
      }
    }
    const prefixes =
      this.branches || this.tags
        ? [...(this.branches ? ["refs/heads/"] : []), ...(this.tags ? ["refs/tags/"] : [])]
        : ["refs/"];
    for (const prefix of prefixes) {
      for (const ref of await this.listRefs(prefix)) {
        if (this.patterns.length > 0 && !this.patterns.some((p) => tailMatches(ref.name, p))) {
          continue;
        }
        found++;
        await this.showOne(ref);
      }
    }
    return found ? 0 : 1;
  }

  /** cmd_show_ref__verify */
  private async runVerify(): Promise<number> {
    if (this.patterns.length === 0) throw new PlumbingError("fatal: --verify requires a reference");
    for (const name of this.patterns) {
      const id = this.verifiable(name) ? await this.resolveName(name) : undefined;
      if (id) {
        const peeled = await this.packedPeel(name);
        await this.showOne({ name, id, ...(peeled ? { peeled } : {}) });
      } else if (!this.quiet) {
        throw new PlumbingError(`fatal: '${name}' - not a valid ref`);
      } else {
        return 1;
      }
    }
    return 0;
  }

  /**
   * The names `--verify` reads: `refs/...` and HEAD, and from 2.45 any name refname_is_safe
   * takes outside `refs/` (`CHERRY_PICK_HEAD`, `ORIG_HEAD`: uppercase letters and `_`).
   */
  private verifiable(name: string): boolean {
    if (name.startsWith("refs/") || name === "HEAD") return true;
    return this.compatibility !== "2.43" && refnameIsSafe(name);
  }

  /** cmd_show_ref__exists: refs_read_raw_ref, a symbolic ref not followed */
  private async runExists(): Promise<number> {
    const [name, more] = this.patterns;
    if (name === undefined) throw new PlumbingError("fatal: --exists requires a reference");
    if (more !== undefined) {
      throw new PlumbingError("fatal: --exists requires exactly one reference");
    }
    let value: unknown;
    try {
      value = await this.refsStore.get(name);
    } catch {
      // unreadable content (files_read_raw_ref's EINVAL)
      this.warn("error: failed to look up reference: Invalid argument");
      return 1;
    }
    if (value) return 0;
    const raw = await this.looseRefFile(name);
    // 2.43 reports the files backend's EISDIR; 2.5x's read_ref_internal takes a directory
    // for a missing ref (`reference does not exist`, exit 2)
    if (raw === "directory" && this.compatibility === "2.43") {
      this.warn("error: failed to look up reference: Is a directory");
      return 1;
    }
    if (raw !== undefined && raw !== "directory") {
      if (this.isObjectIdLine(raw)) return 0;
      this.warn("error: failed to look up reference: Invalid argument");
      return 1;
    }
    if (this.compatibility === "2.43" && (name === "FETCH_HEAD" || name === "MERGE_HEAD")) {
      // 2.43's refs_read_special_head leaves failure_errno unset for a missing file
      this.warn("error: failed to look up reference: Success");
      return 1;
    }
    this.warn("error: reference does not exist");
    return 2;
  }

  /** cmd_show_ref__exclude_existing */
  private async runExcludeExisting(): Promise<number> {
    const existing = new Set((await this.listRefs("refs/")).map((r) => r.name));
    const pattern = this.excludePattern;
    for (const line of stdinLines(this.stdin)) {
      let buf = line;
      if (buf.length >= 3 && buf.endsWith("^{}")) buf = buf.slice(0, -3);
      let start = buf.length;
      while (start > 0 && !isSpace(buf.charCodeAt(start - 1))) start--;
      const ref = buf.slice(start);
      if (pattern !== undefined && !ref.startsWith(pattern)) continue;
      if (!isValidRefName(ref)) {
        this.warn(`warning: ref '${ref}' ignored`);
        continue;
      }
      if (!existing.has(ref)) await this.write(`${buf}\n`);
    }
    return 0;
  }

  /** show_one: the ref's line (and its `^{}` line); a missing object is fatal. */
  private async showOne(ref: ListedRef): Promise<void> {
    const objects = this.workingCopy.history?.objects;
    const present = objects ? await objects.has(ref.id).catch(() => false) : true;
    if (!present) throw new PlumbingError(`fatal: git show-ref: bad ref ${ref.name} (${ref.id})`);
    if (this.quiet) return;
    const hex = await this.hexOf(ref.id);
    await this.write(this.hashOnly ? `${hex}\n` : `${hex} ${ref.name}\n`);
    if (!this.deref) return;
    const peeled = ref.peeled ?? (await this.peel(ref.id));
    if (peeled) await this.write(`${await this.hexOf(peeled)} ${ref.name}^{}\n`);
  }

  /** peel_iterated_oid: what an annotated tag ends at, undefined for anything else. */
  private async peel(id: ObjectId): Promise<ObjectId | undefined> {
    const resolver = this.revisionResolver();
    const type = await resolver.objectType(id).catch(() => undefined);
    if (type !== "tag") return undefined;
    const end = await resolver.peelTags(id).catch(() => undefined);
    return end && end.id !== id ? end.id : undefined;
  }

  /** repo_find_unique_abbrev with the command's length (0: the whole id). */
  private async hexOf(id: ObjectId): Promise<string> {
    if (this.abbrev === 0) return id;
    if (this.abbrev === DEFAULT_ABBREV) return this.abbreviateObjectId(id);
    const length = Math.min(this.abbrev, id.length);
    const lengths = await this.idAbbreviator().lengths([id], length);
    return id.slice(0, lengths.get(id) ?? length);
  }

  /** The refs under `prefix` in name order, symbolic ones at their target's id, dangling ones left out. */
  private async listRefs(prefix: string): Promise<ListedRef[]> {
    const refs = this.refsStore;
    const out: ListedRef[] = [];
    for await (const entry of refs.list(prefix)) {
      if (isSymbolicRef(entry)) {
        const id = await this.resolveName(entry.name);
        if (id) out.push({ name: entry.name, id });
      } else if (entry.objectId) {
        out.push({
          name: entry.name,
          id: entry.objectId,
          ...(entry.peeledObjectId ? { peeled: entry.peeledObjectId } : {}),
        });
      }
    }
    return out.sort((a, b) => compareRefNames(a.name, b.name));
  }

  /** What a ref name resolves to, symbolic refs followed (read_ref). */
  private async resolveName(name: string): Promise<ObjectId | undefined> {
    const ref = await this.refsStore.resolve(name).catch(() => undefined);
    return ref?.objectId;
  }

  /** The peeled id packed-refs records for `name`, if it is a direct packed ref. */
  private async packedPeel(name: string): Promise<ObjectId | undefined> {
    const value = await this.refsStore.get(name).catch(() => undefined);
    return value && !isSymbolicRef(value) ? value.peeledObjectId : undefined;
  }

  /**
   * A loose ref's file in the files backend that the store does not read as a ref (a
   * directory, FETCH_HEAD): `"directory"`, its text, or undefined when there is none (and
   * always in a reftable repository).
   */
  private async looseRefFile(name: string): Promise<string | "directory" | undefined> {
    const config = RemoteConfigStore.from(this.workingCopy);
    if (config.value("extensions.refStorage")?.toLowerCase() === "reftable") return undefined;
    const perWorktree =
      !name.startsWith("refs/") ||
      ["refs/bisect/", "refs/worktree/", "refs/rewritten/"].some((p) => name.startsWith(p));
    const file = await (perWorktree
      ? this.hooks.gitFile(name)
      : this.hooks.commonGitFile(name)
    ).catch(() => undefined);
    if (!file) return undefined;
    const stats = await file.files.stats(file.path).catch(() => undefined);
    if (!stats) return undefined;
    if (stats.kind === "directory") return "directory";
    if (stats.kind !== "file") return undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.files.read(file.path)) chunks.push(chunk);
    let size = 0;
    for (const c of chunks) size += c.length;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return new TextDecoder().decode(bytes);
  }

  /** parse_loose_ref_contents of a direct value: the format's hex digits, then the end or a space. */
  private isObjectIdLine(text: string): boolean {
    const hex = this.objectFormat.hexLength;
    if (!new RegExp(`^[0-9a-f]{${hex}}`).test(text)) return false;
    const next = text.charAt(hex);
    return next === "" || isSpace(next.charCodeAt(0));
  }
}

/** parse_opt_abbrev_cb: 0 stays (whole ids), less than 4 is 4; longer than any id is the id. */
function clampAbbrev(length: number): number {
  if (length !== 0 && length < MINIMUM_ABBREV) return MINIMUM_ABBREV;
  return length;
}

/** show_ref's pattern test: `pattern` is the whole name or its tail after a `/`. */
function tailMatches(name: string, pattern: string): boolean {
  if (pattern.length > name.length || !name.endsWith(pattern)) return false;
  return pattern.length === name.length || name.charAt(name.length - pattern.length - 1) === "/";
}

/** refs.c's refname_is_safe for a name outside `refs/`: uppercase letters and `_` only. */
function refnameIsSafe(name: string): boolean {
  return /^[A-Z_]+$/.test(name);
}

/** isspace in git's ctype: space, \t, \n, \v, \f, \r. */
function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** fgets' lines: each without its newline, a last unterminated line included. */
function stdinLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
