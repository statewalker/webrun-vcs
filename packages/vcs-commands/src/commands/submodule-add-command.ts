/**
 * `git submodule add` (builtin/submodule--helper.c `module_add`, `add_submodule`,
 * `clone_submodule`, `configure_added_submodule`), over the submodule model of
 * `submodule-model.ts` and the clone, checkout and add commands.
 */
import { FileMode } from "@statewalker/vcs-core";
import type { GitTransportRegistry } from "@statewalker/vcs-transport";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { AddCommand } from "./add-command.js";
import { CheckoutCommand } from "./checkout-command.js";
import { checkSubmoduleName } from "./fsck/fsck-object-checks.js";
import { commonGitFileOf } from "./git-hooks.js";
import { DO_MATCH_DIRECTORY, matchPathspec, parsePathspec } from "./pathspec.js";
import { SubmoduleCommandBase, type SubmoduleCommandResult } from "./submodule-commands.js";
import {
  joinFilesPath,
  relativeFilesPath,
  resolveRelativeUrl,
  submodulePathConfigOf,
  worktreeHostPath,
} from "./submodule-model.js";

const ADD_USAGE = [
  "usage: git submodule add [<options>] [--] <repository> [<path>]",
  "",
  "    -b, --[no-]branch <branch>",
  "                          branch of repository to add as submodule",
  "    -f, --[no-]force      allow adding an otherwise ignored submodule path",
  "    -q, --[no-]quiet      print only error messages",
  "    --[no-]progress       force cloning progress",
  "    --[no-]reference <repository>",
  "                          reference repository",
  "    --[no-]ref-format <format>",
  "                          specify the reference format to use",
  "    --[no-]dissociate     borrow the objects from reference repositories",
  "    --[no-]name <name>    sets the submodule's name to the given string instead of defaulting to its path",
  "    --[no-]depth <n>      depth for shallow clones",
  "",
].join("\n");

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
const isDirSep = (c: string | undefined) => c === "/";

/**
 * git's `git_url_basename(repo, 0, 0)` (dir.c): the directory `git clone <repo>` would
 * make: the last component of the URL without scheme, credentials, trailing slashes, `/.git`,
 * a host's port or a `.git` suffix; control characters and runs of spaces become one space.
 *
 * @throws GitApiError "No directory name could be guessed." where git dies
 *
 * @example
 * ```typescript
 * gitUrlBasename("https://example.com/org/lib.git"); // "lib"
 * gitUrlBasename("../up/.git");                      // "up"
 * ```
 */
export function gitUrlBasename(repo: string): string {
  const noGuess = () =>
    new GitApiError(
      "fatal: No directory name could be guessed.\nPlease specify a directory on the command line",
    );
  let end = repo.length;
  const scheme = repo.indexOf("://");
  let start = scheme < 0 ? 0 : scheme + 3;
  for (let p = start; p < end && !isDirSep(repo[p]); p++) if (repo[p] === "@") start = p + 1;
  while (start < end && (isDirSep(repo[end - 1]) || isSpace(repo[end - 1]))) end--;
  if (end - start > 5 && isDirSep(repo[end - 5]) && repo.slice(end - 4, end) === ".git") {
    end -= 5;
    while (start < end && isDirSep(repo[end - 1])) end--;
  }
  if (end - start < 0) throw noGuess();
  const part = repo.slice(start, end);
  if (!part.includes("/") && part.includes(":")) {
    let p = end;
    while (start < p && /[0-9]/.test(repo[p - 1] ?? "")) p--;
    if (start < p && repo[p - 1] === ":") end = p - 1;
  }
  let p = end;
  while (start < p && !isDirSep(repo[p - 1]) && repo[p - 1] !== ":") p--;
  start = p;
  let name = repo.slice(start, end);
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (name === "" || name === "/") throw noGuess();
  let out = "";
  let prevSpace = true;
  for (const ch of name) {
    const c = ch.charCodeAt(0) < 0x20 ? " " : ch;
    if (isSpace(c)) {
      if (prevSpace) continue;
      prevSpace = true;
    } else prevSpace = false;
    out += c;
  }
  return out.replace(/ +$/, "");
}

/**
 * git's `normalize_path_copy` of a submodule path: `//` collapsed, `.` components dropped,
 * `..` taking the component before it; the path as given when it climbs above the top (git
 * then goes on with what it wrote so far, which this does not reproduce). A trailing `/`
 * stays.
 */
function normalizeSubmodulePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return path;
      out.pop();
    } else out.push(part);
  }
  const joined = out.join("/");
  const trailing = path.startsWith("/") ? "/" : "";
  return `${trailing}${joined}${path.endsWith("/") && joined ? "/" : ""}`;
}

