/**
 * Git LFS configuration as git-lfs reads it (v3, `config/git_fetcher.go`,
 * `git/config.go` `Sources`, `lfsapi/endpoint_finder.go`, `lfshttp/endpoint.go`): the
 * repository's `.lfsconfig` (the worktree's file, else the index's stage-0 blob, else
 * HEAD's; HEAD's alone in a bare repository) read first, then the whole git configuration,
 * the last value of a key winning. `.lfsconfig` is repository content: only git-lfs's safe
 * keys are taken from it (`lfs.url`, `lfs.pushurl`, `remote.<name>.lfsurl`, ...), the others
 * are ignored with git-lfs's warning.
 *
 * The LFS endpoint of an operation (`download`, `upload`) and remote follows git-lfs's order:
 * `lfs.pushurl` (upload), `lfs.url`, then the remote's `lfspushurl` (upload), `lfsurl`, then
 * its `pushurl` (upload) or `url` with `.git/info/lfs` appended (`/info/lfs` after a `.git`
 * path), the remote named `origin` when the asked remote gives none. URLs go through
 * `url.<base>.insteadOf` (`pushInsteadOf` for uploads) and Go's URL reading, so an ssh remote
 * gives `https://<host><path>` and its ssh metadata, a `git://` one `lfs.gitprotocol`
 * (default `https`).
 *
 * @example
 * ```typescript
 * const lfs = await LfsConfig.load(workingCopy);
 * const ep = await lfs.endpoint("download", lfs.remote());
 * ep.url; // "https://example.com/foo/bar.git/info/lfs"
 * ```
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { ConfigParseError, GitWorkingCopyConfig } from "@statewalker/vcs-store-files";
import { collectChunks, type WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../../git-command.js";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { hostEnvironmentOf } from "../git-ident.js";
import { worktreeHostPath } from "../submodule-model.js";
import { type GoUrl, goUrlParse, goUrlString } from "./go-url.js";

/** The LFS operation an endpoint is for. */
export type LfsEndpointOperation = "download" | "upload";

/** git-lfs's `UrlUnknown`: an ssh URL whose host cannot be read. */
export const LFS_URL_UNKNOWN = "<unknown>";

/** How git-lfs reaches an endpoint over ssh (`git-lfs-authenticate`, `git-lfs-transfer`). */
export interface LfsSshMetadata {
  /** `user@host`, or `host` */
  userAndHost: string;
  /** The port, `""` for ssh's default */
  port: string;
  path: string;
}

/** Which setting gave an endpoint. */
export type LfsEndpointSource =
  | "lfs.pushurl"
  | "lfs.url"
  | "remote.lfspushurl"
  | "remote.lfsurl"
  | "remote.pushurl"
  | "remote.url"
  /** The remote's name read as a URL (a remote without URL, or a URL given as the remote) */
  | "remote.name";

/** An LFS endpoint, as git-lfs's `lfshttp.Endpoint`. */
export interface LfsEndpoint {
  /**
   * The endpoint's URL: `""` when nothing names one, {@link LFS_URL_UNKNOWN} for an ssh URL
   * whose host cannot be read; a `file://` URL for a local repository
   */
  url: string;
  operation: LfsEndpointOperation;
  /** The remote whose settings gave the endpoint (`origin` after a fallback) */
  remote: string;
  /** Present for an ssh URL */
  ssh?: LfsSshMetadata;
  /** The setting that gave it; absent when nothing did */
  source?: LfsEndpointSource;
  /**
   * The setting's value came from `.lfsconfig` (repository content), not the git
   * configuration; {@link LfsEndpointCommand} also sets it when `.lfsconfig` chose the remote
   */
  fromLfsconfig: boolean;
}

/** Where `.lfsconfig` was read from. */
export type LfsconfigSource =
  | { kind: "worktree" }
  | { kind: "index"; id: ObjectId }
  | { kind: "head"; id: ObjectId }
  | { kind: "none" };

/** git-lfs's `safeKeys`: what `.lfsconfig` may set. */
const SAFE_KEYS = new Set([
  "lfs.allowincompletepush",
  "lfs.fetchexclude",
  "lfs.fetchinclude",
  "lfs.gitprotocol",
  "lfs.locksverify",
  "lfs.pushurl",
  "lfs.skipdownloaderrors",
  "lfs.url",
]);

