/**
 * `git format-patch`: each commit of a range as an email (`From <id> Mon Sep 17 00:00:00
 * 2001`, `From:`, `Date:`, `Subject: [PATCH n/m] ...`, the message, `---`, the diffstat,
 * the summary, the patch with binary hunks, the `-- ` signature), as git writes them byte
 * for byte: numbered subjects, cover letters with the shortlog and diffstat, threading
 * headers, `--base` prerequisite patch ids, signoffs through the trailers engine, MIME
 * attachments (`--attach`/`--inline`), notes after the `---` line, cover letters from the
 * branch description, `--ignore-if-in-upstream` and the `format.*` settings.
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { nullObjectIdLike } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { ChangeType } from "../results/diff-entry.js";
import { showDate } from "./date-format.js";
import { DiffCommand } from "./diff-command.js";
import { LogCommand } from "./log-command.js";
import { mailFromHeader, mailSubjectLine } from "./log-output.js";
import { configValue } from "./merge-config.js";
import { type PatchIdChange, patchIdOfChanges } from "./patch-id.js";
import { sanitizedSubject } from "./pretty-format.js";
import { commitSubject, outputEncoderFor, Shortlog } from "./shortlog.js";
import { trailerConfigOf } from "./trailers.js";

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

/** `--cover-from-description` modes (`default` is `message`). */
export type CoverFromDescription = "default" | "none" | "message" | "subject" | "auto";

/** diff.c's mime_boundary_leader */
const MIME_BOUNDARY_LEADER = "------------";

/** builtin/log.c's COVER_FROM_AUTO_MAX_SUBJECT_LEN */
const COVER_FROM_AUTO_MAX_SUBJECT_LEN = 100;