/**
 * `git submodule add [-b <branch>] [-f] [-q] [--name <name>] [--reference <repo>]
 * [--depth <n>] <repository> [<path>]`: the repository cloned into
 * `.git/modules/<name>` (`--no-checkout`, then `checkout -f -q [-B <branch>
 * origin/<branch>]`), linked to its worktree at `<path>` by a gitfile and `core.worktree`,
 * then registered: `submodule.<name>.url` (a `./` or `../` URL resolved against the
 * superproject's default remote, else its own directory) and `submodule.<name>.active` in
 * `.git/config`, `path`, `url` (as given) and `branch` in `.gitmodules`, the gitlink and
 * `.gitmodules` staged.
 *
 * A repository already at the path is added as it is ("Adding existing repo at ..."); a git
 * directory kept from an earlier submodule of that name is refused without `-f` and
 * reactivated with it. As git, a local URL is cloned with `GIT_PROTOCOL_FROM_USER=0`, so
 * `protocol.file.allow` must be `always` (git 2.38+'s default is `user`).
 *
 * Refusals are git's: a path the index holds, an ignored path without `-f` (exit status 1,
 * git add's message), a URL that is neither absolute nor `./`/`../`, an invalid name, a name
 * another path uses (git 2.5x; `-f` picks `<name><n>`), a directory that is no repository,
 * a repository without a commit, a missing `.gitmodules` the index or HEAD has.
 *
 * @example
 * ```typescript
 * const { stderr } = await git.submoduleAdd().setURI("../lib").setPath("lib").call();
 * // "Cloning into '/work/super/lib'...\ndone.\n"
 * ```
 */
export class SubmoduleAddCommand extends SubmoduleCommandBase {
  private uri?: string;
  private path?: string;
  private name?: string;
  private branch?: string;
  private force = false;
  private reference?: string;
  private depth?: number;
  private transports?: GitTransportRegistry;

  /** `<repository>`: the URL to clone (absolute, or `./`/`../` relative to the remote). */
  setURI(uri: string): this {
    this.checkCallable();
    this.uri = uri;
    return this;
  }

  /** `<path>`: where the submodule goes (default: the URL's basename, as `git clone`'s). */
  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  /** `--name <name>`: the submodule's name (default: its path). */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /** `-b <branch>`: check out and record this branch of the repository. */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /** `-f`: add an ignored path, reuse a kept git directory, rename a clashing name. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `--reference <repository>`: borrow objects from it (clone's `--reference`). */
  setReference(reference: string): this {
    this.checkCallable();
    this.reference = reference;
    return this;
  }

  /** `--depth <n>`: a shallow clone (ignored, with git's warning, for a local path). */
  setDepth(depth: number): this {
    this.checkCallable();
    this.depth = depth;
    return this;
  }

  /** The transports the clone reaches non-local URLs through. */
  setTransports(transports: GitTransportRegistry): this {
    this.checkCallable();
    this.transports = transports;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    if (!(await this.writingGitmodulesOk())) {
      this.die("fatal: please make sure that the .gitmodules file is in the working tree");
    }
    if (this.uri === undefined) this.die(ADD_USAGE, 129);
    const repo = this.uri;
    let path: string;
    try {
      path = this.path ?? gitUrlBasename(repo);
    } catch (error) {
      if (error instanceof GitApiError) this.die(error.message);
      throw error;
    }

    let realrepo: string;
    // starts_with_dot_slash / starts_with_dot_dot_slash ('/' only, on POSIX)
    if (/^\.\.?\//.test(repo)) {
      try {
        realrepo = await resolveRelativeUrl(this.workingCopy, repo, undefined, { quiet: true });
      } catch (error) {
        if (error instanceof GitApiError) this.die(error.message);
        throw error;
      }
    } else if (repo.startsWith("/") || repo.includes(":")) {
      realrepo = repo;
    } else {
      this.die(`fatal: repo URL: '${repo}' must be absolute or begin with ./|../`);
    }

    path = normalizeSubmodulePath(path);
    // strip_dir_trailing_slashes
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    if (this.compatibility !== "2.43") await this.validatePath(path);
    await this.dieOnIndexMatch(path);
    await this.dieOnRepoWithoutCommits(path);

    if (!this.force) {
      // `git add --dry-run --ignore-missing --no-warn-embedded-repo <path>`, which takes the
      // index lock first (and dies when another process holds it)
      const refusal = await this.indexLockRefusal();
      if (refusal !== undefined) {
        this.out.stderr += `${refusal}\n`;
        this.out.exitCode = 128;
        return this.finish();
      }
      try {
        await new AddCommand(this.workingCopy)
          .setCompatibility(this.compatibility)
          .setDryRun(true)
          .setIgnoreMissing(true)
          .setWarnEmbeddedRepo(false)
          .addFilepattern(path)
          .call();
      } catch (error) {
        if (!(error instanceof GitApiError)) throw error;
        this.out.stderr += `${error.message}\n`;
        this.out.exitCode = error.exitCode || 1;
        return this.finish();
      }
    }

    let name = this.name ?? path;
    if (this.compatibility !== "2.43") {
      const model = await this.model();
      const existing = model.fromName(name);
      if (existing?.path !== undefined && existing.path !== path) {
        if (!this.force) {
          this.die(`fatal: submodule name '${name}' already used for path '${existing.path}'`);
        }
        let i = 1;
        while (model.fromName(`${name}${i}`)) i++;
        name = `${name}${i}`;
      }
    }
    if (!checkSubmoduleName(name)) this.die(`fatal: '${name}' is not a valid submodule name`);

    if (await submodulePathConfigOf(this.workingCopy)) await this.createDefaultGitdirConfig(name);

    await this.addSubmodule(path, name, realrepo);
    await this.configureAddedSubmodule(path, name, repo, realrepo);
    return this.finish();
  }

