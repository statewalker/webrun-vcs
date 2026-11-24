/**
 * `git check-mailmap` (builtin/check-mailmap.c): each contact as the repository's mailmap
 * maps it (`.mailmap`, `mailmap.blob`, `mailmap.file`, plus `--mailmap-blob` and
 * `--mailmap-file`).
 *
 * @example
 * ```typescript
 * // git check-mailmap "nick1 <bugs@company.xx>"
 * await git.checkMailmap().addContact("nick1 <bugs@company.xx>").call();
 * // "Some Dude <some@dude.xx>\n"
 * ```
 */

import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { type Mailmap, readMailmapBlob, readMailmapFile } from "./mailmap.js";
import { inputLines, splitIdent } from "./shortlog.js";

/**
 * The contacts of `git check-mailmap <contact>...` (and `--stdin`'s lines after them), one
 * output line each: `Name <email>`, or `<email>` when the result has no name.
 *
 * git 2.43 (`setCompatibility("2.43")`) takes only `Name <email>` contacts (`fatal: unable
 * to parse contact: <contact>`) and has no `--mailmap-file`/`--mailmap-blob`; 2.47 and later
 * also map a bare address. Where git dies, the error carries what was printed before
 * ({@link getOutput}).
 */
export class CheckMailmapCommand extends GitCommand<string> {
  private readonly contacts: string[] = [];
  private stdin?: string;
  private mailmapFile?: string;
  private mailmapBlob?: string;
  private compatibility: "2.43" | "2.56" = "2.56";
  private output = "";
  private readonly errors: string[] = [];

  /** A contact argument. */
  addContact(contact: string): this {
    this.checkCallable();
    this.contacts.push(contact);
    return this;
  }

  /** `--stdin`: these lines (git's stdin) checked after the arguments. */
  setStdin(text: string): this {
    this.checkCallable();
    this.stdin = text;
    return this;
  }

  /** `--mailmap-file=<file>` (git 2.47+): more entries from this host file. */
  setMailmapFile(path: string): this {
    this.checkCallable();
    this.mailmapFile = path;
    return this;
  }

  /** `--mailmap-blob=<blob>` (git 2.47+): more entries from this blob. */
  setMailmapBlob(name: string): this {
    this.checkCallable();
    this.mailmapBlob = name;
    return this;
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** What was printed on stdout (also after a death). */
  getOutput(): string {
    return this.output;
  }

  /** git's `error:` lines (a mailmap blob that is no blob). */
  getErrors(): string[] {
    return [...this.errors];
  }

  /** The output. */
  async call(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const legacy = this.compatibility === "2.43";
    if (legacy && (this.mailmapFile !== undefined || this.mailmapBlob !== undefined)) {
      const option = this.mailmapFile !== undefined ? "mailmap-file" : "mailmap-blob";
      throw new GitApiError(
        `error: unknown option \`${option}'\nusage: git check-mailmap [<options>] <contact>...`,
      );
    }
    if (this.contacts.length === 0 && this.stdin === undefined)
      throw new GitApiError("fatal: no contacts specified");
    const onError = (line: string) => this.errors.push(line);
    const mailmap = await this.readMailmap(onError);
    if (this.mailmapBlob !== undefined) {
      const bytes = await readMailmapBlob(
        { readObjectNamed: (name) => this.readObjectNamed(name), onError },
        this.mailmapBlob,
      );
      if (bytes) mailmap.read(decodeGitPath(bytes));
    }
    if (this.mailmapFile !== undefined) {
      const bytes = await readMailmapFile(
        this.mailmapFile,
        hostEnvironmentOf(this._workingCopy),
        this.worktreeAccess,
      );
      if (bytes) mailmap.read(decodeGitPath(bytes));
    }
    for (const contact of this.contacts) this.check(mailmap, contact, legacy);
    if (this.stdin !== undefined)
      for (const line of inputLines(this.stdin)) this.check(mailmap, line, legacy);
    return this.output;
  }

  private check(mailmap: Mailmap, contact: string, legacy: boolean): void {
    let ident = splitIdent(contact);
    if (!ident) {
      if (legacy) throw new GitApiError(`fatal: unable to parse contact: ${contact}`);
      ident = { name: "", email: contact };
    }
    const mapped = mailmap.map(ident.name, ident.email);
    this.output += `${mapped.name ? `${mapped.name} ` : ""}<${mapped.email}>\n`;
  }
}