/** parse_cover_from_description: dies on an unknown mode. */
function coverFromDescriptionMode(
  value: string | undefined,
): "none" | "message" | "subject" | "auto" {
  if (value === undefined || value === "default" || value === "message") return "message";
  if (value === "none" || value === "subject" || value === "auto") return value;
  throw new FormatPatchError(`${value}: invalid cover from description mode`);
}

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
  /** `--attach`/`--inline`/`--no-attach`: the boundary (true: the version string, null: none) */
  private attach?: { boundary: string | true | null; inline: boolean };
  private notesOptions: (boolean | string)[] = [];
  private coverFromDescription?: string;
  private ignoreIfInUpstream = false;

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

  /**
   * `--attach[=<boundary>]` (true: git's version string as the boundary) / `--no-attach`
   * (false): each patch a MIME attachment (`Content-Disposition: attachment`) after the
   * message and the diffstat. Default `format.attach`.
   */
  setAttach(value: string | boolean): this {
    this.attach = { boundary: value === false ? null : value, inline: false };
    return this;
  }

  /**
   * `--inline[=<boundary>]` (true: git's version string): as {@link setAttach}, the part
   * marked `Content-Disposition: inline` (`--no-attach` turns either off).
   */
  setInline(value: string | true): this {
    this.attach = { boundary: value, inline: true };
    return this;
  }

  /**
   * `--notes` (true), `--notes=<ref>` (a ref, `x` is `refs/notes/x`), `--no-notes` (false):
   * each call is one option, applied in order after `format.notes`. The notes go after the
   * `---` line.
   */
  setNotes(value: boolean | string): this {
    this.notesOptions.push(value);
    return this;
  }

  /**
   * `--cover-from-description=<mode>`: how the cover letter uses `branch.<name>.description`
   * (default `format.coverFromDescription`, else `message`).
   */
  setCoverFromDescription(mode: CoverFromDescription | (string & {})): this {
    this.coverFromDescription = mode;
    return this;
  }

  /** `--ignore-if-in-upstream`: leave out the patches the upstream side has (patch ids). */
  setIgnoreIfInUpstream(value: boolean): this {
    this.ignoreIfInUpstream = value;
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

  /** Every value of a variable in order, `text` undefined for one without `=`. */
  private configWhere(key: string): { text: string | undefined }[] {
    return RemoteConfigStore.from(this.workingCopy).valuesWithOrigin(key);
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

    // format.attach: a boundary, an empty value none, no value the version string; then
    // --attach/--inline/--no-attach
    let mime: { boundary: string; inline: boolean } | undefined;
    const attachCfg = this.configWhere("format.attach").at(-1);
    if (attachCfg) {
      if (attachCfg.text === undefined) mime = { boundary: this.versionString, inline: false };
      else if (attachCfg.text !== "") mime = { boundary: attachCfg.text, inline: false };
      else mime = undefined;
    }
    if (this.attach) {
      const b = this.attach.boundary;
      mime =
        b === null
          ? undefined
          : { boundary: b === true ? this.versionString : b, inline: this.attach.inline };
    }
    // format.notes, then --notes/--notes=<ref>/--no-notes (display_notes_opt)
    const notes = { show: false, useDefault: false, refs: [] as string[] };
    const notesOption = (value: boolean | string) => {
      if (value === true) {
        notes.useDefault = true;
        notes.show = true;
      } else if (value === false) {
        notes.useDefault = false;
        notes.refs = [];
        notes.show = false;
      } else {
        notes.refs.push(value);
        notes.show = true;
      }
    };
    for (const where of this.configWhere("format.notes")) {
      const b = where.text === undefined ? true : maybeBool(where.text);
      notesOption(b === undefined ? (where.text as string) : b);
    }
    for (const value of this.notesOptions) notesOption(value);
    // format.coverFromDescription, then --cover-from-description (dies on a bad mode)
    let coverMode = coverFromDescriptionMode(undefined);
    const cfgCoverMode = this.config("format.coverFromDescription");
    if (cfgCoverMode !== undefined) coverMode = coverFromDescriptionMode(cfgCoverMode);
    if (this.coverFromDescription !== undefined)
      coverMode = coverFromDescriptionMode(this.coverFromDescription);

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
    const { list, origin, branchName } = await this.walk();
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
    const fileName = (subject: string | undefined, inDir = true) => {
      let name = outDir && inDir ? (outDir.endsWith("/") ? outDir : `${outDir}/`) : "";
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
        coverMode,
        ...(branchName !== undefined ? { branchName } : {}),
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
      // log_write_email_headers: a multipart mail, the patch in a part of its own
      let afterSubject = extraHeaders;
      let statSep: string | undefined;
      if (mime) {
        const boundary = `${MIME_BOUNDARY_LEADER}${mime.boundary}`;
        const part = fileName(subject, false);
        afterSubject +=
          `MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="${boundary}"\n\n` +
          `This is a multi-part message in MIME format.\n--${boundary}\n` +
          "Content-Type: text/plain; charset=UTF-8; format=fixed\nContent-Transfer-Encoding: 8bit\n\n";
        statSep =
          `\n--${boundary}\nContent-Type: text/x-patch; name="${part}"\n` +
          "Content-Transfer-Encoding: 8bit\n" +
          `Content-Disposition: ${mime.inline ? "inline" : "attachment"}; filename="${part}"\n\n`;
      }
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
          ...(statSep !== undefined ? { statSep } : {}),
        });
      const bytes = await log.callBytes({
        pretty: this.stdout && bool(this.config("format.mboxrd")) ? "mboxrd" : "email",
        stat: !this.noStat,
        summary: !this.noStat,
        patch: true,
        showRoot: true,
        mailmap: false,
        // load_display_notes: the default refs unless only --notes=<ref> ones were asked for
        ...(!notes.show
          ? { notes: false }
          : notes.useDefault || notes.refs.length === 0
            ? { notes: true, notesRefs: notes.refs }
            : { notesRefs: notes.refs }),
        abbrevCommit: false,
        decorate: false,
        mail: {
          subject: subjectOf,
          threadHeaders,
          afterSubject,
          zeroCommit: this.zeroCommit,
          preserveSubject: this.keepSubject,
          ...(sob ? { signoff: sob, trailerConfig: trailerConfigOf(this.workingCopy) } : {}),
          ...(mime ? { multipart: true } : {}),
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
      parts.push(
        bytes,
        latin(bases.text),
        latin(mime ? `\n--${MIME_BOUNDARY_LEADER}${mime.boundary}--\n\n\n` : sig()),
      );
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
    /** The object a name gives (a tag as itself) and the commit it peels to */
    const resolve = async (spec: string) => {
      const id = await resolver.resolve(spec, { type: "commit" } as never);
      if (!id)
        throw new FormatPatchError(
          `ambiguous argument '${spec}': unknown revision or path not in the working tree.`,
        );
      const peeled = (await resolver.peelToType(id, "commit")) ?? id;
      return { id, peeled };
    };
    const positive: ObjectId[] = [];
    const negative: ObjectId[] = [];
    /** rev->cmdline's interesting entries: the name as given and its object */
    const interesting: { name: string; id: ObjectId }[] = [];
    let singleName: string | undefined;
    for (const rev of this.revisions) {
      const dots = rev.indexOf("..");
      if (dots >= 0 && rev[dots + 2] !== ".") {
        const a = rev.slice(0, dots) || "HEAD";
        const b = rev.slice(dots + 2) || "HEAD";
        negative.push((await resolve(a)).peeled);
        const tip = await resolve(b);
        positive.push(tip.peeled);
        interesting.push({ name: b, id: tip.id });
      } else if (rev.startsWith("^")) negative.push((await resolve(rev.slice(1))).peeled);
      else {
        const tip = await resolve(rev);
        positive.push(tip.peeled);
        interesting.push({ name: rev, id: tip.id });
        singleName = rev;
      }
    }
    if (!positive.length && !negative.length) {
      const head = await resolve("HEAD");
      positive.push(head.peeled);
      interesting.push({ name: "HEAD", id: head.id });
      singleName = "HEAD";
    }
    let branchName: string | undefined;
    if (this.revisions.length <= 1 && positive.length === 1 && negative.length === 0) {
      let checkHead = false;
      if (this.maxCount === undefined && !this.root) {
        negative.push(positive.pop() as ObjectId);
        positive.push((await resolve("HEAD")).peeled);
        checkHead = true;
      }
      if (singleName === "HEAD") checkHead = true;
      if (checkHead) {
        const branch = await this.getCurrentBranch();
        branchName = branch?.startsWith("refs/heads/") ? branch.slice(11) : "";
      }
    }
    // find_branch_name: the one interesting revision, when it names a branch at its tip
    if (branchName === undefined && interesting.length === 1) {
      const only = interesting[0] as { name: string; id: ObjectId };
      const found = (await resolver.dwimRef(only.name).catch(() => []))[0];
      if (found?.ref.startsWith("refs/heads/") && found.id === only.id)
        branchName = found.ref.slice(11);
    }
    // --ignore-if-in-upstream: the patch ids of the upstream side (get_patch_ids)
    let upstream: Set<string> | undefined;
    if (this.ignoreIfInUpstream) {
      const pending = [
        ...negative.map((id) => ({ id, uninteresting: true })),
        ...positive.map((id) => ({ id, uninteresting: false })),
      ];
      // nothing to say when head and upstream are the same
      if (pending.length === 2 && pending[0]?.id === pending[1]?.id) return { list: [] };
      if (pending.length !== 2) throw new FormatPatchError("need exactly one range");
      if (pending[0]?.uninteresting === pending[1]?.uninteresting)
        throw new FormatPatchError("not a range");
      upstream = new Set();
      const check = new LogCommand(this.workingCopy);
      check.add(negative[0] as ObjectId);
      check.not(positive[0] as ObjectId);
      for await (const c of await check.call()) {
        if (c.parents.length > 1) continue;
        upstream.add(await this.commitPatchId(c.id, c.parents[0], false));
      }
    }
    const log = new LogCommand(this.workingCopy);
    for (const p of positive) log.add(p);
    for (const n of negative) log.not(n);
    const list: ObjectId[] = [];
    const walked = new Set<ObjectId>();
    const parentsOf = new Map<ObjectId, ObjectId[]>();
    for await (const c of await log.call()) {
      if (c.parents.length > 1) continue;
      if (this.maxCount !== undefined && walked.size >= this.maxCount) break;
      walked.add(c.id);
      parentsOf.set(c.id, c.parents);
      if (upstream?.size && upstream.has(await this.commitPatchId(c.id, c.parents[0], false)))
        continue;
      list.push(c.id);
    }
    // the walk's boundary (commits left out as already upstream still walked)
    const boundary = new Set<ObjectId>();
    for (const id of walked)
      for (const p of parentsOf.get(id) ?? []) if (!walked.has(p)) boundary.add(p);
    const origin = boundary.size === 1 ? [...boundary][0] : undefined;
    return {
      list,
      ...(origin ? { origin } : {}),
      ...(branchName !== undefined ? { branchName } : {}),
    };
  }

  /**
   * commit_patch_id: the patch id of a commit's diff against its parent (the empty tree for
   * a root), rename detection as asked; the null id for an empty diff.
   */
  private async commitPatchId(
    id: ObjectId,
    parent: ObjectId | undefined,
    renames: boolean,
  ): Promise<string> {
    const diff = new DiffCommand(this.workingCopy).setNewTree(id).setRenames(renames);
    if (parent) diff.setOldTree(parent);
    else diff.setOldTree(this.objectFormat.emptyTreeId);
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
    return changes.length
      ? await patchIdOfChanges(this.blobs, changes, { objectFormat: this.objectFormat })
      : this.objectFormat.nullId;
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
      ids.push(await this.commitPatchId(c.id, c.parents[0], true));
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
      /** How the branch description is used (`--cover-from-description`) */
      coverMode: "none" | "message" | "subject" | "auto";
      /** The branch whose `branch.<name>.description` is read ("" for none) */
      branchName?: string;
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
    // git before 2.44 left the cover letter's headers unencoded (pp.encode_email_headers unset)
    const encodeHeaders = mail.encodeHeaders && gitVersionAtLeast(this.versionString, 2, 44);
    text += mailFromHeader(who.name, who.email, { encodeHeaders });
    text += `Date: ${showDate(date.timestamp, date.tzOffset, { type: "rfc2822", local: false })}\n`;
    // prepare_cover_text
    let subject = "*** SUBJECT HERE ***";
    let body = "*** BLURB HERE ***";
    const description =
      mail.coverMode !== "none" && mail.branchName
        ? this.config(`branch.${mail.branchName}.description`)
        : undefined;
    if (description) {
      let firstParagraph: { subject: string; rest: string } | undefined;
      if (mail.coverMode === "subject" || mail.coverMode === "auto") {
        firstParagraph = formatSubject(description);
        body = firstParagraph.rest;
      }
      if (
        mail.coverMode === "message" ||
        (mail.coverMode === "auto" &&
          encodeGitPath(firstParagraph?.subject ?? "").length > COVER_FROM_AUTO_MAX_SUBJECT_LEN)
      )
        body = description;
      else subject = firstParagraph?.subject ?? subject;
    }
    // pp_email_subject: the title as format_subject joins it
    text += mailSubjectLine(mail.subject, formatSubject(subject).subject, {
      encodeHeaders,
    });
    if (eightBit)
      text +=
        "MIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n";
    text += mail.afterSubject;
    text += "\n";
    // pp_remainder: leading blank lines dropped, each line without its trailing blanks
    let first = true;
    for (const line of linesWithEnds(body)) {
      const trimmed = line.replace(/[ \t\n\v\f\r]+$/, "");
      if (trimmed === "" && first) continue;
      first = false;
      text += `${trimmed}\n`;
    }
    text += "\n";
    const parts: Uint8Array[] = [new TextEncoder().encode(text)];
    text = "";
    // generate_shortlog_cover_letter: authors (%aN, through the mailmap) in byte order, their
    // subjects oldest first, wrapped at 72; each commit's name and subject in the log output
    // encoding (shortlog_add_commit), as stored where they do not convert (logmsg_reencode)
    const mailmap = await this.readMailmap();
    const shortlog = new Shortlog<(s: string) => Uint8Array>({
      wrap: { width: MAIL_DEFAULT_WRAP, indent1: 2, indent2: 4 },
    });
    for (const [k, c] of commits.entries()) {
      if (!c) continue;
      const utf8 = await this.utf8AuthorAndMessage(list[k] as ObjectId, c);
      const name = mailmap.map(utf8.name, c.author.email).name;
      const encoder = outputEncoderFor(
        mail.outputEncoding,
        `${name}\n${utf8.message}`,
        utf8.stored,
      );
      // shortlog_add_commit: `<none>` for an empty subject
      shortlog.insert(name, commitSubject(utf8.message) || "<none>", encoder);
    }
    const utf8Encode = (x: string) => new TextEncoder().encode(x);
    for (const piece of shortlog.pieces()) parts.push((piece.tag ?? utf8Encode)(piece.text));
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

/**
 * pretty.c's format_subject: the first paragraph's lines (each without its trailing
 * blanks; a blank line, the first one too, ends it) joined by a space, and what follows
 * the blank line that ends it.
 */
function formatSubject(text: string): { subject: string; rest: string } {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(at, end).replace(/[ \t\n\v\f\r]+$/, "");
    at = end;
    if (line === "") break;
    parts.push(line);
  }
  return { subject: parts.join(" "), rest: text.slice(at) };
}

/** The lines of a text, each with its LF (get_one_line) */
function linesWithEnds(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
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
