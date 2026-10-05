/**
 * Bidirectional P2P sync operation.
 *
 * Synchronizes two repositories over a Duplex stream, performing
 * both fetch and push operations as needed based on the sync direction.
 */

import type { Duplex } from "../api/duplex.js";
import type { FetchResult } from "../api/fetch-result.js";
import type { RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import { fetchOverDuplex } from "./fetch-over-duplex.js";
import type { PushResult } from "./push-over-duplex.js";
import { pushOverDuplex } from "./push-over-duplex.js";

/**
 * Sync direction options.
 */
export type SyncDirection = "pull" | "push" | "bidirectional";

/**
 * Options for P2P sync operation.
 */
export interface P2PSyncOptions {
  /** Local repository facade */
  localRepository: RepositoryFacade;
  /** Local ref store */
  localRefStore: RefStore;
  /** Duplex stream connected to remote peer */
  remoteDuplex: Duplex;
  /** Sync direction */
  direction?: SyncDirection;
  /** Refspecs to sync */
  refspecs?: string[];
  /** Use atomic operations */
  atomic?: boolean;
  /** Shallow sync depth */
  depth?: number;
}

/**
 * Result of a P2P sync operation.
 */
export interface P2PSyncResult {
  /** Whether the sync was successful */
  success: boolean;
  /** Error message if sync failed */
  error?: string;
  /** Fetch result (if direction includes pull) */
  fetchResult?: FetchResult;
  /** Push result (if direction includes push) */
  pushResult?: PushResult;
  /** Total refs synced */
  refsSynced?: number;
}

/**
 * Performs bidirectional P2P sync over a Duplex stream.
 *
 * This operation can:
 * - Pull: Fetch changes from remote to local
 * - Push: Push changes from local to remote
 * - Bidirectional: Do both pull and push
 *
 * @param options - P2P sync options
 * @returns Sync result with fetch and push results
 *
 * @example
 * ```ts
 * // Bidirectional sync
 * const result = await p2pSync({
 *   localRepository,
 *   localRefStore,
 *   remoteDuplex,
 *   direction: "bidirectional",
 * });
 *
 * if (result.success) {
 *   console.log(`Synced ${result.refsSynced} refs`);
 * }
 * ```
 */
export async function p2pSync(options: P2PSyncOptions): Promise<P2PSyncResult> {
  const {
    localRepository,
    localRefStore,
    remoteDuplex,
    direction = "bidirectional",
    refspecs,
    atomic,
    depth,
  } = options;

  let fetchResult: FetchResult | undefined;
  let pushResult: PushResult | undefined;
  let refsSynced = 0;

  try {
    // Pull (fetch from remote)
    if (direction === "pull" || direction === "bidirectional") {
      fetchResult = await fetchOverDuplex({
        duplex: remoteDuplex,
        repository: localRepository,
        refStore: localRefStore,
        refspecs,
        depth,
      });

      if (!fetchResult.success) {
        return {
          success: false,
          error: `Fetch failed: ${fetchResult.error}`,
          fetchResult,
        };
      }

      if (fetchResult.updatedRefs) {
        refsSynced += fetchResult.updatedRefs.size;
      }
    }

    // Push (push to remote)
    if (direction === "push" || direction === "bidirectional") {
      pushResult = await pushOverDuplex({
        duplex: remoteDuplex,
        repository: localRepository,
        refStore: localRefStore,
        refspecs,
        atomic,
      });

      if (!pushResult.success) {
        return {
          success: false,
          error: `Push failed: ${pushResult.error}`,
          fetchResult,
          pushResult,
          refsSynced,
        };
      }

      if (pushResult.refStatus) {
        refsSynced += pushResult.refStatus.size;
      }
    }

    return {
      success: true,
      fetchResult,
      pushResult,
      refsSynced,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      fetchResult,
      pushResult,
      refsSynced,
    };
  }
}
