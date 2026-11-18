import { isValidRefName, type ObjectId } from "@statewalker/vcs-core";

import { RebaseAction } from "../results/rebase-result.js";

/**
 * The todo list of git's sequencer (`rebase-merge/git-rebase-todo`): parsing as git's
 * parse_insn_line reads a line, writing as todo_list_to_strbuf writes it, the help text
 * the editor shows (append_todo_help), and the rearrangements git makes before the list is
 * edited (`--autosquash`, `--exec`).
 */

/** One line of the todo list. */
export interface TodoItem {
  action: RebaseAction;
  /**
   * The commit of a pick-like command, or the original merge of a `merge -C` (empty for the
   * other commands); as written until the list's names are resolved
   */
  id: ObjectId;
  /**
   * The line's text after the id (`# <subject>`, as `rebase.instructionFormat` made it, or as
   * the todo file has it): written back unchanged, and what `Could not apply` names. The
   * argument of `exec`, `label`, `reset`, `update-ref` and an id-less `merge`, the whole line
   * of a comment (a blank line is one)
   */
  rest?: string;
  /** `merge -c` / `fixup -c`: the message edited */
  editMessage?: boolean;
  /** `fixup -C`: this commit's message replaces the previous one's */
  replaceMessage?: boolean;
  /** A line git could not parse: kept as written (git's TODO_COMMENT + 1) */
  invalid?: boolean;
  /** The line as read from a todo file (written back as it is while the list runs) */
  line?: string;
  /** git's errors for this line (`error: ...`), in the order git prints them */
  errors?: string[];
  /**
   * An `update-ref` (or checked-out comment) --update-refs added: its argument keeps the
   * newline git added it with, so the first list shows a blank line after it
   */
  blankAfter?: boolean;
}

/** git's todo_command_info in parse order: the name and the one-letter abbreviation. */
const COMMANDS: [RebaseAction, string, string | undefined][] = [
  [RebaseAction.PICK, "pick", "p"],
  [RebaseAction.EDIT, "edit", "e"],
  [RebaseAction.REWORD, "reword", "r"],
  [RebaseAction.FIXUP, "fixup", "f"],
  [RebaseAction.SQUASH, "squash", "s"],
  [RebaseAction.EXEC, "exec", "x"],
  [RebaseAction.BREAK, "break", "b"],
  [RebaseAction.LABEL, "label", "l"],
  [RebaseAction.RESET, "reset", "t"],
  [RebaseAction.MERGE, "merge", "m"],
  [RebaseAction.UPDATE_REF, "update-ref", "u"],
  [RebaseAction.NOOP, "noop", undefined],
  [RebaseAction.DROP, "drop", "d"],
];

const ABBREVIATION = new Map(COMMANDS.map(([action, , char]) => [action, char]));

/** The commands that take a commit (merge only with `-C`/`-c`). */
const WITH_COMMIT = new Set<RebaseAction>([
  RebaseAction.PICK,
  RebaseAction.EDIT,
  RebaseAction.REWORD,
  RebaseAction.FIXUP,
  RebaseAction.SQUASH,
  RebaseAction.DROP,
]);

/** git's is_noop: `noop`, `drop`, comments and lines that could not be parsed. */
export function isNoop(item: TodoItem): boolean {
  return (
    item.invalid === true ||
    item.action === RebaseAction.NOOP ||
    item.action === RebaseAction.DROP ||
    item.action === RebaseAction.COMMENT
  );
}

/** git's is_fixup: `fixup` or `squash`. */
export function isFixup(action: RebaseAction | undefined): boolean {
  return action === RebaseAction.FIXUP || action === RebaseAction.SQUASH;
}

/** git's is_pick_or_similar: the commands that make a (non-merge) commit. */
export function isPickLike(action: RebaseAction): boolean {
  return (
    action === RebaseAction.PICK ||
    action === RebaseAction.EDIT ||
    action === RebaseAction.REWORD ||
    action === RebaseAction.FIXUP ||
    action === RebaseAction.SQUASH
  );
}

/** git's count_commands: every item but comments (`noop`, `drop` and bad lines count). */
export function countTodoCommands(items: TodoItem[]): number {
  return items.filter((item) => item.action !== RebaseAction.COMMENT || item.invalid).length;
}

/** The result of parsing a todo list: its items and git's errors (`error: ...` lines). */
export interface ParsedTodo {
  items: TodoItem[];
  errors: string[];
}

