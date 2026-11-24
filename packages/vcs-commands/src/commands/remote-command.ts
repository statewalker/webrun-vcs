import { isSymbolicRef, isValidRefName, type OwnReflogLine } from "@statewalker/vcs-core";
import {
  expandFromDestination,
  lsRefs,
  matchDestination,
  parseRefSpec,
  type RefSpec,
  type RemoteRef as TransportRemoteRef,
} from "@statewalker/vcs-transport";
import { compilePosixRegex, type PosixRegex, PosixRegexError } from "@statewalker/vcs-utils";

import {
  GitApiError,
  InvalidArgumentError,
  InvalidRemoteError,
  MissingArgumentError,
  RefNotFoundError,
  RemoteAlreadyExistsError,
  RemoteNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import {
  deleteRefs,
  listRemoteNames,
  moveRefs,
  type RemoteConfig,
  RemoteConfigStore,
} from "../remote-config/index.js";
import type { FetchResult } from "../results/index.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand } from "./fetch-command.js";
import { removeLegacyRemoteFile } from "./legacy-remotes.js";
import { withRemoteUploadPack } from "./remote-transport.js";

export type { RemoteConfig };

/**
 * How `git remote add --mirror` sets a remote up: `fetch` (`--mirror=fetch`: the fetch
 * refspec maps every ref to itself), `push` (`--mirror=push`: `remote.<name>.mirror=true`),
 * `both` (git's deprecated bare `--mirror`).
 */
export type RemoteMirrorMode = "fetch" | "push" | "both";

/**
 * Add a remote to the repository.
 *
 * Equivalent to `git remote add [-f] [--[no-]tags] [-t <branch>]... [-m <master>]
 * [--mirror=(fetch|push)] <name> <url>`, as git's builtin/remote.c `add`: `remote.<name>.url`,
 * then one `remote.<name>.fetch` line per tracked branch (`+refs/heads/<b>:refs/remotes/<name>/<b>`,
 * every branch by default; a fetch mirror maps `refs/<b>` to itself), `remote.<name>.mirror`
 * for a push mirror and `remote.<name>.tagOpt` for `--tags`/`--no-tags`; with {@link setFetch}
 * the remote is fetched (git runs `git fetch <name>`), and with {@link setMaster}
 * `refs/remotes/<name>/HEAD` names `refs/remotes/<name>/<master>` (reflog `remote add`).
 *
 * A remote counts as existing as git's `remote_is_configured(remote, 1)` decides: a
 * `remote.<name>.*` variable of the repository's own configuration, or a legacy remote file
 * (`.git/remotes/`, `.git/branches/`, git 2.x); tracking refs alone do not make one.
 *
 * @example
 * ```typescript
 * await git.remoteAdd()
 *   .setName("upstream")
 *   .setUri("https://github.com/user/repo")
 *   .setTrack("main", "next")
 *   .setMaster("main")
 *   .call();
 * ```
 */
export class RemoteAddCommand extends TransportCommand<RemoteConfig> {
  private name?: string;
  private uri?: string;
  private fetchRefspec?: string;
  private fetchAfter = false;
  private track: string[] = [];
  private master?: string;
  private mirror?: RemoteMirrorMode;
  private tags?: boolean;
  private messages: string[] = [];
  private fetchResult?: FetchResult;

  /**
   * Set the remote name.
   *
   * @param name Remote name
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getName(): string | undefined {
    return this.name;
  }

  /**
   * Set the remote URI.
   *
   * @param uri Remote URL
   */
  setUri(uri: string): this {
    this.checkCallable();
    this.uri = uri;
    return this;
  }

  /**
   * Get the remote URI.
   */
  getUri(): string | undefined {
    return this.uri;
  }

  /**
   * Set custom fetch refspec, written instead of the ones {@link setTrack} and
   * {@link setMirror} make.
   *
   * If not set, defaults to +refs/heads/*:refs/remotes/{name}/*
   *
   * @param refspec Fetch refspec
   */
  setFetchRefspec(refspec: string): this {
    this.checkCallable();
    this.fetchRefspec = refspec;
    return this;
  }

  /** Fetch the remote once it is added (`-f`), as git's `git fetch <name>`. */
  setFetch(fetch: boolean): this {
    this.checkCallable();
    this.fetchAfter = fetch;
    return this;
  }

  /**
   * The branches to track (`-t <branch>`, repeated): one fetch refspec each instead of
   * every branch. A name may be a pattern (`feat/*`), as git writes it into the refspec.
   */
  setTrack(...branches: string[]): this {
    this.checkCallable();
    this.track = [...branches];
    return this;
  }

  /** Point `refs/remotes/<name>/HEAD` at `refs/remotes/<name>/<branch>` (`-m <branch>`). */
  setMaster(branch: string): this {
    this.checkCallable();
    this.master = branch;
    return this;
  }

  /**
   * Set the remote up as a mirror (`--mirror=fetch`, `--mirror=push`); `true` is git's bare
   * `--mirror` (both, with git's deprecation warning in {@link getMessages}), `false` none.
   */
  setMirror(mirror: "fetch" | "push" | boolean): this {
    this.checkCallable();
    if (mirror === true) {
      this.mirror = "both";
      this.messages.push(
        "warning: --mirror is dangerous and deprecated; please\n\t use --mirror=fetch or --mirror=push instead",
      );
    } else this.mirror = mirror === false ? undefined : mirror;
    return this;
  }

  /**
   * `--tags` (true: `remote.<name>.tagOpt=--tags`) or `--no-tags` (false: `--no-tags`);
   * undefined writes no `tagOpt`.
   */
  setTags(tags: boolean | undefined): this {
    this.checkCallable();
    this.tags = tags;
    return this;
  }

  /**
   * What git prints: the `--mirror` warning, legacy-remote warnings (git 2.5x), `Updating
   * <name>` (stdout) before a fetch, and the fetch's own messages. Empty before {@link call}.
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /** The fetch {@link setFetch} ran, once {@link call} has run it. */
  getFetchResult(): FetchResult | undefined {
    return this.fetchResult;
  }

  /**
   * Execute the remote add operation.
   *
   * @returns Remote configuration
   * @throws MissingArgumentError if name or URI is not set
   * @throws GitApiError (exit 128) for `--mirror` with a master branch (git: "specifying a
   *   master branch makes no sense with --mirror"), or a push mirror with tracked branches
   *   ("specifying branches to track makes sense only with fetch mirrors")
   * @throws RemoteAlreadyExistsError (exit 3) for a configured remote (git: "remote <name>
   *   already exists.")
   * @throws InvalidArgumentError (exit 128) for an invalid name ("'<name>' is not a valid
   *   remote name"); in git 2.5x also for a name inside or around an existing one ("remote
   *   name 'a/b' is a subset of existing remote 'a'", "... superset ...")
   * @throws GitApiError (exit 1) when the fetch fails: its error, then "error: Could not fetch
   *   <name>"; the remote stays configured, as git leaves it
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    const name = this.name;
    if (!name) {
      throw new MissingArgumentError("name", "Remote name must be specified");
    }
    if (!this.uri) {
      throw new MissingArgumentError("uri", "Remote URI must be specified");
    }
    const mirror = this.mirror;
    let store: RemoteConfigStore;
    try {
      store = await this.checkAdd(name, mirror);
    } catch (error) {
      // what git printed before it died (the --mirror warning, a legacy-remote warning)
      if (error instanceof GitApiError && this.messages.length > 0) {
        error.message = [...this.messages, error.message].join("\n");
      }
      throw error;
    }

    store.setValue(`remote.${name}.url`, this.uri);
    if (this.fetchRefspec !== undefined) {
      store.addValue(`remote.${name}.fetch`, this.fetchRefspec);
    } else if (mirror !== "push") {
      // add_branch
      for (const branch of this.track.length > 0 ? this.track : ["*"]) {
        store.addValue(
          `remote.${name}.fetch`,
          mirror
            ? `+refs/${branch}:refs/${branch}`
            : `+refs/heads/${branch}:refs/remotes/${name}/${branch}`,
        );
      }
    }
    if (mirror === "push" || mirror === "both") store.setValue(`remote.${name}.mirror`, "true");
    if (this.tags !== undefined) {
      store.setValue(`remote.${name}.tagOpt`, this.tags ? "--tags" : "--no-tags");
    }
    await store.save();

    if (this.fetchAfter) await this.fetchRemote(name);

    if (this.master !== undefined) {
      const head = `refs/remotes/${name}/HEAD`;
      try {
        await this.refsStore.setSymbolic(
          head,
          `refs/remotes/${name}/${this.master}`,
          this.reflogLine("remote add"),
        );
      } catch (cause) {
        throw new GitApiError(`error: Could not setup master '${this.master}'`, {
          exitCode: 1,
          cause,
        });
      }
    }

    return store.read(name);
  }

  /** git's refusals before `remote add` writes anything; the store to write to. */
  private async checkAdd(
    name: string,
    mirror: RemoteMirrorMode | undefined,
  ): Promise<RemoteConfigStore> {
    if (mirror && this.master !== undefined) {
      throw new GitApiError("fatal: specifying a master branch makes no sense with --mirror");
    }
    if (mirror === "push" && this.track.length > 0) {
      throw new GitApiError(
        "fatal: specifying branches to track makes sense only with fetch mirrors",
      );
    }

    // remote_get: a legacy remote file defines the remote too (git 2.x; 2.5x warns)
    this.messages.push(...(await this.loadLegacyRemote(name)));
    const store = RemoteConfigStore.from(this.workingCopy);
    if (store.isConfiguredInRepo(name)) {
      throw new RemoteAlreadyExistsError(name, `error: remote ${name} already exists.`);
    }
    // git dies before it writes `remote.<name>.url`: a name with a newline would break the file
    if (!isValidRemoteName(name)) {
      throw new InvalidArgumentError("name", name, `fatal: '${name}' is not a valid remote name`);
    }
    // check_remote_collision (git 2.5x): refs/remotes/a/ and refs/remotes/a/b/ would clash
    if (this.hooks.compatibility !== "2.43") {
      for (const other of store.configuredNames()) {
        if (name.startsWith(`${other}/`)) {
          throw new InvalidArgumentError(
            "name",
            name,
            `fatal: remote name '${name}' is a subset of existing remote '${other}'`,
          );
        }
        if (other.startsWith(`${name}/`)) {
          throw new InvalidArgumentError(
            "name",
            name,
            `fatal: remote name '${name}' is a superset of existing remote '${other}'`,
          );
        }
      }
    }

    return store;
  }

  /** git's fetch_remote: `Updating <name>`, then `git fetch <name>` as a child. */
  private async fetchRemote(name: string): Promise<void> {
    this.messages.push(`Updating ${name}`);
    const fetch = new FetchCommand(this._workingCopy).shareHooksOf(this);
    fetch.setTransports(this.getTransports());
    fetch.setRemote(name);
    if (this.credentials) fetch.setCredentials(this.credentials);
    if (this.headers) fetch.setHeaders(this.headers);
    if (this.timeout) fetch.setTimeout(this.timeout);
    if (this.progressCallback) fetch.setProgressMonitor(this.progressCallback);
    if (this.progressMessageCallback) {
      fetch.setProgressMessageCallback(this.progressMessageCallback);
    }
    try {
      this.fetchResult = await fetch.call();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new GitApiError(`${message}\nerror: Could not fetch ${name}`, { exitCode: 1, cause });
    }
    this.messages.push(...this.fetchResult.messages);
  }
}

/**
 * Remove a remote from the repository.
 *
 * Equivalent to `git remote remove`.
 *
 * Based on JGit's RemoteRemoveCommand.
 *
 * As git's builtin/remote.c `rm`: the branches whose upstream is the remote lose
 * `branch.<b>.remote` and `branch.<b>.merge`, those pushing to it `branch.<b>.pushRemote`;
 * the remote-tracking refs its fetch refspecs map to (under `refs/remotes/`, and not mapped
 * by another remote too) are deleted with their reflogs, `refs/remotes/<name>/HEAD`
 * included; `remote.pushDefault` naming it is unset; the `[remote "<name>"]` section goes.
 * Local branches a refspec maps to are kept, and git's note naming them is in
 * {@link getMessages}. A remote without a config section is refused, as git refuses it.
 *
 * @example
 * ```typescript
 * await git.remoteRemove()
 *   .setRemoteName("upstream")
 *   .call();
 * ```
 */
export class RemoteRemoveCommand extends GitCommand<RemoteConfig> {
  private remoteName?: string;
  private messages: string[] = [];

  /**
   * Set the remote name to remove.
   *
   * @param name Remote name
   */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getRemoteName(): string | undefined {
    return this.remoteName;
  }

  /**
   * What git prints after the removal (on stderr): the note on local branches a refspec
   * maps to, which are not removed. Empty until {@link call} has run.
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /**
   * Execute the remote remove operation.
   *
   * @returns Removed remote config
   * @throws RemoteNotFoundError when the remote has no config section (git: "No such
   *   remote: '<name>'"); nothing is changed then
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    const name = this.remoteName;
    if (!name) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfigured(name)) {
      throw new RemoteNotFoundError(name, `No such remote: '${name}'`);
    }

    // Read before removing: this is what we report back.
    const removed = store.read(name);

    // the refs its refspecs map to, unless another remote maps them too (add_branch_for_removal)
    const own = store.configuredFetchRefspecs(name).map((spec) => parseRefSpec(spec));
    const others = store
      .configuredNames()
      .filter((other) => other !== name)
      .map((other) => store.configuredFetchRefspecs(other).map((spec) => parseRefSpec(spec)));
    const refsToDelete: string[] = [];
    const skipped: string[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      if (!tracks(own, ref.name)) continue;
      if (others.some((specs) => tracks(specs, ref.name))) continue;
      // refs outside refs/remotes/ are kept, as git; local branches are named in a note
      if (!ref.name.startsWith("refs/remotes/")) {
        if (ref.name.startsWith("refs/heads/")) skipped.push(ref.name.slice("refs/heads/".length));
        continue;
      }
      refsToDelete.push(ref.name);
    }

    for (const branch of store.subsections("branch")) {
      if (store.value(`branch.${branch}.remote`) === name) {
        store.unset(`branch.${branch}.remote`);
        store.unset(`branch.${branch}.merge`);
      }
      if (store.value(`branch.${branch}.pushRemote`) === name) {
        store.unset(`branch.${branch}.pushRemote`);
      }
    }

    // in for_each_ref order (a store may list its loose refs before its packed ones)
    refsToDelete.sort();
    await deleteRefs(this.refsStore, refsToDelete, "remote: remove", {
      legacy: this.hooks.compatibility === "2.43",
    });
    if (skipped.length > 0) {
      this.messages.push(
        skipped.length === 1
          ? "Note: A branch outside the refs/remotes/ hierarchy was not removed;\nto delete it, use:"
          : "Note: Some branches outside the refs/remotes/ hierarchy were not removed;\nto delete them, use:",
        ...skipped.map((branch) => `  git branch -d ${branch}`),
      );
    }

    store.remove(name);
    // handle_push_default: a local remote.pushDefault naming it is unset
    if (store.value("remote.pushDefault") === name) store.unset("remote.pushDefault");
    await store.save();

    return removed;
  }
}

/** What {@link RemoteRenameCommand} did. */
export interface RemoteRenameResult {
  /** The remote under its new name */
  remote: RemoteConfig;
  /**
   * git's warnings: each fetch refspec that does not write under `refs/remotes/<old>/`
   * is kept as it is ("Not updating non-default fetch refspec ...")
   */
  warnings: string[];
}

/**
 * Rename a remote.
 *
 * Equivalent to `git remote rename <old> <new>`.
 *
 * As git's builtin/remote.c `mv`: the `[remote "<old>"]` section is renamed in place; each
 * fetch refspec writing under `refs/remotes/<old>/` is rewritten to `refs/remotes/<new>/`,
 * the others kept with git's warning; `branch.<b>.remote` and `branch.<b>.pushRemote`
 * naming the remote are updated. When a refspec was rewritten, the refs under
 * `refs/remotes/<old>/` move to `refs/remotes/<new>/` in one batch, each with its reflog
 * and a `remote: renamed <old ref> to <new ref>` line, symbolic refs (`HEAD`) re-pointed
 * at the moved refs, and `remote.pushDefault` follows the new name.
 *
 * @example
 * ```typescript
 * const { remote, warnings } = await git.remoteRename().setOldName("origin").setNewName("upstream").call();
 * ```
 */
export class RemoteRenameCommand extends GitCommand<RemoteRenameResult> {
  private oldName?: string;
  private newName?: string;

  /** Set the remote to rename. */
  setOldName(name: string): this {
    this.checkCallable();
    this.oldName = name;
    return this;
  }

  /** Set the remote's new name. */
  setNewName(name: string): this {
    this.checkCallable();
    this.newName = name;
    return this;
  }

  /**
   * @throws RemoteNotFoundError if the remote has no config section (git: "No such remote: '<old>'")
   * @throws RemoteAlreadyExistsError if the new name is taken (git: "remote <new> already exists.")
   * @throws InvalidArgumentError for an invalid new name (git: "'<new>' is not a valid remote name")
   */
  async call(): Promise<RemoteRenameResult> {
    this.checkCallable();
    this.setCallable(false);
    const { oldName, newName } = this;
    if (!oldName) throw new MissingArgumentError("oldName", "Old remote name must be specified");
    if (!newName) throw new MissingArgumentError("newName", "New remote name must be specified");

    const store = RemoteConfigStore.from(this.workingCopy);
    // remote_get: a remote missing from the configuration may be read from .git/remotes/ or
    // .git/branches/ (git 2.x; 2.5x warns), and counts as configured
    const warnings: string[] = (await this.loadLegacyRemote(oldName))
      .filter((m) => m.startsWith("warning: "))
      .map((m) => m.slice("warning: ".length));
    if (!store.isConfigured(oldName)) {
      throw new RemoteNotFoundError(oldName, `No such remote: '${oldName}'`);
    }
    const legacyOrigin = store.legacyOrigin(oldName);
    if (oldName === newName && legacyOrigin) {
      // migrate_file: the remote as read goes into the configuration, the file goes away
      // read whole before writing: once it has a URL, the configuration hides the file
      const urls = store.remoteUrls(oldName);
      const push = store.pushRefspecs(oldName);
      const fetch = store.configuredFetchRefspecs(oldName);
      for (const url of urls) store.addValue(`remote.${oldName}.url`, url);
      for (const spec of push) store.addValue(`remote.${oldName}.push`, spec);
      for (const spec of fetch) store.addValue(`remote.${oldName}.fetch`, spec);
      await store.save();
      await removeLegacyRemoteFile(this.workingCopy, legacyOrigin, oldName);
      return { remote: store.read(oldName), warnings };
    }
    if (oldName !== newName) {
      for (const m of await this.loadLegacyRemote(newName)) {
        if (m.startsWith("warning: ")) warnings.push(m.slice("warning: ".length));
      }
    }
    if (store.isConfigured(newName)) {
      throw new RemoteAlreadyExistsError(newName, `remote ${newName} already exists.`);
    }
    if (!isValidRemoteName(newName)) {
      throw new InvalidArgumentError("newName", newName, `'${newName}' is not a valid remote name`);
    }
    // git_config_rename_section finds no section to rename for a remote read from a file
    if (!store.hasSection(oldName)) {
      throw new GitApiError(
        `Could not rename config section 'remote.${oldName}' to 'remote.${newName}'`,
        { exitCode: 1 },
      );
    }

    const fetch = store.configuredFetchRefspecs(oldName);
    const oldContext = `:refs/remotes/${oldName}/`;
    const refspecsNeedUpdate = fetch.some((spec) => spec.includes(oldContext));
    const oldTop = `refs/remotes/${oldName}/`;
    const renamed = (ref: string) => `refs/remotes/${newName}/${ref.slice(oldTop.length)}`;

    // the refs first: a refused batch (a name conflict) leaves everything as it was
    if (refspecsNeedUpdate) {
      const renameLine = this.reflogLine("");
      const moves = [];
      for await (const ref of this.refsStore.list(oldTop)) {
        const to = renamed(ref.name);
        const reflog: OwnReflogLine[] = [];
        const symbolic = isSymbolicRef(ref);
        const id = symbolic ? undefined : ref.objectId;
        // git's rename_one_reflog: a ref with a log takes it along, plus git's line (the
        // committer's); a symbolic ref has no id of its own there, so its line is zeros
        const log = id || symbolic ? await this.refsStore.getReflog?.(ref.name) : undefined;
        if (log) {
          for (const entry of (await log.getReverseEntries()).reverse()) {
            reflog.push({
              oldId: entry.oldId,
              newId: entry.newId,
              ident: formatIdent(entry.who),
              message: entry.comment,
            });
          }
          reflog.push({
            oldId: id ?? this.objectFormat.nullId,
            newId: id ?? this.objectFormat.nullId,
            ...(renameLine.ident !== undefined ? { ident: renameLine.ident } : {}),
            message: `remote: renamed ${ref.name} to ${to}`,
          });
        }
        moves.push({ from: ref.name, to, reflog: reflog.length > 0 ? reflog : undefined });
      }
      await moveRefs(this.refsStore, moves, (target) =>
        target.startsWith(oldTop) ? renamed(target) : target,
      );
    }

    store.rename(oldName, newName);
    if (fetch.length > 0) {
      const rewritten = fetch.map((spec) => {
        const at = spec.indexOf(oldContext);
        if (at < 0) {
          warnings.push(
            `Not updating non-default fetch refspec\n\t${spec}\n\tPlease update the configuration manually if necessary.`,
          );
          return spec;
        }
        const nameAt = at + ":refs/remotes/".length;
        return `${spec.slice(0, nameAt)}${newName}${spec.slice(nameAt + oldName.length)}`;
      });
      store.setValues(`remote.${newName}.fetch`, rewritten);
    }
    for (const branch of store.subsections("branch")) {
      if (store.value(`branch.${branch}.remote`) === oldName) {
        store.setValue(`branch.${branch}.remote`, newName);
      }
      if (store.value(`branch.${branch}.pushRemote`) === oldName) {
        store.setValue(`branch.${branch}.pushRemote`, newName);
      }
    }
    if (refspecsNeedUpdate && store.value("remote.pushDefault") === oldName) {
      store.setValue("remote.pushDefault", newName);
    }
    await store.save();
    return { remote: store.read(newName), warnings };
  }
}

/** git's report_set_head_auto (builtin/remote.c), from what `refs/remotes/<remote>/HEAD` held. */
function reportSetHeadAuto(
  remote: string,
  head: string,
  previous: { target?: string; objectId?: string } | undefined,
): string {
  const prefix = `refs/remotes/${remote}/`;
  const target = previous && "target" in previous ? previous.target : undefined;
  const prev = target?.startsWith(prefix) ? target.slice(prefix.length) : undefined;
  if (prev === head) return `'${remote}/HEAD' is unchanged and points to '${head}'`;
  if (prev !== undefined) {
    return `'${remote}/HEAD' has changed from '${prev}' and now points to '${head}'`;
  }
  if (!previous) return `'${remote}/HEAD' is now created and points to '${head}'`;
  if (target === undefined) {
    return `'${remote}/HEAD' was detached at '${previous.objectId}' and now points to '${head}'`;
  }
  return `'${remote}/HEAD' used to point to '${target}' (which is not a remote branch), but now points to '${head}'`;
}

/** git's remote_find_tracking: whether a fetch refspec writes `refName` (and no negative one excludes it). */
function tracks(specs: RefSpec[], refName: string): boolean {
  const sources: string[] = [];
  for (const spec of specs) {
    if (spec.negative || !spec.source || !spec.destination) continue;
    if (spec.wildcard) {
      if (!matchDestination(spec, refName)) continue;
      const source = expandFromDestination(spec, refName).source;
      if (source) sources.push(source);
    } else if (spec.destination === refName) {
      sources.push(spec.source);
    }
  }
  // git's query_refspecs: a source a negative refspec matches excludes the ref
  const negative = specs.filter((spec) => spec.negative && spec.source);
  const excluded = sources.some((source) =>
    negative.some((n) =>
      n.wildcard ? matchesPattern(n.source as string, source) : n.source === source,
    ),
  );
  return sources.length > 0 && !excluded;
}

/** A `*` pattern of a negative refspec matches `name`. */
function matchesPattern(pattern: string, name: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === name;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail);
}

/** git's valid_remote_name: `refs/remotes/<name>/test` is a valid ref name. */
export function isValidRemoteName(name: string): boolean {
  return name.length > 0 && isValidRefName(`refs/remotes/${name}/test`);
}

/** A reflog identity, as git writes it: `Name <email> <seconds> <tz>`. */
function formatIdent(who: { name: string; email: string; timestamp: number; tzOffset: string }) {
  return `${who.name} <${who.email}> ${Math.floor(who.timestamp)} ${who.tzOffset}`;
}

/**
 * List remotes in the repository.
 *
 * Equivalent to `git remote -v`.
 *
 * Based on JGit's RemoteListCommand.
 *
 * @example
 * ```typescript
 * const remotes = await git.remoteList().call();
 * for (const remote of remotes) {
 *   console.log(remote.name, remote.urls[0]);
 * }
 * ```
 */
export class RemoteListCommand extends GitCommand<RemoteConfig[]> {
  private verbose = false;

  /** List each remote's URLs too (`git remote -v`), for {@link callText}. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /**
   * What `git remote` (or with {@link setVerbose}, `git remote -v`) prints, as builtin/remote.c
   * `show_all`: the remotes of the configuration (every scope; not the names known only
   * from `refs/remotes/`, nor legacy remote files) in byte order, one per line; verbose,
   * `<name>\t<url> (fetch)` with its first fetch URL (and ` [<filter>]` for a
   * `remote.<name>.partialclonefilter`), then `<name>\t<url> (push)` for each push URL
   * (`pushurl`, else the fetch URLs), `insteadOf`/`pushInsteadOf` applied; a remote without
   * a URL has the line `<name>\t`.
   *
   * @example
   * ```typescript
   * const text = await git.remoteList().setVerbose(true).callText();
   * // "origin\thttps://example.com/r.git (fetch)\norigin\thttps://example.com/r.git (push)\n"
   * ```
   */
  async callText(): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const store = RemoteConfigStore.from(this.workingCopy);
    const entries: { name: string; info: string }[] = [];
    for (const name of store.configuredNames()) {
      // get_one_entry
      const urls = store.remoteUrls(name);
      if (urls.length > 0) {
        const filter = store.value(`remote.${name}.partialclonefilter`);
        entries.push({
          name,
          info: `${urls[0]} (fetch)${filter !== undefined ? ` [${filter}]` : ""}`,
        });
      } else entries.push({ name, info: "" });
      for (const url of store.remotePushUrls(name)) entries.push({ name, info: `${url} (push)` });
    }
    // string_list_sort: by name only, stable (glibc's merge sort)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let out = "";
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as { name: string; info: string };
      if (this.verbose) out += `${entry.name}\t${entry.info}\n`;
      else if (i === 0 || entries[i - 1]?.name !== entry.name) out += `${entry.name}\n`;
    }
    return out;
  }

  /**
   * Execute the remote list operation.
   *
   * Lists the union of the configured remotes and the names appearing under
   * `refs/remotes/`; a remote with no config section is reported with no URLs
   * and the default fetch refspec.
   *
   * @returns List of remote configurations
   */
  async call(): Promise<RemoteConfig[]> {
    this.checkCallable();
    this.setCallable(false);

    const store = RemoteConfigStore.from(this.workingCopy);
    const names = await listRemoteNames(store, this.refsStore);
    return names.map((name) => store.read(name));
  }
}

