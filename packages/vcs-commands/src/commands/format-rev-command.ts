/**
 * `git format-rev` (builtin/name-rev.c's cmd_format_rev, git 2.56+, experimental): each
 * commit read from stdin, or each full object id in running text, replaced by a pretty format
 * of the commit.
 *
 * ```typescript
 * const { stdout } = await git
 *   .formatRev()
 *   .setStdinMode("revs")
 *   .setFormat("%s")
 *   .setInput("HEAD\nHEAD~1\n")
 *   .callOutput();
 * ```
 *
 * The formats are git's: user formats (`format:`, `tformat:`, a text with `%`, a `pretty.<name>`
 * alias) and the builtin ones (`reference`, `oneline`, `medium`, `short`, `full`, `fuller`,
 * `raw`, `email`, `mboxrd`), the latter as pretty.c's `pretty_print_commit` prints them: no
 * `commit <id>` line (log-tree's), no notes, tabs kept, a mail's subject without `[PATCH]`.
 * Each commit is formatted by `git log`'s pretty engine with no configuration of its own:
 * `log.*` settings do not apply, as format-rev starts from a fresh `rev_info`.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { RemoteConfigStore } from "../remote-config/index.js";
import { LogCommand } from "./log-command.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

/** `--stdin-mode`: lines of revisions, or running text holding object ids. */
export type FormatRevStdinMode = "text" | "revs";

/** A format as get_commit_format reads it: a user format, or a builtin `CMIT_FMT_*` one. */
type Pretty = { format: string; date?: string; builtin?: never } | { builtin: string };

/** A builtin format git's get_commit_format knows, with its default date mode. */
const BUILTIN_USER_FORMATS: Record<string, { format: string; date?: string }> = {
  reference: { format: "%C(auto)%h (%s, %ad)", date: "short" },
};
const BUILTIN_OTHER = new Set([
  "raw",
  "medium",
  "short",
  "email",
  "mboxrd",
  "fuller",
  "full",
  "oneline",
]);

export class FormatRevCommand extends PlumbingCommand {
  private format?: string;
  private stdinMode?: string;
  private notes: string[] = [];
  private nulInput = false;
  private nulOutput = false;
  private input: Uint8Array = new Uint8Array(0);

  /** `--format=<pretty>` (required) */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** `--stdin-mode=<mode>` (required): `text`, `revs` or `rev` */
  setStdinMode(mode: string): this {
    this.checkCallable();
    this.stdinMode = mode;
    return this;
  }

  /** `--notes=<ref>`: a notes ref (or glob) `%N` shows; repeatable */
  addNotes(ref: string): this {
    this.checkCallable();
    this.notes.push(ref);
    return this;
  }

  /** `--no-notes`: forget the `--notes` given so far */
  clearNotes(): this {
    this.checkCallable();
    this.notes = [];
    return this;
  }

  /** `-z`: NUL-terminated input and output */
  setNul(): this {
    this.checkCallable();
    this.nulInput = true;
    this.nulOutput = true;
    return this;
  }

  /** `--[no-]null-input` */
  setNullInput(nul: boolean): this {
    this.checkCallable();
    this.nulInput = nul;
    return this;
  }

  /** `--[no-]null-output` */
  setNullOutput(nul: boolean): this {
    this.checkCallable();
    this.nulOutput = nul;
    return this;
  }