const isBlank = (ch: string | undefined) => ch === " " || ch === "\t";

/**
 * A todo list's lines as git's todo_list_parse_insn_buffer reads them. Commit names are
 * kept as written (resolved later); a line git refuses is kept as written (`invalid`) and
 * reported as git reports it (`error: invalid command 'x'`, `error: invalid line 3: x`).
 * `fixupOkay` (`rebase-merge/done` exists): a fixup or squash may start the list.
 */
export function parseTodo(text: string, comment = "#", fixupOkay = false): ParsedTodo {
  const items: TodoItem[] = [];
  const errors: string[] = [];
  let p = 0;
  let lineNumber = 1;
  let okay = fixupOkay;
  while (p < text.length) {
    const nl = text.indexOf("\n", p);
    let eol = nl < 0 ? text.length : nl;
    const next = nl < 0 ? text.length : nl + 1;
    if (eol > p && text[eol - 1] === "\r") eol--;
    const raw = text.slice(p, eol);
    const parsed = parseLine(raw, comment);
    if ("error" in parsed) {
      const lines = [`error: ${parsed.error}`, `error: invalid line ${lineNumber}: ${raw}`];
      errors.push(...lines);
      items.push({
        action: RebaseAction.COMMENT,
        id: "",
        rest: raw,
        invalid: true,
        line: raw,
        errors: lines,
      });
    } else {
      parsed.line = raw;
      items.push(parsed);
      if (okay) {
        // nothing to check
      } else if (isFixup(parsed.action)) {
        const line = `error: cannot '${parsed.action}' without a previous commit`;
        errors.push(line);
        parsed.errors = [line];
      } else if (!isNoop(parsed)) okay = true;
    }
    p = next;
    lineNumber++;
  }
  return { items, errors };
}

/** git's parse_insn_line for one line (no LF, no trailing CR). */
function parseLine(line: string, comment: string): TodoItem | { error: string } {
  let bol = 0;
  while (isBlank(line[bol])) bol++;
  let action: RebaseAction | undefined;
  let name = "";
  for (const [a, str, nick] of COMMANDS) {
    for (const word of nick ? [str, nick] : [str]) {
      if (line.startsWith(word, bol)) {
        const after = line[bol + word.length];
        if (after === undefined || isBlank(after) || after === "\r") {
          action = a;
          name = str;
          bol += word.length;
          break;
        }
      }
    }
    if (action) break;
  }
  if (!action) {
    if (line.startsWith(comment, bol) || bol === line.length) {
      return { action: RebaseAction.COMMENT, id: "", rest: line.slice(bol) };
    }
    const word = /^[^ \t\r\n]*/.exec(line.slice(bol))?.[0] ?? "";
    return { error: `invalid command '${word}'` };
  }
  const start = bol;
  while (isBlank(line[bol])) bol++;
  const padding = bol - start;
  const arg = line.slice(bol);
  if (action === RebaseAction.NOOP || action === RebaseAction.BREAK) {
    if (arg !== "") return { error: `${name} does not accept arguments: '${arg}'` };
    return { action, id: "", rest: "" };
  }
  if (padding === 0) return { error: `missing arguments for ${name}` };
  if (
    action === RebaseAction.EXEC ||
    action === RebaseAction.LABEL ||
    action === RebaseAction.RESET ||
    action === RebaseAction.UPDATE_REF
  ) {
    if (action === RebaseAction.LABEL) {
      if (arg === "#" || !isValidRefName(arg, { allowOneLevel: true })) {
        return { error: `'${arg}' is not a valid label` };
      }
    } else if (action === RebaseAction.UPDATE_REF) {
      if (!isValidRefName(arg, { allowOneLevel: true })) {
        return { error: `'${arg}' is not a valid refname` };
      }
      if (!isValidRefName(arg)) {
        return { error: `update-ref requires a fully qualified refname e.g. refs/heads/${arg}` };
      }
    }
    return { action, id: "", rest: arg };
  }
  let rest = arg;
  const item: TodoItem = { action, id: "" };
  if (action === RebaseAction.FIXUP) {
    if (rest.startsWith("-C")) {
      rest = rest.slice(2).replace(/^[ \t]+/, "");
      item.replaceMessage = true;
    } else if (rest.startsWith("-c")) {
      rest = rest.slice(2).replace(/^[ \t]+/, "");
      item.editMessage = true;
    }
  }
  if (action === RebaseAction.MERGE) {
    if (rest.startsWith("-C")) rest = rest.slice(2).replace(/^[ \t]+/, "");
    else if (rest.startsWith("-c")) {
      rest = rest.slice(2).replace(/^[ \t]+/, "");
      item.editMessage = true;
    } else return { action, id: "", rest, editMessage: true };
  }
  const end = rest.search(/[ \t\n]/);
  item.id = end < 0 ? rest : rest.slice(0, end);
  item.rest = end < 0 ? "" : rest.slice(end).replace(/^[ \t]+/, "");
  return item;
}