/**
 * The URLs of a remote as git uses them: `git remote get-url [--push] [--all] <name>`.
 *
 * The URLs are rewritten by `url.<base>.insteadOf` (and, for push URLs of a remote without
 * `pushurl`, by `url.<base>.pushInsteadOf`), as git reads them.
 *
 * @example
 * ```typescript
 * const [url] = await git.remoteGetUrl().setRemoteName("origin").call();
 * const pushUrls = await git.remoteGetUrl().setRemoteName("origin").setPush(true).setAll(true).call();
 * ```
 */
export class RemoteGetUrlCommand extends GitCommand<string[]> {
  private remoteName?: string;
  private push = false;
  private all = false;

  /** Set the remote whose URL is read. */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /** Read the push URLs (`--push`). */
  setPush(push: boolean): this {
    this.checkCallable();
    this.push = push;
    return this;
  }

  /** Every URL (`--all`), not only the first. */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /**
   * @returns the first URL, or with {@link setAll} every one
   * @throws RemoteNotFoundError (exit 2) when the remote has no configuration (git: "No such
   *   remote '<name>'")
   */
  async call(): Promise<string[]> {
    this.checkCallable();
    this.setCallable(false);
    const name = this.remoteName;
    if (!name) throw new MissingArgumentError("remoteName", "Remote name must be specified");
    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfigured(name)) {
      throw new RemoteNotFoundError(name, `error: No such remote '${name}'`);
    }
    const urls = this.push ? store.remotePushUrls(name) : store.remoteUrls(name);
    return this.all ? urls : urls.slice(0, 1);
  }
}

