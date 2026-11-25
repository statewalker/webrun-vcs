/**
 * git's bundle transport (transport.c's `bundle_vtable`): a remote URL that is a path to a
 * bundle file is read as a repository whose refs are the bundle's and whose only pack is the
 * bundle's. Fetch, clone, pull and ls-remote reach it through an upload-pack served in
 * process from the bundle: its refs advertised (in git's order: the bundle's refs reversed,
 * as `get_refs_from_bundle` prepends each), and any fetch answered with the bundle's pack,
 * once the fetching repository has the bundle's prerequisites (`unbundle`'s `verify_bundle`).
 */

import {
  type Duplex,
  openDuplexConnection,
  type RefStore,
  type RepositoryFacade,
  serveOverDuplex,
  type UploadPackConnection,
} from "@statewalker/vcs-transport";

import { TransportError } from "../../errors/index.js";
import type { BundleHeader } from "./bundle-format.js";
import type { OpenedBundle } from "./bundle-verify.js";

/** A bundle remote: its file read, and how to check it against the fetching repository. */
export interface BundleRemote {
  readonly bundle: OpenedBundle;
  /**
   * `verify_bundle` against the repository fetching (its `error:` lines on failure), run
   * before the pack is handed over
   */
  verify(): Promise<{ ok: boolean; stderr: string }>;
}

/**
 * A fetch from a bundle the repository lacks the prerequisites of: `verify_bundle`'s lines
 * (`git fetch` exits 1; `git clone` adds `fatal: remote transport reported error`, 128).
 */
export class BundlePrerequisitesError extends TransportError {
  constructor(readonly lines: string) {
    super(lines.replace(/\n$/, ""), undefined, { exitCode: 1 });
    this.name = "BundlePrerequisitesError";
  }
}

/** Bytes per chunk the served pack is cut into. */
const CHUNK = 64 * 1024;

/**
 * Runs `run` over a connection to an upload-pack serving the bundle (protocol v0). A fetch
 * that needs the pack verifies the bundle first: when the repository lacks its prerequisites
 * the fetch fails with git's lines (exit 1, as `git fetch` returns).
 */
export async function withBundleUploadPack<T>(
  remote: BundleRemote,
  createPair: () => [Duplex, Duplex],
  run: (connection: UploadPackConnection) => Promise<T>,
): Promise<T> {
  const { header, pack } = remote.bundle;
  let refused: string | undefined;
  const facade: RepositoryFacade = {
    objectFormat: header.objectFormat,
    importPack: () => Promise.reject(new Error("a bundle cannot be written to")),
    async *exportPack() {
      const verified = await remote.verify();
      if (!verified.ok) {
        refused = verified.stderr;
        throw new Error("bundle prerequisites missing");
      }
      for (let at = 0; at < pack.length; at += CHUNK) yield pack.subarray(at, at + CHUNK);
    },
    has: async (oid) => header.references.some((r) => r.id === oid),
    async *walkAncestors() {},
  };
  const [client, server] = createPair();
  const serving = serveOverDuplex({
    duplex: server,
    repository: facade,
    refStore: bundleRefStore(header),
    service: "git-upload-pack",
  }).finally(() => server.close?.());
  try {
    const connection = await openDuplexConnection(client, { closeDuplex: true });
    try {
      return await run(connection);
    } catch (error) {
      if (refused !== undefined) {
        throw new BundlePrerequisitesError(refused);
      }
      throw error;
    } finally {
      await connection.close();
    }
  } finally {
    await client.close?.();
    await serving.catch(() => undefined);
  }
}

/** The refs a bundle advertises: read-only, in `get_refs_from_bundle`'s (reversed) order. */
function bundleRefStore(header: BundleHeader): RefStore {
  const refs = [...header.references].reverse();
  return {
    get: async (name) => refs.find((r) => r.name === name)?.id,
    update: () => Promise.reject(new Error("a bundle cannot be written to")),
    listAll: async () => refs.map((r): [string, string] => [r.name, r.id]),
    isRefTip: async (oid) => refs.some((r) => r.id === oid),
  };
}