/** Whether the command carries a commit (resolved after parsing). */
export function takesCommit(item: TodoItem): boolean {
  if (item.invalid) return false;
  if (item.action === RebaseAction.MERGE) return item.id !== "";
  return WITH_COMMIT.has(item.action);
}

/** Options of {@link formatTodo}. */
export interface FormatTodoOptions {
  /** `rebase.abbreviateCommands`: the commands as their letters */
  abbreviate?: boolean;
  /** The id written for a commit (TODO_LIST_SHORTEN_IDS: abbreviated); default the id */
  idOf?: (id: ObjectId) => string;
  /** Lines read from a file written back as they were read (save_todo) */
  verbatim?: boolean;
}

/** git's peek_command: the first command from `offset` on that is not a noop. */
export function peekCommand(items: TodoItem[], offset: number): RebaseAction | undefined {
  for (let i = offset; i < items.length; i++) {
    const item = items[i] as TodoItem;
    if (!isNoop(item)) return item.action;
  }
  return undefined;
}

/** sequencer.c's is_final_fixup: `items[0]` is a fixup/squash no later one follows. */
export function isFinalFixup(items: TodoItem[]): boolean {
  if (!isFixup(items[0]?.action)) return false;
  for (let i = 1; i < items.length; i++) {
    const item = items[i] as TodoItem;
    if (isFixup(item.action) && !item.invalid) return false;
    if (!isNoop(item)) break;
  }
  return true;
}

/** git's todo_list_to_strbuf: each item as a line. */
export function formatTodo(items: TodoItem[], options: FormatTodoOptions = {}): string {
  let out = "";
  for (const item of items) {
    if (options.verbatim && item.line !== undefined) {
      out += `${item.line}\n`;
      continue;
    }
    if (item.action === RebaseAction.COMMENT) {
      out += `${item.rest ?? ""}\n${item.blankAfter ? "\n" : ""}`;
      continue;
    }
    const char = ABBREVIATION.get(item.action);
    out += options.abbreviate && char ? char : item.action;
    if (takesCommit(item)) {
      if (item.action === RebaseAction.FIXUP) {
        if (item.editMessage) out += " -c";
        else if (item.replaceMessage) out += " -C";
      }
      if (item.action === RebaseAction.MERGE) out += item.editMessage ? " -c" : " -C";
      out += ` ${options.idOf ? options.idOf(item.id) : item.id}`;
    }
    out += item.rest ? ` ${item.rest}\n` : "\n";
    if (item.blankAfter) out += "\n";
  }
  return out;
}

/**
 * git's strbuf_add_commented_lines: each line after the comment string and a space (no
 * space before an empty line or a tab), the text ended by a newline.
 */
export function commentLines(out: string, text: string, comment: string): string {
  let result = out;
  let p = 0;
  while (p < text.length) {
    const nl = text.indexOf("\n", p);
    const next = nl < 0 ? text.length : nl + 1;
    result += comment;
    if (text[p] !== "\n" && text[p] !== "\t") result += " ";
    result += text.slice(p, next);
    p = next;
  }
  if (result.length > 0 && !result.endsWith("\n")) result += "\n";
  return result;
}

/**
 * sequencer.c's add_commented_lines: like {@link commentLines}, but the lines at the start
 * that are already comments are copied as they are.
 */
function commentLinesOnce(out: string, text: string, comment: string): string {
  let result = out;
  let s = 0;
  while (text.startsWith(comment, s)) {
    const nl = text.indexOf("\n", s);
    const next = nl < 0 ? text.length : nl + 1;
    result += text.slice(s, next);
    s = next;
  }
  return commentLines(result, text.slice(s), comment);
}

/**
 * rebase-interactive.c's append_todo_help: the help after the list (`# Rebase a..b onto c
 * (n commands)` for a new list, the commands, the warnings).
 */
