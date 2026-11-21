/**
 * git's hooks (githooks(5), hook.c): finding a hook as `find_hook` does and running it
 * through the host's {@link HookRunner}.
 *
 * ```typescript
 * const hooks = new HookSession(workingCopy);
 * const result = await hooks.run("pre-commit", { env: { GIT_INDEX_FILE: ".git/index" } });
 * if (result && result.exitCode !== 0) throw new Error("pre-commit refused the commit");
 * hooks.output; // what the hook wrote (git relays it on stderr), and any hints
 * ```
 *
 * A hook is a file named after it in `core.hooksPath` (relative to the worktree top, the git
 * directory when bare; `~/` the home directory) or else in `$GIT_DIR/hooks` (the common git
 * directory of a linked worktree). It counts only when executable: a file that is not gets
 * git's `advice.ignoredHook` hint, once per hook name. Without a runner on the host
 * environment (`GitHostEnvironment.hookRunner`), nothing is looked up and no hook runs.
 *
 * Every hook runs in the worktree top (the git directory when bare) with `GIT_PREFIX` empty,
 * as git's setup exports it, plus the variables of the call; its stdout goes to its stderr
 * unless the call asks otherwise (`RUN_HOOKS_OPT_INIT`'s `stdout_to_stderr`).
 */

import type { RefTransactionHook } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  expandUserPath,
  type GitHostEnvironment,
  type HookOutcome,
  type HookRunner,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { GitApiError, HookFailedError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { configBool, configValue } from "./merge-config.js";

/** What a hook is given beyond its name. */
export interface HookCallOptions {
  /** Arguments after the script */
  args?: string[];
  /** What the hook reads on stdin (text is written as UTF-8) */
  stdin?: string | Uint8Array;
  /** Variables set for the hook (GIT_INDEX_FILE, GIT_EDITOR, ...) */
  env?: Record<string, string>;
  /** Keep the hook's stdout apart (default false: sent to stderr, as git's hooks) */
  keepStdout?: boolean;
  /**
   * The directory the hook runs in, a path of the repository's FilesApi, in place of the
   * worktree top (git's `opt.dir`: `worktree add` runs post-checkout in the new worktree);
   * the hook is then named by its absolute path, as git names it there
   */
  dir?: string;
  /**
   * Whether git's setup exported `GIT_PREFIX` (default true: the commands that run in a
   * repository; `clone` and the receive side do not)
   */
  prefix?: boolean;
}

/** What running a hook gave: its exit code and output as text. */
export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A hook found: where it is, for the runner and for git's messages. */
export interface FoundHook {
  /** The path git names it by, relative to the hook's directory or absolute */
  path: string;
  /** Its path in the repository's FilesApi, when it lies there */
  filesPath?: string;
  /** Its absolute path on the host, when known */
  hostPath?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const trimSlashes = (path: string) => path.replace(/^\/+/, "").replace(/\/+$/, "");

/** `a` and `b` joined as FilesApi paths ("" is the root). */
function joinFilesPath(a: string, b: string): string {
  const left = trimSlashes(a);
  const right = trimSlashes(b);
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** A path with `.` and `..` components resolved (no leading slash). */
function normalizeFilesPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Whether resolving `..` components of a FilesApi path climbs above the root. */
function leavesFilesRoot(path: string): boolean {
  let depth = 0;
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return true;
      depth--;
    } else depth++;
  }
  return false;
}

/** `path` relative to `from` (both FilesApi paths). */
function relativeFilesPath(from: string, path: string): string {
  const a = normalizeFilesPath(from).split("/").filter(Boolean);
  const b = normalizeFilesPath(path).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** The host's absolute path of a FilesApi path, where the FilesApi has a root directory. */
function hostPathOf(files: FilesApi, path: string): string | undefined {
  const root = (files as { rootDirectory?: string }).rootDirectory;
  if (!root) return undefined;
  const base = root.replace(/\/+$/, "");
  const rest = normalizeFilesPath(path);
  return rest ? `${base}/${rest}` : base || "/";
}

/** The FilesApi path of an absolute host path inside the FilesApi's root directory. */
function filesPathOfHost(files: FilesApi, hostPath: string): string | undefined {
  const root = (files as { rootDirectory?: string }).rootDirectory;
  if (!root) return undefined;
  const base = root.replace(/\/+$/, "");
  if (hostPath === base) return "";
  if (!hostPath.startsWith(`${base}/`)) return undefined;
  return normalizeFilesPath(hostPath.slice(base.length + 1));
}

/** The hook runner of a working copy's host environment, if any. */
export function hookRunnerOf(workingCopy: WorkingCopy): HookRunner | undefined {
  return hostEnvironmentOf(workingCopy)?.hookRunner;
}

/** Where the repository's files are, for hooks: its FilesApi, worktree top and git dirs. */
export interface HookLayout {
  files: FilesApi;
  /** The worktree top ("" for the FilesApi root) */
  top: string;
  /** The git directory */
  gitDir: string;
  /** Where the hook runs: the worktree top, the git directory when bare */
  cwd: string;
  bare: boolean;
}

/**
 * The repository a {@link HookSession} runs hooks of: where its files are, its settings and
 * the host's environment (the runner). A working copy gives all three (see
 * {@link hookHostOf}); the receive side of a local push gives the remote repository's.
 */
export interface HookHost {
  layout(): Promise<HookLayout | undefined>;
  configValue(key: string): string | undefined;
  environment(): GitHostEnvironment | undefined;
  /**
   * The `hook.<name>.<variable>` settings (event, command, enabled) in the configuration's
   * order, for git 2.5x's configured hooks; absent: none are configured
   */
  hookSettings?(): HookSetting[];
}

/** One `hook.<name>.<variable>` setting (git 2.5x's configured hooks). */
export interface HookSetting {
  /** The hook's friendly name (`<name>`) */
  name: string;
  variable: "event" | "command" | "enabled";
  /** The value as git reads it (unquoted); undefined for a variable without `=` */
  value: string | undefined;
  /** The file it was read from, as the host names it (absent where the config cannot tell) */
  file?: string;
  /** Its line in that file, from 1 */
  line?: number;
  /** The scope of that file (git's `config_scope_name`: `local`, `global`, ...) */
  scope?: string;
}

/** The hook host of a working copy. */
export function hookHostOf(workingCopy: WorkingCopy): HookHost {
  return {
    layout: () => hookLayout(workingCopy),
    configValue: (key) => configValue(workingCopy, key),
    environment: () => hostEnvironmentOf(workingCopy),
    hookSettings: () => hookSettingsOf(workingCopy),
  };
}

const HOOK_VARIABLES = ["event", "command", "enabled"] as const;

/**
 * The `hook.*` settings of a working copy's configuration, in its order: by file (in the
 * order the files are first met) and line where the configuration tells them, else as read.
 */
function hookSettingsOf(workingCopy: WorkingCopy): HookSetting[] {
  const store = RemoteConfigStore.from(workingCopy);
  let names: string[];
  try {
    names = store.subsections("hook");
  } catch {
    return [];
  }
  const found: Array<HookSetting & { seq: number }> = [];
  for (const name of names) {
    for (const variable of HOOK_VARIABLES) {
      const key = `hook.${name}.${variable}`;
      // the values as git reads them (unquoted, unescaped; undefined without `=`) and where
      // they were read, for the order and git's messages
      for (const where of store.valuesWithOrigin(key)) {
        found.push({
          name,
          variable,
          value: where.text,
          ...(where.file !== undefined ? { file: where.file } : {}),
          ...(where.line !== undefined ? { line: where.line } : {}),
          ...(where.scope !== undefined ? { scope: where.scope } : {}),
          seq: found.length,
        });
      }
    }
  }
  const fileOrder = new Map<string, number>();
  for (const f of found)
    if (f.file !== undefined && !fileOrder.has(f.file)) fileOrder.set(f.file, fileOrder.size);
  const rank = (f: (typeof found)[number]) =>
    f.file !== undefined && f.line !== undefined
      ? [fileOrder.get(f.file) ?? 0, f.line]
      : [Number.MAX_SAFE_INTEGER, f.seq];
  return found
    .sort((a, b) => {
      const [fa, la] = rank(a);
      const [fb, lb] = rank(b);
      return (fa as number) - (fb as number) || (la as number) - (lb as number) || a.seq - b.seq;
    })
    .map(({ seq: _seq, ...setting }) => setting);
}

/**
 * The `hook.<name>.<variable>` settings (event, command, enabled) among a configuration's
 * entries in the order git reads them (an opened repository's `listWithOrigin`, else `list`
 * without origins): the hook settings of a repository a push reaches.
 */
export function hookSettingsFromEntries(
  entries: ReadonlyArray<{
    key: string;
    value: string | null;
    file?: string;
    line?: number;
    scope?: string;
  }>,
): HookSetting[] {
  const out: HookSetting[] = [];
  for (const e of entries) {
    const first = e.key.indexOf(".");
    const last = e.key.lastIndexOf(".");
    if (first < 0 || last <= first) continue;
    if (e.key.slice(0, first).toLowerCase() !== "hook") continue;
    const variable = e.key.slice(last + 1).toLowerCase();
    if (variable !== "event" && variable !== "command" && variable !== "enabled") continue;
    out.push({
      name: e.key.slice(first + 1, last),
      variable,
      value: e.value === null ? undefined : e.value,
      ...(e.file !== undefined ? { file: e.file } : {}),
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.scope !== undefined ? { scope: e.scope } : {}),
    });
  }
  return out;
}

/** git's hook names (hook-list.h, from githooks(5)): no friendly name may be one of them. */
const KNOWN_HOOKS = new Set([
  "applypatch-msg",
  "commit-msg",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "p4-prepare-changelist",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-receive",
  "post-rewrite",
  "post-update",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "pre-receive",
  "prepare-commit-msg",
  "proc-receive",
  "push-to-checkout",
  "reference-transaction",
  "sendemail-validate",
  "update",
]);

/** Whether `name` is one of git's hooks (hook.c `is_known_hook`, hook-list.h). */
export function isKnownHook(name: string): boolean {
  return KNOWN_HOOKS.has(name);
}

/**
 * What git 2.5x dies with (or warns of) on reading the configured hooks, which it does on
 * looking up any hook (hook.c `hook_config_lookup_all`, `build_hook_config_map`): a
 * variable without `=` (`error: missing value for ...`, then git's `bad config variable`), a
 * friendly name that is a known hook name, a name of some event with no command (unless
 * disabled). Returns the fatal message (undefined when none) and git's warnings (a friendly
 * name equal to its event; a disabled one without a command).
 */
export function hookSettingsCheck(settings: readonly HookSetting[]): {
  fatal?: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const events = new Map<string, string[]>();
  const commands = new Set<string>();
  const disabled = new Set<string>();
  for (const s of settings) {
    const key = `hook.${s.name}.${s.variable}`;
    if (s.value === undefined) {
      const fatal =
        s.file !== undefined && s.line !== undefined
          ? `fatal: bad config variable '${key}' in file '${s.file}' at line ${s.line}`
          : `fatal: unable to parse '${key}' from command-line config`;
      return { fatal: `error: missing value for '${key}'\n${fatal}`, warnings };
    }
    if (s.variable === "event") {
      if (s.value === "") {
        for (const list of events.values()) {
          const at = list.indexOf(s.name);
          if (at >= 0) list.splice(at, 1);
        }
        continue;
      }
      if (KNOWN_HOOKS.has(s.name)) {
        return {
          fatal: `fatal: hook friendly-name '${s.name}' collides with a known event name; please choose a different friendly-name`,
          warnings,
        };
      }
      if (s.name === s.value) {
        warnings.push(
          `warning: hook friendly-name '${s.name}' is the same as its event; this may cause ambiguity with hook.${s.name}.enabled`,
        );
      }
      const list = events.get(s.value) ?? [];
      const at = list.indexOf(s.name);
      if (at >= 0) list.splice(at, 1);
      list.push(s.name);
      events.set(s.value, list);
    } else if (s.variable === "command") {
      commands.add(s.name);
    } else {
      const enabled = parseGitBool(s.value);
      if (enabled === false) disabled.add(s.name);
      else if (enabled === true) disabled.delete(s.name);
    }
  }
  for (const list of events.values()) {
    for (const name of list) {
      if (commands.has(name)) continue;
      if (disabled.has(name)) {
        warnings.push(`warning: disabled hook '${name}' has no command configured`);
        continue;
      }
      return {
        fatal: `fatal: 'hook.${name}.command' must be configured or 'hook.${name}.event' must be removed; aborting.`,
        warnings,
      };
    }
  }
  return { warnings };
}

/** One configured hook of an event, as git 2.5x's `list_hooks` keeps it (`git hook list`). */
export interface ConfiguredHookEntry {
  /** Its friendly name (`hook.<name>`) */
  name: string;
  /** Its `hook.<name>.command` (absent: only a disabled hook may have none) */
  command?: string;
  /** `hook.<name>.enabled=false` */
  disabled: boolean;
  /** The whole event is disabled (`hook.<event>.enabled=false`, `<event>` no friendly name) */
  eventDisabled: boolean;
  /** The scope of its last event line (`local`, `global`, ...), where the config tells */
  scope?: string;
}

/**
 * git 2.5x's configured hooks of `event` (hook.c `build_hook_config_map`,
 * `list_hooks_add_configured`): the friendly names whose `hook.<name>.event` names it, in the
 * order of their last such line (an empty value drops the name from every event), each with
 * its last `hook.<name>.command`, whether `hook.<name>.enabled=false` disables it and whether
 * the event itself is disabled (`hook.<event>.enabled=false`, `<event>` not a friendly name).
 * Disabled ones are kept, as `git hook list` shows them; none of them runs.
 */
export function configuredHookEntries(
  settings: readonly HookSetting[],
  event: string,
): ConfiguredHookEntry[] {
  const events = new Map<string, Array<{ name: string; scope?: string }>>();
  const commands = new Map<string, string>();
  const disabled = new Set<string>();
  const drop = (list: Array<{ name: string }>, name: string) => {
    const at = list.findIndex((e) => e.name === name);
    if (at >= 0) list.splice(at, 1);
  };
  for (const s of settings) {
    if (s.variable === "event") {
      if (s.value === undefined) continue;
      if (s.value === "") {
        // an empty value drops the name from every event
        for (const list of events.values()) drop(list, s.name);
        continue;
      }
      // moved to the end of its event's list (last-seen order)
      const list = events.get(s.value) ?? [];
      drop(list, s.name);
      list.push({ name: s.name, ...(s.scope !== undefined ? { scope: s.scope } : {}) });
      events.set(s.value, list);
    } else if (s.variable === "command") {
      if (s.value !== undefined) commands.set(s.name, s.value);
    } else {
      const enabled = parseGitBool(s.value ?? "true");
      if (enabled === false) disabled.add(s.name);
      else if (enabled === true) disabled.delete(s.name);
    }
  }
  const friendly = (name: string) =>
    commands.has(name) || [...events.values()].some((list) => list.some((e) => e.name === name));
  const eventDisabled = disabled.has(event) && !friendly(event);
  return (events.get(event) ?? []).map(({ name, scope }) => {
    const command = commands.get(name);
    return {
      name,
      ...(command !== undefined ? { command } : {}),
      disabled: disabled.has(name),
      eventDisabled,
      ...(scope !== undefined ? { scope } : {}),
    };
  });
}

/**
 * git 2.5x's configured hooks of `event` that run (see {@link configuredHookEntries}): those
 * neither disabled nor of a disabled event. A name with no command is left out (git refuses
 * to run any hook then, see {@link hookSettingsCheck}).
 */
export function configuredHooks(
  settings: readonly HookSetting[],
  event: string,
): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  for (const e of configuredHookEntries(settings, event)) {
    if (e.command === undefined || e.disabled || e.eventDisabled) continue;
    out.push({ name: e.name, command: e.command });
  }
  return out;
}

