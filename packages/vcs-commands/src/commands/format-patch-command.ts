/**
 * `git format-patch`: each commit of a range as an email (`From <id> Mon Sep 17 00:00:00
 * 2001`, `From:`, `Date:`, `Subject: [PATCH n/m] ...`, the message, `---`, the diffstat,
 * the summary, the patch with binary hunks, the `-- ` signature), as git writes them byte
 * for byte: numbered subjects, cover letters with the shortlog and diffstat, threading
 * headers, `--base` prerequisite patch ids, signoffs and the `format.*` settings.
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { nullObjectIdLike } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitCommand } from "../git-command.js";
import { ChangeType } from "../results/diff-entry.js";
import { showDate } from "./date-format.js";
import { DiffCommand } from "./diff-command.js";
import { LogCommand } from "./log-command.js";
import { mailFromHeader } from "./log-output.js";
import { configValue } from "./merge-config.js";
import { type PatchIdChange, patchIdOfChanges } from "./patch-id.js";
import { sanitizedSubject, wrapText } from "./pretty-format.js";

/** One file `git format-patch` writes (or one mail of `--stdout`). */
export interface FormatPatchFile {
  /** The file name (with the output directory), as git prints it */
  name: string;
  /** The mail */
  content: Uint8Array;
}

/** What `git format-patch` produced. */
export interface FormatPatchResult {
  /** The mails, in order (the cover letter first) */
  patches: FormatPatchFile[];
  /** Standard output: the file names, or the mails with `--stdout` */
  output: Uint8Array;
}

/** Thrown where git dies (`fatal: ...`). */
export class FormatPatchError extends Error {}