  /** stdin */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? encodeGitPath(input) : input;
    return this;
  }

  protected async run(): Promise<number> {
    if (this.format === undefined) throw new PlumbingError("fatal: '--format' is required");
    if (this.stdinMode === undefined) throw new PlumbingError("fatal: '--stdin-mode' is required");
    const mode = this.stdinMode;
    if (mode !== "text" && mode !== "revs" && mode !== "rev")
      throw new PlumbingError("fatal: '--stdin-mode' needs to be either text, revs, or rev");
    const pretty = this.prettyOf(this.format);
    const terminator = this.nulOutput ? "\0" : "\n";
    const lines = this.lines();
    const hexLength = this.objectFormat.hexLength;
    const formatted = new Map<ObjectId, string | undefined>();
    const formatCommit = async (id: ObjectId): Promise<string | undefined> => {
      if (formatted.has(id)) return formatted.get(id);
      const text = await this.formatOne(id, pretty);
      formatted.set(id, text);
      return text;
    };

    if (mode === "text") {
      const hex = new RegExp(`(?<![0-9a-f])[0-9a-f]{${hexLength}}(?![0-9a-f])`, "g");
      for (const line of lines) {
        let out = "";
        let last = 0;
        for (const m of line.matchAll(hex)) {
          const at = m.index ?? 0;
          const id = m[0];
          const type = await this.typeOf(id);
          const text = type === "commit" ? await formatCommit(id) : undefined;
          out += line.slice(last, at) + (text ?? id);
          last = at + id.length;
        }
        out += line.slice(last);
        await this.write(`${out}${terminator}`);
      }
      return 0;
    }

    for (const line of lines) {
      let id: ObjectId | undefined;
      if (line.length === hexLength && /^[0-9a-fA-F]+$/.test(line)) id = line.toLowerCase();
      else {
        try {
          id = await this.revisionResolver().resolve(line);
        } catch {
          id = undefined;
        }
      }
      if (!id) {
        this.warnRaw(`Could not get object name for ${line}. Skipping.\n`);
        continue;
      }
      let type = await this.typeOf(id);
      if (!type) {
        this.warnRaw(`Could not get object for ${line}. Skipping.\n`);
        continue;
      }
      let peeled: ObjectId | undefined = id;
      while (type === "tag" && peeled) {
        peeled = await this.tagTarget(peeled);
        type = peeled ? await this.typeOf(peeled) : undefined;
      }
      if (!peeled || type !== "commit") {
        this.warnRaw(`Could not get commit for ${line}. Skipping.\n`);
        continue;
      }
      await this.write(`${(await formatCommit(peeled)) ?? ""}${terminator}`);
    }
    return 0;
  }

  /** stderr as given (git's fprintf, not an `error:` line) */
  private warnRaw(text: string): void {
    this.warn(text.replace(/\n$/, ""));
  }

  /** stdin split as strbuf_getline_lf / strbuf_getline_nul: a last line without terminator kept */
  private lines(): string[] {
    const text = decodeGitPath(this.input);
    if (!text) return [];
    const parts = text.split(this.nulInput ? "\0" : "\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  /** get_commit_format: the user format and its date mode. */
  private prettyOf(format: string, depth = 0): Pretty {
    if (format.startsWith("format:")) return { format: format.slice(7) };
    if (format.startsWith("tformat:")) return { format: format.slice(8) };
    if (format.includes("%")) return { format };
    const builtin = BUILTIN_USER_FORMATS[format];
    if (builtin) return builtin;
    if (!BUILTIN_OTHER.has(format) && depth < 10) {
      const alias = RemoteConfigStore.from(this.workingCopy).value(`pretty.${format}`);
      if (alias !== undefined) return this.prettyOf(alias, depth + 1);
    }
    if (BUILTIN_OTHER.has(format)) return { builtin: format };
    throw new PlumbingError(`fatal: invalid --pretty format: ${format}`);
  }

  /** pretty_print_commit of one commit (with its notes when the format shows `%N`). */
  private async formatOne(id: ObjectId, pretty: Pretty): Promise<string | undefined> {
    const log = new LogCommand(this.workingCopy).setNoWalk([{ id }]).setLogConfig(false);
    try {
      if (pretty.builtin !== undefined) {
        // pretty_print_commit with format-rev's context: fmt_output_email_subject of a
        // rev_info without a subject prefix, encode_email_headers off, no mailmap, and the
        // default date mode of a fresh rev_info (`log.date` is never read)
        return decodeGitPath(
          await log.callBytes({
            pretty: pretty.builtin,
            prettyOnly: true,
            notes: false,
            mailmap: false,
            date: "default",
            mail: { subject: () => "Subject: ", encodeHeaders: false },
          }),
        );
      }
      const wantsNotes = /%N/.test(pretty.format);
      return decodeGitPath(
        await log.callBytes({
          pretty: `format:${pretty.format}`,
          ...(pretty.date ? { date: pretty.date } : {}),
          ...(!wantsNotes
            ? { notes: false }
            : this.notes.length > 0
              ? { notesRefs: [...this.notes] }
              : { notes: true }),
        }),
      );
    } catch {
      return undefined;
    }
  }

  private async typeOf(id: ObjectId): Promise<string | undefined> {
    const objects = this.workingCopy.history.objects;
    if (!objects) return undefined;
    try {
      return (await objects.header?.(id))?.type ?? (await objects.get(id))?.type;
    } catch {
      return undefined;
    }
  }

  private async tagTarget(id: ObjectId): Promise<ObjectId | undefined> {
    try {
      return (await this.workingCopy.history.tags.load(id))?.object;
    } catch {
      return undefined;
    }
  }
}
