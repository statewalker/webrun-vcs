/**
 * Fetch over any duplex stream (MessagePort, WebSocket, WebRTC, a spawned `git upload-pack`).
 */

import type { Duplex } from "../api/duplex.js";
import type { FetchResult } from "../api/fetch-result.js";
import {
  type FetchClientOptions,
  fetchFromConnection,
  openDuplexConnection,
} from "../fetch-client/index.js";

/** Options of {@link fetchOverDuplex}. */
export interface FetchOverDuplexOptions extends FetchClientOptions {
  /** Bidirectional stream whose other end runs upload-pack */
  duplex: Duplex;
  /** Close the duplex when the fetch ends (default false: the caller owns it) */
  closeDuplex?: boolean;
}

/**
 * Fetches over a duplex stream: the same client as the HTTP {@link fetch}, over a stateful
 * connection. The server speaks first; the protocol (v2 or v0) follows its first line.
 *
 * Never throws: failures come back as `success: false` with the error. `updatedRefs` lists
 * the local refs that now hold the fetched values (written, or already up to date);
 * `report` has every ref's status (rejected non-fast-forwards included), the shallow
 * change and the negotiation counters.
 *
 * @example
 * ```ts
 * const channel = new MessageChannel();
 * serveOverDuplex({ duplex: createMessagePortDuplex(channel.port2), repository: serverRepo, refStore: serverRefs });
 * const result = await fetchOverDuplex({
 *   duplex: createMessagePortDuplex(channel.port1),
 *   repository: myRepo,
 *   refStore: myRefStore,
 *   refspecs: ["+refs/heads/*:refs/remotes/peer/*"],
 * });
 * if (result.success) console.log("Fetched refs:", result.updatedRefs);
 * ```
 */
export async function fetchOverDuplex(options: FetchOverDuplexOptions): Promise<FetchResult> {
  try {
    const connection = await openDuplexConnection(options.duplex, {
      closeDuplex: options.closeDuplex,
    });
    try {
      const report = await fetchFromConnection(connection, options);
      const updatedRefs = new Map<string, string>();
      for (const u of report.refUpdates) {
        if (u.status !== "rejected") updatedRefs.set(u.localRef, u.newOid);
      }
      const objectsImported = report.imports.reduce((n, r) => n + r.objectsImported, 0);
      return { success: true, updatedRefs, objectsImported, report };
    } finally {
      await connection.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