/** Whether a version string (`2.56.0`, `2.43.0.windows.1`) is at least `major.minor`. */
function gitVersionAtLeast(version: string, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

const MAIL_DEFAULT_WRAP = 72;

/**
 * `git format-patch`.
 *
 * @example
 * ```typescript
 * const { patches } = await git.formatPatch().addRevision("main..topic").setCoverLetter(true).call();
 * const { output } = await git.formatPatch().setMaxCount(1).setStdout(true).call();
 * ```
 */
export class FormatPatchCommand extends GitCommand<FormatPatchResult> {
  private revisions: string[] = [];
  private maxCount?: number;
  private root = false;
  private stdout = false;
  private outputDirectory?: string;
  private numbered?: boolean;
  private numberedCmdline = false;
  private startNumber?: number;
  private subjectPrefix?: string;
  private rfc?: string;
  private rerollCount?: string;
  private keepSubject = false;
  private signoff = false;
  private coverLetter?: boolean;
  private numberedFiles = false;
  private suffix?: string;
  private noStat = false;
  private noBinary = false;
  private zeroCommit = false;
  private to: string[] = [];
  private cc: string[] = [];
  private headers: string[] = [];
  private noTo = false;
  private noCc = false;
  private from?: string | true;
  private forceInBodyFrom = false;
  private inReplyTo?: string;
  private thread?: "shallow" | "deep" | false;
  private signature?: string | false;
  private base?: string;
  private quiet = false;
  private filenameMaxLength?: number;
  private versionString = "2.56.0";
  private messageIdTime?: () => number;
  private writeFiles = true;

  /** A revision argument: `<since>` (to HEAD), `<a>..<b>`, `^<a>`, `<b>`. */
  addRevision(revision: string): this {
    this.revisions.push(revision);
    return this;
  }

  /** `-<n>`: the last n commits. */
  setMaxCount(n: number): this {
    this.maxCount = n;
    return this;
  }

  /** `--root`: from the root commit, a single revision taken as the tip. */
  setRoot(root: boolean): this {
    this.root = root;
    return this;
  }

  /** `--stdout`: the mails to standard output (no files). */
  setStdout(value: boolean): this {
    this.stdout = value;
    return this;
  }

  /** `-o <dir>`: where the files go (relative to the worktree's top). */
  setOutputDirectory(dir: string): this {
    this.outputDirectory = dir;
    return this;
  }

  /** Whether to write the files into the worktree (default true); false only returns them. */
  setWriteFiles(value: boolean): this {
    this.writeFiles = value;
    return this;
  }

  /** `-n` (true) / `-N` (false). */
  setNumbered(value: boolean): this {
    this.numbered = value;
    this.numberedCmdline = true;
    return this;
  }

  /** `--start-number=<n>`. */
  setStartNumber(n: number): this {
    this.startNumber = n;
    return this;
  }

  /** `--subject-prefix=<prefix>` (default `format.subjectPrefix`, else `PATCH`). */
  setSubjectPrefix(prefix: string): this {
    this.subjectPrefix = prefix;
    return this;
  }

  /** `--rfc[=<rfc>]`. */
  setRfc(rfc: string | true): this {
    this.rfc = rfc === true ? "RFC" : rfc;
    return this;
  }

  /** `-v <n>` / `--reroll-count=<n>`. */
  setRerollCount(n: string | number): this {
    this.rerollCount = String(n);
    return this;
  }

  /** `-k`: keep the subject as it is. */
  setKeepSubject(value: boolean): this {
    this.keepSubject = value;
    return this;
  }

  /** `-s` / `--signoff`. */
  setSignoff(value: boolean): this {
    this.signoff = value;
    return this;
  }

  /** `--cover-letter` / `--no-cover-letter` (default `format.coverLetter`). */
  setCoverLetter(value: boolean): this {
    this.coverLetter = value;
    return this;
  }

  /** `--numbered-files`. */
  setNumberedFiles(value: boolean): this {
    this.numberedFiles = value;
    return this;
  }

  /** `--suffix=<sfx>` (default `format.suffix`, else `.patch`). */
  setSuffix(suffix: string): this {
    this.suffix = suffix;
    return this;
  }

  /** `-p` / `--no-stat`. */
  setNoStat(value: boolean): this {
    this.noStat = value;
    return this;
  }

  /** `--no-binary`. */
  setNoBinary(value: boolean): this {
    this.noBinary = value;
    return this;
  }

  /** `--zero-commit`. */
  setZeroCommit(value: boolean): this {
    this.zeroCommit = value;
    return this;
  }

  /** `--to=<email>` (repeatable). */
  addTo(address: string): this {
    this.to.push(address);
    return this;
  }

  /** `--cc=<email>` (repeatable). */
  addCc(address: string): this {
    this.cc.push(address);
    return this;
  }

  /** `--no-to` / `--no-cc`: drop the configured ones. */
  setNoTo(value: boolean): this {
    this.noTo = value;
    return this;
  }

  setNoCc(value: boolean): this {
    this.noCc = value;
    return this;
  }

  /** `--add-header=<header>` (repeatable). */
  addHeader(header: string): this {
    this.headers.push(header);
    return this;
  }

  /** `--from[=<ident>]`: true for the committer. */
  setFrom(from: string | true): this {
    this.from = from;
    return this;
  }

  /** `--force-in-body-from`. */
  setForceInBodyFrom(value: boolean): this {
    this.forceInBodyFrom = value;
    return this;
  }

  /** `--in-reply-to=<message-id>`. */
  setInReplyTo(id: string): this {
    this.inReplyTo = id;
    return this;
  }

  /** `--thread[=shallow|deep]` / `--no-thread`. */
  setThread(style: "shallow" | "deep" | boolean): this {
    this.thread = style === true ? "shallow" : style;
    return this;
  }

  /** `--signature=<text>` / `--no-signature` (false). */
  setSignature(signature: string | false): this {
    this.signature = signature;
    return this;
  }

  /** `--base=<commit>` (or `auto`). */
  setBase(base: string): this {
    this.base = base;
    return this;
  }

  /** `-q`: no file names printed. */
  setQuiet(value: boolean): this {
    this.quiet = value;
    return this;
  }

  /** `--filename-max-length=<n>` (default `format.filenameMaxLength`, else 64). */
  setFilenameMaxLength(n: number): this {
    this.filenameMaxLength = n;
    return this;
  }

  /**
   * The default signature: git's version string (`git_version_string`). Defaults to
   * "2.56.0", the git this port follows; set it to match another git. It also picks the
   * cover letter's `From:` with `--from`: the given ident dated at the epoch from 2.54 on,
   * the committer (and the commit date) before.
   */
  setVersionString(version: string): this {
    this.versionString = version;
    return this;
  }

  /** The clock of the generated Message-IDs, in seconds (default: now). */
  setMessageIdTime(now: () => number): this {
    this.messageIdTime = now;
    return this;
  }

  private config(key: string): string | undefined {
    return configValue(this.workingCopy, key);
  }

  private configAll(key: string): string[] {
    const store = (this.workingCopy as unknown as { config?: { getAll?(k: string): string[] } })
      .config;
    const all = store?.getAll?.(key);
    if (all) return all;
    const one = this.config(key);
    return one === undefined ? [] : [one];
  }

  async call(): Promise<FormatPatchResult> {
    this.checkCallable();
    this.setCallable(false);

    // git_format_config
    const bool = (v: string | undefined) =>
      v === undefined ? undefined : ["true", "yes", "on", "1", ""].includes(v.toLowerCase());
    const cfgHeaders = this.configAll("format.headers");
    const cfgTo = this.noTo ? [] : this.configAll("format.to");
    const cfgCc = this.noCc ? [] : this.configAll("format.cc");
    let autoNumber = true;
    let numbered = false;
    const fmtNumbered = this.config("format.numbered");
    if (fmtNumbered !== undefined) {
      if (fmtNumbered.toLowerCase() === "auto") autoNumber = true;
      else {
        numbered = bool(fmtNumbered) ?? false;
        autoNumber = autoNumber && numbered;
      }
    }
    if (this.numbered !== undefined) {
      numbered = this.numbered;
      autoNumber = false;
      if (!this.numbered) numbered = false;
    }
    const suffix = this.suffix ?? this.config("format.suffix") ?? ".patch";
    let nameMax = this.filenameMaxLength ?? Number(this.config("format.filenameMaxLength") ?? 64);
    if (nameMax <= 5 + suffix.length) nameMax = 5 + suffix.length;
    let thread: "shallow" | "deep" | false = false;
    const cfgThread = this.config("format.thread");
    if (cfgThread !== undefined) {
      const t = cfgThread.toLowerCase();
      thread = t === "deep" ? "deep" : t === "shallow" ? "shallow" : bool(t) ? "shallow" : false;
    }
    if (this.thread !== undefined) thread = this.thread;
    const cfgCover = this.config("format.coverLetter");
    let configCover: "on" | "off" | "auto" = "off";
    if (cfgCover !== undefined)
      configCover = cfgCover.toLowerCase() === "auto" ? "auto" : bool(cfgCover) ? "on" : "off";
    const encodeHeaders = bool(this.config("format.encodeEmailHeaders")) ?? true;
    // get_log_output_encoding
    const outputEncoding =
      this.config("i18n.logOutputEncoding") || this.config("i18n.commitEncoding") || "UTF-8";
    // format.noprefix (diff.noprefix is ignored)
    const noPrefixCfg = this.config("format.noprefix");
    let noPrefix = false;
    if (noPrefixCfg !== undefined) {
      const v = noPrefixCfg.toLowerCase();
      if (["true", "yes", "on", "1", ""].includes(v)) noPrefix = true;
      else if (["false", "no", "off", "0"].includes(v)) noPrefix = false;
      else
        throw new FormatPatchError(
          `bad boolean config value '${noPrefixCfg}' for 'format.noprefix'`,
        );
    }
    const outDir = this.stdout
      ? undefined
      : (this.outputDirectory ?? this.config("format.outputDirectory"));
    let signature: string | false = this.versionString;
    if (this.signature !== undefined) signature = this.signature;
    else {
      const cfgSig = this.config("format.signature");
      if (cfgSig !== undefined) signature = cfgSig;
    }
    let signoff = this.signoff || (bool(this.config("format.signOff")) ?? false);
    if (this.signoff) signoff = true;
    const fromCfg = this.config("format.from");
    let fromSpec: string | true | undefined = this.from;
    if (fromSpec === undefined && fromCfg !== undefined) {
      // git_parse_maybe_bool: an ident where the value is not a boolean (a valueless
      // `format.from`, read here as "", is true)
      const b = maybeBool(fromCfg);
      fromSpec = b === undefined ? fromCfg : b ? true : undefined;
    }

    let sprefix = this.subjectPrefix ?? this.config("format.subjectPrefix") ?? "PATCH";
    const subjectPrefixGiven = this.subjectPrefix !== undefined;
    if (this.rfc) {
      if (this.rfc.startsWith("-")) sprefix = `${sprefix} ${this.rfc.slice(1)}`;
      else sprefix = `${this.rfc} ${sprefix}`;
    }
    if (this.rerollCount) sprefix = `${sprefix} v${this.rerollCount}`;

    let extraHeaders = "";
    for (const h of [...cfgHeaders, ...this.headers]) extraHeaders += `${h}\n`;
    const toList = [...cfgTo, ...this.to];
    const ccList = [...cfgCc, ...this.cc];
    const addressHeader = (name: string, list: string[]) => {
      if (!list.length) return;
      extraHeaders += `${name}: `;
      list.forEach((a, i) => {
        if (i) extraHeaders += "    ";
        extraHeaders += a;
        if (i + 1 < list.length) extraHeaders += ",";
        extraHeaders += "\n";
      });
    };
    addressHeader("To", toList);
    addressHeader("Cc", ccList);

    const committer = this.resolveCommitter();
    let fromIdent: { name: string; email: string } | undefined;
    if (fromSpec === true) fromIdent = { name: committer.name, email: committer.email };
    else if (fromSpec !== undefined) {
      const m = /^(.*?)\s*<([^>]*)>/.exec(fromSpec);
      if (!m) throw new FormatPatchError(`invalid ident line: ${fromSpec}`);
      fromIdent = { name: m[1] as string, email: m[2] as string };
    }

    const startNumber = this.startNumber ?? 1;
    if (numbered && this.keepSubject && !this.numberedCmdline) numbered = false;
    if (numbered && this.keepSubject)
      throw new FormatPatchError("options '-n' and '-k' cannot be used together");
    if (this.keepSubject && (subjectPrefixGiven || this.rfc))
      throw new FormatPatchError(
        "options '--subject-prefix/--rfc' and '-k' cannot be used together",
      );

    // the commits: newest first, merges left out
    const { list, origin } = await this.walk();
    if (!list.length) return { patches: [], output: new Uint8Array(0) };
    const total0 = list.length;
    let cover = this.coverLetter;
    if (cover === undefined) {
      if (configCover === "auto") cover = total0 > 1;
      else cover = configCover === "on";
    }
    if (!this.keepSubject && autoNumber && (total0 > 1 || cover)) numbered = true;
    // rev.total: the last number shown (0: not numbered, -1: -k)
    const total = numbered ? total0 + startNumber - 1 : this.keepSubject ? -1 : 0;

    // --base
    const bases = await this.prepareBases(list);

    const time = () => (this.messageIdTime ? this.messageIdTime() : Math.floor(Date.now() / 1000));
    const messageId = (base: string) => `${base}.${time()}.git.${committer.email}`;
    const refIds: string[] = [];
    let ownId: string | undefined;
    if (this.inReplyTo) refIds.push(cleanMessageId(this.inReplyTo));

    const patches: FormatPatchFile[] = [];
    const stdoutParts: Uint8Array[] = [];
    const out: string[] = [];
    let nr = 0;
    const subjectOf = () => {
      if (total > 0) {
        const width = String(total).length;
        return `Subject: [${sprefix}${sprefix ? " " : ""}${String(nr).padStart(width, "0")}/${total}] `;
      }
      if (total === 0 && sprefix) return `Subject: [${sprefix}] `;
      return "Subject: ";
    };
    const threadHeaders = () => {
      let h = "";
      if (ownId) h += `Message-ID: <${ownId}>\n`;
      if (refIds.length) {
        h += `In-Reply-To: <${refIds[refIds.length - 1]}>\n`;
        refIds.forEach((id, i) => {
          h += `${i > 0 ? "\t" : "References: "}<${id}>\n`;
        });
      }
      return h;
    };
    const fileName = (subject: string | undefined) => {
      let name = outDir ? (outDir.endsWith("/") ? outDir : `${outDir}/`) : "";
      if (this.numberedFiles) return `${name}${nr}`;
      const maxLen = encodeGitPath(name).length + nameMax - (suffix.length + 1);
      if (this.rerollCount) name += `${sanitizedSubject(`v${this.rerollCount}`)}-`;
      name += `${String(nr).padStart(4, "0")}-${subject ?? ""}`;
      let bytes = encodeGitPath(name);
      if (maxLen < bytes.length) bytes = bytes.subarray(0, maxLen);
      return `${decodeGitPath(bytes)}${suffix}`;
    };
    const emit = (name: string, content: Uint8Array) => {
      if (this.stdout) {
        stdoutParts.push(content);
        patches.push({ name: "", content });
      } else {
        patches.push({ name, content });
        if (!this.quiet) out.push(`${name}\n`);
      }
    };
    const sig = (): string => {
      if (signature === false || signature === "") return "";
      return `-- \n${signature}${signature.endsWith("\n") ? "" : "\n"}\n`;
    };

    if (cover) {
      if (thread) ownId = messageId("cover");
      nr = 0;
      const text = await this.coverLetterText(list, origin, {
        subject: subjectOf(),
        thread: threadHeaders(),
        afterSubject: extraHeaders,
        from: fromIdent,
        committer,
        encodeHeaders,
        zeroCommit: this.zeroCommit,
        outputEncoding,
      });
      const content = concat([text, latin(bases.text), latin(sig())]);
      bases.text = "";
      emit(fileName(this.numberedFiles ? undefined : "cover-letter"), content);
    }

    const sob = signoff ? `Signed-off-by: ${committer.name} <${committer.email}>\n` : undefined;
    let shownOne = false;
    for (let k = 0; k < list.length; k++) {
      const id = list[list.length - 1 - k] as ObjectId;
      nr = startNumber + k;
      if (thread) {
        if (ownId) {
          // shallow: every mail replies to the first one (or to --in-reply-to, or to the
          // cover letter); deep: each to the one before
          const keepFirst = thread === "shallow" && refIds.length > 0 && (!cover || nr > 1);
          if (!keepFirst) refIds.push(ownId);
        }
        ownId = messageId(id);
      }
      const subject = this.numberedFiles ? undefined : await this.fileSubject(id);
      const log = new LogCommand(this.workingCopy)
        .add(id)
        .setMaxCount(1)
        .setDiffOptions({
          stat: { width: MAIL_DEFAULT_WRAP },
          binaryPatch: !this.noBinary,
          ignoreConfigNoPrefix: true,
          // git_format_config ignores diff.submodule
          submoduleFormat: "short",
          uiConfig: false,
          ...(noPrefix ? { noPrefix: true } : {}),
        });
      const bytes = await log.callBytes({
        pretty: this.stdout && bool(this.config("format.mboxrd")) ? "mboxrd" : "email",
        stat: !this.noStat,
        summary: !this.noStat,
        patch: true,
        showRoot: true,
        mailmap: false,
        notes: false,
        abbrevCommit: false,
        decorate: false,
        mail: {
          subject: subjectOf,
          threadHeaders,
          afterSubject: extraHeaders,
          zeroCommit: this.zeroCommit,
          preserveSubject: this.keepSubject,
          ...(sob ? { signoff: sob } : {}),
          ...(fromIdent ? { from: fromIdent } : {}),
          forceInBodyFrom: this.forceInBodyFrom,
          encodeHeaders,
          outputEncoding,
        },
      });
      const parts: Uint8Array[] = [];
      // log-tree's shown_one: one blank line between the mails of --stdout
      if (this.stdout && shownOne) parts.push(latin("\n"));
      shownOne = true;
      parts.push(bytes, latin(bases.text), latin(sig()));
      bases.text = "";
      emit(fileName(subject), concat(parts));
    }

    if (!this.stdout && this.writeFiles) {
      const worktree = this.worktreeAccess;
      if (worktree) {
        for (const p of patches) {
          await worktree.writeContent(p.name, p.content, { createParents: true, raw: true });
        }
      }
    }
    const output = this.stdout ? concat(stdoutParts) : new TextEncoder().encode(out.join(""));
    return { patches, output };
  }

  /** The subject for the file name (`%f`). */
  private async fileSubject(id: ObjectId): Promise<string> {
    const commit = await this.commits.load(id);
    const message = commit?.message ?? "";
    const lines = message.split("\n");
    let at = 0;
    while (at < lines.length && (lines[at] as string).trim() === "") at++;
    const subject: string[] = [];
    for (; at < lines.length && (lines[at] as string).trim() !== ""; at++)
      subject.push(lines[at] as string);
    return sanitizedSubject(subject.join(" "));
  }

  /** The commits to format (newest first), the single boundary commit, the branch name. */
  private async walk(): Promise<{ list: ObjectId[]; origin?: ObjectId; branchName?: string }> {
    const resolver = this.revisionResolver();
    const resolve = async (spec: string) => {
      const id = await resolver.resolve(spec, { type: "commit" } as never);
      if (!id)
        throw new FormatPatchError(
          `ambiguous argument '${spec}': unknown revision or path not in the working tree.`,
        );
      const peeled = (await resolver.peelToType(id, "commit")) ?? id;
      return peeled;
    };
    const positive: ObjectId[] = [];
    const negative: ObjectId[] = [];
    let singleName: string | undefined;
    for (const rev of this.revisions) {
      const dots = rev.indexOf("..");
      if (dots >= 0 && rev[dots + 2] !== ".") {
        const a = rev.slice(0, dots) || "HEAD";
        const b = rev.slice(dots + 2) || "HEAD";
        negative.push(await resolve(a));
        positive.push(await resolve(b));
      } else if (rev.startsWith("^")) negative.push(await resolve(rev.slice(1)));
      else {
        positive.push(await resolve(rev));
        singleName = rev;
      }
    }
    if (!positive.length && !negative.length) {
      positive.push(await resolve("HEAD"));
      singleName = "HEAD";
    }
    let branchName: string | undefined;
    if (this.revisions.length <= 1 && positive.length === 1 && negative.length === 0) {
      let checkHead = false;
      if (this.maxCount === undefined && !this.root) {
        negative.push(positive.pop() as ObjectId);
        positive.push(await resolve("HEAD"));
        checkHead = true;
      }
      if (singleName === "HEAD") checkHead = true;
      if (checkHead) {
        const branch = await this.getCurrentBranch();
        branchName = branch?.startsWith("refs/heads/") ? branch.slice(11) : "";
      }
    }
    const log = new LogCommand(this.workingCopy);
    for (const p of positive) log.add(p);
    for (const n of negative) log.not(n);
    const list: ObjectId[] = [];
    const listed = new Set<ObjectId>();
    const parentsOf = new Map<ObjectId, ObjectId[]>();
    for await (const c of await log.call()) {
      if (c.parents.length > 1) continue;
      if (this.maxCount !== undefined && list.length >= this.maxCount) break;
      list.push(c.id);
      listed.add(c.id);
      parentsOf.set(c.id, c.parents);
    }
    const boundary = new Set<ObjectId>();
    for (const id of list)
      for (const p of parentsOf.get(id) ?? []) if (!listed.has(p)) boundary.add(p);
    const origin = boundary.size === 1 ? [...boundary][0] : undefined;
    return {
      list,
      ...(origin ? { origin } : {}),
      ...(branchName !== undefined ? { branchName } : {}),
    };
  }

  /** `get_base_commit` + `prepare_bases`: the text `print_bases` writes once. */
  private async prepareBases(list: ObjectId[]): Promise<{ text: string }> {
    let spec = this.base;
    if (spec === undefined && (this.config("format.useAutoBase") ?? "").toLowerCase() === "true")
      spec = "auto";
    if (spec === undefined) return { text: "" };
    if (spec === "auto") {
      throw new FormatPatchError(
        "failed to get upstream, if you want to record base commit automatically,\nplease use git branch --set-upstream-to to track a remote branch.\nOr you could specify base commit by --base=<base-commit-id> manually",
      );
    }
    const resolver = this.revisionResolver();
    const base = await resolver.resolve(spec);
    if (!base) throw new FormatPatchError(`unknown commit ${spec}`);
    for (const id of list) {
      if (!(await this.commits.isAncestor(base, id)))
        throw new FormatPatchError("base commit should be the ancestor of revision list");
    }
    if (list.includes(base))
      throw new FormatPatchError("base commit shouldn't be in revision list");
    // the commits between the base and the series (topological, merges left out)
    const log = new LogCommand(this.workingCopy);
    for (const id of list) log.add(id);
    log.not(base);
    const inList = new Set(list);
    const ids: string[] = [];
    for await (const c of await log.call()) {
      if (c.parents.length > 1 || inList.has(c.id)) continue;
      // commit_patch_id: the diff against the parent with rename detection (diff.renames)
      const parent = c.parents[0];
      const diff = new DiffCommand(this.workingCopy).setNewTree(c.id).setRenames(true);
      if (parent) diff.setOldTree(parent);
      const changes: PatchIdChange[] = [];
      for (const e of await diff.call()) {
        const del = e.changeType === ChangeType.DELETE;
        const add = e.changeType === ChangeType.ADD;
        changes.push({
          path: (del ? e.oldPath : e.newPath) as string,
          ...(e.changeType === ChangeType.RENAME || e.changeType === ChangeType.COPY
            ? { oldPath: e.oldPath as string }
            : {}),
          ...(!add && e.oldId ? { old: { mode: e.oldMode as number, id: e.oldId } } : {}),
          ...(!del && e.newId ? { new: { mode: e.newMode as number, id: e.newId } } : {}),
        });
      }
      ids.push(
        changes.length
          ? await patchIdOfChanges(this.blobs, changes, { objectFormat: this.objectFormat })
          : this.objectFormat.nullId,
      );
    }
    let text = `\nbase-commit: ${base}\n`;
    for (let i = ids.length - 1; i >= 0; i--) text += `prerequisite-patch-id: ${ids[i]}\n`;
    return { text };
  }

  /** `make_cover_letter`. */
  private async coverLetterText(
    list: ObjectId[],
    origin: ObjectId | undefined,
    mail: {
      subject: string;
      thread: string;
      afterSubject: string;
      from?: { name: string; email: string };
      committer: PersonIdent;
      encodeHeaders: boolean;
      zeroCommit: boolean;
      /** get_log_output_encoding(): the shortlog's (the headers stay UTF-8) */
      outputEncoding: string;
    },
  ): Promise<Uint8Array> {
    const head = list[0] as ObjectId;
    const commits = await Promise.all(list.map((id) => this.commits.load(id)));
    // need_8bit_cte: any commit (headers included) with a byte above 0x7f
    let eightBit = false;
    for (const id of list) {
      const raw = await this.rawCommitBytes(id);
      if (raw.some((b) => b >= 0x80)) {
        eightBit = true;
        break;
      }
    }
    // git 2.54 and later: the --from ident (no date: the epoch); before, the committer's
    const fromIdent = gitVersionAtLeast(this.versionString, 2, 54) ? mail.from : undefined;
    const who = fromIdent ?? { name: mail.committer.name, email: mail.committer.email };
    const date = fromIdent
      ? { timestamp: 0, tzOffset: "+0000" }
      : { timestamp: mail.committer.timestamp, tzOffset: mail.committer.tzOffset };
    let text = `From ${mail.zeroCommit ? nullObjectIdLike(head) : head} Mon Sep 17 00:00:00 2001\n`;
    text += mail.thread;
    text += mailFromHeader(who.name, who.email, { encodeHeaders: mail.encodeHeaders });
    text += `Date: ${showDate(date.timestamp, date.tzOffset, { type: "rfc2822", local: false })}\n`;
    text += `${mail.subject}*** SUBJECT HERE ***\n`;
    if (eightBit)
      text +=
        "MIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n";
    text += mail.afterSubject;
    text += "\n*** BLURB HERE ***\n\n";
    const parts: Uint8Array[] = [new TextEncoder().encode(text)];
    text = "";
    // shortlog: authors in byte order, their subjects oldest first, wrapped at 72; each
    // commit's name and subject in the log output encoding (shortlog_add_commit), as
    // stored where they do not convert (logmsg_reencode)
    const byAuthor = new Map<string, string[]>();
    const encoderOf = new Map<string, (s: string) => Uint8Array>();
    for (const [k, c] of commits.entries()) {
      if (!c) continue;
      const utf8 = await this.utf8AuthorAndMessage(list[k] as ObjectId, c);
      const name = utf8.name;
      const encoder = outputEncoder(mail.outputEncoding, `${name}\n${utf8.message}`, utf8.stored);
      let subject = subjectLine(utf8.message);
      if (subject.startsWith("[PATCH")) {
        const eob = subject.indexOf("]");
        if (eob >= 0) subject = subject.slice(eob + 1).replace(/^[ \t]+/, "");
      }
      const listFor = byAuthor.get(name) ?? [];
      listFor.push(subject);
      byAuthor.set(name, listFor);
      encoderOf.set(`${name}\n${listFor.length - 1}`, encoder);
      if (!encoderOf.has(name)) encoderOf.set(name, encoder);
    }
    const names = [...byAuthor.keys()].sort(compareBytes);
    const utf8Encode = (x: string) => new TextEncoder().encode(x);
    for (const name of names) {
      const subjects = byAuthor.get(name) as string[];
      parts.push((encoderOf.get(name) ?? utf8Encode)(`${name} (${subjects.length}):\n`));
      for (let j = subjects.length; j >= 1; j--)
        parts.push(
          (encoderOf.get(`${name}\n${j - 1}`) ?? utf8Encode)(
            `${wrapText(subjects[j - 1] as string, 2, 4, MAIL_DEFAULT_WRAP)}\n`,
          ),
        );
      parts.push(utf8Encode("\n"));
    }
    if (origin) {
      const originTree = (await this.commits.load(origin))?.tree;
      const headTree = commits[0]?.tree;
      text += await this.treeDiffstat(originTree, headTree as string);
      text += "\n";
    }
    parts.push(new TextEncoder().encode(text));
    return concat(parts);
  }

  /** The commit as stored (its fields encoded again when the store has no raw bytes). */
  private async rawCommitBytes(id: ObjectId): Promise<Uint8Array> {
    const objects = this.workingCopy.history?.objects;
    try {
      const obj = await objects?.get(id);
      if (obj) {
        if (obj.bytes) return obj.bytes;
        const chunks: Uint8Array[] = [];
        for await (const c of obj.content) chunks.push(c);
        return concat(chunks);
      }
    } catch {
      // fall back to the parsed commit
    }
    const commit = await this.commits.load(id);
    return encodeGitPath(
      `author ${commit?.author.name ?? ""} <${commit?.author.email ?? ""}>\ncommitter ${commit?.committer.name ?? ""} <${commit?.committer.email ?? ""}>\n\n${commit?.message ?? ""}`,
    );
  }

  /**
   * The author name and message of a commit in UTF-8 (the cover letter's encoding): from its
   * `encoding` header when it has one (logmsg_reencode), as stored when that fails.
   */
  private async utf8AuthorAndMessage(
    id: ObjectId,
    commit: { author: { name: string }; message: string },
  ): Promise<{ name: string; message: string; stored: string }> {
    const raw = await this.rawCommitBytes(id);
    let end = 0;
    let encoding: string | undefined;
    let authorLine: Uint8Array | undefined;
    for (;;) {
      const nl = raw.indexOf(0x0a, end);
      if (nl < 0 || nl === end) break;
      const line = raw.subarray(end, nl);
      const text = decodeGitPath(line);
      if (text.startsWith("encoding ")) encoding = text.slice(9);
      if (text.startsWith("author ")) authorLine = line.subarray(7);
      end = nl + 1;
    }
    const stored = { name: commit.author.name, message: commit.message, stored: "UTF-8" };
    if (!encoding || /^utf-?8$/i.test(encoding)) return stored;
    const decode = (bytes: Uint8Array): string | undefined => {
      if (/^(iso[-_]?8859-1|latin-?1|l1)$/i.test(encoding as string)) {
        let out = "";
        for (const b of bytes) out += String.fromCharCode(b);
        return out;
      }
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        return undefined;
      }
    };
    const message = decode(raw.subarray(end + 1));
    const ident = authorLine ? decode(authorLine) : undefined;
    const name = ident?.replace(/ ?<[^>]*>.*$/s, "");
    if (message === undefined) return stored;
    return { name: name ?? stored.name, message, stored: encoding };
  }

  /** `--stat --summary` of two trees, as format-patch's cover letter shows them. */
  private async treeDiffstat(a: ObjectId | undefined, b: ObjectId): Promise<string> {
    const diff = new DiffCommand(this.workingCopy).setNewTree(b).setOptions({
      stat: { width: MAIL_DEFAULT_WRAP },
      uiConfig: false,
    });
    if (a) diff.setOldTree(a);
    const r = await diff.callFormats(["stat", "summary"]);
    return r.bytes ? decodeGitPath(r.bytes) : "";
  }
}

