import type { ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitCommand } from "../git-command.js";
import { commentPrefixOf, stripspace } from "./message-cleanup.js";
import {
  commitNotes,
  copyNoteForRewrite,
  defaultNotesRef,
  expandNotesRef,
  finishCopyNotesForRewrite,
  initCopyNotesForRewrite,
  initNotes,
  type NotesContext,
  NotesError,
  type NotesHandle,
} from "./notes-support.js";
import { combineNotesOverwrite, readNoteBytes } from "./notes-tree.js";

/**
 * What a `git notes` subcommand printed and how it ended: `output` is its standard output,
 * `errors` its standard error (git's `error: ` lines and notices such as `Removing note for
 * object <id>`), `exitCode` its exit status (1 after an `error:`). Where git dies, the
 * commands throw {@link NotesError} with git's `fatal:` message.
 */
export interface NotesResult {
  exitCode: number;
  output: string;
  errors: string;
}

/**
 * The message editor of `git notes add`/`append`/`edit` (git's `core.editor`): given the
 * template git writes to `NOTES_EDITMSG`, it returns the edited text. Without one the text
 * stays as it is, as with `GIT_EDITOR=:`. A throw is git's failed editor.
 */
export type NotesEditor = (text: string) => string | Promise<string>;

const NOTE_TEMPLATE = "Write/edit the notes for the following object:";

const STRIPSPACE_UNSPECIFIED = -1;
const NO_STRIPSPACE = 0;
const STRIPSPACE = 1;

/** The notes of `git notes` (`--ref`, `GIT_NOTES_REF`, `core.notesRef`) for each subcommand. */
export abstract class NotesSubcommand<T> extends GitCommand<T> {
  protected refOverride?: string;

  /** `git notes --ref=<ref>`: the notes ref used (expanded as git expands it, `x` is `refs/notes/x`). */
  setNotesRef(ref: string): this {
    this.checkCallable();
    this.refOverride = expandNotesRef(ref);
    return this;
  }

  /** The notes ref used: `--ref`, `GIT_NOTES_REF`, `core.notesRef`, `refs/notes/commits`. */
  protected notesRef(): string {
    return defaultNotesRef(this.workingCopy, this.refOverride);
  }

  protected get ctx(): NotesContext {
    return this.notesContext();
  }

  /** builtin/notes.c's init_notes_check: the notes tree, refused outside of refs/notes/. */
  protected async initCheck(subcommand: string, writable: boolean): Promise<NotesHandle> {
    const ref = this.notesRef();
    const t = await initNotes(this.ctx, ref, { writable });
    if (!ref.startsWith("refs/notes/")) {
      throw new NotesError(`refusing to ${subcommand} notes in ${ref} (outside of refs/notes/)`);
    }
    return t;
  }

  /** repo_get_oid, or git's `failed to resolve '<name>' as a valid ref.` */
  protected async resolveObject(name: string): Promise<ObjectId> {
    const id = await this.ctx.resolve(name);
    if (!id) throw new NotesError(`failed to resolve '${name}' as a valid ref.`);
    return id;
  }

  protected async readNoteText(id: ObjectId): Promise<string | undefined> {
    const bytes = await readNoteBytes(this.blobs, id);
    return bytes ? decodeGitPath(bytes) : undefined;
  }
}

/** `git notes list [<object>]`. */
export interface NotesListResult extends NotesResult {
  /** The notes listed: the annotated object and its note blob, in id order */
  notes: { object: ObjectId; note: ObjectId }[];
}

/**
 * `git notes list [<object>]`: every note as `<note> <object>` lines (in object id order),
 * or the note blob of one object (`error: no note found for object <id>.` when it has none).
 *
 * @example
 * ```typescript
 * const { output } = await git.notes().list().call(); // "<note> <commit>\n..."
 * ```
 */
export class NotesListCommand extends NotesSubcommand<NotesListResult> {
  private object?: string;

  /** The object whose note is shown (default: every note listed). */
  setObject(name: string): this {
    this.checkCallable();
    this.object = name;
    return this;
  }

