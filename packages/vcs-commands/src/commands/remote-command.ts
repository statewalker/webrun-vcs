import { isSymbolicRef, isValidRefName, type OwnReflogLine } from "@statewalker/vcs-core";
import {
  expandFromDestination,
  lsRefs,
  matchDestination,
  openHttpConnection,
  parseRefSpec,
  type RefSpec,
  type RemoteRef as TransportRemoteRef,
} from "@statewalker/vcs-transport";

import {
  InvalidArgumentError,
  InvalidRemoteError,
  MissingArgumentError,
  RefNotFoundError,
  RemoteAlreadyExistsError,
  RemoteNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import {
  defaultFetchRefspec,
  deleteRefs,
  listRemoteNames,
  moveRefs,
  type RemoteConfig,
  RemoteConfigStore,
} from "../remote-config/index.js";
import { TransportCommand } from "../transport-command.js";

const ZERO_ID = "0".repeat(40);

export type { RemoteConfig };

/**
 * Add a remote to the repository.
 *
 * Equivalent to `git remote add`.
 *
 * Based on JGit's RemoteAddCommand.
 *
 * The remote is written to the working copy configuration as a
 * `[remote "<name>"]` section, so it survives the command that created it.
 * A remote already known from `refs/remotes/<name>/*` counts as existing even
 * without a config section.
 *
 * @example
 * ```typescript
 * await git.remoteAdd()
 *   .setName("upstream")
 *   .setUri("https://github.com/user/repo")
 *   .call();
 * ```
 */
export class RemoteAddCommand extends GitCommand<RemoteConfig> {
  private name?: string;
  private uri?: string;
  private fetchRefspec?: string;

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
   * Set custom fetch refspec.
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

  /**
   * Execute the remote add operation.
   *
   * @returns Remote configuration
   * @throws Error if name or URI is not set
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.name) {
      throw new MissingArgumentError("name", "Remote name must be specified");
    }
    if (!this.uri) {
      throw new MissingArgumentError("uri", "Remote URI must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);

    // A remote exists if it is configured OR if it already has tracking refs.
    if (store.isConfigured(this.name) || (await this.hasTrackingRefs(this.name))) {
      throw new RemoteAlreadyExistsError(this.name);
    }

    const config: RemoteConfig = {
      name: this.name,
      urls: [this.uri],
      pushUrls: [],
      fetchRefspecs: [this.fetchRefspec || defaultFetchRefspec(this.name)],
      pushRefspecs: [],
    };

    store.write(config);
    await store.save();

    return config;
  }

  /** Whether any `refs/remotes/<name>/*` ref exists. */
  private async hasTrackingRefs(name: string): Promise<boolean> {
    for await (const _ref of this.refsStore.list(`refs/remotes/${name}/`)) {
      return true;
    }
    return false;
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

    await deleteRefs(this.refsStore, refsToDelete, "remote: remove");
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
    if (!store.isConfigured(oldName)) {
      throw new RemoteNotFoundError(oldName, `No such remote: '${oldName}'`);
    }
    if (store.isConfigured(newName)) {
      throw new RemoteAlreadyExistsError(newName, `remote ${newName} already exists.`);
    }
    if (!isValidRemoteName(newName)) {
      throw new InvalidArgumentError("newName", newName, `'${newName}' is not a valid remote name`);
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
            oldId: id ?? ZERO_ID,
            newId: id ?? ZERO_ID,
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
    const warnings: string[] = [];
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
function isValidRemoteName(name: string): boolean {
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
 * Set URL for a remote.
 *
 * Equivalent to `git remote set-url`.
 *
 * Based on JGit's RemoteSetUrlCommand.
 *
 * @example
 * ```typescript
 * await git.remoteSetUrl()
 *   .setRemoteName("origin")
 *   .setRemoteUri("https://github.com/user/repo")
 *   .call();
 * ```
 */
export class RemoteSetUrlCommand extends GitCommand<RemoteConfig> {
  private remoteName?: string;
  private remoteUri?: string;
  private pushUri = false;
  private oldUri?: string;

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
   * Set the new remote URI.
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
   * Set the URL to replace.
   *
   * Only this URL is replaced, leaving the remote's other URLs alone — the
   * `<oldurl>` argument of `git remote set-url <name> <newurl> <oldurl>`.
   * Without it, the new URL replaces all of them.
   *
   * @param uri Old URI to replace
   */
  setOldUri(uri: string): this {
    this.checkCallable();
    this.oldUri = uri;
    return this;
  }

  /**
   * Execute the remote set-url operation.
   *
   * The URL is written to the working copy configuration, so it survives the
   * command. The remote may be known from its config section or from its
   * tracking refs; in the latter case, this is what first gives it a URL.
   *
   * @returns Updated remote configuration
   * @throws MissingArgumentError if remote name or URI is not set
   * @throws RemoteNotFoundError if the remote is neither configured nor tracked
   * @throws InvalidArgumentError if {@link setOldUri} names a URL the remote does not have
   */
  async call(): Promise<RemoteConfig> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.remoteName) {
      throw new MissingArgumentError("remoteName", "Remote name must be specified");
    }
    if (!this.remoteUri) {
      throw new MissingArgumentError("remoteUri", "Remote URI must be specified");
    }

    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfigured(this.remoteName) && !(await this.hasTrackingRefs(this.remoteName))) {
      throw new RemoteNotFoundError(this.remoteName);
    }

    store.setUrl(this.remoteName, this.remoteUri, {
      push: this.pushUri,
      oldUrl: this.oldUri,
    });
    await store.save();

    return store.read(this.remoteName);
  }

  /** Whether any `refs/remotes/<name>/*` ref exists. */
  private async hasTrackingRefs(name: string): Promise<boolean> {
    for await (const _ref of this.refsStore.list(`refs/remotes/${name}/`)) {
      return true;
    }
    return false;
  }
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
    const connection = await openHttpConnection({
      url,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
    });
    let refs: readonly TransportRemoteRef[];
    try {
      refs =
        connection.version === 2 ? await lsRefs(connection, []) : (connection.advertisedRefs ?? []);
    } finally {
      await connection.close();
    }
    const head = refs.find((r) => r.name === "HEAD");
    if (!head) return [];
    const branches = refs.filter((r) => r.oid && r.name.startsWith("refs/heads/"));
    const matches = head.symref
      ? branches.filter((r) => r.name === head.symref)
      : branches.filter((r) => r.oid === head.oid);
    return matches.map((r) => r.name.slice("refs/heads/".length));
  }
}