/**
 * Set URL for a remote.
 *
 * Equivalent to `git remote set-url [--push] <name> <newurl> [<oldurl>]`,
 * `git remote set-url --add [--push] <name> <newurl>` and
 * `git remote set-url --delete [--push] <name> <url>`, as git's builtin/remote.c `set_url`:
 *
 * - without `<oldurl>`, `remote.<name>.url` (`pushurl` with {@link setPush}) is set to the new
 *   URL (git refuses a variable with several values: "could not set ...");
 * - {@link setAdd} adds a value (one empty value is replaced);
 * - {@link setOldUri} is a POSIX extended regular expression: one of the remote's URLs (as git
 *   reads them, `insteadOf` applied) must match it ("No such URL found: <oldurl>"), and the
 *   configuration's one value it matches is replaced (no value matching: the new one is added);
 * - {@link setDelete} removes every value matching the pattern given as the URI, refusing to
 *   remove every fetch URL ("Will not delete all non-push URLs").
 *
 * The remote must be configured in the repository (a `remote.<name>.*` variable, or a legacy
 * remote file); tracking refs alone do not make one.
 *
 * @example
 * ```typescript
 * await git.remoteSetUrl()
 *   .setRemoteName("origin")
 *   .setRemoteUri("https://github.com/user/repo")
 *   .call();
 * await git.remoteSetUrl().setRemoteName("origin").setRemoteUri("^https://old").setDelete(true).call();
 * ```
 */