  async call(): Promise<NotesListResult> {
    this.checkCallable();
    this.setCallable(false);
    const t = await this.initCheck("list", false);
    if (this.object !== undefined) {
      const object = await this.resolveObject(this.object);
      const note = await t.tree.get(object);
      if (note) return { exitCode: 0, output: `${note}\n`, errors: "", notes: [{ object, note }] };
      return {
        exitCode: 1,
        output: "",
        errors: `error: no note found for object ${object}.\n`,
        notes: [],
      };
    }
    const notes: { object: ObjectId; note: ObjectId }[] = [];
    await t.tree.forEach(0, async (object, note) => {
      notes.push({ object, note });
      return false;
    });
    return {
      exitCode: 0,
      output: notes.map((n) => `${n.note} ${n.object}\n`).join(""),
      errors: "",
      notes,
    };
  }
}

/** A message given (-m, -F, -C, -c). */
interface NoteMessage {
  kind: "m" | "F" | "C" | "c";
  value: string | Uint8Array;
}

/** builtin/notes.c's struct note_data, once its messages are joined. */
interface NoteData {
  buf: string;
  count: number;
  useEditor: boolean;
  stripspace: number;
  allowEmpty: boolean;
}

/** The message options of `add`, `append` and `edit`. */
abstract class NotesMessageCommand<T> extends NotesSubcommand<T> {
  protected messages: NoteMessage[] = [];
  protected useEditor = false;
  protected stripspaceMode = STRIPSPACE_UNSPECIFIED;
  /** `--separator` (default a newline; null: `--no-separator`) */
  protected separator: string | null = "\n";
  protected allowEmpty = false;
  protected object?: string;
  protected editor?: NotesEditor;

  /** `-m <msg>`: a paragraph of the note (whitespace cleaned up, as git's `stripspace`). */
  addMessage(message: string): this {
    this.checkCallable();
    this.messages.push({ kind: "m", value: message });
    return this;
  }

  /** `-F <file>`: a paragraph read from a file, given as its content. */
  addMessageFile(content: string | Uint8Array): this {
    this.checkCallable();
    this.messages.push({ kind: "F", value: content });
    return this;
  }

  /** `-C <object>`: the content of a blob as it is (no cleanup). */
  setReuseMessage(object: string): this {
    this.checkCallable();
    this.messages.push({ kind: "C", value: object });
    return this;
  }

  /** `-c <object>`: as `-C`, then edited (see {@link setEditor}). */
  setReeditMessage(object: string): this {
    this.checkCallable();
    this.useEditor = true;
    this.messages.push({ kind: "c", value: object });
    return this;
  }

  /** `-e` / `--edit` (git 2.44+): the message given edited too. */
  setEdit(edit: boolean): this {
    this.checkCallable();
    this.useEditor = edit;
    return this;
  }

  /** `--allow-empty`: an empty note is stored instead of the note being removed. */
  setAllowEmpty(allow: boolean): this {
    this.checkCallable();
    this.allowEmpty = allow;
    return this;
  }

  /**
   * `--separator[=<paragraph-break>]` (`true`: a newline, the default), `--no-separator`
   * (`false`): what goes between the paragraphs, and between an appended note and the one
   * there (a newline added to a separator without one).
   */
  setSeparator(separator: string | boolean): this {
    this.checkCallable();
    this.separator = separator === true ? "\n" : separator === false ? null : separator;
    return this;
  }

  /**
   * `--stripspace` / `--no-stripspace`: whether the message is cleaned up (by default `-m`
   * and `-F` paragraphs are, `-C`/`-c` blobs are not).
   */
  setStripspace(strip: boolean): this {
    this.checkCallable();
    this.stripspaceMode = strip ? STRIPSPACE : NO_STRIPSPACE;
    return this;
  }

  /** The object annotated (default `HEAD`). */
  setObject(name: string): this {
    this.checkCallable();
    this.object = name;
    return this;
  }

