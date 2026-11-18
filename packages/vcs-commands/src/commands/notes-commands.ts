import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import {
  NotesAddCommand,
  NotesAppendCommand,
  NotesCopyCommand,
  NotesEditCommand,
  NotesGetRefCommand,
  NotesListCommand,
  NotesPruneCommand,
  NotesRemoveCommand,
  NotesShowCommand,
  type NotesSubcommand,
} from "./notes-command.js";
import { NotesMergeCommand } from "./notes-merge-command.js";

/**
 * The `git notes` subcommands of a working copy (see `Git.notes()`), on the notes ref given
 * (`git notes --ref=<ref>`), else the default one (`GIT_NOTES_REF`, `core.notesRef`,
 * `refs/notes/commits`).
 *
 * @example
 * ```typescript
 * await git.notes().add().addMessage("Tested-by: CI").call();
 * const { output } = await git.notes("review").list().call();
 * ```
 */
export class NotesCommands {
  constructor(
    private readonly workingCopy: WorkingCopy,
    private readonly ref?: string,
  ) {}

  private on<C extends NotesSubcommand<unknown>>(command: C): C {
    return this.ref !== undefined ? command.setNotesRef(this.ref) : command;
  }

  /** `git notes list [<object>]` */
  list(): NotesListCommand {
    return this.on(new NotesListCommand(this.workingCopy));
  }

  /** `git notes add` */
  add(): NotesAddCommand {
    return this.on(new NotesAddCommand(this.workingCopy));
  }

  /** `git notes append` */
  append(): NotesAppendCommand {
    return this.on(new NotesAppendCommand(this.workingCopy));
  }

  /** `git notes edit` */
  edit(): NotesEditCommand {
    return this.on(new NotesEditCommand(this.workingCopy));
  }

  /** `git notes copy` */
  copy(): NotesCopyCommand {
    return this.on(new NotesCopyCommand(this.workingCopy));
  }

  /** `git notes show` */
  show(): NotesShowCommand {
    return this.on(new NotesShowCommand(this.workingCopy));
  }

  /** `git notes remove` */
  remove(): NotesRemoveCommand {
    return this.on(new NotesRemoveCommand(this.workingCopy));
  }

  /** `git notes prune` */
  prune(): NotesPruneCommand {
    return this.on(new NotesPruneCommand(this.workingCopy));
  }

  /** `git notes get-ref` */
  getRef(): NotesGetRefCommand {
    return this.on(new NotesGetRefCommand(this.workingCopy));
  }

  /** `git notes merge` (`--commit`, `--abort`) */
  merge(): NotesMergeCommand {
    return this.on(new NotesMergeCommand(this.workingCopy));
  }
}