interface LfsValue {
  value: string;
  lfsconfig: boolean;
}

/** A host path's kind, links followed (Go's `os.Stat`). */
type HostStat = (path: string) => Promise<"file" | "directory" | "other" | undefined>;

/** What {@link LfsConfig.load} reads besides the configuration. */
export interface LfsConfigLoadOptions {
  /** Leave `.lfsconfig` out (the user's own configuration alone) */
  withoutLfsconfig?: boolean;
}

/** Reads `.lfsconfig` as git-lfs's `Sources` does. */
class LfsconfigReader extends GitCommand<{ bytes?: Uint8Array; source: LfsconfigSource }> {
  async call(): Promise<{ bytes?: Uint8Array; source: LfsconfigSource }> {
    const blob = async (id: ObjectId) => collectChunks((await this.blobs.load(id)) ?? []);
    const head = async (): Promise<{ bytes?: Uint8Array; source: LfsconfigSource }> => {
      const id = await this.resolveRevision("HEAD:.lfsconfig").catch(() => undefined);
      if (id === undefined) return { source: { kind: "none" } };
      return { bytes: await blob(id), source: { kind: "head", id } };
    };
    const worktree = this.worktreeAccess;
    if (!worktree) return head();
    const file = await worktree.getEntry(".lfsconfig").catch(() => undefined);
    if (file) {
      // git-lfs stats and reads the file through its links; ours never follows a link out
      // of the worktree (repository content), so a linked `.lfsconfig` gives nothing
      if (file.isDirectory || file.mode === FileMode.SYMLINK) return { source: { kind: "none" } };
      return {
        bytes: await collectChunks(worktree.readContent(".lfsconfig")),
        source: { kind: "worktree" },
      };
    }
    // `git config --blob :.lfsconfig`: the stage-0 entry only
    let staged: ObjectId | undefined;
    for await (const entry of this.staging.entries()) {
      if (entry.path !== ".lfsconfig") continue;
      if (entry.stage === 0) staged = entry.objectId;
    }
    if (staged !== undefined) {
      return { bytes: await blob(staged), source: { kind: "index", id: staged } };
    }
    return head();
  }
}

/** Every `key=value` of a config text, keys canonical, in file order (`git config -l`). */
async function configLines(bytes: Uint8Array, name: string): Promise<[string, string][]> {
  const config = new GitWorkingCopyConfig(
    { read: async () => bytes, write: async () => {} },
    name,
    // git-lfs passes `--includes`; ours never follows an include of repository content
    { includes: false },
  );
  await config.load();
  const lines: [string, string][] = [];
  for (const entry of config.listWithOrigin()) {
    // `git config -l` prints a variable without `=` as its key alone: git-lfs skips it
    if (entry.text !== undefined) lines.push([entry.key, entry.text]);
  }
  return lines;
}

/** git-lfs's `caseFoldKey`: section and name in lower case, the middle kept. */
function caseFoldKey(key: string): string {
  const parts = key.split(".");
  if (parts.length < 3) return key.toLowerCase();
  const last = parts.length - 1;
  return [
    (parts[0] as string).toLowerCase(),
    parts.slice(1, last).join("."),
    (parts[last] as string).toLowerCase(),
  ].join(".");
}

/** POSIX `filepath.Clean`. */
function cleanPath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** `path.Ext`: the suffix from the last `.` of the last element. */
function pathExt(path: string): string {
  for (let i = path.length - 1; i >= 0 && path[i] !== "/"; i--) {
    if (path[i] === ".") return path.slice(i);
  }
  return "";
}

/**
 * The LFS configuration of a working copy (see the module notes): `.lfsconfig` and the git
 * configuration merged as git-lfs merges them, and git-lfs's endpoint finder over them.
 */
export class LfsConfig {
  private readonly aliases = new Map<string, string>();
  private readonly pushAliases = new Map<string, string>();
  private readonly gitProtocol: string;