  /** The editor of the note (see {@link NotesEditor}). */
  setEditor(editor: NotesEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /** append_separator */
  protected appendSeparator(text: string): string {
    const sep = this.separator;
    if (sep === null) return text;
    if (sep.length > 0 && sep.endsWith("\n")) return text + sep;
    return `${text}${sep}\n`;
  }

  /** The messages read (parse_*_arg) and joined (concat_messages). */
  protected async noteData(): Promise<NoteData> {
    const msgs: { text: string; strip: boolean }[] = [];
    for (const m of this.messages) {
      if (m.kind === "m") msgs.push({ text: m.value as string, strip: true });
      else if (m.kind === "F") {
        const v = m.value;
        msgs.push({ text: typeof v === "string" ? v : decodeGitPath(v), strip: true });
      } else {
        const name = m.value as string;
        const id = await this.ctx.resolve(name);
        if (!id) throw new NotesError(`failed to resolve '${name}' as a valid ref.`);
        const bytes = (await this.blobs.has(id).catch(() => false))
          ? await readNoteBytes(this.blobs, id)
          : undefined;
        if (!bytes) {
          if (await this.objectExists(id)) {
            throw new NotesError(`cannot read note data from non-blob object '${name}'.`);
          }
          throw new NotesError(`failed to read object '${name}'.`);
        }
        msgs.push({ text: decodeGitPath(bytes), strip: false });
      }
    }
    let buf = "";
    for (const msg of msgs) {
      if (buf.length > 0) buf = this.appendSeparator(buf);
      buf += msg.text;
      if (
        (this.stripspaceMode === STRIPSPACE_UNSPECIFIED && msg.strip) ||
        this.stripspaceMode === STRIPSPACE
      ) {
        buf = stripspace(buf);
      }
    }
    return {
      buf,
      count: msgs.length,
      useEditor: this.useEditor,
      stripspace: this.stripspaceMode,
      allowEmpty: this.allowEmpty,
    };
  }

  protected async objectExists(id: ObjectId): Promise<boolean> {
    const stores = [this.blobs, this.trees, this.commits, this.tagsStore];
    for (const s of stores) {
      if (s && (await s.has(id).catch(() => false))) return true;
    }
    return false;
  }

  /**
   * prepare_note_data: with `-e`/`-c`, or without a message, the editor runs on git's
   * template (the message, else the note there, then the commented instructions), the
   * result cleaned up of comments unless `--no-stripspace`.
   */
  protected async prepare(d: NoteData, oldNote: ObjectId | undefined): Promise<string> {
    if (!d.useEditor && d.count > 0) return d.buf;
    const comment = commentPrefixOf(this.workingCopy);
    let text = d.count > 0 ? d.buf : oldNote ? ((await this.readNoteText(oldNote)) ?? "") : "";
    text += `\n${comment}\n${comment} ${NOTE_TEMPLATE}\n${comment}\n`;
    let edited: string;
    try {
      edited = this.editor ? await this.editor(text) : text;
    } catch {
      throw new NotesError("please supply the note contents using either -m or -F option");
    }
    if (d.stripspace !== NO_STRIPSPACE) edited = stripspace(edited, comment);
    return edited;
  }

  protected async writeNote(text: string): Promise<ObjectId> {
    return this.blobs.store([encodeGitPath(text)]);
  }

  /** builtin/notes.c's append_edit: `append` (to the note there) or `edit`. */
  protected async appendEdit(edit: boolean, d: NoteData, errors: string[]): Promise<NotesResult> {
    const subcommand = edit ? "edit" : "append";
    if (d.count > 0 && edit) {
      errors.push(
        "The -m/-F/-c/-C options have been deprecated for the 'edit' subcommand.\n" +
          "Please use 'git notes add -f -m/-F/-c/-C' instead.\n",
      );
    }
    const objectRef = this.object ?? "HEAD";
    const object = await this.resolveObject(objectRef);
    const t = await this.initCheck(subcommand, true);
    const note = await t.tree.get(object);
    let buf = await this.prepare(d, edit && note ? note : undefined);
    if (note && !edit) {
      const prevBytes = await readNoteBytes(this.blobs, note);
      if (!prevBytes) throw new NotesError(`unable to read ${note}`);
      let prev = decodeGitPath(prevBytes);
      if (buf.length > 0 && prevBytes.length > 0) prev = this.appendSeparator(prev);
      buf = prev + buf;
    }
    let logmsg: string;
    if (buf.length > 0 || d.allowEmpty) {
      const id = await this.writeNote(buf);
      await t.tree.add(object, id, combineNotesOverwrite);
      logmsg = `Notes added by 'git notes ${subcommand}'`;
    } else {
      errors.push(`Removing note for object ${object}\n`);
      await t.tree.remove(object);
      logmsg = `Notes removed by 'git notes ${subcommand}'`;
    }
    await commitNotes(this.ctx, t, logmsg);
    return { exitCode: 0, output: "", errors: errors.join("") };
  }
}

/**
 * `git notes add [-f] [--allow-empty] [-m/-F/-C/-c] [<object>]`: a note for the object
 * (default `HEAD`), committed on the notes ref as `Notes added by 'git notes add'`. An
 * object with a note is refused without `-f` (`error: Cannot add notes...`), or, without a
 * message, edited as `git notes edit` does. An empty message removes the note.
 *
 * @example
 * ```typescript
 * await git.notes().add().addMessage("Reviewed-by: Ann").setObject("HEAD~1").call();
 * ```
 */
export class NotesAddCommand extends NotesMessageCommand<NotesResult> {
  private force = false;

