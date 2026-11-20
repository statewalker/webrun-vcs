/**
 * The transport a remote URL takes, as git's `transport_get` picks it, and git's local
 * transport: a repository named by a path (or a `file://` URL) is opened through the working
 * copy's storage and served by upload-pack (or receive-pack) in process, over an in-memory
 * duplex, where git spawns `git-upload-pack '<path>'`.
 */

import {
  createRepositoryFacade,
  createTransportRefStore,
  type Duplex,
  openDuplexConnection,
  openDuplexReceivePackConnection,
  type ReceivePackConnection,
  serveOverDuplex,
  type UploadPackConnection,
} from "@statewalker/vcs-transport";
import type { OpenedRepository, WorkingCopy } from "@statewalker/vcs-working-tree";

import { TransportError } from "../errors/index.js";

/** How a remote is reached: smart HTTP, git's local transport, or not at all. */
export type RemoteTransport =
  | { kind: "http" }
  | {
      kind: "local";
      /** The repository's path, as git reports it (`file://` stripped and decoded) */
      path: string;
    }
  | {
      kind: "unsupported";
      /** git's lines (or ours, where git would connect somewhere this cannot) */
      message: string;
    };

const isSchemeChar = (first: boolean, ch: string | undefined) =>
  ch !== undefined && (/[A-Za-z0-9]/.test(ch) || (!first && /[+.-]/.test(ch)));

/** git's `is_url`: `<scheme>://`, the scheme `[A-Za-z0-9][A-Za-z0-9+.-]*`. */
function isUrl(url: string): boolean {
  if (!isSchemeChar(true, url[0])) return false;
  let i = 1;
  while (i < url.length && url[i] !== ":") {
    if (!isSchemeChar(false, url[i])) return false;
    i++;
  }
  return url.startsWith("://", i);
}

/** git's `url_is_local_not_ssh`: no colon, or a slash before it (or a DOS drive). */
function isLocalNotSsh(url: string): boolean {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon < 0 || (slash >= 0 && slash < colon) || /^[A-Za-z]:[\\/]/.test(url);
}

const NOT_A_REPOSITORY = (path: string) =>
  `fatal: '${path}' does not appear to be a git repository\n` +
  "fatal: Could not read from remote repository.\n\n" +
  "Please make sure you have the correct access rights\nand the repository exists.";

/**
 * git's `transport_get` over a remote URL: `<helper>::<address>` and an unknown
 * `<scheme>://` go to a remote helper (none here: "unable to find remote helper"); http(s)
 * is smart HTTP; a path or `file://` URL the local transport (connect.c's path: for
 * `file://`, the URL decoded and its path from the first `/` after the host). ssh and
 * git:// would connect elsewhere, which cannot be done here.
 *
 * @example
 * ```typescript
 * remoteTransportOf("https://example.com/r.git"); // { kind: "http" }
 * remoteTransportOf("../other");                    // { kind: "local", path: "../other" }
 * remoteTransportOf("file:///srv/r.git");           // { kind: "local", path: "/srv/r.git" }
 * ```
 */
export function remoteTransportOf(url: string): RemoteTransport {
  let p = 0;
  while (isSchemeChar(p === 0, url[p])) p++;
  if (p > 0 && url.startsWith("::", p)) {
    return {
      kind: "unsupported",
      message: `fatal: unable to find remote helper for '${url.slice(0, p)}'`,
    };
  }
  if (/^https?:\/\//i.test(url)) return { kind: "http" };
  if (url.startsWith("rsync:")) {
    return { kind: "unsupported", message: "fatal: git-over-rsync is no longer supported" };
  }
  const builtin = !isUrl(url) || /^(?:file|git|ssh|git\+ssh|ssh\+git):\/\//.test(url) || url === "";
  if (!builtin) {
    // external_specification_len: the scheme before "://"
    const scheme = url.slice(0, url.indexOf(":"));
    return { kind: "unsupported", message: `fatal: unable to find remote helper for '${scheme}'` };
  }
  if (url.startsWith("file://")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      decoded = url;
    }
    const rest = decoded.slice("file://".length);
    const slash = rest.indexOf("/");
    const path = slash < 0 ? "" : rest.slice(slash);
    if (!path) {
      return {
        kind: "unsupported",
        message: "fatal: no path specified; see 'git help pull' for valid url syntax",
      };
    }
    return { kind: "local", path };
  }
  if (!isUrl(url) && isLocalNotSsh(url)) {
    if (url === "") {
      return {
        kind: "unsupported",
        message: "fatal: no path specified; see 'git help pull' for valid url syntax",
      };
    }
    return { kind: "local", path: url };
  }
  return {
    kind: "unsupported",
    message: `fatal: cannot connect to '${url}': only http(s) and local repositories are reachable here`,
  };
}

