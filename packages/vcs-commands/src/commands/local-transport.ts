/**
 * git's local transport: a repository named by a path (or a `file://` URL) is opened through
 * the working copy's storage and served by upload-pack (or receive-pack) in process, over an
 * in-memory duplex, where git spawns `git-upload-pack '<path>'`. Which transport a URL takes
 * is decided in `remote-transport.ts` (`resolveRemote`).
 */

import { historyWithoutLazyFetch, type RefTransactionHook } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type Duplex,
  type GitServeSettings,
  openDuplexConnection,
  openDuplexReceivePackConnection,
  type ReceiveCommand,
  type ReceivePackConnection,
  ReceivePackDiedError,
  type ReceivePackHookContext,
  type ReceivePackHooks,
  type ServedRequestContext,
  type ServerConfigSettings,
  serveOverDuplex,
  serverSettingsFromConfig,
  type UploadPackConnection,
} from "@statewalker/vcs-transport";
import { parseGitBool, parseGitInt } from "@statewalker/vcs-utils/encoding";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  type LinkedWorktrees,
  type OpenedRepository,
  sparseFilterMatcher,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { GitApiError, TransportError } from "../errors/index.js";
import { quoteCStyleBody } from "../results/index.js";
import {
  HookSession,
  hookHostOf,
  hookSettingsFromEntries,
  LOCAL_REPO_ENV,
  refTransactionHookOf,
} from "./git-hooks.js";
import { ReadTreeCommand } from "./read-tree-command.js";
import { StatusCommand } from "./status-command.js";
import { repositoryPlaceOf, usesBranch, worktreeUsingBranch } from "./worktree-support.js";

/** The client's lines when the remote end of a local transport died. */
const COULD_NOT_READ =
  "fatal: Could not read from remote repository.\n\n" +
  "Please make sure you have the correct access rights\nand the repository exists.";

const NOT_A_REPOSITORY = (path: string) =>
  `fatal: '${path}' does not appear to be a git repository\n${COULD_NOT_READ}`;

/**
 * A connected pair of in-memory duplex streams: what one side writes, the other reads. `end`
 * half-closes a side (the other one reads to its end and can still answer); `close` ends it.
 */