  /** `-f`: replace an existing note. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  async call(): Promise<NotesResult> {
    this.checkCallable();
    this.setCallable(false);
    const errors: string[] = [];
    const d = await this.noteData();
    const objectRef = this.object ?? "HEAD";
    const object = await this.resolveObject(objectRef);
    const t = await this.initCheck("add", true);
    const note = await t.tree.get(object);
    if (note) {
      if (!this.force) {
        if (d.count > 0) {
          return {
            exitCode: 1,
            output: "",
            errors:
              `error: Cannot add notes. Found existing notes for object ${object}. ` +
              "Use '-f' to overwrite existing notes\n",
          };
        }
        // redirected to "edit", its options parsed again (none of add's carried over)
        return this.appendEdit(
          true,
          {
            buf: "",
            count: 0,
            useEditor: false,
            stripspace: STRIPSPACE_UNSPECIFIED,
            allowEmpty: false,
          },
          errors,
        );
      }
      errors.push(`Overwriting existing notes for object ${object}\n`);
    }
    const buf = await this.prepare(d, note);
    if (buf.length > 0 || d.allowEmpty) {
      const id = await this.writeNote(buf);
      await t.tree.add(object, id, combineNotesOverwrite);
      await commitNotes(this.ctx, t, "Notes added by 'git notes add'");
    } else {
      errors.push(`Removing note for object ${object}\n`);
      await t.tree.remove(object);
      await commitNotes(this.ctx, t, "Notes removed by 'git notes add'");
    }
    return { exitCode: 0, output: "", errors: errors.join("") };
  }
}

/**
 * `git notes append [--allow-empty] [-m/-F/-C/-c] [<object>]`: the message added to the
 * object's note (after the separator, a blank line by default), or its note when it has none.
 */
export class NotesAppendCommand extends NotesMessageCommand<NotesResult> {
  async call(): Promise<NotesResult> {
    this.checkCallable();
    this.setCallable(false);
    return this.appendEdit(false, await this.noteData(), []);
  }
}

/**
 * `git notes edit [<object>]`: the object's note edited (see {@link NotesEditor}); an empty
 * result removes it.
 */
export class NotesEditCommand extends NotesMessageCommand<NotesResult> {
  async call(): Promise<NotesResult> {
    this.checkCallable();
    this.setCallable(false);
    return this.appendEdit(true, await this.noteData(), []);
  }
}

/**
 * `git notes copy [-f] <from> [<to>]`, `--stdin` (`<from> <to>` lines) and
 * `--for-rewrite=<command>` (the notes rewriting configuration of `amend`/`rebase`).
 */
export class NotesCopyCommand extends NotesSubcommand<NotesResult> {
  private force = false;
  private from?: string;
  private to?: string;
  private stdin?: string;
  private forRewrite?: string;