/** One hook `git hook list` lists: a configured one or the hooks directory's script. */
export type HookListEntry =
  | ({ kind: "configured" } & ConfiguredHookEntry)
  | {
      kind: "traditional";
      /** The script's path as git names it (`.git/hooks/pre-commit`) */
      path: string;
    };

/** A hook to run: a script of the hooks directory or one the configuration defines. */
type HookToRun =
  | { kind: "traditional"; found: FoundHook }
  | { kind: "configured"; name: string; command: string };

async function hookLayout(workingCopy: WorkingCopy): Promise<HookLayout | undefined> {
  let worktree:
    | { getFiles?(): FilesApi; getGitDir?(): string | undefined; getRoot?(): string }
    | undefined;
  try {
    worktree = workingCopy.worktree as typeof worktree;
  } catch {
    // a bare repository's working copy refuses its worktree
    return undefined;
  }
  const files = worktree?.getFiles?.();
  const gitDir = worktree?.getGitDir?.();
  if (!files || gitDir === undefined) return undefined;
  const top = normalizeFilesPath(worktree?.getRoot?.() ?? "");
  const bareValue = configValue(workingCopy, "core.bare");
  const bare = bareValue !== undefined && configBool(workingCopy, "core.bare", false);
  const dir = normalizeFilesPath(gitDir);
  return { files, top, gitDir: dir, cwd: bare ? dir : top, bare };
}

