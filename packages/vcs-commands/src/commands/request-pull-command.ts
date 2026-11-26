/**
 * `git request-pull` (git-request-pull.sh) as a library command: the text asking someone to
 * pull a branch or tag of a published repository, with the range's shortlog and diffstat.
 *
 * @example
 * ```typescript
 * // git request-pull v1.0 https://example.com/repo.git main:for-linus
 * const { stdout, stderr, exitCode } = await git
 *   .requestPull()
 *   .setStart("v1.0")
 *   .setUrl("https://example.com/repo.git")
 *   .setEnd("main:for-linus")
 *   .call();
 * ```
 */

import { isSymbolicRef, type ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { TransportCommand } from "../transport-command.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { DiffCommand } from "./diff-command.js";
import { LsRemoteCommand } from "./ls-remote-command.js";
import { MergeBaseCommand } from "./merge-base-command.js";
import { formatCommitPretty } from "./pretty-format.js";
import { ShortlogCommand } from "./shortlog-command.js";
import { ShowRefCommand } from "./show-ref-command.js";

const RULE = "----------------------------------------------------------------";

/** What `"$0" -h` prints (stdout) when the start or the URL is missing; git then exits 1. */
const USAGE =
  "usage: git request-pull [options] start url [end]\n\n" +
  "    -p                    show patch text as well\n\n";

/** git-sh-setup's `die`: the message on stderr, exit 1. */
class RequestPullDeath extends Error {}

/** A line of `git ls-remote` output: an object id and the ref (`^{}` for a peeled tag). */
type ListedRef = readonly [sha1: string, ref: string];

/**
 * `git request-pull [-p] <start> <url> [<end>]`. The result is git's stdout, stderr and exit
 * status: 1 with git's `warn:` lines when `<url>` has no ref of the remote name (default
 * `HEAD`) at the commit asked for, or one at another object (the text is still printed), 1
 * with git's `fatal:` line when a revision names nothing or the two have no common history.
 *
 * The remote's refs are listed through the command's transports (credentials and headers as
 * {@link TransportCommand} gives them); everything else is read from the repository: the
 * merge base, the shortlog (`git shortlog ^<start> <end>`, mailmap applied) and `git diff -M
 * --stat --summary [-p]` of the merge base and the end.
 */
export class RequestPullCommand extends TransportCommand<PlumbingTextOutput> {
  private start = "";
  private url = "";
  private end = "";
  private patch = false;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `<start>`: the commit the changes are based on (the upstream's), any committish. */
  setStart(start: string): this {
    this.checkCallable();
    this.start = start;
    return this;
  }

  /** `<url>`: the repository to pull from, a URL or a remote's name. */
  setUrl(url: string): this {
    this.checkCallable();
    this.url = url;
    return this;
  }

  /**
   * `<end>`: what to pull, `<local>[:<remote>]` (default `HEAD`, asked as the remote's
   * `HEAD`); the remote side is the name looked for among the remote's refs.
   */
  setEnd(end: string): this {
    this.checkCallable();
    this.end = end;
    return this;
  }

  /** `-p`: the patch after the diffstat. */
  setPatch(patch: boolean): this {
    this.checkCallable();
    this.patch = patch;
    return this;
  }

  /**
   * The git version to follow (default 2.56). Before 2.50 a Perl script matched the remote's
   * refs and kept the last ref matching, from 2.50 a shell loop keeps the first.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.start || !this.url) return { exitCode: 1, stdout: USAGE, stderr: "" };
    const out: string[] = [];
    const err: string[] = [];
    try {
      const status = await this.run(out, err);
      return { exitCode: status, stdout: out.join(""), stderr: err.join("") };
    } catch (error) {
      if (!(error instanceof RequestPullDeath)) throw error;
      return { exitCode: 1, stdout: out.join(""), stderr: `${err.join("")}${error.message}\n` };
    }
  }

  private async run(out: string[], err: string[]): Promise<number> {
    let status = 0;
    const base = this.start;
    const url = this.url;
    const baserev = await this.verify(`${base}^0`);
    if (baserev === undefined) throw new RequestPullDeath(`fatal: Not a valid revision: ${base}`);

    // $3 is `<local>[:<remote>]`: ${3%:*} and ${3#*:}
    const end = this.end;
    const lastColon = end.lastIndexOf(":");
    const firstColon = end.indexOf(":");
    const local = (lastColon >= 0 ? end.slice(0, lastColon) : end) || "HEAD";
    const remote = firstColon >= 0 ? end.slice(firstColon + 1) : end;
    let prettyRemote = remote.startsWith("refs/") ? remote.slice(5) : remote;
    if (prettyRemote.startsWith("heads/")) prettyRemote = prettyRemote.slice(6);
    const head =
      (await this.symbolicRef(local)) ||
      (await this.showRef(local)) ||
      (await this.verify(local)) ||
      "";
    if (!head) throw new RequestPullDeath(`fatal: Not a valid revision: ${local}`);
    // this also verifies that the head is unique: show-ref could have listed several refs
    const headrev = await this.verify(`${head}^0`);
    if (headrev === undefined) throw new RequestPullDeath(`fatal: Ambiguous revision: ${local}`);
    const localSha1 = (await this.verify(head)) ?? "";

    // was it a branch with a description?
    const config = RemoteConfigStore.from(this._workingCopy);
    const branchName = head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : head;
    const description = config.value(`branch.${branchName}.description`);

    const mergeBase = (
      await new MergeBaseCommand(this._workingCopy).addCommit(baserev).addCommit(headrev).call()
    ).bases[0];
    if (mergeBase === undefined) {
      throw new RequestPullDeath(`fatal: No commits in common between ${base} and ${head}`);
    }

    // a ref of the remote's name at the remote, at the commit asked for
    const asked = remote || "HEAD";
    const found = this.matchRef(await this.listRemote(url, err), asked, headrev);
    if (!found) {
      err.push(`warn: No match for commit ${headrev} found at ${url}\n`);
      err.push(`warn: Are you sure you pushed '${asked}' there?\n`);
      status = 1;
    } else if (localSha1 !== found.remoteSha1) {
      err.push(`warn: ${head} found at ${url} but points to a different object\n`);
      err.push(`warn: Are you sure you pushed '${asked}' there?\n`);
      status = 1;
    }
    // special case: turn "for_linus" to "tags/for_linus" when it is correct
    if (found?.ref === `refs/tags/${prettyRemote}`) prettyRemote = `tags/${prettyRemote}`;

    const fetchUrl = await this.configureChild(new LsRemoteCommand(this._workingCopy))
      .setRemote(url)
      .callGetUrl();

    out.push(
      await this.show(
        mergeBase,
        "The following changes since commit %H:\n\n  %s (%ci)\n\nare available in the Git repository at:\n",
      ),
    );
    out.push(`  ${fetchUrl} ${prettyRemote}\n`);
    out.push(
      await this.show(headrev, `\nfor you to fetch changes up to %H:\n\n  %s (%ci)\n\n${RULE}`),
    );
    const tag = await this.tagMessage(localSha1);
    if (tag !== undefined) out.push(`${tag}\n${RULE}\n`);
    if (branchName && description !== undefined) {
      out.push(`(from the branch description for ${branchName} local branch)\n\n`);
      out.push(`${description}\n${RULE}\n`);
    }

    const shortlog = new ShortlogCommand(this._workingCopy)
      .addArgument(`^${baserev}`)
      .addArgument(headrev);
    out.push(await shortlog.callText());
    for (const line of shortlog.getErrors()) err.push(`${line}\n`);

    const diff = new DiffCommand(this._workingCopy)
      .setOldTree(mergeBase)
      .setNewTree(headrev)
      .setOptions({ findRenames: true });
    const { bytes } = await diff.callFormats(
      this.patch ? ["stat", "summary", "patch"] : ["stat", "summary"],
    );
    if (bytes) out.push(decodeGitPath(bytes));
    return status;
  }

  /** `git rev-parse --verify --quiet <name>`: undefined when it names no single object. */
  private async verify(name: string): Promise<ObjectId | undefined> {
    if (name.includes("\n")) return undefined;
    try {
      return await this.revisionResolver().resolve(name);
    } catch {
      return undefined;
    }
  }

  /** `git symbolic-ref -q <name>`: the ref a symbolic ref names, else undefined. */
  private async symbolicRef(name: string): Promise<string | undefined> {
    try {
      const ref = await this.refsStore.get(name);
      return ref && isSymbolicRef(ref) ? ref.target : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `git show-ref --heads --tags <name> | cut -d' ' -f2`: the branches and tags the name ends
   * (several lines when it names several, which `rev-parse` then refuses).
   */
  private async showRef(name: string): Promise<string | undefined> {
    const r = await new ShowRefCommand(this._workingCopy)
      .setHeads(true)
      .setTags(true)
      .addPattern(name)
      .callOutput();
    const text = decodeGitPath(r.stdout).replace(/\n+$/, "");
    if (!text) return undefined;
    return text
      .split("\n")
      .map((line) => line.split(" ")[1] ?? "")
      .join("\n");
  }

  /**
   * `git ls-remote <url>`: HEAD first, then each ref and its peeled object (`<ref>^{}`). A
   * listing that fails leaves its lines on stderr and lists nothing, as the pipe does.
   */
  private async listRemote(url: string, err: string[]): Promise<ListedRef[]> {
    try {
      const r = await this.configureChild(new LsRemoteCommand(this._workingCopy))
        .setRemote(url)
        .call();
      const lines: ListedRef[] = [];
      if (r.head) lines.push([r.head, "HEAD"]);
      for (const ref of r.refs) {
        lines.push([ref.objectId, ref.name]);
        if (ref.peeledObjectId) lines.push([ref.peeledObjectId, `${ref.name}^{}`]);
      }
      return lines;
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      err.push(`${error.message}\n`);
      return [];
    }
  }

  /**
   * find_matching_ref: the remote ref named `asked` (or ending in `/<asked>`) at `headrev`,
   * with the object the remote's matching unpeeled ref names. 2.50+ (a shell loop) stops at
   * the first match; 2.43's Perl script meant to (`break` is no Perl statement) and keeps the
   * last one, the object of the last unpeeled matching ref.
   */
  private matchRef(
    lines: ListedRef[],
    asked: string,
    headrev: ObjectId,
  ): { remoteSha1: string; ref: string } | undefined {
    const matches = (ref: string) => ref === asked || ref.endsWith(`/${asked}`);
    if (this.compatibility === "2.43") {
      let remoteSha1: string | undefined;
      let found: string | undefined;
      for (const [sha1, line] of lines) {
        // /^(\S+)\s+([^^]+)(\S*)$/
        const caret = line.indexOf("^");
        const ref = caret >= 0 ? line.slice(0, caret) : line;
        const deref = caret >= 0 ? line.slice(caret) : "";
        if (!ref) continue;
        if (sha1 === asked) found = remoteSha1 = sha1;
        if (matches(ref)) {
          if (deref === "") remoteSha1 = sha1;
          if (sha1 === headrev) found = ref;
        }
      }
      return found ? { remoteSha1: remoteSha1 ?? headrev, ref: found } : undefined;
    }
    let remoteSha1 = "";
    for (const [sha1, line] of lines) {
      // *"^"?*: ${ref%"^"*}
      const caret = line.lastIndexOf("^");
      const deref = caret >= 0 && caret < line.length - 1;
      const ref = deref ? line.slice(0, caret) : line;
      if (sha1 === asked) return { remoteSha1: sha1, ref: sha1 };
      if (matches(ref)) {
        if (!deref) remoteSha1 = sha1;
        if (sha1 === headrev) return { remoteSha1: remoteSha1 || headrev, ref };
      }
    }
    return undefined;
  }

  /** `git show -s --format=<format> <id>` */
  private async show(id: ObjectId, format: string): Promise<string> {
    const commit = await this.commits.load(id);
    if (!commit) return "";
    return `${await formatCommitPretty(format, commit, id)}\n`;
  }

  /**
   * `git cat-file tag <head> | sed -n -e '1,/^$/d' -e '/^-----BEGIN \(PGP\|SSH\|SIGNED\) /q'
   * -e p` when the end names a tag: its message up to the signature (undefined otherwise).
   */
  private async tagMessage(id: string): Promise<string | undefined> {
    const objects = this._workingCopy.history?.objects;
    const object = await objects?.get(id).catch(() => undefined);
    if (!object) return undefined;
    if (object.type !== "tag") {
      await object.content[Symbol.asyncIterator]().return?.();
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    for await (const c of object.content) chunks.push(c.slice());
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const lines = decodeGitPath(bytes).split("\n");
    // a final newline leaves an empty last element, which is no line
    const complete = lines[lines.length - 1] === "";
    if (complete) lines.pop();
    let printed = "";
    // 1,/^$/d: the range's end is looked for from line 2 on
    let i = 1;
    while (i < lines.length && lines[i] !== "") i++;
    for (i++; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^-----BEGIN (PGP|SSH|SIGNED) /.test(line)) break;
      printed += line;
      if (i < lines.length - 1 || complete) printed += "\n";
    }
    return printed;
  }
}