  /** `-f`: replace the note of the target. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** The object whose note is copied. */
  setFrom(name: string): this {
    this.checkCallable();
    this.from = name;
    return this;
  }

  /** The object it is copied to (default `HEAD`). */
  setTo(name: string): this {
    this.checkCallable();
    this.to = name;
    return this;
  }

  /** `--stdin`: the standard input, `<from> <to>` per line. */
  setStdin(input: string): this {
    this.checkCallable();
    this.stdin = input;
    return this;
  }

  /** `--for-rewrite=<command>` (implies `--stdin`). */
  setForRewrite(command: string): this {
    this.checkCallable();
    this.forRewrite = command;
    return this;
  }

  async call(): Promise<NotesResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.stdin !== undefined || this.forRewrite !== undefined) return this.fromStdin();
    if (this.from === undefined) throw new NotesError("too few arguments");
    const errors: string[] = [];
    const fromObj = await this.resolveObject(this.from);
    const object = await this.resolveObject(this.to ?? "HEAD");
    const t = await this.initCheck("copy", true);
    const note = await t.tree.get(object);
    if (note) {
      if (!this.force) {
        return {
          exitCode: 1,
          output: "",
          errors:
            `error: Cannot copy notes. Found existing notes for object ${object}. ` +
            "Use '-f' to overwrite existing notes\n",
        };
      }
      errors.push(`Overwriting existing notes for object ${object}\n`);
    }
    const fromNote = await t.tree.get(fromObj);
    if (!fromNote) {
      errors.push(`error: missing notes on source object ${fromObj}. Cannot copy.\n`);
      return { exitCode: 1, output: "", errors: errors.join("") };
    }
    await t.tree.add(object, fromNote, combineNotesOverwrite);
    await commitNotes(this.ctx, t, "Notes added by 'git notes copy'");
    return { exitCode: 0, output: "", errors: errors.join("") };
  }

  /** notes_copy_from_stdin */
  private async fromStdin(): Promise<NotesResult> {
    const ctx = this.ctx;
    const errors: string[] = [];
    const msg = "Notes added by 'git notes copy'";
    let ret = 0;
    const rewrite =
      this.forRewrite !== undefined
        ? await initCopyNotesForRewrite(ctx, this.forRewrite, errors)
        : undefined;
    if (this.forRewrite !== undefined && !rewrite) {
      return { exitCode: 0, output: "", errors: errors.map((e) => `${e}\n`).join("") };
    }
    const t = rewrite ? undefined : await initNotes(ctx, this.notesRef(), { writable: true });
    const lines = (this.stdin ?? "").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const out = errors.map((e) => `${e}\n`);
    for (const line of lines) {
      const split = line.split(" ").map((p) => p.trim());
      if (split.length < 2) throw new NotesError(`malformed input line: '${line}'.`);
      const [a, b] = split as [string, string];
      const from = await this.resolveObject(a);
      const to = await this.resolveObject(b);
      let failed = false;
      if (rewrite) await copyNoteForRewrite(rewrite, from, to);
      else
        failed = !(await (t as NotesHandle).tree.copy(from, to, this.force, combineNotesOverwrite));
      if (failed) {
        out.push(`error: failed to copy notes from '${a}' to '${b}'\n`);
        ret = 1;
      }
    }
    if (rewrite) await finishCopyNotesForRewrite(ctx, rewrite, msg);
    else await commitNotes(ctx, t as NotesHandle, msg);
    return { exitCode: ret, output: "", errors: out.join("") };
  }
}

/** `git notes show [<object>]`. */
export interface NotesShowResult extends NotesResult {
  /** The note blob shown */
  note?: ObjectId;
}

/** `git notes show [<object>]`: the note's text (`git show <note>`). */
export class NotesShowCommand extends NotesSubcommand<NotesShowResult> {
  private object?: string;

  /** The object (default `HEAD`). */
  setObject(name: string): this {
    this.checkCallable();
    this.object = name;
    return this;
  }