  private constructor(
    private readonly values: Map<string, LfsValue[]>,
    /** git-lfs's `Remotes()`: every remote any `remote.*` key names, in the order first seen */
    readonly remotes: readonly string[],
    /** `git remote`: the remotes of the git configuration */
    private readonly gitRemotes: readonly string[],
    /** What git-lfs prints on stderr reading the configuration (ignored `.lfsconfig` keys) */
    readonly warnings: readonly string[],
    /**
     * Why the configuration was not read (a worktree `.lfsconfig` git cannot parse: git-lfs
     * then reads no configuration at all)
     */
    readonly errors: readonly string[],
    /** Where `.lfsconfig` was read from */
    readonly lfsconfigSource: LfsconfigSource,
    private readonly currentBranch: string | undefined,
    private readonly stat: HostStat,
    private readonly cwd: string | undefined,
  ) {
    this.gitProtocol = this.get("lfs.gitprotocol") ?? "https";
    // initAliases: every `url.<base>.insteadof` / `.pushinsteadof` value names an alias
    for (const [key, entries] of values) {
      if (!key.startsWith("url.")) continue;
      for (const [suffix, map] of [
        [".insteadof", this.aliases],
        [".pushinsteadof", this.pushAliases],
      ] as const) {
        if (!key.endsWith(suffix)) continue;
        const base = key.slice(4, key.length - suffix.length);
        for (const { value } of entries) {
          const known = map.get(value);
          if (known !== undefined && known !== base) {
            (this.warnings as string[]).push(
              `warning: Multiple 'url.*.${suffix}' keys with the same alias: "${value}"`,
            );
          }
          map.set(value, base);
        }
      }
    }
  }

