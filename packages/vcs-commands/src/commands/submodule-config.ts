/**
 * The submodule settings `git status` reads: the name of the submodule at a path (from
 * `.gitmodules`), and how much of its state to ignore (`submodule.<name>.ignore` in the
 * repository's config, else in `.gitmodules`; `diff.ignoreSubmodules`).
 */

/** How much of a submodule's state git ignores (`--ignore-submodules=<when>`). */
export type SubmoduleIgnoreMode = "none" | "untracked" | "dirty" | "all";

/** One submodule of `.gitmodules`. */
export interface GitmodulesEntry {
  name: string;
  path?: string;
  ignore?: string;
}

/** Whether the value is one git accepts for an ignore setting. */
export function isSubmoduleIgnoreMode(value: string | undefined): value is SubmoduleIgnoreMode {
  return value === "none" || value === "untracked" || value === "dirty" || value === "all";
}

/** git's diff flags for an ignore mode (`handle_ignore_submodules_arg`). */
export interface SubmoduleIgnoreFlags {
  /** Ignore the submodule entirely (`all`) */
  all: boolean;
  /** Ignore its worktree: only its commit counts (`dirty`) */
  dirty: boolean;
  /** Ignore untracked files inside it (`untracked`) */
  untracked: boolean;
}

/** The flags of an ignore mode. */
export function submoduleIgnoreFlags(mode: SubmoduleIgnoreMode): SubmoduleIgnoreFlags {
  return { all: mode === "all", dirty: mode === "dirty", untracked: mode === "untracked" };
}

/**
 * The submodules of a `.gitmodules` file (git's config syntax: `[submodule "name"]`
 * sections with `path` and `ignore`), by section, in file order.
 *
 * @example
 * ```typescript
 * parseGitmodules('[submodule "lib"]\n\tpath = libs/lib\n\tignore = dirty\n');
 * // [{ name: "lib", path: "libs/lib", ignore: "dirty" }]
 * ```
 */
export function parseGitmodules(text: string): GitmodulesEntry[] {
  const out = new Map<string, GitmodulesEntry>();
  let current: GitmodulesEntry | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      current = undefined;
      const m = line.match(/^\[\s*([A-Za-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"\s*\](.*)$/);
      if (!m || m[1].toLowerCase() !== "submodule") continue;
      const name = m[2].replace(/\\(.)/g, "$1");
      current = out.get(name) ?? { name };
      out.set(name, current);
      line = m[3].trim();
      if (line === "") continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? "true" : configValue(line.slice(eq + 1));
    if (key === "path") current.path = value;
    else if (key === "ignore") current.ignore = value;
  }
  return [...out.values()];
}

/** A config value: quotes removed, escapes resolved, an unquoted comment dropped. */
function configValue(input: string): string {
  let out = "";
  let quoted = false;
  let pendingSpace = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && i + 1 < input.length) {
      const n = input[++i];
      out += pendingSpace + (n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n);
      pendingSpace = "";
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "#" || c === ";")) break;
    else if (!quoted && (c === " " || c === "\t")) {
      if (out !== "") pendingSpace += c;
    } else {
      out += pendingSpace + c;
      pendingSpace = "";
    }
  }
  return out;
}