  async call(): Promise<NotesShowResult> {
    this.checkCallable();
    this.setCallable(false);
    const object = await this.resolveObject(this.object ?? "HEAD");
    const t = await this.initCheck("show", false);
    const note = await t.tree.get(object);
    if (!note) {
      return { exitCode: 1, output: "", errors: `error: no note found for object ${object}.\n` };
    }
    return { exitCode: 0, output: (await this.readNoteText(note)) ?? "", errors: "", note };
  }
}

/**
 * `git notes remove [--ignore-missing] [--stdin] [<object>...]`: the notes of the objects
 * (default `HEAD`) removed, committed as `Notes removed by 'git notes remove'` when every one
 * went well.
 */
export class NotesRemoveCommand extends NotesSubcommand<NotesResult> {
  private objects: string[] = [];
  private ignoreMissing = false;
  private stdin?: string;

  /** The objects whose notes are removed. */
  addObjects(...names: string[]): this {
    this.checkCallable();
    this.objects.push(...names);
    return this;
  }

  /** `--ignore-missing`: an object without a note is no error. */
  setIgnoreMissing(ignore: boolean): this {
    this.checkCallable();
    this.ignoreMissing = ignore;
    return this;
  }

  /** `--stdin`: object names, one per line, after those given. */
  setStdin(input: string): this {
    this.checkCallable();
    this.stdin = input;
    return this;
  }

  async call(): Promise<NotesResult> {
    this.checkCallable();
    this.setCallable(false);
    const t = await this.initCheck("remove", true);
    const errors: string[] = [];
    let retval = 0;
    const removeOne = async (name: string): Promise<number> => {
      const id = await this.ctx.resolve(name);
      if (!id) {
        errors.push(`error: Failed to resolve '${name}' as a valid ref.\n`);
        return 1;
      }
      const status = (await t.tree.remove(id)) ? 0 : 1;
      errors.push(status ? `Object ${name} has no note\n` : `Removing note for object ${name}\n`);
      return this.ignoreMissing ? 0 : status;
    };
    if (this.objects.length === 0 && this.stdin === undefined) retval = await removeOne("HEAD");
    else for (const name of this.objects) retval |= await removeOne(name);
    if (this.stdin !== undefined) {
      const lines = this.stdin.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) retval |= await removeOne(line.replace(/\s+$/, ""));
    }
    if (!retval) await commitNotes(this.ctx, t, "Notes removed by 'git notes remove'");
    return { exitCode: retval ? 1 : 0, output: "", errors: errors.join("") };
  }
}

/** `git notes prune [-n] [-v]`. */
export interface NotesPruneResult extends NotesResult {
  /** The objects whose notes were (with `-n`: would be) removed */
  pruned: ObjectId[];
}

/** `git notes prune [-n] [-v]`: the notes of objects that are not in the repository removed. */
export class NotesPruneCommand extends NotesSubcommand<NotesPruneResult> {
  private dryRun = false;
  private verbose = false;

  /** `-n`: list them (as `-v`), remove nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `-v`: list the objects whose notes are removed. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  async call(): Promise<NotesPruneResult> {
    this.checkCallable();
    this.setCallable(false);
    const t = await this.initCheck("prune", true);
    const missing = await t.tree.unreachableObjects((id) => this.objectExists(id));
    let output = "";
    for (const id of missing) {
      if (this.verbose || this.dryRun) output += `${id}\n`;
      if (!this.dryRun) await t.tree.remove(id);
    }
    if (!this.dryRun) await commitNotes(this.ctx, t, "Notes removed by 'git notes prune'");
    return { exitCode: 0, output, errors: "", pruned: missing };
  }

  private async objectExists(id: ObjectId): Promise<boolean> {
    for (const s of [this.blobs, this.trees, this.commits, this.tagsStore]) {
      if (s && (await s.has(id).catch(() => false))) return true;
    }
    return false;
  }
}

/** `git notes get-ref`: the notes ref used. */
export class NotesGetRefCommand extends NotesSubcommand<string> {
  async call(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    return this.notesRef();
  }
}
