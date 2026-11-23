/**
 * git 2.x's legacy remotes: a remote defined by a file `$GIT_COMMON_DIR/remotes/<name>` or
 * `$GIT_COMMON_DIR/branches/<name>` instead of the configuration (remote.c
 * `read_remotes_file`, `read_branches_file`). git reads them when it looks a remote up by
 * name and the configuration gives that name no URL; git 3.0 (`WITH_BREAKING_CHANGES`,
 * `GitHostEnvironment.breakingChanges`) never reads them.
 *
 * @example
 * ```text
 * $ cat .git/remotes/upstream          $ cat .git/branches/vendor
 * URL: https://example.com/r.git       https://example.com/v.git#stable
 * Pull: refs/heads/main:refs/heads/upstream
 * Push: refs/heads/main:refs/heads/main
 * ```
 *
 * The branches file fetches `refs/heads/stable:refs/heads/vendor` and pushes
 * `HEAD:refs/heads/stable`; without `#<branch>` the branch is `init.defaultBranch`, else
 * `master`.
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { type LegacyRemote, RemoteConfigStore, setLegacyRemote } from "../remote-config/index.js";
import { defaultBranchHint } from "./default-branch.js";
import { commonGitFileOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";

/** What {@link loadLegacyRemote} found, and the lines git prints on stderr reading it. */
export interface LegacyRemoteLoad {
  remote?: LegacyRemote;
  /**
   * git's stderr while it reads the files, each entry one message (lines joined by `\n`):
   * 2.5x's deprecation warning per file read, and the `advice.defaultBranchName` hint of a
   * branches file without `#<branch>` (2.43 prints only the hint, in its own words)
   */
  messages: string[];
}

/**
 * Reads the legacy remote `name` of a working copy, as remote.c's `remotes_remote_get_1`
 * does, and records it for the working copy's {@link RemoteConfigStore}s (they see it while
 * the configuration gives the name no URL): nothing under git 3.0, for a name that is no
 * valid remote nickname (empty, `.`, `..`, a `/`), or for a remote the configuration gives a
 * URL; else `remotes/<name>`, then, while there is still no URL, `branches/<name>`.
 *
 * @param compatibility The git whose stderr to give: 2.43 has no deprecation warning
 */
export async function loadLegacyRemote(
  workingCopy: WorkingCopy,
  name: string,
  compatibility: "2.43" | "2.56" = "2.56",
): Promise<LegacyRemoteLoad> {
  const messages: string[] = [];
  const store = RemoteConfigStore.from(workingCopy);
  setLegacyRemote(workingCopy, name, undefined);
  if (hostEnvironmentOf(workingCopy)?.breakingChanges) return { messages };
  if (!isValidRemoteNick(name) || store.remoteUrls(name).length > 0) return { messages };

  let remote: LegacyRemote | undefined;
  const remotesFile = await readGitFile(workingCopy, `remotes/${name}`);
  if (remotesFile !== undefined) {
    if (compatibility !== "2.43") messages.push(deprecationWarning("remotes", name));
    remote = { ...parseRemotesFile(remotesFile), origin: "remotes", followTags: false };
  }
  if (!remote || remote.urls.length === 0) {
    const branchesFile = await readGitFile(workingCopy, `branches/${name}`);
    if (branchesFile !== undefined) {
      if (compatibility !== "2.43") messages.push(deprecationWarning("branches", name));
      const line = (branchesFile.split("\n")[0] ?? "").trim();
      if (line) {
        const at = line.indexOf("#");
        let branch: string;
        if (at >= 0) branch = line.slice(at + 1);
        else {
          const found = defaultBranchName(store, compatibility);
          branch = found.name;
          if (found.hint) messages.push(found.hint);
        }
        const url = at >= 0 ? line.slice(0, at) : line;
        remote = {
          origin: "branches",
          urls: [...(remote?.urls ?? []), url],
          fetchRefspecs: [
            ...(remote?.fetchRefspecs ?? []),
            `refs/heads/${branch}:refs/heads/${name}`,
          ],
          pushRefspecs: [...(remote?.pushRefspecs ?? []), `HEAD:refs/heads/${branch}`],
          followTags: true,
        };
      }
    }
  }
  setLegacyRemote(workingCopy, name, remote);
  return { remote, messages };
}