export class RemoteSetUrlCommand extends GitCommand<RemoteConfig> {
  private remoteName?: string;
  private remoteUri?: string;
  private pushUri = false;
  private oldUri?: string;
  private addMode = false;
  private deleteMode = false;
  private messages: string[] = [];

  /**
   * Set the remote name.
   *
   * @param name Remote name
   */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /**
   * Get the remote name.
   */
  getRemoteName(): string | undefined {
    return this.remoteName;
  }

  /**
   * Set the new remote URI (with {@link setDelete}: the pattern of the URLs to delete).
   *
   * @param uri New remote URL
   */
  setRemoteUri(uri: string): this {
    this.checkCallable();
    this.remoteUri = uri;
    return this;
  }

  /**
   * Get the new remote URI.
   */
  getRemoteUri(): string | undefined {
    return this.remoteUri;
  }

  /**
   * Set whether this is a push URL.
   *
   * @param push Whether to set push URL
   */
  setPush(push: boolean): this {
    this.checkCallable();
    this.pushUri = push;
    return this;
  }

  /**
   * Whether this is a push URL.
   */
  isPush(): boolean {
    return this.pushUri;
  }

  /**
   * Set the URL to replace: a POSIX extended regular expression (`<oldurl>` of
   * `git remote set-url <name> <newurl> <oldurl>`), matched anywhere in each URL. Only the
   * value it matches is replaced; without it, the new URL replaces the variable's value.
   *
   * @param uri Old URI pattern
   */
  setOldUri(uri: string): this {
    this.checkCallable();
    this.oldUri = uri;
    return this;
  }

