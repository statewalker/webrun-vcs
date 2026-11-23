/**
 * `core.commentChar` / `core.commentString` = `auto`, deprecated in git 2.5x and removed in
 * git 3.0 (config.c's `comment_char_callback` and `check_auto_comment_char_config`). git
 * tracks every value of the two keys in configuration order; when the last one is exactly
 * `auto`, a git built with `WITH_BREAKING_CHANGES` dies in every command that reads the
 * repository's configuration, and git 2.5x warns once in commit, merge, rebase, revert and
 * cherry-pick. Both add advice naming the files to change, as `git config` scope options.
 *
 * ```typescript
 * autoCommentCharLines(workingCopy, "removed");
 * // ["fatal: Support for 'core.commentChar=auto' has been removed in Git 3.0", "hint:",
 * //  "hint: To use the default comment string (#) please run", ...]
 * ```
 */
import type { GitHostEnvironment, WorkingCopy } from "@statewalker/vcs-working-tree";
import { InvalidConfigError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";

const KEYS = ["core.commentchar", "core.commentstring"] as const;
const NAMES = ["core.commentChar", "core.commentString"] as const;

interface Item {
  keyId: 0 | 1;
  scope: string | undefined;
  file: string;
}

/** `core.commentChar=auto` in a git 3.0 build: every command but `git config` dies (exit 128). */
export class AutoCommentCharRemovedError extends InvalidConfigError {
  /** git's stderr: the fatal line and its hints */
  readonly lines: string[];
  constructor(lines: string[]) {
    super("core.commentChar", lines.join("\n"));
    this.name = "AutoCommentCharRemovedError";
    this.lines = lines;
  }
}

/**
 * git's lines about an `auto` comment character, or undefined when the last value of the two
 * keys is not exactly `auto`: `removed` gives git 3.0's death (`fatal:`), `deprecated` git
 * 2.5x's warning (`warning:`), each followed by the advice.
 */
export function autoCommentCharLines(
  workingCopy: WorkingCopy,
  kind: "removed" | "deprecated",
): string[] | undefined {
  const config = RemoteConfigStore.from(workingCopy);
  const entries = config.entriesWithOriginFor([...KEYS]);
  if (!entries) {
    // a config that cannot list its variables: the last value alone, no advice
    const last = config.lastValueOf([...NAMES]);
    if (last !== "auto") return undefined;
    return [headline(kind, "core.commentChar")];
  }
  let lastKey: 0 | 1 = 0;
  let autoSet = false;
  let autoSetInFile = false;
  const items: Item[] = [];
  const seenTwice = new Set<string>();
  for (const entry of entries) {
    const keyId = KEYS.indexOf(entry.key as (typeof KEYS)[number]) as 0 | 1;
    lastKey = keyId;
    autoSet = entry.text === "auto";
    // values of the command line are not files: no advice names them
    if (entry.scope === "command" || entry.file === undefined) continue;
    const id = `${keyId}\0${entry.file}`;
    if (items.some((item) => `${item.keyId}\0${item.file}` === id)) seenTwice.add(id);
    else items.push({ keyId, scope: entry.scope, file: entry.file });
    autoSetInFile = autoSet;
  }
  if (!autoSet) return undefined;
  const lines = [headline(kind, NAMES[lastKey])];
  if (autoSetInFile && items.length > 0) {
    const environment = hostEnvironmentOf(workingCopy);
    const unset = items.map(
      (item) =>
        `    git config unset ${scopeArg(item, environment)}${
          seenTwice.has(`${item.keyId}\0${item.file}`) ? "--all " : ""
        }${NAMES[item.keyId]}`,
    );
    lines.push(
      ...hint(`\nTo use the default comment string (#) please run\n\n${unset.join("\n")}\n`),
    );
    const last = items[items.length - 1] as Item;
    const set = `    git config set ${scopeArg(last, environment)}${NAMES[last.keyId]} <comment string>`;
    lines.push(
      ...hint(
        `\nTo set a custom comment string please run\n\n${set}\n\nwhere '<comment string>' is the string you wish to use.\n`,
      ),
    );
  }
  return lines;
}

/**
 * The git 3.0 check every command runs as it reads the configuration (`check_deprecated_config`
 * in `repo_read_config`): throws with git's lines when the comment character is `auto` and the
 * host asked for git 3.0 (`GitHostEnvironment.breakingChanges`).
 */
export function checkAutoCommentChar(workingCopy: WorkingCopy): void {
  if (!hostEnvironmentOf(workingCopy)?.breakingChanges) return;
  const lines = autoCommentCharLines(workingCopy, "removed");
  if (lines) throw new AutoCommentCharRemovedError(lines);
}

function headline(kind: "removed" | "deprecated", key: string): string {
  return kind === "removed"
    ? `fatal: Support for '${key}=auto' has been removed in Git 3.0`
    : `warning: Support for '${key}=auto' is deprecated and will be removed in Git 3.0`;
}

/** advice.c's `vadvise`: each line as `hint: <line>`, an empty one as `hint:`. */
function hint(text: string): string[] {
  const out: string[] = [];
  const parts = text.split("\n");
  // a trailing newline ends the last line; it adds no empty one
  if (parts[parts.length - 1] === "") parts.pop();
  for (const part of parts) out.push(part === "" ? "hint:" : `hint: ${part}`);
  return out;
}

/**
 * config.c's `add_config_scope_arg`: the option naming the file a value came from. The
 * system file is taken as writable (git recommends `--global` when it is not; the FilesApi
 * cannot tell).
 */
function scopeArg(item: Item, environment: GitHostEnvironment | undefined): string {
  const base = item.file.split("/").pop() ?? item.file;
  if (item.scope === "system" && item.file === environment?.systemConfig) return "--system ";
  if (item.scope === "global" && isGlobalFile(item.file, environment)) return "--global ";
  if (item.scope === "local" && base === "config") return "";
  if (item.scope === "worktree" && base === "config.worktree") return "--worktree ";
  let path = item.file;
  let prefix = "";
  const home = environment?.home;
  if (home && path.startsWith(home)) {
    path = path.slice(home.length).replace(/^\//, "");
    prefix = "~/";
  }
  return `--file ${prefix}${quotePretty(path)} `;
}

function isGlobalFile(file: string, environment: GitHostEnvironment | undefined): boolean {
  if (!environment) return false;
  if (environment.globalConfig !== undefined) return file === environment.globalConfig;
  const home = environment.home?.replace(/\/+$/, "");
  const xdg = environment.xdgConfigHome ?? (home ? `${home}/.config` : undefined);
  return (
    (home !== undefined && file === `${home}/.gitconfig`) ||
    (xdg !== undefined && file === `${xdg}/git/config`)
  );
}

/** quote.c's `sq_quote_buf_pretty`: as is when every byte is safe, else single-quoted. */
function quotePretty(path: string): string {
  if (path !== "" && /^[A-Za-z0-9+,\-./:=@_^]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
}
