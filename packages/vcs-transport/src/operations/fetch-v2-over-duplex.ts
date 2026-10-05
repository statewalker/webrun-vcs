/**
 * High-level fetch operation over a Duplex stream using Git protocol **v2**.
 *
 * Mirrors {@link fetchOverDuplex} exactly, but drives the protocol-v2 client
 * FSM (`clientV2Transitions` / `clientV2Handlers`) instead of the v1 fetch FSM.
 * The v1 path is untouched — this is a strictly additive sibling operation.
 *
 * Wire flow (per handlers): READ_CAPABILITIES → SEND_LS_REFS →
 * READ_LS_REFS_RESPONSE → COMPUTE_WANTS → SEND_FETCH → process
 * acks/shallow/wanted-refs → RECEIVE_PACK → UPDATE_REFS.
 */

import type { FetchResult } from "../api/fetch-result.js";
import type { BaseDuplexOptions, BaseFetchOptions } from "../api/options.js";
import { HandlerOutput } from "../context/handler-output.js";
import type { ProcessConfiguration } from "../context/process-config.js";
import type { ProcessContext, RefStore } from "../context/process-context.js";
import { ProtocolState } from "../context/protocol-state.js";
import { createTransportApi } from "../factories/transport-api-factory.js";
import { Fsm } from "../fsm/fsm.js";
import { clientV2Handlers, clientV2Transitions } from "../fsm/protocol-v2/client-v2-fsm.js";
import { expandFromSource, matchSource, parseRefSpec } from "../utils/refspec.js";

/**
 * Options for the fetch-over-duplex operation in protocol-v2 mode.
 */
export interface FetchV2OverDuplexOptions extends BaseDuplexOptions, BaseFetchOptions {
  /** Ref store for reading/writing refs */
  refStore: RefStore;
  /** Filter spec for partial clone (e.g., "blob:none") */
  filter?: string;
  /** Local HEAD ref for negotiation (haves are walked from its tip) */
  localHead?: string;
  /** Maximum haves to send during negotiation */
  maxHaves?: number;
  /** Ref prefixes for the ls-refs command (default: refs/heads/, refs/tags/) */
  refPrefixes?: string[];
  /** Request peeled tag info in ls-refs */
  peel?: boolean;
  /** Request symref info in ls-refs */
  symrefs?: boolean;
}

/**
 * Performs a Git fetch over a Duplex stream using **protocol v2**.
 *
 * Constructs the same {@link ProcessContext} as {@link fetchOverDuplex}
 * (transport / repository / refStore over the duplex) and runs the v2 client
 * FSM to completion, returning the same {@link FetchResult} shape.
 *
 * @param options - Fetch options including duplex, repository, and refStore
 * @returns Fetch result with success status and updated refs
 */
export async function fetchV2OverDuplex(options: FetchV2OverDuplexOptions): Promise<FetchResult> {
  const { duplex, repository, refStore } = options;

  const state = new ProtocolState();
  const transport = createTransportApi(duplex, state);

  // Protocol-v2's packfile section is ALWAYS side-band-64k multiplexed
  // (protocol-v2.txt: "The transmission of the packfile is always
  // multiplexed, using the same semantics of the 'side-band-64k'
  // capability") — even though the v2 capability advertisement never lists
  // "side-band-64k". `TransportApi.readPack()` selects its sideband path off
  // this capability, so seed it before the FSM receives the pack.
  state.capabilities.add("side-band-64k");

  // Resolve localHead ref name → OID for the ancestry walk (haves).
  const localHeadRef = options.localHead ?? "refs/heads/main";
  const localHeadOid = await refStore.get(localHeadRef);

  const config: ProcessConfiguration = {
    localHead: localHeadOid,
    maxHaves: options.maxHaves ?? 256,
    depth: options.depth,
    filter: options.filter,
    refPrefixes: options.refPrefixes,
    lsRefsPeel: options.peel,
    lsRefsSymrefs: options.symrefs,
  };

  const output = new HandlerOutput();

  const ctx: ProcessContext = {
    transport,
    repository,
    refStore,
    state,
    output,
    config,
  };

  const fsm = new Fsm(clientV2Transitions, clientV2Handlers);

  try {
    const success = await fsm.run(ctx);

    if (!success || ctx.output.error) {
      return {
        success: false,
        error: ctx.output.error ?? "V2 FSM did not complete successfully",
      };
    }

    // Persist every advertised ref (from ls-refs), applying refspec mapping if
    // provided. Mirrors fetchOverDuplex; the FSM's UPDATE_REFS already wrote
    // the subset it fetched, this writes the full advertised set idempotently.
    const updatedRefs = new Map<string, string>();
    const parsedSpecs = (options.refspecs ?? []).map(parseRefSpec);

    for (const [refName, oid] of state.refs) {
      if (parsedSpecs.length > 0) {
        for (const spec of parsedSpecs) {
          if (spec.negative) continue;
          if (matchSource(spec, refName)) {
            const expanded = expandFromSource(spec, refName);
            const localName = expanded.destination ?? refName;
            await refStore.update(localName, oid);
            updatedRefs.set(localName, oid);
            break;
          }
        }
      } else {
        await refStore.update(refName, oid);
        updatedRefs.set(refName, oid);
      }
    }

    return {
      success: true,
      updatedRefs,
      objectsImported: ctx.output.packResult?.objectsImported,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
