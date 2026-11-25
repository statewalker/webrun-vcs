/**
 * `git stripspace` (builtin/stripspace.c): a message cleaned up as `strbuf_stripspace`
 * cleans it (`-s` also drops comment lines), or every line commented out (`-c`,
 * `strbuf_add_commented_lines`).
 *
 * @example
 * ```typescript
 * // printf 'a  \n\n\n# c\nb' | git stripspace -s
 * await git.stripspace().setInput("a  \n\n\n# c\nb").setMode("strip-comments").call();
 * // { exitCode: 0, stdout: "a\n\nb\n", stderr: "" }
 * ```
 */

import { decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { stripspace } from "./message-cleanup.js";

/** `git stripspace`'s modes: no option, `-s` (`--strip-comments`), `-c` (`--comment-lines`). */
export type StripspaceMode = "default" | "strip-comments" | "comment-lines";

/**
 * git's `add_lines` with a space after the prefix (`strbuf_add_commented_lines`): every
 * line prefixed, a space between unless the line is empty or starts with a tab, the last
 * line completed.
 */
export function commentLines(text: string, commentPrefix: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const eol = text.indexOf("\n", i);
    const next = eol < 0 ? text.length : eol + 1;
    const first = text[i];
    out += commentPrefix + (first !== "\n" && first !== "\t" ? " " : "") + text.slice(i, next);
    i = next;
  }
  return out.length === 0 || out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * `git stripspace [-s | -c]` over {@link setInput} (git's stdin). The comment string of
 * `-s` and `-c` is `core.commentChar` / `core.commentString` (the last value of either; `auto`
 * is `#`); git dies reading a value it refuses (2.5x: empty or holding a newline; 2.43, which
 * knows only `core.commentChar`: anything but one ASCII character), exit 128 with git's two
 * lines. The default mode reads no configuration.
 */
export class StripspaceCommand extends GitCommand<PlumbingTextOutput> {
  private input = "";
  private mode: StripspaceMode = "default";
  private compatibility: "2.43" | "2.56" = "2.56";

  /** The text to clean up (git's stdin); bytes are read as git paths are (`decodeGitPath`). */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? input : decodeGitPath(input);
    return this;
  }

  /** `-s` / `-c`; the default only cleans up whitespace. */
  setMode(mode: StripspaceMode): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    if (this.mode === "default") {
      return { exitCode: 0, stdout: stripspace(this.input), stderr: "" };
    }
    const prefix = this.commentString();
    if (typeof prefix !== "string") return { exitCode: 128, stdout: "", stderr: prefix.error };
    const stdout =
      this.mode === "strip-comments"
        ? stripspace(this.input, prefix)
        : commentLines(this.input, prefix);
    return { exitCode: 0, stdout, stderr: "" };
  }

  /** git_default_core_config's comment settings, each value checked in config order. */
  private commentString(): string | { error: string } {
    const legacy = this.compatibility === "2.43";
    const keys = legacy ? ["core.commentchar"] : ["core.commentchar", "core.commentstring"];
    const config = RemoteConfigStore.from(this._workingCopy);
    let prefix = "#";
    const entries =
      config.entriesWithOriginFor(keys) ??
      keys.flatMap((key) => config.valuesWithOrigin(key).map((where) => ({ key, ...where })));
    for (const { key, text, file, line } of entries) {
      const fatal =
        file !== undefined && line !== undefined
          ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
          : `fatal: unable to parse '${key}' from command-line config`;
      let error: string | undefined;
      if (text === undefined) error = `error: missing value for '${key}'`;
      else if (text.toLowerCase() === "auto") prefix = "#";
      else if (legacy) {
        if (text.length !== 1 || text.charCodeAt(0) >= 0x80)
          error = "error: core.commentChar should only be one ASCII character";
        else prefix = text;
      } else if (text === "") error = `error: ${key} must have at least one character`;
      else if (text.includes("\n")) error = `error: ${key} cannot contain newline`;
      else prefix = text;
      if (error) return { error: `${error}\n${fatal}\n` };
    }
    return prefix;
  }
}