/** The common git directory of `gitDir` (its `commondir` file), as a FilesApi path. */
async function commonDirOf(files: FilesApi, gitDir: string): Promise<string> {
  const path = joinFilesPath(gitDir, "commondir");
  try {
    if ((await files.stats(path))?.kind !== "file") return gitDir;
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read(path)) chunks.push(chunk);
    const text = decoder
      .decode(chunks.length === 1 ? chunks[0] : concat(chunks))
      .replace(/\r?\n$/, "");
    if (!text) return gitDir;
    if (text.startsWith("/")) return filesPathOfHost(files, text) ?? gitDir;
    return normalizeFilesPath(joinFilesPath(gitDir, text));
  } catch {
    return gitDir;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** What `access(path, X_OK)` says: executable, present but not executable, or absent. */
async function accessOf(
  files: FilesApi | undefined,
  filesPath: string | undefined,
  hostPath: string | undefined,
  environment: GitHostEnvironment | undefined,
): Promise<"executable" | "not-executable" | "absent"> {
  if (files && filesPath !== undefined) {
    try {
      return await filesAccessOf(files, filesPath, environment);
    } catch {
      return "absent";
    }
  }
  return hostAccessOf(hostPath, environment);
}

/** `access(X_OK)` of a host path, by its stat (links followed) through the host. */
async function hostAccessOf(
  hostPath: string | undefined,
  environment: GitHostEnvironment | undefined,
): Promise<"executable" | "not-executable" | "absent"> {
  if (!hostPath || !environment?.statFile) return "absent";
  const stats = await environment.statFile(hostPath);
  if (!stats) return "absent";
  if (stats.kind === "directory" || stats.mode === undefined) return "executable";
  return (stats.mode & 0o111) !== 0 ? "executable" : "not-executable";
}

/** The most links followed before giving up (the kernel's ELOOP limit). */
const MAX_LINK_HOPS = 40;

/**
 * `access(X_OK)` of a FilesApi path: a symbolic link followed to its target (through the
 * FilesApi while the target lies in it, else by its host path through the host), whose mode
 * decides, as `access` follows links. A FilesApi without `lstat` gives no modes: present
 * counts as executable.
 */
async function filesAccessOf(
  files: FilesApi,
  start: string,
  environment: GitHostEnvironment | undefined,
): Promise<"executable" | "not-executable" | "absent"> {
  const posix = files as {
    lstat?(path: string): Promise<{ kind: string; mode?: number } | undefined>;
    readlink?(path: string): Promise<Uint8Array | undefined>;
  };
  if (!posix.lstat) {
    const stats = await files.stats(start);
    return stats ? "executable" : "absent";
  }
  let path = normalizeFilesPath(start);
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const link = await posix.lstat(path);
    if (!link) return "absent";
    if (link.kind !== "symlink") {
      if (link.kind !== "file" || link.mode === undefined) return "executable";
      return (link.mode & 0o111) !== 0 ? "executable" : "not-executable";
    }
    const raw = posix.readlink ? await posix.readlink(path) : undefined;
    if (!raw) return "absent";
    const target = decoder.decode(raw);
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    if (target.startsWith("/")) {
      const inside = filesPathOfHost(files, target);
      if (inside === undefined) return hostAccessOf(target, environment);
      path = inside;
      continue;
    }
    // a relative target that climbs out of the FilesApi is reached through the host
    if (escapesRoot(parent ? `${parent}/${target}` : target)) {
      const parentHost = hostPathOf(files, parent);
      return hostAccessOf(parentHost ? `${parentHost}/${target}` : undefined, environment);
    }
    path = normalizeFilesPath(joinFilesPath(parent, target));
  }
  return "absent";
}