/**
 * Removes the file a legacy remote was read from (builtin/remote.c `migrate_file`'s
 * `unlink_or_warn`) and forgets the remote; a file already gone is no error.
 */
export async function removeLegacyRemoteFile(
  workingCopy: WorkingCopy,
  origin: "remotes" | "branches",
  name: string,
): Promise<void> {
  const file = await commonGitFileOf(workingCopy, `${origin}/${name}`);
  if (file) await file.files.remove(file.path).catch(() => false);
  setLegacyRemote(workingCopy, name, undefined);
}

/** remote.c's `valid_remote_nick`: not empty, `.` or `..`, and no `/`. */
export function isValidRemoteNick(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/");
}

/**
 * Parses a `remotes/<name>` file as `read_remotes_file`: each line, its trailing
 * whitespace dropped, is a `URL:`, `Push:` or `Pull:` line (the value's leading whitespace
 * dropped) or ignored.
 */
export function parseRemotesFile(
  text: string,
): Pick<LegacyRemote, "urls" | "fetchRefspecs" | "pushRefspecs"> {
  const urls: string[] = [];
  const fetchRefspecs: string[] = [];
  const pushRefspecs: string[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/[\t\n\v\f\r ]+$/, "");
    const value = (prefix: string) => line.slice(prefix.length).replace(/^[\t\n\v\f\r ]+/, "");
    if (line.startsWith("URL:")) urls.push(value("URL:"));
    else if (line.startsWith("Push:")) pushRefspecs.push(value("Push:"));
    else if (line.startsWith("Pull:")) fetchRefspecs.push(value("Pull:"));
  }
  return { urls, fetchRefspecs, pushRefspecs };
}

/** 2.5x's `warn_about_deprecated_remote_type`, as `warning()` prints it. */
function deprecationWarning(type: "remotes" | "branches", name: string): string {
  return [
    `warning: reading remote from "${type}/${name}", which is nominated for removal.`,
    "",
    'If you still use the "remotes/" directory it is recommended to',
    "migrate to config-based remotes:",
    "",
    `\tgit remote rename ${name} ${name}`,
    "",
    "If you cannot, please let us know why you still need to use it by",
    "sending an e-mail to <git@vger.kernel.org>.",
  ].join("\n");
}

/**
 * refs.c's `repo_default_branch_name(repo, 0)`: `init.defaultBranch` (every scope of the
 * working copy's configuration), else `master` with the `advice.defaultBranchName` hint.
 */
function defaultBranchName(
  store: RemoteConfigStore,
  compatibility: "2.43" | "2.56",
): { name: string; hint?: string } {
  const configured = store.value("init.defaultBranch");
  if (configured !== undefined && configured !== "") return { name: configured };
  const name = "master";
  const advice = store.value("advice.defaultBranchName");
  if (advice !== undefined && parseGitBool(advice) === false) return { name };
  const hint =
    compatibility === "2.43" ? defaultBranchHint243(name) : defaultBranchHint(name, false);
  return { name, hint: hint.join("\n") };
}

/** git 2.43's `default_branch_name_advice` (an empty line is `hint: `, with its space). */
function defaultBranchHint243(name: string): string[] {
  return [
    `Using '${name}' as the name for the initial branch. This default branch name`,
    "is subject to change. To configure the initial branch name to use in all",
    "of your new repositories, which will suppress this warning, call:",
    "",
    "\tgit config --global init.defaultBranch <name>",
    "",
    "Names commonly chosen instead of 'master' are 'main', 'trunk' and",
    "'development'. The just-created branch can be renamed via this command:",
    "",
    "\tgit branch -m <name>",
  ].map((line) => `hint: ${line}`);
}

/**
 * A file of the common git directory as text, or undefined when it is not a regular file
 * (absent, a directory: `fopen_or_warn` reads nothing from either).
 */
async function readGitFile(workingCopy: WorkingCopy, name: string): Promise<string | undefined> {
  const file = await commonGitFileOf(workingCopy, name);
  if (!file) return undefined;
  return readText(file.files, file.path);
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  try {
    if ((await files.stats(path))?.kind !== "file") return undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read(path)) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
