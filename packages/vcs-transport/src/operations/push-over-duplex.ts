/**
 * Push over any duplex stream (MessagePort, WebSocket, WebRTC, a spawned `git receive-pack`).
 */

import type { Duplex } from "../api/duplex.js";
import type { PushResult, RefPushStatus } from "../api/push-result.js";
import {
  isPushSuccess,
  openDuplexReceivePackConnection,
  type PushClientOptions,
  pushToConnection,
} from "../push-client/index.js";

export type { PushResult, RefPushStatus } from "../api/push-result.js";

/** Options of {@link pushOverDuplex}. */
export interface PushOverDuplexOptions extends PushClientOptions {
  /** Bidirectional stream whose other end runs receive-pack */
  duplex: Duplex;
  /** Close the duplex when the push ends (default false: the caller owns it) */
  closeDuplex?: boolean;
}

/**
 * Pushes over a duplex stream: the same client as the HTTP {@link push}, over a stateful
 * connection (the server speaks first, with its ref advertisement).
 *
 * Never throws: failures come back as `success: false` with the error. `refStatus` has every
 * matched remote ref's verdict; `report` the whole result (statuses with git's summaries,
 * the unpack status, pack counters).
 *
 * @example
 * ```ts
 * const result = await pushOverDuplex({
 *   duplex,
 *   repository,
 *   refStore,
 *   refspecs: ["refs/heads/main:refs/heads/main"],
 * });
 * if (!result.success) console.error(result.error);
 * ```
 */
export async function pushOverDuplex(options: PushOverDuplexOptions): Promise<PushResult> {
  try {
    const connection = await openDuplexReceivePackConnection(options.duplex, {
      closeDuplex: options.closeDuplex,
    });
    try {
      const report = await pushToConnection(connection, options);
      const refStatus = new Map<string, RefPushStatus>();
      for (const u of report.updates) {
        const success = isPushSuccess(u.status);
        refStatus.set(u.remoteRef, {
          success,
          status: u.status,
          ...(success ? {} : { error: u.message ?? u.summary }),
          oldOid: u.oldOid,
          newOid: u.newOid,
        });
      }
      const failed = report.updates.filter((u) => !isPushSuccess(u.status));
      let error: string | undefined;
      if (report.unpack && !report.unpack.ok) {
        error = `unpack failed: ${report.unpack.message}`;
      } else if (failed.length > 0) {
        const list = failed.map((u) => `${u.remoteRef} ${u.summary}`).join(", ");
        error = `failed to push some refs: ${list}`;
      }
      return { success: report.ok, ...(error ? { error } : {}), refStatus, report };
    } finally {
      await connection.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