/** git_parse_maybe_bool: undefined (git's -1) for a value that is not a boolean. */
function maybeBool(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (v === "" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off") return false;
  // git_parse_int: an integer with an optional k/m/g unit
  const m = /^\s*[+-]?(0x[0-9a-f]+|\d+)[kmg]?$/i.exec(value);
  if (m) return Number(m[1]) !== 0;
  return undefined;
}

const LATIN1_NAME = /^(iso[-_]?8859-1|iso8859-1|latin-?1|l1|iso-ir-100|cp819|ibm819|csisolatin1)$/i;

const latin1Bytes = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * How a commit's text is written in the log output encoding: UTF-8 or ISO-8859-1 (when
 * every character converts); otherwise in the encoding the commit is stored in, as git
 * keeps a message iconv cannot convert.
 */
function outputEncoder(output: string, text: string, stored: string): (s: string) => Uint8Array {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const encoderFor = (charset: string) =>
    /^utf-?8$/i.test(charset)
      ? utf8
      : LATIN1_NAME.test(charset) && [...text].every((ch) => (ch.codePointAt(0) ?? 0) <= 0xff)
        ? latin1Bytes
        : undefined;
  return encoderFor(output) ?? encoderFor(stored) ?? utf8;
}

function subjectLine(message: string): string {
  const lines = message.split("\n");
  let at = 0;
  while (at < lines.length && (lines[at] as string).trim() === "") at++;
  const parts: string[] = [];
  for (; at < lines.length && (lines[at] as string).trim() !== ""; at++)
    parts.push((lines[at] as string).trim());
  return parts.join(" ");
}

function compareBytes(a: string, b: string): number {
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

/** `clean_message_id`: the id without its angle brackets and surrounding blanks. */
function cleanMessageId(id: string): string {
  let a = 0;
  let z = id.length;
  while (a < z && (/\s/.test(id[a] as string) || id[a] === "<")) a++;
  while (a < z && (/\s/.test(id[z - 1] as string) || id[z - 1] === ">")) z--;
  return id.slice(a, z);
}

function latin(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