  /**
   * Reads `.lfsconfig` (see the module notes) and the working copy's configuration.
   *
   * A `.lfsconfig` git cannot parse makes git-lfs drop its whole configuration (git's too:
   * `Error reading \`git config\``) when it is the worktree's file; a blob git cannot parse is
   * passed over for the next source.
   */
  static async load(
    workingCopy: WorkingCopy,
    options: LfsConfigLoadOptions = {},
  ): Promise<LfsConfig> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const sources: { lines: [string, string][]; onlySafeKeys: boolean }[] = [];
    let lfsconfigSource: LfsconfigSource = { kind: "none" };
    let broken = false;
    if (!options.withoutLfsconfig) {
      const reader = new LfsconfigReader(workingCopy);
      const read = await reader.call();
      lfsconfigSource = read.source;
      if (read.bytes) {
        try {
          sources.push({
            lines: await configLines(read.bytes, ".lfsconfig"),
            onlySafeKeys: true,
          });
        } catch (error) {
          if (!(error instanceof ConfigParseError)) throw error;
          if (read.source.kind === "worktree") {
            broken = true;
            errors.push(
              `Error reading \`git config\`: fatal: bad config line ${error.line} in file .lfsconfig`,
            );
          } else {
            lfsconfigSource = { kind: "none" };
          }
        }
      }
    }
    const store = RemoteConfigStore.from(workingCopy);
    if (!broken) {
      const listed = (
        workingCopy.config as { listWithOrigin?: () => { key: string; text?: string }[] }
      )?.listWithOrigin;
      const entries = listed ? listed.call(workingCopy.config) : [];
      const lines: [string, string][] = [];
      for (const e of entries) if (e.text !== undefined) lines.push([e.key, e.text]);
      sources.push({ lines, onlySafeKeys: false });
    }
    // readGitConfig
    const values = new Map<string, LfsValue[]>();
    const remotes: string[] = [];
    const ignored: string[] = [];
    for (const source of sources) {
      for (const [key, value] of source.lines) {
        let allowed = !source.onlySafeKeys;
        const parts = key.split(".");
        if (parts.length === 4 && parts[0] === "lfs" && parts[1] === "extension") {
          if ((parts[3] === "clean" || parts[3] === "smudge") && source.onlySafeKeys) {
            ignored.push(key);
            continue;
          }
          if (parts[3] === "priority") allowed = true;
        } else if (parts.length > 1 && parts[0] === "remote") {
          if (source.onlySafeKeys && parts.length === 3 && parts[2] !== "lfsurl") {
            ignored.push(key);
            continue;
          }
          allowed = true;
          const remote = parts.slice(1, parts.length - 1).join(".");
          if (!remotes.includes(remote)) remotes.push(remote);
        } else if (parts.length > 2 && parts[parts.length - 1] === "access") {
          allowed = true;
        }
        if (!allowed && !SAFE_KEYS.has(key)) {
          ignored.push(key);
          continue;
        }
        const list = values.get(key) ?? [];
        values.set(key, list);
        list.push({ value, lfsconfig: source.onlySafeKeys });
      }
    }
    if (ignored.length > 0) {
      warnings.push("warning: These unsafe '.lfsconfig' keys were ignored:", "");
      for (const key of ignored) warnings.push(`  ${key}`);
    }
    const environment = hostEnvironmentOf(workingCopy);
    const stat: HostStat = async (path) => {
      const stats = await environment?.statFile?.(path).catch(() => undefined);
      if (!stats) return undefined;
      return stats.kind === "directory" ? "directory" : stats.kind === "file" ? "file" : "other";
    };
    return new LfsConfig(
      values,
      remotes,
      store.configuredNames(),
      warnings,
      errors,
      lfsconfigSource,
      await currentBranchOf(workingCopy),
      stat,
      await worktreeHostPath(workingCopy).catch(() => undefined),
    );
  }

  /** The last value of `key` (git-lfs's `Get`), undefined when unset. */
  get(key: string): string | undefined {
    return this.entry(key)?.value;
  }

  /** Every value of `key`, `.lfsconfig`'s first. */
  getAll(key: string): string[] {
    return (this.values.get(caseFoldKey(key)) ?? []).map((v) => v.value);
  }

  private entry(key: string): LfsValue | undefined {
    const list = this.values.get(caseFoldKey(key));
    return list?.[list.length - 1];
  }

  /**
   * git-lfs's `Remote()`: the current branch's `branch.<name>.remote`, else
   * `remote.lfsdefault`, else the only remote, else `origin`.
   */
  remote(): string {
    return this.remoteChoice("download").name;
  }

  /**
   * git-lfs's `PushRemote()`: `branch.<name>.pushRemote`, `remote.lfspushdefault`,
   * `remote.pushDefault`, else {@link remote}.
   */
  pushRemote(): string {
    return this.remoteChoice("upload").name;
  }

  /**
   * {@link remote} (download) or {@link pushRemote} (upload), and whether `.lfsconfig` chose
   * it: git-lfs takes `remote.lfsdefault`, `remote.lfspushdefault` and `remote.pushDefault`
   * from `.lfsconfig` (and a remote with a URL-like name is read as that URL), so a remote it
   * picks is repository content too.
   */
  remoteChoice(operation: LfsEndpointOperation): { name: string; fromLfsconfig: boolean } {
    const pick = (key: string) => {
      const e = this.entry(key);
      return e ? { name: e.value, fromLfsconfig: e.lfsconfig } : undefined;
    };
    const branch = (name: string) =>
      this.currentBranch !== undefined ? pick(`branch.${this.currentBranch}.${name}`) : undefined;
    const download = () =>
      branch("remote") ??
      pick("remote.lfsdefault") ??
      (this.remotes.length === 1
        ? {
            name: this.remotes[0] as string,
            fromLfsconfig: !this.gitRemotes.includes(this.remotes[0] as string),
          }
        : { name: "origin", fromLfsconfig: false });
    if (operation === "download") return download();
    return (
      branch("pushremote") ??
      pick("remote.lfspushdefault") ??
      pick("remote.pushdefault") ??
      download()
    );
  }

  /**
   * git-lfs's `Endpoint(operation, remote)`: `lfs.pushurl` (upload), `lfs.url`, the remote's
   * own endpoint, else `origin`'s.
   */
  async endpoint(operation: LfsEndpointOperation, remote?: string): Promise<LfsEndpoint> {
    if (operation === "upload") {
      const push = this.entry("lfs.pushurl");
      if (push) return this.newEndpoint(operation, push, "lfs.pushurl", "origin", remote);
    }
    const url = this.entry("lfs.url");
    if (url) return this.newEndpoint(operation, url, "lfs.url", "origin", remote);
    if (remote !== undefined && remote !== "" && remote !== "origin") {
      const own = await this.remoteEndpoint(operation, remote);
      if (own.url !== "") return own;
    }
    return this.remoteEndpoint(operation, "origin");
  }

  /** git-lfs's `RemoteEndpoint`: the remote's own settings alone. */
  async remoteEndpoint(operation: LfsEndpointOperation, remote: string): Promise<LfsEndpoint> {
    const name = remote === "" ? "origin" : remote;
    if (operation === "upload") {
      const push = this.entry(`remote.${name}.lfspushurl`);
      if (push) return this.newEndpoint(operation, push, "remote.lfspushurl", name);
    }
    const lfsurl = this.entry(`remote.${name}.lfsurl`);
    if (lfsurl) return this.newEndpoint(operation, lfsurl, "remote.lfsurl", name);
    const git = this.gitRemoteUrl(name, operation === "upload");
    if (git) {
      const ep = await this.newEndpoint(operation, git.entry, git.source, name);
      if (ep.url === LFS_URL_UNKNOWN) return ep;
      if (ep.url.endsWith("/")) ep.url = ep.url.slice(0, -1);
      if (ep.url.startsWith("file://")) return ep;
      ep.url += pathExt(ep.url) === ".git" ? "/info/lfs" : ".git/info/lfs";
      return ep;
    }
    return { url: "", operation, remote: name, fromLfsconfig: false };
  }

  /** git-lfs's `GitRemoteURL`: `pushurl` (push), `url`, else the name if it is a remote or a URL. */
  private gitRemoteUrl(
    remote: string,
    forPush: boolean,
  ): { entry: LfsValue; source: LfsEndpointSource } | undefined {
    if (forPush) {
      const push = this.entry(`remote.${remote}.pushurl`);
      if (push) return { entry: push, source: "remote.pushurl" };
    }
    const url = this.entry(`remote.${remote}.url`);
    if (url) return { entry: url, source: "remote.url" };
    if (this.gitRemotes.includes(remote) || isRemoteUrl(remote)) {
      return { entry: { value: remote, lfsconfig: false }, source: "remote.name" };
    }
    return undefined;
  }

  private async newEndpoint(
    operation: LfsEndpointOperation,
    entry: LfsValue,
    source: LfsEndpointSource,
    remote: string,
    asked?: string,
  ): Promise<LfsEndpoint> {
    const fields = await this.readEndpointUrl(operation, entry.value);
    return {
      ...fields,
      operation,
      remote: source.startsWith("lfs.") && asked ? asked : remote,
      source,
      fromLfsconfig: entry.lfsconfig,
    };
  }

  /** git-lfs's `NewEndpoint`: the URL as the endpoint gives it. */
  private async readEndpointUrl(
    operation: LfsEndpointOperation,
    raw: string,
  ): Promise<{ url: string; ssh?: LfsSshMetadata }> {
    const rawurl = this.replaceUrlAlias(operation, raw);
    if (rawurl.startsWith("/")) return { url: await this.localPathUrl(rawurl) };
    let u: GoUrl;
    try {
      u = goUrlParse(rawurl);
    } catch {
      return endpointFromBareSshUrl(rawurl);
    }
    switch (u.scheme) {
      case "ssh":
      case "git+ssh":
      case "ssh+git":
        return endpointFromSshUrl(u);
      case "http":
      case "https":
      case "file":
        return { url: goUrlString(u) };
      case "git":
        return { url: goUrlString({ ...u, scheme: this.gitProtocol }) };
      case "":
        if ((await this.stat(this.hostPath(rawurl))) !== undefined) {
          return { url: await this.localPathUrl(rawurl) };
        }
        return endpointFromBareSshUrl(goUrlString(u));
      default:
        if (rawurl.startsWith(`${u.scheme}::`)) return { url: rawurl };
        if ((await this.stat(this.hostPath(rawurl))) !== undefined) {
          return { url: await this.localPathUrl(rawurl) };
        }
        return endpointFromBareSshUrl(goUrlString(u));
    }
  }

  /** A path as the process sees it: relative ones from the worktree top. */
  private hostPath(path: string): string {
    if (path.startsWith("/")) return path;
    return this.cwd !== undefined ? `${this.cwd}/${path}` : path;
  }

  /** git's `RewriteLocalPathAsURL` (git-lfs). */
  private async localPathUrl(raw: string): Promise<string> {
    let path = cleanPath(this.hostPath(raw));
    let gitPath: string;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base === ".git") {
      gitPath = path;
      path = cleanPath(path.slice(0, path.lastIndexOf("/")) || "/");
    } else {
      gitPath = path === "/" ? "/.git" : `${path}/.git`;
    }
    if ((await this.stat(gitPath)) !== undefined) path = gitPath;
    else if ((await this.stat(path)) === undefined) return path;
    return `file://${path}`;
  }

  /** git-lfs's `ReplaceUrlAlias`: the longest `insteadOf` (`pushInsteadOf` first for uploads). */
  replaceUrlAlias(operation: LfsEndpointOperation, rawurl: string): string {
    if (operation === "upload") {
      const pushed = replaceAlias(this.pushAliases, rawurl);
      if (pushed !== undefined) return pushed;
    }
    return replaceAlias(this.aliases, rawurl) ?? rawurl;
  }
}