export function createDuplexPair(): [Duplex, Duplex] {
  const make = () => {
    const queue: Uint8Array[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const push = (chunk: Uint8Array | null) => {
      if (chunk === null) ended = true;
      else queue.push(chunk);
      wake?.();
      wake = undefined;
    };
    async function* read(): AsyncGenerator<Uint8Array> {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    return { push, read };
  };
  const a = make();
  const b = make();
  let aClosed = false;
  let bClosed = false;
  const endLeft = async () => {
    if (aClosed) return;
    aClosed = true;
    b.push(null);
  };
  const endRight = async () => {
    if (bClosed) return;
    bClosed = true;
    a.push(null);
  };
  const left: Duplex = {
    [Symbol.asyncIterator]: () => a.read()[Symbol.asyncIterator](),
    write: (data) => {
      if (!aClosed) b.push(data.slice());
    },
    end: endLeft,
    close: endLeft,
  };
  const right: Duplex = {
    [Symbol.asyncIterator]: () => b.read()[Symbol.asyncIterator](),
    write: (data) => {
      if (!bClosed) a.push(data.slice());
    },
    end: endRight,
    close: endRight,
  };
  return [left, right];
}

/**
 * Opens the repository a local remote names (see `Worktree.openRepository`), or throws
 * git's "does not appear to be a git repository" lines (exit 128).
 */
export async function openLocalRemote(
  workingCopy: WorkingCopy,
  path: string,
): Promise<OpenedRepository> {
  // a bare repository opens it from its git directory, as git runs there
  // upload-pack opens it whatever its owner (git 2.48+'s ENTER_REPO_ANY_OWNER_OK);
  // receive-pack checks before it serves (withLocalReceivePack)
  const opened = await repositoryPlaceOf(workingCopy)
    ?.openRepository?.(path, { checkOwnership: false, commandLineConfig: false })
    .catch(() => undefined);
  if (!opened) throw new TransportError(NOT_A_REPOSITORY(path));
  return opened;
}

/**
 * Runs `run` over a connection to upload-pack serving a local repository (opened by
 * {@link openLocalRemote}) with protocol v2, git's default `protocol.version` (v0 when the
 * option says 0, v1 when it says 1), as git's local transport runs `git-upload-pack '<path>'`,
 * in process.
 */
export async function withLocalUploadPack<T>(
  remote: OpenedRepository,
  run: (connection: UploadPackConnection) => Promise<T>,
  options: { protocolVersion?: 0 | 1 | 2 } = {},
): Promise<T> {
  const head = await remote.history.refs.get("HEAD").catch(() => undefined);
  const settings = serverSettingsOf(remote);
  const [client, server] = createDuplexPair();
  // upload-pack never fetches lazily (GIT_NO_LAZY_FETCH): it reads through the history's
  // view without lazy fetch, as receive-pack does (rev-list --exclude-promisor-objects)
  const serving = (async () =>
    serveOverDuplex({
      duplex: server,
      repository: createRepositoryFacade({
        history: historyWithoutLazyFetch(remote.history),
        useBitmaps: servedUseBitmaps(remote),
        sparseFilterPatterns: sparseFilterMatcher,
        maxTreeDepth: servedMaxTreeDepth(remote),
      }),
      refStore: createTransportRefStore(remote.history.refs),
      service: "git-upload-pack",
      ...((options.protocolVersion ?? 2) === 2 ? { protocolVersion: "2" as const } : {}),
      // GIT_PROTOCOL=version=1: upload-pack's `version 1` line before its advertisement
      ...(options.protocolVersion === 1 ? { announceVersion1: true } : {}),
      // uploadpack.hideRefs and transfer.hideRefs, in the order git reads them
      uploadPackHideRefs: settings.uploadPackHideRefs,
      // uploadpack.allowFilter and uploadpackfilter.*
      ...(settings.uploadPackFilter ? { uploadPackFilter: settings.uploadPackFilter } : {}),
      ...(head && "target" in head ? { currentBranch: head.target } : {}),
    }))().finally(() => server.close?.());
  try {
    const connection = await openDuplexConnection(client, { closeDuplex: true });
    try {
      return await run(connection);
    } catch (error) {
      throw packFailure(error) ?? error;
    } finally {
      await connection.close();
    }
  } finally {
    await client.close?.();
    await serving.catch(() => undefined);
  }
}

/**
 * The lines git prints when upload-pack's pack-objects fails on an object it cannot read
 * (upload-pack.c's create_pack_file): its own error and death (upload-pack's stderr, which
 * the local transport shares), the abort message it sends on band 3, then the client's
 * deaths. The pack failure reaches the client as a band-3 `ERR <reason>` (`sendPackStream`).
 */
function packFailure(error: unknown): TransportError | undefined {
  const message = error instanceof Error ? error.message : "";
  if (!(error instanceof Error) || error.name !== "ServerError" || !message.startsWith("ERR ")) {
    return undefined;
  }
  const abort = "aborting due to possible repository corruption on the remote side.";
  return new TransportError(
    [
      "error: git upload-pack: git-pack-objects died with error.",
      `fatal: git upload-pack: ${abort}`,
      `remote: ${abort}`,
      "fatal: early EOF",
      "fatal: fetch-pack: invalid index-pack output",
    ].join("\n"),
    undefined,
    { cause: error },
  );
}

/** git's defaults, for a repository whose configuration cannot be read. */
const DEFAULT_SETTINGS: ServerConfigSettings = {
  allowDeletes: true,
  allowNonFastForward: true,
  denyCurrentBranch: "unconfigured",
  denyDeleteCurrent: "unconfigured",
  shallowUpdate: false,
  uploadPackHideRefs: [],
  receivePackHideRefs: [],
};

/**
 * The served repository's `pack.useBitmaps` (default true): its pack-objects (upload-pack's)
 * lists through a bitmap only while it allows.
 */
export function servedUseBitmaps(remote: OpenedRepository): boolean {
  const value = remote.config?.getAll("pack.useBitmaps").at(-1);
  if (value === undefined || value === null) return true;
  return parseGitBool(String(value)) ?? true;
}

/**
 * The served repository's `core.maxTreeDepth` (git's repo settings, default 2048): its
 * pack-objects dies on a deeper tree. Undefined when unset or unreadable (the default then).
 */
export function servedMaxTreeDepth(remote: OpenedRepository): number | undefined {
  const value = remote.config?.getAll("core.maxTreeDepth").at(-1);
  if (value === undefined || value === null) return undefined;
  return parseGitInt(value);
}

/** What git's upload-pack and receive-pack read from the served repository's config. */
function serverSettingsOf(remote: OpenedRepository): ServerConfigSettings {
  const config = remote.config;
  if (!config) return DEFAULT_SETTINGS;
  const listWithOrigin = config.listWithOrigin?.bind(config);
  if (!listWithOrigin) return serverSettingsFromConfig(config);
  // receive-pack runs in the git directory: git names its files from there (`config`)
  const gitDir = `${remote.gitDir.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
  return serverSettingsFromConfig({
    getAll: (key) => config.getAll(key),
    list: () => config.list(),
    listWithOrigin: () =>
      listWithOrigin().map((e) =>
        e.file?.replace(/^\/+/, "").startsWith(gitDir)
          ? { ...e, file: e.file.replace(/^\/+/, "").slice(gitDir.length) }
          : e,
      ),
  });
}

/**
 * The branches the HEAD of a non-bare worktree of the repository uses, the main one and
 * every linked one (git's `find_shared_symref(get_worktrees(), "HEAD", ref)`, a worktree
 * being rebased or bisected on a branch included); undefined without the worktree list.
 */
async function checkedOutBranches(
  worktrees: LinkedWorktrees | undefined,
): Promise<string[] | undefined> {
  if (!worktrees) return undefined;
  const list = await worktrees.list().catch(() => undefined);
  if (!list) return undefined;
  const out = new Set<string>();
  for (const wt of list) {
    for (const ref of [wt.headRef, wt.rebasing, wt.bisecting]) {
      if (ref !== undefined && usesBranch(wt, ref)) out.add(ref);
    }
  }
  return [...out];
}

/**
 * receive.denyCurrentBranch=updateInstead (receive-pack.c's `update_worktree`, without the
 * push-to-checkout hook: `push_to_deploy`): the worktree that has `ref` checked out is
 * refused while it has unstaged or staged changes, else brought to `newOid` by
 * `read-tree -u -m`; the ref itself is updated afterwards by receive-pack.
 *
 * @returns the refusal reason, as git reports it; undefined when the worktree was updated
 */
export async function pushToDeploy(
  worktrees: LinkedWorktrees,
  ref: string,
  newOid: string,
): Promise<string | undefined> {
  const wt = await worktreeUsingBranch(worktrees, ref);
  if (!wt) return "denyCurrentBranch = updateInstead needs a worktree";
  let workingCopy: WorkingCopy;
  try {
    workingCopy = await worktrees.open(wt);
  } catch {
    return "Up-to-date check failed";
  }
  // diff-files --quiet --ignore-submodules, then diff-index --quiet --cached HEAD
  const status = await new StatusCommand(workingCopy)
    .setUntrackedFiles("no")
    .setIgnoreSubmodules("all")
    .call();
  if (status.modified.size > 0 || status.missing.size > 0 || status.conflicting.size > 0) {
    return "Working directory has unstaged changes";
  }
  if (status.added.size > 0 || status.changed.size > 0 || status.removed.size > 0) {
    return "Working directory has staged changes";
  }
  try {
    await new ReadTreeCommand(workingCopy).addTree(newOid).setMerge(true).setUpdate(true).call();
  } catch {
    return "Could not update working tree to new HEAD";
  }
  return undefined;
}

/**
 * Runs `run` over a connection to receive-pack serving a local repository (opened by
 * {@link openLocalRemote}), as git's local transport runs `git-receive-pack '<path>'`, in
 * process: the pushed objects go into that repository and its refs are updated there, under
 * the settings git's receive-pack reads from that repository's config (see
 * `serverSettingsFromConfig`: deletes, forced updates, the current branch, hidden refs,
 * shallow updates). A branch checked out in any non-bare worktree of it, linked ones
 * included, is the current branch `receive.denyCurrentBranch` rules on.
 */
export async function withLocalReceivePack<T>(
  remote: OpenedRepository,
  run: (connection: ReceivePackConnection) => Promise<T>,
  /** The remote repository's hooks ({@link remoteHookSession}): pre-receive, update, ... */
  hooks?: HookSession,
  /**
   * The session its reference-transaction hook runs in (default `hooks`): that hook's
   * output reaches the pushing user's stderr directly, not as "remote: " lines
   */
  transactionHooks: HookSession | undefined = hooks,
  /** `protocol.version`: 1 has receive-pack answer `version 1` first (2 is v0 for a push) */
  options: { protocolVersion?: 0 | 1 | 2 } = {},
): Promise<T> {
  // receive-pack's enter_repo(path, 0): a repository another user owns is refused (git's
  // die_upon_dubious_ownership in the child), and the client sees the connection fail
  try {
    await remote.checkOwnership?.();
  } catch (error) {
    if (error instanceof Error && error.name === "DubiousOwnershipError") {
      throw new TransportError(`${error.message}\n${COULD_NOT_READ}`);
    }
    throw error;
  }
  const receiveHooks = hooks?.enabled ? scriptReceiveHooks(hooks) : undefined;
  // the remote's reference-transaction hook on its ref store while receive-pack runs (its
  // output goes to the pushing user's stderr directly, not through the side-band)
  return withReceiveTransactionHook(remote, transactionHooks, () =>
    receiveOver(remote, run, hooks, receiveHooks, options.protocolVersion === 1),
  );
}

/**
 * The receive-side reference-transaction hooks installed on a ref store, oldest first, and
 * the hook the store had before the first of them: overlapping receive-packs on one store
 * (two served pushes at once) each put theirs in and take theirs out, whatever the order
 * they end in, and the last one out puts back the store's own.
 */
const receiveTransactionHooks = new WeakMap<
  object,
  { active: RefTransactionHook[]; previous: RefTransactionHook | undefined }
>();

/**
 * Runs `body` with the reference-transaction hook of `hooks` (a receiving repository's
 * session) installed on `remote`'s ref store, as git's receive-pack runs it: in the git
 * directory with `GIT_DIR=.` and no `GIT_PREFIX`. The hook that was there before is put
 * back after (once every overlapping receive on the store has ended). Without a hook
 * runner, or a ref store that cannot take one, `body` alone.
 */
export async function withReceiveTransactionHook<T>(
  remote: OpenedRepository,
  hooks: HookSession | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const store = remote.history.refs as {
    setTransactionHook?(hook: RefTransactionHook | undefined): void;
    getTransactionHook?(): RefTransactionHook | undefined;
  };
  if (!hooks?.enabled || store.setTransactionHook === undefined) return body();
  const transactionHook = refTransactionHookOf(hooks, { env: { GIT_DIR: "." }, prefix: false });
  let installed = receiveTransactionHooks.get(store);
  if (!installed) {
    installed = { active: [], previous: store.getTransactionHook?.() };
    receiveTransactionHooks.set(store, installed);
  }
  installed.active.push(transactionHook);
  store.setTransactionHook(transactionHook);
  try {
    return await body();
  } finally {
    const { active, previous } = installed;
    active.splice(active.indexOf(transactionHook), 1);
    const current = store.getTransactionHook?.();
    // a hook installed meanwhile by something else (a command's) stays where it is
    const ours = current === transactionHook || current === undefined;
    if (active.length === 0) {
      receiveTransactionHooks.delete(store);
      if (ours) store.setTransactionHook(previous);
    } else if (ours) {
      store.setTransactionHook(active[active.length - 1]);
    }
  }
}

/**
 * The settings git's receive-pack takes from the repository it serves: the policies and hidden
 * refs of its config (`serverSettingsFromConfig`), its current branch and the branches its
 * worktrees have checked out, `updateInstead` (push-to-checkout, push-to-deploy), and, with
 * hooks, pre-receive / update / post-receive run as git's receive-pack runs them.
 */
export async function receivePackSettingsOf(
  remote: OpenedRepository,
  hooks?: HookSession,
  receiveHooks: ReceivePackHooks | undefined = hooks?.enabled
    ? scriptReceiveHooks(hooks)
    : undefined,
): Promise<GitServeSettings> {
  const head = await remote.history.refs.get("HEAD").catch(() => undefined);
  const settings = serverSettingsOf(remote);
  const checkedOut = await checkedOutBranches(remote.worktrees);
  const worktrees = remote.worktrees;
  return {
    bare: remote.bare,
    ...(head && "target" in head ? { currentBranch: head.target } : {}),
    allowDeletes: settings.allowDeletes,
    allowNonFastForward: settings.allowNonFastForward,
    denyCurrentBranch: settings.denyCurrentBranch,
    denyDeleteCurrent: settings.denyDeleteCurrent,
    shallowUpdate: settings.shallowUpdate,
    uploadPackHideRefs: settings.uploadPackHideRefs,
    receivePackHideRefs: settings.receivePackHideRefs,
    ...(receiveHooks ? { hooks: receiveHooks, relayPostReceive: true } : {}),
    // git's receive-pack migrates its quarantine before update() checks the commands
    publishBeforeUpdate: true,
    // ... and runs pre-receive with every command, refused ones included (skip_broken 0)
    preReceiveSeesRefused: true,
    // receive.procReceiveRefs: the commands the proc-receive hook takes
    ...(settings.procReceiveRefs?.length ? { procReceiveRefs: settings.procReceiveRefs } : {}),
    ...(settings.receivePackConfigError !== undefined
      ? { receivePackConfigError: settings.receivePackConfigError }
      : {}),
    // git 2.5x updates the refs of a push that is not atomic in two batches
    ...(hooks?.enabled && hooks.compatibility !== "2.43" ? { batchNonAtomic: true } : {}),
    // ... git 2.43 updates each ref after its update hook
    ...(hooks?.enabled && hooks.compatibility === "2.43" ? { interleaveUpdateHook: true } : {}),
    ...(checkedOut ? { checkedOutBranches: checkedOut } : {}),
    ...(worktrees
      ? {
          updateWorktree: async (ref: string, newOid: string, ctx?: ReceivePackHookContext) => {
            const verdict = await pushToCheckout(hooks, worktrees, ref, newOid, ctx);
            return verdict === null ? pushToDeploy(worktrees, ref, newOid) : verdict;
          },
        }
      : {}),
  };
}

async function receiveOver<T>(
  remote: OpenedRepository,
  run: (connection: ReceivePackConnection) => Promise<T>,
  hooks: HookSession | undefined,
  receiveHooks: ReceivePackHooks | undefined,
  version1: boolean,
): Promise<T> {
  const [client, server] = createDuplexPair();
  const settings = await receivePackSettingsOf(remote, hooks, receiveHooks);
  const serving = serveOverDuplex({
    ...settings,
    duplex: server,
    repository: createRepositoryFacade({
      history: historyWithoutLazyFetch(remote.history),
      useBitmaps: servedUseBitmaps(remote),
      sparseFilterPatterns: sparseFilterMatcher,
      maxTreeDepth: servedMaxTreeDepth(remote),
    }),
    refStore: createTransportRefStore(remote.history.refs),
    service: "git-receive-pack",
    ...(version1 ? { announceVersion1: true } : {}),
  }).finally(() => server.close?.());
  // receive-pack died (its reference-transaction hook aborted the update): its message on
  // the shared stderr, then send-pack's, as git's local transport shows them
  const died = async (cause?: unknown) => {
    await client.close?.();
    const served = await serving.catch(() => undefined);
    if (!served?.error?.startsWith("fatal: ")) return undefined;
    return new TransportError(
      `${served.error}\nsend-pack: unexpected disconnect while reading sideband packet\n` +
        "fatal: the remote end hung up unexpectedly",
      undefined,
      cause === undefined ? undefined : { cause },
    );
  };
  try {
    const connection = await openDuplexReceivePackConnection(client, { closeDuplex: true });
    let value: T;
    try {
      value = await run(connection);
    } finally {
      await connection.close();
    }
    const death = await died();
    if (death) throw death;
    return value;
  } catch (error) {
    // receive-pack died before it advertised anything (its config unreadable): its lines,
    // then the client's, as git's connect shows them
    const early = settings.receivePackConfigError;
    if (early !== undefined) {
      await client.close?.();
      await serving.catch(() => undefined);
      throw new TransportError(
        `${early}\nfatal: Could not read from remote repository.\n\n` +
          "Please make sure you have the correct access rights\nand the repository exists.",
        undefined,
        { cause: error },
      );
    }
    if (error instanceof TransportError) throw error;
    throw (await died(error)) ?? error;
  } finally {
    await client.close?.();
    await serving.catch(() => undefined);
  }
}

/**
 * The hooks of a repository a local push reaches (git's receive-pack runs them there): found
 * in its git directory (or its `core.hooksPath`), run in its git directory, through the host
 * environment of the working copy pushing. Undefined without a runner or a FilesApi.
 *
 * With `localPush` (a push to a path: git's connect.c starts receive-pack with
 * `local_repo_env` cleared), the hooks run without the pushing side's repository variables
 * ({@link LOCAL_REPO_ENV}: `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_DIR`, `GIT_INDEX_FILE`,
 * `GIT_CONFIG_COUNT`, ...), so a quarantined pre-receive's alternates name the receiving
 * repository's objects alone. Without it (a served push over HTTP or git://, where the
 * server's own environment is receive-pack's) the host's variables reach them.
 */
export function remoteHookSession(
  workingCopy: WorkingCopy,
  remote: OpenedRepository,
  options: { localPush?: boolean } = {},
): HookSession | undefined {
  const local = hookHostOf(workingCopy);
  if (!local.environment()?.hookRunner) return undefined;
  let files: FilesApi | undefined;
  try {
    files = repositoryPlaceOf(workingCopy)?.getFiles?.();
  } catch {
    files = undefined;
  }
  if (!files) return undefined;
  const gitDir = remote.gitDir.replace(/^\/+/, "").replace(/\/+$/, "");
  const top = !remote.bare && gitDir.endsWith("/.git") ? gitDir.slice(0, -5) : gitDir;
  const setting = (key: string) => {
    const values = remote.config?.getAll(key) ?? [];
    const last = values[values.length - 1];
    return last === null ? "" : last;
  };
  return new HookSession({
    // receive-pack works in the git directory (enter_repo), with GIT_DIR=.
    layout: async () => ({ files: files as FilesApi, top, gitDir, cwd: gitDir, bare: remote.bare }),
    configValue: setting,
    environment: () => local.environment(),
    ...(options.localPush ? { unsetEnv: LOCAL_REPO_ENV } : {}),
    // git 2.5x's configured hooks (hook.<name>.*) of the receiving repository: receive-pack
    // runs pre-receive, update, post-receive, post-update, push-to-checkout and
    // reference-transaction through the hook API (proc-receive through find_hook alone:
    // `HookSession.start`)
    hookSettings: () => {
      const config = remote.config;
      if (!config) return [];
      return hookSettingsFromEntries(config.listWithOrigin?.() ?? config.list());
    },
  });
}

/**
 * receive-pack's `push_to_checkout` (`receive.denyCurrentBranch=updateInstead`): when the
 * push-to-checkout hook exists it updates the worktree in place of git's own push-to-deploy,
 * told the pushed commit, with `GIT_DIR` and `GIT_WORK_TREE` the worktree's (absolute):
 * undefined when it accepts, git's "push-to-checkout hook declined" when it refuses; null
 * when there is no hook (push-to-deploy decides).
 */
async function pushToCheckout(
  hooks: HookSession | undefined,
  worktrees: LinkedWorktrees,
  ref: string,
  newOid: string,
  ctx?: ReceivePackHookContext,
): Promise<string | undefined | null> {
  if (!hooks?.enabled || !(await hooks.exists("push-to-checkout"))) return null;
  const wt = await worktreeUsingBranch(worktrees, ref);
  if (!wt || wt.bare) return "denyCurrentBranch = updateInstead needs a worktree";
  const gitDir = await hooks.hostGitDir();
  const env: Record<string, string> = { ...hookClientEnv(hooks, ctx), GIT_WORK_TREE: wt.path };
  // absolute_path(get_worktree_git_dir): receive-pack's own git directory is ".", so the
  // main worktree's reads `<git dir>/.`
  if (gitDir) env.GIT_DIR = wt.id ? `${gitDir}/worktrees/${wt.id}` : `${gitDir}/.`;
  const result = await hooks.run("push-to-checkout", { args: [newOid], env, prefix: false });
  return result && result.exitCode !== 0 ? "push-to-checkout hook declined" : undefined;
}

/**
 * tmp-objdir.c's `tmp_objdir_env` for a hook run while the push's objects are quarantined
 * (`ctx.quarantinePath`: pre-receive, as git's receive-pack hands `odb_transaction_env` to
 * it): `GIT_QUARANTINE_PATH` and `GIT_OBJECT_DIRECTORY` name the quarantine,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` the repository's objects, appended to the host's own
 * (`env_append`: after a `:`, C-quoted when the directory holds a `:` or starts with `"`),
 * absolute where the repository's files have a host path, so native git run by the hook
 * reads the pushed objects. Nothing once the objects are published.
 */
export async function quarantineEnv(
  hooks: HookSession,
  ctx: Pick<ReceivePackHookContext, "quarantinePath">,
): Promise<Record<string, string>> {
  const quarantine = ctx.quarantinePath;
  if (quarantine === undefined) return {};
  const objects = await hooks.commonGitFile("objects");
  const trim = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const host = await hooks.hostGitDir();
  const below = objects && trim(quarantine).startsWith(`${trim(objects.path)}/`);
  // git's absolute_path of `./objects/...`: receive-pack runs with GIT_DIR=. in its git dir
  const path =
    host && objects && below
      ? `${host}/./objects/${trim(quarantine).slice(trim(objects.path).length + 1)}`
      : await hooks.hookPathOf(quarantine);
  const env: Record<string, string> = { GIT_QUARANTINE_PATH: path, GIT_OBJECT_DIRECTORY: path };
  if (objects) {
    const dir = host && below ? `${host}/./objects` : await hooks.hookPathOf(objects.path);
    // env_append: quoted (quote_c_style) when it holds the separator or starts with a quote,
    // after the alternates receive-pack was given
    const value =
      dir.includes(":") || dir.startsWith('"') ? `"${quoteCStyleBody(dir) ?? dir}"` : dir;
    const old = hooks.hostAlternateObjectDirectories;
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = old === undefined ? value : `${old}:${value}`;
  }
  return env;
}

/**
 * The variables git's http-backend hands receive-pack, and so every hook it runs
 * (http-backend.c `run_service`), for a push served over smart HTTP: the web server's
 * `REMOTE_USER` and `REMOTE_ADDR` (inherited), and, where the host sets none,
 * `GIT_COMMITTER_NAME=<user>` and `GIT_COMMITTER_EMAIL=<user>@http.<addr>` (`anonymous` and
 * `(none)` when unknown). Nothing for a push not over HTTP.
 */
export function httpBackendEnv(
  hooks: HookSession,
  client: ServedRequestContext | undefined,
): Record<string, string> {
  if (!client?.http) return {};
  const env: Record<string, string> = {};
  if (client.remoteUser) env.REMOTE_USER = client.remoteUser;
  if (client.remoteAddr) env.REMOTE_ADDR = client.remoteAddr;
  const user = client.remoteUser || "anonymous";
  const addr = client.remoteAddr || "(none)";
  const committer = hooks.hostCommitter;
  if (committer.name === undefined) env.GIT_COMMITTER_NAME = user;
  if (committer.email === undefined) env.GIT_COMMITTER_EMAIL = `${user}@http.${addr}`;
  return env;
}

/** {@link httpBackendEnv} of a push its hook context describes (HTTP: it has a request). */
function hookClientEnv(hooks: HookSession, ctx: ReceivePackHookContext | undefined) {
  return httpBackendEnv(
    hooks,
    ctx?.request
      ? {
          http: true,
          ...(ctx.remoteUser !== undefined ? { remoteUser: ctx.remoteUser } : {}),
          ...(ctx.remoteAddr !== undefined ? { remoteAddr: ctx.remoteAddr } : {}),
        }
      : undefined,
  );
}

/**
 * receive-pack's hooks as scripts (builtin/receive-pack.c `run_receive_hook`,
 * `run_update_hook`, `run_update_post_hook`, `run_proc_receive_hook`): pre-receive and
 * post-receive read `<old> <new> <ref>` lines on stdin (with `GIT_PUSH_OPTION_COUNT` and the
 * options; post-receive the proc-receive hook's reports in place of their commands), update
 * is told one ref, post-update the refs that moved, proc-receive is started and talked to
 * over its stdin and stdout (found as `find_hook` finds it: no configured hook); each runs
 * with `GIT_DIR=.` and its output goes to the pushing user (side-band, git's "remote: "
 * lines).
 */
function scriptReceiveHooks(hooks: HookSession): ReceivePackHooks {
  const lines = (commands: readonly ReceiveCommand[]) =>
    commands.map((c) => `${c.oldOid} ${c.newOid} ${c.refName}\n`).join("");
  const optionEnv = (ctx: ReceivePackHookContext) => {
    const env: Record<string, string> = { GIT_PUSH_OPTION_COUNT: String(ctx.pushOptions.length) };
    ctx.pushOptions.forEach((option, i) => {
      env[`GIT_PUSH_OPTION_${i}`] = option;
    });
    return env;
  };
  const run = async (
    name: string,
    ctx: ReceivePackHookContext,
    options: { args?: string[]; stdin?: string; env?: Record<string, string> },
  ) => {
    const result = await hooks
      .run(name, {
        ...options,
        env: {
          ...hookClientEnv(hooks, ctx),
          GIT_DIR: ".",
          ...(await quarantineEnv(hooks, ctx)),
          ...(options.env ?? {}),
        },
        prefix: false,
      })
      .catch((error: unknown) => {
        // receive-pack dies looking the hook up (a broken hook.* configuration)
        if (error instanceof GitApiError && error.message.startsWith("fatal: ")) {
          throw new ReceivePackDiedError(error.message.slice("fatal: ".length));
        }
        throw error;
      });
    if (result?.stderr) await ctx.message(result.stderr);
    return result;
  };
  return {
    preReceive: async (commands, ctx) => {
      const result = await run("pre-receive", ctx, {
        stdin: lines(commands),
        env: optionEnv(ctx),
      });
      return !result || result.exitCode === 0;
    },
    update: async (refName, oldOid, newOid, ctx) => {
      const result = await run("update", ctx, { args: [refName, oldOid, newOid] });
      return !result || result.exitCode === 0;
    },
    postReceive: async (commands, ctx) => {
      await run("post-receive", ctx, { stdin: lines(commands), env: optionEnv(ctx) });
      // run_update_post_hook: the refs pushed (not the proc-receive hook's reports)
      const refs = commands.filter((c) => !c.report).map((c) => c.pushedRef ?? c.refName);
      if (refs.length > 0) await run("post-update", ctx, { args: refs });
    },
    // run_proc_receive_hook: its stdin and stdout piped, its stderr relayed to the user; the
    // objects are published by now (no quarantine variables) and no push option variables
    procReceive: (ctx) =>
      hooks.start("proc-receive", {
        env: { ...hookClientEnv(hooks, ctx), GIT_DIR: "." },
        prefix: false,
        onStderr: (text) => ctx.message(text),
      }),
  };
}