/** Whether a relative path's `..` components climb above its root. */
function escapesRoot(path: string): boolean {
  let depth = 0;
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) return true;
    } else depth++;
  }
  return false;
}

/**
 * The hooks one command runs, with git's per-process memory of the hints given and the
 * output the hooks wrote (git relays it on its stderr, the hints included).
 */
export class HookSession {
  /** The hook names whose `advice.ignoredHook` hint was given (git's `advise_given`) */
  private readonly advised = new Set<string>();
  /** What the hooks wrote, and the hints, in order */
  private readonly chunks: string[] = [];
  /** What the hooks whose stdout git keeps apart (pre-push) wrote there */
  private readonly stdoutChunks: string[] = [];

  private readonly host: HookHost;
  /** Variables every hook of this session gets, below each call's own (see {@link withEnv}) */
  private processEnv: Record<string, string> = {};

  constructor(source: WorkingCopy | HookHost) {
    this.host = "layout" in source ? source : hookHostOf(source);
  }

  /**
   * A session sharing this one's output and hints whose hooks all get `env` too (below each
   * call's own variables): the hooks of a git command git runs as a child process with
   * variables set, as a sequencer's `git commit` with GIT_REFLOG_ACTION.
   */
  withEnv(env: Record<string, string>): HookSession {
    const derived = Object.create(HookSession.prototype) as HookSession;
    Object.assign(derived, this);
    derived.processEnv = { ...this.processEnv, ...env };
    return derived;
  }