function replaceAlias(aliases: Map<string, string>, rawurl: string): string | undefined {
  let longest = "";
  for (const alias of aliases.keys()) {
    if (!rawurl.startsWith(alias)) continue;
    if (longest < alias) longest = alias;
  }
  if (longest.length === 0) return undefined;
  return (aliases.get(longest) as string) + rawurl.slice(longest.length);
}

/** git-lfs's `ValidateRemoteURL`. */
function isRemoteUrl(remote: string): boolean {
  let u: GoUrl | undefined;
  try {
    u = goUrlParse(remote);
  } catch {
    u = undefined;
  }
  if (u === undefined || u.scheme === "") return remote.includes(":");
  return ["ssh", "http", "https", "git", "file"].includes(u.scheme);
}

/** git-lfs's `EndpointFromSshUrl`. */
function endpointFromSshUrl(u: GoUrl): { url: string; ssh?: LfsSshMetadata } {
  const match = /^([^:]+)(?::(\d+))?$/.exec(u.host);
  if (!match) return { url: LFS_URL_UNKNOWN };
  const host = match[1] as string;
  const userAndHost =
    u.user !== undefined && u.user.username !== "" ? `${u.user.username}@${host}` : host;
  return {
    url: `https://${host}${u.path}`,
    ssh: { userAndHost, port: match[2] ?? "", path: u.path },
  };
}