  /** Add the URL to the remote's URLs (`--add`) instead of replacing one. */
  setAdd(add: boolean): this {
    this.checkCallable();
    this.addMode = add;
    return this;
  }

  /** Delete the URLs matching the URI given, a pattern (`--delete`). */
  setDelete(del: boolean): this {
    this.checkCallable();
    this.deleteMode = del;
    return this;
  }

  /** git 2.5x's warnings reading a legacy remote file. Empty before {@link call}. */
  getMessages(): string[] {
    return [...this.messages];
  }

  /**
   * Execute the remote set-url operation.
   *
   * @returns Updated remote configuration
   * @throws MissingArgumentError if remote name or URI is not set
   * @throws GitApiError (exit 128) for `--add` with `--delete` ("--add --delete doesn't make
   *   sense"), or an old URL with either (exit 129, usage)
   * @throws RemoteNotFoundError (exit 2) if the remote is not configured ("No such remote")
   * @throws GitApiError (exit 128) for git's other refusals: "No such URL found: <oldurl>",
   *   "Will not delete all non-push URLs", "could not set '<key>' to '<url>'", "could not
   *   unset '<key>'", "Invalid old URL pattern: <oldurl>"
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    const name = this.remoteName;
    if (!name) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }
    if (this.remoteUri === undefined) {
      throw new MissingArgumentError("remoteUri", "Remote URI must be specified");
    }
    if (this.addMode && this.deleteMode) {
      throw new GitApiError("fatal: --add --delete doesn't make sense");
    }
    if ((this.addMode || this.deleteMode) && this.oldUri !== undefined) {
      throw new GitApiError(
        this.addMode
          ? "usage: git remote set-url --add <name> <newurl>"
          : "usage: git remote set-url --delete <name> <url>",
        { exitCode: 129 },
      );
    }
    const newUrl = this.remoteUri;
    const oldUrl = this.deleteMode ? newUrl : this.oldUri;

    this.messages.push(...(await this.loadLegacyRemote(name)));
    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfiguredInRepo(name)) {
      throw new RemoteNotFoundError(name, `error: No such remote '${name}'`);
    }
    const key = `remote.${name}.${this.pushUri ? "pushurl" : "url"}`;
    const values = store.localValues(key);

    if (oldUrl === undefined || this.addMode) {
      // repo_config_set, or set_multivar with "^$" for --add
      const pattern = this.addMode ? compileUrlPattern("^$") : undefined;
      const matching = values.filter((v) => pattern === undefined || matchesUrl(pattern, v));
      if (matching.length > 1) throw couldNotSet(key, newUrl);
      if (pattern === undefined) store.setValue(key, newUrl);
      else replaceMatching(store, key, values, pattern, newUrl);
      await store.save();
      return store.read(name);
    }

    let regex: PosixRegex;
    try {
      regex = compileUrlPattern(oldUrl);
    } catch (cause) {
      if (!(cause instanceof PosixRegexError)) throw cause;
      throw new GitApiError(`fatal: Invalid old URL pattern: ${oldUrl}`, { cause });
    }
    // matched against the URLs as git reads them (alias_all_urls), not the variable's values
    const urls = store.urlSet(name, this.pushUri);
    const matches = urls.filter((url) => matchesUrl(regex, url)).length;
    if (!this.deleteMode && matches === 0) {
      throw new GitApiError(`fatal: No such URL found: ${oldUrl}`);
    }
    if (this.deleteMode && matches === urls.length && !this.pushUri) {
      throw new GitApiError("fatal: Will not delete all non-push URLs");
    }
    const hits = values.filter((v) => matchesUrl(regex, v)).length;
    if (this.deleteMode) {
      if (hits === 0) throw new GitApiError(`fatal: could not unset '${key}'`);
      store.setValues(
        key,
        values.filter((v): v is string => v !== undefined && !matchesUrl(regex, v)),
      );
    } else {
      if (hits > 1) throw couldNotSet(key, newUrl);
      replaceMatching(store, key, values, regex, newUrl);
    }
    await store.save();
    return store.read(name);
  }
}

/** git's refusal to set one of several values: store_aux's warning, then the death. */
function couldNotSet(key: string, value: string): GitApiError {
  return new GitApiError(
    `warning: ${key} has multiple values\nfatal: could not set '${key}' to '${value}'`,
    { exitCode: 128 },
  );
}

/** git's regcomp(REG_EXTENDED) of a URL pattern. */
function compileUrlPattern(pattern: string): PosixRegex {
  return compilePosixRegex(pattern, { extended: true });
}

/** git's config value match: a variable without `=` never matches. */
function matchesUrl(regex: PosixRegex, value: string | undefined): boolean {
  return value !== undefined && regex.test(new TextEncoder().encode(value));
}

/**
 * git's set_multivar with a value pattern and no multi-replace (at most one value matches):
 * the matching value is replaced where it is, or the new one added after the others.
 */
function replaceMatching(
  store: RemoteConfigStore,
  key: string,
  values: (string | undefined)[],
  regex: PosixRegex,
  newValue: string,
): void {
  if (!values.some((v) => matchesUrl(regex, v))) {
    store.addValue(key, newValue);
    return;
  }
  store.setValues(
    key,
    values.map((v) => (matchesUrl(regex, v) ? newValue : (v ?? ""))),
  );
}

/**
 * Point `refs/remotes/<name>/HEAD` at one of the remote's tracking branches, or delete it.
 *
 * Equivalent to `git remote set-head <name> <branch>`, `git remote set-head <name> -a`
 * and `git remote set-head <name> -d`. The symbolic ref names the remote's default branch,
 * so the remote name alone resolves to that branch (`git log origin`); `git clone` creates
 * it. With {@link setAuto} the remote is asked which branch its HEAD is (its HEAD symref,
 * or else the one branch at HEAD's commit). As git 2.48+, setting it on a remote whose
 * `remote.<name>.followRemoteHEAD` is `always` turns that into `warn`, so the next fetch
 * does not undo the choice.
 *
 * @example
 * ```typescript
 * await git.remoteSetHead().setRemoteName("origin").setBranch("develop").call();
 * await git.remoteSetHead().setRemoteName("origin").setAuto(true).call();
 * await git.remoteSetHead().setRemoteName("origin").setDelete(true).call();
 * ```
 */
export class RemoteSetHeadCommand extends TransportCommand<string | undefined> {
  private remoteName?: string;
  private branch?: string;
  private deleteHead = false;
  private auto = false;
  private messages: string[] = [];