  private get runner(): HookRunner | undefined {
    return this.host.environment()?.hookRunner;
  }

  /**
   * The committer variables the host sets (`GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`), as
   * the host environment's `committer` gives them: what git's http-backend checks before
   * naming the pushing user the committer of its children.
   */
  get hostCommitter(): { name?: string; email?: string } {
    return this.host.environment()?.committer ?? {};
  }

  /** Whether hooks can run at all: the host environment has a runner. */
  get enabled(): boolean {
    return this.runner !== undefined;
  }

  /** The runner's git version (default 2.56). */
  get compatibility(): "2.43" | "2.56" {
    return this.runner?.compatibility ?? "2.56";
  }

  /** Everything the hooks wrote (stderr, and stdout sent there) and the hints, as git shows it. */
  get output(): string {
    return this.chunks.join("");
  }

  /** What the hooks whose stdout git keeps on its own stdout wrote there (pre-push). */
  get stdout(): string {
    return this.stdoutChunks.join("");
  }

  /** Text added to the output, as git writes its own messages between the hooks' output. */
  append(text: string): void {
    if (text) this.chunks.push(text);
  }

  /**
   * A file of the git directory as git names it to hooks (`git_path`): relative to the
   * directory the hooks run in (`.git/index`, `.git/COMMIT_EDITMSG`), else absolute.
   * `absolute` names it by its host path where there is one, as git names a lock file
   * (lockfile.c resolves the path it locks: `index.lock` of `commit -a`).
   */
  async gitPath(name: string, absolute = false): Promise<string> {
    const layout = await this.host.layout();
    if (!layout) return `.git/${name}`;
    const filesPath = joinFilesPath(layout.gitDir, name);
    if (absolute) {
      const host = hostPathOf(layout.files, filesPath);
      if (host) return host;
    }
    const relative = relativeFilesPath(layout.cwd, filesPath);
    if (!relative.startsWith("../")) return relative;
    return hostPathOf(layout.files, filesPath) ?? filesPath;
  }

  /** A file of the git directory as the repository's FilesApi names it (no layout: none). */
  async gitFile(name: string): Promise<{ files: FilesApi; path: string } | undefined> {
    const layout = await this.host.layout();
    return layout ? { files: layout.files, path: joinFilesPath(layout.gitDir, name) } : undefined;
  }

  /**
   * A file of the repository's common directory (the main git directory of a linked
   * worktree: `objects/`, `packed-refs`) as the repository's FilesApi names it.
   */
  async commonGitFile(name: string): Promise<{ files: FilesApi; path: string } | undefined> {
    const layout = await this.host.layout();
    if (!layout) return undefined;
    return {
      files: layout.files,
      path: joinFilesPath(await commonDirOf(layout.files, layout.gitDir), name),
    };
  }

  /**
   * A path of the repository's FilesApi as hooks are told it: its absolute host path where the
   * files have one (as git names `GIT_QUARANTINE_PATH`), else relative to the directory the
   * hooks run in; as given without a layout.
   */
  async hookPathOf(filesPath: string): Promise<string> {
    const layout = await this.host.layout();
    if (!layout) return filesPath;
    return hostPathOf(layout.files, filesPath) ?? relativeFilesPath(layout.cwd, filesPath);
  }