export function todoHelp(
  commandCount: number,
  comment: string,
  range?: { shortRevisions: string; shortOnto: string },
  missingCommitsError = false,
): string {
  let buf = "";
  if (range) {
    buf += `\n${comment} Rebase ${range.shortRevisions} onto ${range.shortOnto} (${commandCount} command${commandCount === 1 ? "" : "s"})\n`;
  }
  buf = commentLines(
    buf,
    `\nCommands:
p, pick <commit> = use commit
r, reword <commit> = use commit, but edit the commit message
e, edit <commit> = use commit, but stop for amending
s, squash <commit> = use commit, but meld into previous commit
f, fixup [-C | -c] <commit> = like "squash" but keep only the previous
                   commit's log message, unless -C is used, in which case
                   keep only this commit's message; -c is same as -C but
                   opens the editor
x, exec <command> = run command (the rest of the line) using shell
b, break = stop here (continue rebase later with 'git rebase --continue')
d, drop <commit> = remove commit
l, label <label> = label current HEAD with a name
t, reset <label> = reset HEAD to a label
m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]
        create a merge commit using the original merge commit's
        message (or the oneline, if no original merge commit was
        specified); use -c <commit> to reword the commit message
u, update-ref <ref> = track a placeholder for the <ref> to be updated
                      to this position in the new commits. The <ref> is
                      updated at the end of the rebase

These lines can be re-ordered; they are executed from top to bottom.
`,
    comment,
  );
  buf = commentLines(
    buf,
    missingCommitsError
      ? "\nDo not remove any line. Use 'drop' explicitly to remove a commit.\n"
      : "\nIf you remove a line here THAT COMMIT WILL BE LOST.\n",
    comment,
  );
  buf = commentLines(
    buf,
    range
      ? "\nHowever, if you remove everything, the rebase will be aborted.\n\n"
      : "\nYou are editing the todo file of an ongoing interactive rebase.\nTo continue rebase after editing, run:\n    git rebase --continue\n\n",
    comment,
  );
  return buf;
}

/**
 * sequencer.c's todo_list_add_exec_commands: the commands after every pick and merge (after
 * the fixup/squash chain that follows it).
 */
export function addExecCommands(items: TodoItem[], commands: string[]): TodoItem[] {
  const execs = () =>
    commands.map((command): TodoItem => ({ action: RebaseAction.EXEC, id: "", rest: command }));
  const out: TodoItem[] = [];
  let insert = false;
  for (const item of items) {
    if (insert && !isFixup(item.action)) {
      out.push(...execs());
      insert = false;
    }
    out.push(item);
    if (!item.invalid && (item.action === RebaseAction.PICK || item.action === RebaseAction.MERGE))
      insert = true;
  }
  if (insert) out.push(...execs());
  return out;
}

/** sequencer.c's skip_fixupish: the text after `fixup! `, `amend! ` or `squash! `. */
function skipFixupish(subject: string): string | undefined {
  for (const prefix of ["fixup! ", "amend! ", "squash! "]) {
    if (subject.startsWith(prefix)) return subject.slice(prefix.length);
  }
  return undefined;
}

/**
 * sequencer.c's todo_list_rearrange_squash (`--autosquash`): each `fixup! <subject>`,
 * `amend! <subject>` and `squash! <subject>` commit moved after the commit it names (by
 * subject, by a commit name, or by a subject's prefix) and made a `fixup`, `fixup -C` or
 * `squash`; undefined when the list already has fixups (git's "the script was already
 * rearranged.").
 */