  /** Set the remote whose HEAD is set. */
  setRemoteName(name: string): this {
    this.checkCallable();
    this.remoteName = name;
    return this;
  }

  /** Set the branch (`develop`, or `refs/remotes/origin/develop`) HEAD names. */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /** Delete `refs/remotes/<name>/HEAD` instead (`-d`). */
  setDelete(deleteHead: boolean): this {
    this.checkCallable();
    this.deleteHead = deleteHead;
    return this;
  }

  /**
   * What `git remote set-head -a` prints (git 2.48+): `'origin/HEAD' is now created and
   * points to 'main'`, `… is unchanged and points to …`, `… has changed from 'a' and now
   * points to 'b'`, and so on. Empty without {@link setAuto}, or before {@link call}.
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /** Ask the remote which branch its HEAD is, and point at that one (`-a`). */
  setAuto(auto: boolean): this {
    this.checkCallable();
    this.auto = auto;
    return this;
  }

  /**
   * @returns The tracking ref HEAD now names, or undefined after a delete
   * @throws RefNotFoundError if the tracking branch does not exist (git: "Not a valid ref: <ref>")
   * @throws RefNotFoundError with `-a` when the remote HEAD names no branch (git: "Cannot
   *   determine remote HEAD"), or several ("Multiple remote HEAD branches. Please choose
   *   one explicitly with:" and a `git remote set-head` line for each)
   */
  async call(): Promise<string | undefined> {
    this.checkCallable();
    this.setCallable(false);
    const remote = this.remoteName;
    if (!remote) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }
    const top = `refs/remotes/${remote}/`;
    if (this.deleteHead) {
      await this.refsStore.delete(`${top}HEAD`);
      return undefined;
    }
    let branch = this.branch;
    if (this.auto) {
      const heads = await this.remoteHeads(remote);
      if (heads.length === 0) {
        throw new RefNotFoundError(`${top}HEAD`, "Cannot determine remote HEAD");
      }
      if (heads.length > 1) {
        const lines = heads.map((h) => `  git remote set-head ${remote} ${h}`);
        throw new RefNotFoundError(
          `${top}HEAD`,
          ["Multiple remote HEAD branches. Please choose one explicitly with:", ...lines].join(
            "\n",
          ),
        );
      }
      branch = heads[0];
    }
    if (!branch) {
      throw new MissingArgumentError("branch", "Branch must be specified, or auto or delete set");
    }
    const target = branch.startsWith(top) ? branch : `${top}${branch}`;
    if (!(await this.refsStore.resolve(target))?.objectId) {
      throw new RefNotFoundError(target, `Not a valid ref: ${target}`);
    }
    const previous = await this.refsStore.get(`${top}HEAD`);
    // git's `create_symref(..., "remote set-head")`: logged in the symbolic ref's reflog
    await this.refsStore.setSymbolic(`${top}HEAD`, target, this.reflogLine("remote set-head"));
    if (this.auto)
      this.messages.push(reportSetHeadAuto(remote, target.slice(top.length), previous));
    const store = RemoteConfigStore.from(this.workingCopy);
    if (store.value(`remote.${remote}.followRemoteHEAD`) === "always") {
      store.setValue(`remote.${remote}.followRemoteHEAD`, "warn");
      await store.save();
    }
    return target;
  }

  /**
   * The remote's HEAD branches, as git's get_remote_ref_states (GET_HEAD_NAMES) finds them:
   * every ref listed, then the branch HEAD's symref names, or else every branch at HEAD's
   * commit (git's guess_remote_head with all matches).
   */
  private async remoteHeads(remote: string): Promise<string[]> {
    const url = RemoteConfigStore.from(this.workingCopy).urlFor(remote);
    if (!url) throw new InvalidRemoteError(remote);
    // the remote's transport: local in process, else the registry's connector
    const refs: readonly TransportRemoteRef[] = await withRemoteUploadPack(
      await this.prepareRemote(url),
      this.remoteSessionOptions(),
      async (connection) =>
        connection.version === 2 ? lsRefs(connection, []) : (connection.advertisedRefs ?? []),
    );
    const head = refs.find((r) => r.name === "HEAD");
    if (!head) return [];
    const branches = refs.filter((r) => r.oid && r.name.startsWith("refs/heads/"));
    const matches = head.symref
      ? branches.filter((r) => r.name === head.symref)
      : branches.filter((r) => r.oid === head.oid);
    return matches.map((r) => r.name.slice("refs/heads/".length));
  }
}