  /**
   * The bytes of a file a git option names (`git hook run --to-stdin=<path>`): a relative
   * path from the directory git runs in (the worktree top, the git directory when bare),
   * through the repository's FilesApi; an absolute one through it when it lies there, else
   * through the host. Undefined when it cannot be read.
   */
  async readFileAt(path: string): Promise<Uint8Array | undefined> {
    const layout = await this.host.layout();
    const environment = this.host.environment();
    // A relative path that climbs above the FilesApi's root names a host file outside it:
    // resolve it against the host path of the directory git runs in, never clamp it.
    let hostPath = path.startsWith("/") ? path : undefined;
    let filesPath: string | undefined;
    if (layout && !path.startsWith("/")) {
      const joined = joinFilesPath(layout.cwd, path);
      if (leavesFilesRoot(joined)) {
        const hostCwd = hostPathOf(layout.files, layout.cwd);
        if (!hostCwd) return undefined;
        hostPath = `/${normalizeFilesPath(`${hostCwd}/${path}`)}`;
        filesPath = filesPathOfHost(layout.files, hostPath);
      } else {
        filesPath = normalizeFilesPath(joined);
      }
    } else if (layout && hostPath) {
      filesPath = filesPathOfHost(layout.files, hostPath);
    }
    try {
      if (layout && filesPath !== undefined) {
        if ((await layout.files.stats(filesPath))?.kind !== "file") return undefined;
        const chunks: Uint8Array[] = [];
        for await (const chunk of layout.files.read(filesPath)) chunks.push(chunk);
        return chunks.length === 1 ? chunks[0] : concat(chunks);
      }
      if (hostPath && environment) return await environment.readFile(hostPath);
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** The git directory's absolute host path, where the repository's files have one. */
  async hostGitDir(): Promise<string | undefined> {
    const layout = await this.host.layout();
    return layout ? hostPathOf(layout.files, layout.gitDir) : undefined;
  }

  /** Whether `name` exists as an executable hook (git's `hook_exists`), giving no hint. */
  async exists(name: string): Promise<boolean> {
    if (!this.enabled) return false;
    return (await this.list(name, false)).length > 0;
  }

  /**
   * The hooks of `name` git runs, in order (hook.c `list_hooks`): the configured ones (git
   * 2.5x, see {@link configuredHooks}), then the hooks directory's script ({@link find}).
   */
  private async list(name: string, advise = true): Promise<HookToRun[]> {
    const out: HookToRun[] = [];
    if (this.compatibility !== "2.43") {
      const settings = this.host.hookSettings?.() ?? [];
      if (settings.length > 0) this.checkSettings(settings);
      for (const hook of configuredHooks(settings, name)) out.push({ kind: "configured", ...hook });
    }
    const found = await this.find(name, advise);
    if (found) out.push({ kind: "traditional", found });
    return out;
  }

  /**
   * Every hook of `name` git 2.5x's `list_hooks` keeps, in order (`git hook list`): the
   * configured ones, disabled ones included (see {@link configuredHookEntries}; none under
   * 2.43), then the hooks directory's script ({@link find}, its hint given). Throws git's
   * fatal error for a broken `hook.*` configuration.
   */
  async listAll(name: string): Promise<HookListEntry[]> {
    const out: HookListEntry[] = [];
    if (this.compatibility !== "2.43") {
      const settings = this.host.hookSettings?.() ?? [];
      if (settings.length > 0) this.checkSettings(settings);
      for (const entry of configuredHookEntries(settings, name)) {
        out.push({ kind: "configured", ...entry });
      }
    }
    const found = await this.find(name);
    if (found) out.push({ kind: "traditional", path: found.path });
    return out;
  }

  /** Whether the configured hooks' warnings were given (git gives them once per process). */
  private settingsChecked = false;

  /**
   * git 2.5x's checks of the configured hooks on a hook's lookup ({@link hookSettingsCheck}):
   * its warnings once, its fatal error thrown (on every lookup, as each git process dies).
   */
  private checkSettings(settings: readonly HookSetting[]): void {
    const { fatal, warnings } = hookSettingsCheck(settings);
    if (!this.settingsChecked) {
      this.settingsChecked = true;
      if (warnings.length > 0) this.append(`${warnings.join("\n")}\n`);
    }
    if (fatal) throw new GitApiError(fatal);
  }

  /**
   * The hook `name` (git's `find_hook`): undefined when absent or not executable; the latter
   * gives the `advice.ignoredHook` hint (once per name) unless `advise` is false.
   */
  async find(name: string, advise = true): Promise<FoundHook | undefined> {
    const layout = await this.host.layout();
    if (!layout) return undefined;
    const environment = this.host.environment();
    const configured = this.host.configValue("core.hooksPath");
    let found: FoundHook;
    if (configured !== undefined && configured !== "") {
      const expanded = expandUserPath(configured, environment) ?? configured;
      const named = `${expanded.replace(/\/+$/, "")}/${name}`;
      if (named.startsWith("/")) {
        const filesPath = filesPathOfHost(layout.files, named);
        found = { path: named, hostPath: named, ...(filesPath !== undefined ? { filesPath } : {}) };
      } else {
        const filesPath = normalizeFilesPath(joinFilesPath(layout.cwd, named));
        const hostPath = hostPathOf(layout.files, filesPath);
        found = { path: named, filesPath, ...(hostPath ? { hostPath } : {}) };
      }
    } else {
      const commonDir = await commonDirOf(layout.files, layout.gitDir);
      const filesPath = joinFilesPath(commonDir, `hooks/${name}`);
      const hostPath = hostPathOf(layout.files, filesPath);
      // git names it from its git directory, which it reaches relative to the worktree top
      // when inside it (".git/hooks/pre-commit"), else by its absolute path
      const inside =
        !layout.top || filesPath.startsWith(`${layout.top}/`) || layout.bare
          ? relativeFilesPath(layout.cwd, filesPath)
          : undefined;
      const path = inside && !inside.startsWith("../") ? inside : (hostPath ?? filesPath);
      found = { path, filesPath, ...(hostPath ? { hostPath } : {}) };
    }
    const access = await accessOf(layout.files, found.filesPath, found.hostPath, environment);
    if (access === "executable") return found;
    if (
      access === "not-executable" &&
      advise &&
      (parseGitBool(this.host.configValue("advice.ignoredHook")) ?? true) &&
      !this.advised.has(name)
    ) {
      this.advised.add(name);
      const set = this.compatibility === "2.43" ? "" : " set";
      this.append(
        `hint: The '${found.path}' hook was ignored because it's not set as executable.\n` +
          `hint: You can disable this warning with \`git config${set} advice.ignoredHook false\`.\n`,
      );
    }
    return undefined;
  }

  /**
   * Runs the hook `name` (git's `run_hooks_opt`): undefined when there is none (or no
   * runner), else its exit code and output. Its output is kept in {@link output}.
   */
  async run(name: string, options: HookCallOptions = {}): Promise<HookResult | undefined> {
    const runner = this.runner;
    if (!runner) return undefined;
    const hooks = await this.list(name);
    if (hooks.length === 0) return undefined;
    const layout = await this.host.layout();
    if (!layout) return undefined;
    // each in turn, their exit codes or'ed together (hook.c notify_hook_finished)
    let ran: HookResult | undefined;
    for (const hook of hooks) {
      const result = await this.runOne(runner, layout, name, hook, options);
      if (!result) continue;
      ran = ran
        ? {
            exitCode: ran.exitCode | result.exitCode,
            stdout: ran.stdout + result.stdout,
            stderr: ran.stderr + result.stderr,
          }
        : result;
    }
    return ran;
  }

  /** Runs one hook of `name` (see {@link run}). */
  private async runOne(
    runner: HookRunner,
    layout: HookLayout,
    name: string,
    toRun: HookToRun,
    options: HookCallOptions,
  ): Promise<HookResult | undefined> {
    const cwd = options.dir !== undefined ? normalizeFilesPath(options.dir) : layout.cwd;
    const hostCwd = hostPathOf(layout.files, cwd);
    const hook: FoundHook = toRun.kind === "traditional" ? toRun.found : { path: toRun.command };
    // in another directory (git's opt.dir) the hook is named by its absolute path, else by
    // its path from that directory
    const path =
      toRun.kind === "configured" || options.dir === undefined || hook.path.startsWith("/")
        ? hook.path
        : (hook.hostPath ??
          relativeFilesPath(cwd, hook.filesPath ?? joinFilesPath(layout.cwd, hook.path)));
    const stdin =
      options.stdin === undefined
        ? undefined
        : typeof options.stdin === "string"
          ? encoder.encode(options.stdin)
          : options.stdin;
    let outcome: HookOutcome | undefined;
    try {
      outcome = await runner.run({
        name,
        path,
        ...(hook.hostPath ? { hostPath: hook.hostPath } : {}),
        args: options.args ?? [],
        ...(stdin ? { stdin } : {}),
        env: {
          ...(options.prefix === false ? {} : { GIT_PREFIX: "" }),
          ...this.processEnv,
          ...(options.env ?? {}),
        },
        cwd,
        ...(hostCwd ? { hostCwd } : {}),
        stdoutToStderr: !options.keepStdout,
        ...(toRun.kind === "configured" ? { command: toRun.command } : {}),
      });
    } catch (error) {
      // git's notify_start_failure: the hook counts as failed
      this.append(
        `error: cannot run ${hook.path}: ${String((error as Error)?.message ?? error)}\n`,
      );
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (!outcome) return undefined;
    const result = {
      exitCode: outcome.exitCode,
      stdout: decoder.decode(outcome.stdout),
      stderr: decoder.decode(outcome.stderr),
    };
    this.append(result.stderr);
    if (result.stdout) this.stdoutChunks.push(result.stdout);
    return result;
  }
}

/** git's null object id of the length of `like` (sha1 when none is known). */
export function nullIdLike(like?: string): string {
  return "0".repeat(like?.length === 64 ? 64 : 40);
}

/**
 * The post-checkout hook (githooks(5)): the HEAD left and the one checked out (git's null id
 * for none) and `1` for a branch switch, `0` for a path checkout. Its exit code (0 when no
 * hook ran) becomes the command's exit status in git.
 */
export async function runPostCheckoutHook(
  hooks: HookSession,
  oldId: string | undefined,
  newId: string | undefined,
  branchSwitch: boolean,
  env?: Record<string, string>,
  /** The directory it runs in (a FilesApi path), in place of the worktree top */
  dir?: string,
  /** Whether git's setup exported `GIT_PREFIX` (not for clone) */
  prefix = true,
): Promise<number> {
  if (!hooks.enabled) return 0;
  const like = oldId ?? newId;
  const result = await hooks.run("post-checkout", {
    args: [oldId ?? nullIdLike(like), newId ?? nullIdLike(like), branchSwitch ? "1" : "0"],
    ...(env ? { env } : {}),
    ...(dir !== undefined ? { dir } : {}),
    prefix,
  });
  return result?.exitCode ?? 0;
}

/** What the sequencer's hooks write: `COMMIT_EDITMSG` and the rest of the git directory's state. */
export interface SequencerHookState {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
}

/**
 * try_to_commit's prepare-commit-msg (sequencer.c `run_prepare_commit_msg_hook`): when the
 * hook exists, the message written to COMMIT_EDITMSG, the hook told `message`, and the file's
 * text taken back as the commit's message. A failing hook throws git's "'prepare-commit-msg'
 * hook failed". Without the hook, the message as it is.
 */
export async function sequencerPrepareMessage(
  hooks: HookSession,
  state: SequencerHookState,
  message: string,
): Promise<string> {
  if (!hooks.enabled || !(await hooks.exists("prepare-commit-msg"))) return message;
  await state.write("COMMIT_EDITMSG", message);
  const file = await hooks.gitPath("COMMIT_EDITMSG");
  const result = await hooks.run("prepare-commit-msg", {
    args: [file, "message"],
    env: { GIT_INDEX_FILE: await hooks.gitPath("index"), GIT_EDITOR: ":" },
  });
  if (result && result.exitCode !== 0) {
    throw new HookFailedError(
      "prepare-commit-msg",
      result.exitCode,
      "error: 'prepare-commit-msg' hook failed",
      hooks.output,
    );
  }
  return (await state.read("COMMIT_EDITMSG")) ?? message;
}

/** try_to_commit's post-commit hook (`run_commit_hook(0, index_file, ..., "post-commit")`). */
export async function sequencerPostCommit(hooks: HookSession): Promise<void> {
  if (!hooks.enabled) return;
  await hooks.run("post-commit", {
    env: { GIT_INDEX_FILE: await hooks.gitPath("index"), GIT_EDITOR: ":" },
  });
}

/**
 * git's reference-transaction hook (refs.c `run_transaction_hook`) for a ref store's
 * transactions: told `preparing` (2.5x), `prepared`, `committed` or `aborted` with an
 * `<old> <new> <ref>` line per update (git 2.43 lists a symbolic ref the update went
 * through, HEAD, ahead of the ref it names; 2.5x leaves it out); a refusal in `preparing`
 * or `prepared` aborts the transaction. Calls about a transaction only the other git
 * version makes (`context.only`) are left out.
 */
export function refTransactionHookOf(
  hooks: HookSession,
  /** How the hook runs beyond its state and stdin (the receive side: GIT_DIR, no prefix) */
  runOptions: Pick<HookCallOptions, "env" | "prefix"> = {},
): RefTransactionHook {
  return async (state, updates, context) => {
    const legacy = hooks.compatibility === "2.43";
    if (context?.only && context.only !== hooks.compatibility) return true;
    if (state === "preparing" && legacy) return true;
    const lines: string[] = [];
    // git 2.43's log-only updates: the symbolic ref asked for keeps its place, the ref it
    // names and HEAD's line for a ref it names are appended, in order (split_symref_update,
    // split_head_update)
    const appended: string[] = [];
    for (const u of updates) {
      const zero = nullIdLike(u.new ?? u.old ?? undefined);
      const next = u.newTarget !== undefined ? `ref:${u.newTarget}` : (u.new ?? zero);
      const line = (name: string) => `${u.old ?? zero} ${next} ${name}\n`;
      if (state === "preparing") lines.push(line(u.requested));
      else if (legacy && u.requested !== u.name) {
        lines.push(line(u.requested));
        for (const n of u.through ?? []) appended.push(line(n));
        appended.push(line(u.name));
        if (u.viaHead) appended.push(line("HEAD"));
      } else {
        lines.push(line(u.name));
        if (legacy && u.viaHead) appended.push(line("HEAD"));
      }
    }
    const result = await hooks.run("reference-transaction", {
      ...runOptions,
      args: [state],
      stdin: [...lines, ...appended].join(""),
    });
    if (!result || result.exitCode === 0 || state === "committed" || state === "aborted") {
      return true;
    }
    // 2.43 dies with one message for every state
    return legacy ? "ref updates aborted by hook" : false;
  };
}

/** How a sequencer runs `git commit` (sequencer.c `run_git_commit`), for its hooks. */
export interface GitCommitHookRun {
  /** VERIFY_MSG: pre-commit and commit-msg run (else `git commit -n`) */
  verify: boolean;
  /** EDIT_MSG (`-e`): an editor runs, so the hooks get no `GIT_EDITOR=:` */
  editor: boolean;
  /** prepare-commit-msg's arguments after the message file (`message`, `commit HEAD`) */
  hookArgs: string[];
  /** Variables of the `git commit` run (`GIT_REFLOG_ACTION`) */
  env?: Record<string, string>;
}

/** The variables of the hooks of a `git commit` run (run_commit_hook). */
async function gitCommitHookEnv(
  hooks: HookSession,
  run: GitCommitHookRun,
  index = true,
): Promise<Record<string, string>> {
  return {
    ...(index ? { GIT_INDEX_FILE: await hooks.gitPath("index") } : {}),
    ...(run.editor ? {} : { GIT_EDITOR: ":" }),
    ...(run.env ?? {}),
  };
}

/**
 * The hooks of a `git commit` a sequencer runs, up to the commit (builtin/commit.c
 * `prepare_to_commit`): pre-commit (with VERIFY_MSG), `template` written to COMMIT_EDITMSG
 * for prepare-commit-msg, the editor over what it left (`edit`), then commit-msg (with
 * VERIFY_MSG). The file's text once they ran; a refusing hook throws {@link HookFailedError}.
 */
export async function gitCommitMessageHooks(
  hooks: HookSession,
  state: SequencerHookState,
  template: string,
  run: GitCommitHookRun,
  edit: (text: string) => string | Promise<string>,
): Promise<string> {
  const env = await gitCommitHookEnv(hooks, run);
  const refuse = async (name: string, args: string[] = []) => {
    const result = await hooks.run(name, { args, env });
    if (result && result.exitCode !== 0) {
      throw new HookFailedError(
        name,
        result.exitCode,
        `the ${name} hook refused the commit (exit code ${result.exitCode})`,
        hooks.output,
      );
    }
  };
  if (run.verify) await refuse("pre-commit");
  await state.write("COMMIT_EDITMSG", template);
  const file = await hooks.gitPath("COMMIT_EDITMSG");
  await refuse("prepare-commit-msg", [file, ...run.hookArgs]);
  const edited = await edit((await state.read("COMMIT_EDITMSG")) ?? template);
  await state.write("COMMIT_EDITMSG", edited);
  if (run.verify) await refuse("commit-msg", [file]);
  return (await state.read("COMMIT_EDITMSG")) ?? edited;
}

/**
 * The hooks of a `git commit` a sequencer runs, once HEAD has moved: post-commit, then for an
 * amend post-rewrite told `amend` with `<old> <new>` (commit_post_rewrite).
 */
export async function gitCommitAfterHooks(
  hooks: HookSession,
  run: GitCommitHookRun,
  amended?: { from: string; to: string },
): Promise<void> {
  if (!hooks.enabled) return;
  await hooks.run("post-commit", { env: await gitCommitHookEnv(hooks, run) });
  if (amended) {
    await hooks.run("post-rewrite", {
      args: ["amend"],
      stdin: `${amended.from} ${amended.to}\n`,
      env: await gitCommitHookEnv(hooks, run, false),
    });
  }
}