/** git-lfs's `EndpointFromBareSshUrl`: `user@host:path`, `[user@host:port]:path`. */
function endpointFromBareSshUrl(rawurl: string): { url: string; ssh?: LfsSshMetadata } {
  const parts = rawurl.split(":");
  if (parts.length < 2) return { url: rawurl };
  let newPath: string;
  if (parts.length > 2) {
    parts[0] = (parts[0] as string).replace(/^\[/, "");
    parts[1] = (parts[1] as string).replace(/\]$/, "");
    newPath = `${parts[0]}:${parts.slice(1).join("/")}`;
  } else {
    newPath = parts.join("/");
  }
  let u: GoUrl;
  try {
    u = goUrlParse(`ssh://${newPath}`);
  } catch {
    return { url: LFS_URL_UNKNOWN };
  }
  const endpoint = endpointFromSshUrl(u);
  if (endpoint.ssh?.path.startsWith("/")) endpoint.ssh.path = endpoint.ssh.path.slice(1);
  return endpoint;
}

/** The branch HEAD names, when it names one that has a commit (git-lfs's `CurrentRef`). */
async function currentBranchOf(workingCopy: WorkingCopy): Promise<string | undefined> {
  const reader = new HeadBranchReader(workingCopy);
  return reader.call();
}

class HeadBranchReader extends GitCommand<string | undefined> {
  async call(): Promise<string | undefined> {
    const ref = await this.getCurrentBranch().catch(() => undefined);
    if (ref === undefined || !ref.startsWith("refs/heads/")) return undefined;
    // an unborn branch: git-lfs's `git rev-parse` of HEAD fails, no branch is looked at
    if ((await this.resolveRevision("HEAD").catch(() => undefined)) === undefined) return undefined;
    return ref.slice("refs/heads/".length);
  }
}