export async function rearrangeSquash(
  items: TodoItem[],
  subjectOf: (id: ObjectId) => Promise<string>,
  commitNamed: (name: string) => Promise<ObjectId | undefined>,
): Promise<TodoItem[] | undefined> {
  const n = items.length;
  const next: number[] = new Array(n).fill(-1);
  const tail: number[] = new Array(n).fill(-1);
  const subjects: (string | undefined)[] = new Array(n).fill(undefined);
  const subject2item = new Map<string, number>();
  const commitTodo = new Map<ObjectId, number>();
  let rearranged = false;
  for (let i = 0; i < n; i++) {
    const item = items[i] as TodoItem;
    if (!takesCommit(item) || item.action === RebaseAction.DROP) continue;
    if (isFixup(item.action)) return undefined;
    const subject = await subjectOf(item.id);
    subjects[i] = subject;
    let i2 = -1;
    let p = skipFixupish(subject);
    if (p !== undefined) {
      for (;;) {
        p = p.replace(/^[ \t\n\r\f\v]+/, "");
        const more = skipFixupish(p);
        if (more === undefined) break;
        p = more;
      }
      const target = p;
      const bySubject = subject2item.get(target);
      if (bySubject !== undefined) i2 = bySubject;
      else {
        const named = target.includes(" ") ? undefined : await commitNamed(target);
        const byName = named !== undefined ? commitTodo.get(named) : undefined;
        if (byName !== undefined) i2 = byName;
        else {
          for (i2 = 0; i2 < i; i2++) {
            if (subjects[i2]?.startsWith(target)) break;
          }
          if (i2 === i) i2 = -1;
        }
      }
    }
    if (i2 >= 0) {
      rearranged = true;
      if (subject.startsWith("fixup!")) item.action = RebaseAction.FIXUP;
      else if (subject.startsWith("amend!")) {
        item.action = RebaseAction.FIXUP;
        item.replaceMessage = true;
      } else item.action = RebaseAction.SQUASH;
      if (tail[i2] < 0) {
        next[i] = next[i2] as number;
        next[i2] = i;
      } else {
        const t = tail[i2] as number;
        next[i] = next[t] as number;
        next[t] = i;
      }
      tail[i2] = i;
    } else if (!subject2item.has(subject)) subject2item.set(subject, i);
    commitTodo.set(item.id, i);
  }
  if (!rearranged) return items;
  const out: TodoItem[] = [];
  for (let i = 0; i < n; i++) {
    if (isFixup((items[i] as TodoItem).action)) continue;
    for (let cur = i; cur >= 0; cur = next[cur] as number) out.push(items[cur] as TodoItem);
  }
  return out;
}

/** git's find_commit_subject: the message from its first non-blank line. */
export function messageBody(message: string): string {
  return message.replace(/^([ \t\r]*\n)+/, "");
}

/** commit.c's commit_subject_length: the subject paragraph's length (its newlines included). */
export function subjectLength(body: string): number {
  let p = 0;
  while (p < body.length) {
    if (/^[ \t\r]*\n/.test(body.slice(p))) break;
    const nl = body.indexOf("\n", p);
    p = nl < 0 ? body.length : nl + 1;
  }
  return p;
}

/** sequencer.c's messages of a fixup/squash chain. */
const firstMessage = "This is the 1st commit message:";
const nthMessage = (n: number) => `This is the commit message #${n}:`;
const skipFirstMessage = "The 1st commit message will be skipped:";
const skipNthMessage = (n: number) => `The commit message #${n} will be skipped:`;
export const combinedMessage = (n: number) => `This is a combination of ${n} commits.`;

/**
 * sequencer.c's update_squash_message_for_fixup (a `fixup -C` after fixups): the messages
 * kept so far commented out and said to be skipped, the blank lines around them kept.
 */
export function squashMessageForFixup(message: string, comment: string): string {
  let buf1 = commentLines("", firstMessage, comment);
  let buf2 = commentLines("", skipFirstMessage, comment);
  const plain = (out: string, text: string) => out + text;
  const commented = (out: string, text: string) => commentLinesOnce(out, text, comment);
  let copy = plain;
  let msg = "";
  let start = 0;
  let s = 0;
  let i = 1;
  const update = (k: number) => {
    buf1 = `${comment} ${nthMessage(k)}\n`;
    buf2 = `${comment} ${skipNthMessage(k)}\n`;
  };
  while (s >= 0) {
    if (message.startsWith(buf1, s)) {
      let next = s + buf1.length;
      const off = s > start + 1 && message[s - 2] === "\n" ? 1 : 0;
      msg = copy(msg, message.slice(start, s - off));
      if (off) msg += "\n";
      msg += buf2;
      if (message[next] === "\n") {
        msg += "\n";
        next++;
      }
      start = s = next;
      copy = commented;
      update(++i);
    } else if (message.startsWith(buf2, s)) {
      const next = s + buf2.length;
      const off = s > start + 1 && message[s - 2] === "\n" ? 1 : 0;
      msg = copy(msg, message.slice(start, s - off));
      start = s - off;
      s = next;
      copy = plain;
      update(++i);
    } else {
      const nl = message.indexOf("\n", s);
      s = nl < 0 ? -1 : nl + 1;
    }
  }
  return copy(msg, message.slice(start));
}

/** The pieces of git's fixup/squash message text, for the command's update_squash_messages. */
export const squashTexts = {
  firstMessage,
  nthMessage,
  skipFirstMessage,
  skipNthMessage,
  combinedMessage,
  commentLinesOnce,
};
