/**
 * The client half of protocol v2's packfile URIs (fetch-pack.c after the `packfile` section,
 * http-fetch.c's `--packfile`): each pack the server named in its `packfile-uris` section is
 * downloaded, indexed and kept, then its checksum compared with the one the server gave.
 */

import type {
  PackImportOptions,
  PackImportResult,
  RepositoryFacade,
} from "../api/repository-facade.js";
import { TransportError } from "../protocol/index.js";
import { formatOf } from "../protocol/object-format.js";
import type { PackfileUri } from "./fetch-pack.js";

/** How {@link importPackfileUri} downloads and stores a pack. */
export interface PackfileUriImportOptions {
  /** Makes the GET request (default `globalThis.fetch`); no credentials of the remote's */
  fetchImpl?: (request: Request) => Promise<Response>;
  /** Called with each object id and type as the import stores it (fsck's input) */
  onObject?: NonNullable<PackImportOptions["onObject"]>;
  /** Checks the pack's objects once they are in, before they are published; throws to refuse */
  check?: (repository: RepositoryFacade) => Promise<void>;
}

/**
 * The mismatch of a downloaded pack with the hash the server sent for it: fetch-pack's
 * `pack downloaded from <uri> does not match expected hash <hash>` (git dies, exit 128).
 */
export class PackfileUriHashMismatchError extends TransportError {
  constructor(
    readonly uri: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `fatal: fetch-pack: pack downloaded from ${uri} does not match expected hash ${expected}`,
    );
    this.name = "PackfileUriHashMismatchError";
  }
}

/**
 * Downloads the pack at `entry.uri` and stores it as a kept pack (index-pack `--keep`), as
 * git's `http-fetch --packfile=<hash>`. The pack is imported into a quarantine where the
 * repository has one, and published only once its trailer is `entry.hash` and `check`
 * passed: where git leaves a mismatching pack installed, ours leaves nothing.
 */
export async function importPackfileUri(
  repository: RepositoryFacade,
  entry: PackfileUri,
  options: PackfileUriImportOptions = {},
): Promise<Omit<PackImportResult, "quarantine">> {
  const fetchImpl = options.fetchImpl ?? ((request: Request) => globalThis.fetch(request));
  let response: Response;
  try {
    response = await fetchImpl(new Request(entry.uri, { method: "GET" }));
  } catch (error) {
    throw new TransportError(
      `fatal: fetch-pack: unable to download ${entry.uri}: ${(error as Error).message}`,
    );
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    // http-fetch's http_get_file failure, then fetch-pack's death
    throw new TransportError(
      `error: Unable to get pack file ${entry.uri}\nThe requested URL returned error: ${response.status}\nfatal: fetch-pack: unable to finish http-fetch`,
    );
  }
  const rawLength = formatOf(repository).rawLength;
  // the pack's last bytes, its checksum (index-pack's `pack\t<hash>` line)
  const tail = new Uint8Array(rawLength);
  let tailLength = 0;
  const body = response.body;
  async function* tapped(): AsyncIterable<Uint8Array> {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.length >= rawLength) {
          tail.set(value.subarray(value.length - rawLength));
          tailLength = rawLength;
        } else {
          const keep = Math.min(tailLength, rawLength - value.length);
          tail.copyWithin(0, tailLength - keep, tailLength);
          tail.set(value, keep);
          tailLength = keep + value.length;
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const { quarantine, ...imported } = await repository.importPack(tapped(), {
    keepPack: true,
    quarantine: true,
    ...(options.onObject ? { onObject: options.onObject } : {}),
  });
  let committed = false;
  try {
    const actual = Array.from(tail.subarray(0, tailLength), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== entry.hash)
      throw new PackfileUriHashMismatchError(entry.uri, entry.hash, actual);
    await options.check?.(quarantine?.repository ?? repository);
    await quarantine?.commit();
    committed = true;
  } finally {
    if (!committed) await quarantine?.discard().catch(() => {});
  }
  return imported;
}