  /** submodule.c's `is_writing_gitmodules_ok`. */
  private async writingGitmodulesOk(): Promise<boolean> {
    const files = this.worktreeAccess?.getFiles?.() as
      | { lstat?(p: string): Promise<unknown> }
      | undefined;
    const there = files?.lstat
      ? (await files.lstat(this.filesPath(".gitmodules")).catch(() => undefined)) !== undefined
      : (await this.kindOf(".gitmodules")) !== undefined;
    if (there) return true;
    for await (const entry of this.staging.entries()) {
      if (entry.path === ".gitmodules") return false;
    }
    const head = await this.resolveRevision("HEAD:.gitmodules").catch(() => undefined);
    return head === undefined;
  }

  /**
   * git's `unable_to_lock_die` lines when another process holds the index lock (`git add`
   * takes it even for a dry run), undefined once it was taken and released.
   */
  private async indexLockRefusal(): Promise<string | undefined> {
    let lock: Awaited<ReturnType<NonNullable<typeof this.staging.lockIndex>>> | undefined;
    try {
      lock = await this.staging.lockIndex?.();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "IndexLockedError") throw error;
      const lockPath = `${await this.hostGitDir()}/index.lock`;
      const advice =
        this.compatibility === "2.43"
          ? [
              "Another git process seems to be running in this repository, e.g.",
              "an editor opened by 'git commit'. Please make sure all processes",
              "are terminated then try again. If it still fails, a git process",
              "may have crashed in this repository earlier:",
              "remove the file manually to continue.",
            ]
          : [
              "Another git process seems to be running in this repository, or the lock file may be stale",
            ];
      return [`fatal: Unable to create '${lockPath}': File exists.`, "", ...advice].join("\n");
    }
    await lock?.rollback();
    return undefined;
  }

  /** The host path of the superproject's git directory (git's absolute `get_git_dir()`). */
  private async hostGitDir(): Promise<string> {
    const configured = (this.workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
    if (configured) return configured.replace(/\/+$/, "");
    const worktree = this.worktreeAccess;
    const gitDir = worktree?.getGitDir?.() ?? ".git";
    const top = await worktreeHostPath(this.workingCopy);
    if (top === undefined) return gitDir;
    const rel = relativeFilesPath(worktree?.getRoot() ?? "", gitDir);
    return `/${joinFilesPath(top, rel)}`;
  }

  /** submodule--helper.c's `die_on_index_match`. */
  private async dieOnIndexMatch(path: string): Promise<void> {
    // parse_pathspec's prefix_path: a path outside the worktree dies
    const top = (await worktreeHostPath(this.workingCopy)) ?? "";
    const outside = path.startsWith("/")
      ? path !== top && !path.startsWith(`${top}/`)
      : path.split("/").includes(".."); // what normalization could not resolve
    if (outside) this.die(`fatal: ${path}: '${path}' is outside repository at '${top}'`);
    const items = parsePathspec([path]);
    for await (const entry of this.staging.entries()) {
      const isDir = entry.mode === FileMode.GITLINK || entry.mode === FileMode.TREE;
      if (matchPathspec(items, entry.path, isDir ? DO_MATCH_DIRECTORY : 0) <= 0) continue;
      if (!this.force) this.die(`fatal: '${path}' already exists in the index`);
      if (entry.mode !== FileMode.GITLINK) {
        this.die(`fatal: '${path}' already exists in the index and is not a submodule`);
      }
      return;
    }
  }

  /** submodule--helper.c's `die_on_repo_without_commits`. */
  private async dieOnRepoWithoutCommits(path: string): Promise<void> {
    const worktree = this.worktreeAccess;
    if (!(await worktree?.isRepository?.(path).catch(() => false))) return;
    const head = await worktree?.readGitlinkHead?.(path).catch(() => undefined);
    if (head === undefined) this.die(`fatal: '${path}' does not have a commit checked out`);
  }

  /** submodule--helper.c's `add_submodule`. */
  private async addSubmodule(path: string, name: string, realrepo: string): Promise<void> {
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) this.die("fatal: no worktree to add a submodule to");
    if ((await this.kindOf(path)) === "directory") {
      if (await worktree.isRepository?.(path).catch(() => false)) {
        this.out.stdout += `Adding existing repo at '${path}' to the index\n`;
        return;
      }
      this.die(`fatal: '${path}' already exists and is not a valid git repo`);
    }
    const model = await this.model();
    let gitDir: string | undefined;
    try {
      gitDir = await model.gitDirOf(name);
    } catch (error) {
      if (error instanceof GitApiError) this.die(error.message);
      throw error;
    }
    if (gitDir === undefined) this.die("fatal: no git directory to keep the submodule in");
    const common = await commonGitFileOf(this.workingCopy, "modules");
    const gitFiles = common?.files ?? files;
    const gitDirKind = (await gitFiles.stats(gitDir).catch(() => undefined))?.kind;
    if (gitDirKind === "directory") {
      if (!this.force) {
        const remotes = await this.fetchRemotesOf(path, name);
        this.die(
          [
            `fatal: A git directory for '${name}' is found locally with remote(s):`,
            ...remotes,
            "If you want to reuse this local git directory instead of cloning again from",
            `  ${realrepo}`,
            "use the '--force' option. If the local git directory is not the correct repo",
            "or you are unsure what this means choose another name with the '--name' option.",
          ].join("\n"),
        );
      }
      this.out.stdout += `Reactivating local git directory for submodule '${name}'\n`;
    }
    await this.cloneSubmodule(path, realrepo, gitDir, gitFiles, gitDirKind !== undefined, {
      ...(this.depth !== undefined ? { depth: this.depth } : {}),
      ...(this.reference !== undefined ? { references: [this.reference] } : {}),
      ...(this.transports ? { transports: this.transports } : {}),
    });

    const inner = await worktree.openGitlink?.(path).catch(() => undefined);
    if (!inner) this.die(`fatal: unable to checkout submodule '${path}'`);
    const checkout = new CheckoutCommand(inner).setForced(true).setQuiet(true);
    // `checkout -f -q`: HEAD's tree, HEAD left as it is
    if (this.branch === undefined) checkout.setName("HEAD");
    else {
      checkout
        .setName(this.branch)
        .setForceCreateBranch(true)
        .setStartPoint(`origin/${this.branch}`);
    }
    try {
      await checkout.call();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.out.stderr += `${error.message}\n`;
      this.die(`fatal: unable to checkout submodule '${path}'`);
    }
  }

  /** The `git remote -v` fetch lines of the kept git directory, as git lists them. */
  private async fetchRemotesOf(path: string, name: string): Promise<string[]> {
    const inner = await this.worktreeAccess?.openGitlink?.(path, { name }).catch(() => undefined);
    if (!inner) return [];
    const store = RemoteConfigStore.from(inner);
    const lines: string[] = [];
    for (const remote of [...store.configuredNames()].sort()) {
      const urls = store.remoteUrls(remote);
      lines.push(`  ${remote}\t${urls[0] ?? ""}`);
    }
    return lines;
  }

  /** submodule--helper.c's `configure_added_submodule`. */
  private async configureAddedSubmodule(
    path: string,
    name: string,
    repo: string,
    realrepo: string,
  ): Promise<void> {
    await this.setConfig(`submodule.${name}.url`, realrepo);
    try {
      await new AddCommand(this.workingCopy)
        .setCompatibility(this.compatibility)
        .setWarnEmbeddedRepo(false)
        .setForce(this.force)
        .addFilepattern(path)
        .call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      this.out.stderr += `${error.message}\n`;
      this.die(`fatal: Failed to add submodule '${path}'`);
    }
    await this.setInGitmodules(`submodule.${name}.path`, path);
    await this.setInGitmodules(`submodule.${name}.url`, repo);
    if (this.branch !== undefined) {
      await this.setInGitmodules(`submodule.${name}.branch`, this.branch);
    }
    try {
      await new AddCommand(this.workingCopy)
        .setCompatibility(this.compatibility)
        .setForce(true)
        .addFilepattern(".gitmodules")
        .call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      this.out.stderr += `${error.message}\n`;
      this.die(`fatal: Failed to register submodule '${path}'`);
    }
    const patterns = RemoteConfigStore.from(this.workingCopy)
      .valuesWithOrigin("submodule.active")
      .map((v) => v.text);
    // a valueless `submodule.active` makes repo_config_get_string_multi fail: active set
    const matched =
      patterns.length > 0 &&
      !patterns.some((p) => p === null) &&
      patterns.some((p) => wildmatch(p as string, path));
    if (!matched) await this.setConfig(`submodule.${name}.active`, "true");
  }
}