/**
 * Throws the failure a remote that smart HTTP cannot reach ends with, unless it is local.
 *
 * @returns the local repository's path, or undefined for an http(s) URL
 */
export function localRemotePath(url: string): string | undefined {
  const transport = remoteTransportOf(url);
  if (transport.kind === "unsupported") throw new TransportError(transport.message);
  return transport.kind === "local" ? transport.path : undefined;
}

/** A connected pair of in-memory duplex streams: what one side writes, the other reads. */
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
  const left: Duplex = {
    [Symbol.asyncIterator]: () => a.read()[Symbol.asyncIterator](),
    write: (data) => {
      if (!aClosed) b.push(data.slice());
    },
    close: async () => {
      if (aClosed) return;
      aClosed = true;
      b.push(null);
    },
  };
  const right: Duplex = {
    [Symbol.asyncIterator]: () => b.read()[Symbol.asyncIterator](),
    write: (data) => {
      if (!bClosed) a.push(data.slice());
    },
    close: async () => {
      if (bClosed) return;
      bClosed = true;
      a.push(null);
    },
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
  const worktree = workingCopy.worktree as WorkingCopy["worktree"] | undefined;
  const opened = await worktree?.openRepository?.(path).catch(() => undefined);
  if (!opened) throw new TransportError(NOT_A_REPOSITORY(path));
  return opened;
}

/**
 * Runs `run` over a connection to upload-pack serving a local repository (opened by
 * {@link openLocalRemote}) with protocol v2, git's default `protocol.version`, as git's
 * local transport runs `git-upload-pack '<path>'`, in process.
 */
export async function withLocalUploadPack<T>(
  remote: OpenedRepository,
  run: (connection: UploadPackConnection) => Promise<T>,
): Promise<T> {
  const head = await remote.history.refs.get("HEAD").catch(() => undefined);
  const [client, server] = createDuplexPair();
  const serving = serveOverDuplex({
    duplex: server,
    repository: createRepositoryFacade({ history: remote.history }),
    refStore: createTransportRefStore(remote.history.refs),
    service: "git-upload-pack",
    protocolVersion: "2",
    ...(head && "target" in head ? { currentBranch: head.target } : {}),
  }).finally(() => server.close?.());
  try {
    const connection = await openDuplexConnection(client, { closeDuplex: true });
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  } finally {
    await client.close?.();
    await serving.catch(() => undefined);
  }
}

/**
 * Runs `run` over a connection to receive-pack serving a local repository (opened by
 * {@link openLocalRemote}), as git's local transport runs `git-receive-pack '<path>'`, in
 * process: the pushed objects go into that repository and its refs are updated there, with
 * receive-pack's default checks (a non-bare repository's checked-out branch is refused).
 */
export async function withLocalReceivePack<T>(
  remote: OpenedRepository,
  run: (connection: ReceivePackConnection) => Promise<T>,
): Promise<T> {
  const head = await remote.history.refs.get("HEAD").catch(() => undefined);
  const [client, server] = createDuplexPair();
  const serving = serveOverDuplex({
    duplex: server,
    repository: createRepositoryFacade({ history: remote.history }),
    refStore: createTransportRefStore(remote.history.refs),
    service: "git-receive-pack",
    bare: remote.bare,
    ...(head && "target" in head ? { currentBranch: head.target } : {}),
  }).finally(() => server.close?.());
  try {
    const connection = await openDuplexReceivePackConnection(client, { closeDuplex: true });
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  } finally {
    await client.close?.();
    await serving.catch(() => undefined);
  }
}
