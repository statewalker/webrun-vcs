/**
 * Transport Helper Utilities
 *
 * Provides adapters and helpers for using the new VCS transport API over a
 * webrun-streams channel.
 *
 * Migrated off the retired `@statewalker/vcs-port-webrtc`: the old path was
 * RTCDataChannel -> MessagePort (`createDataChannelPort`) -> transport `Duplex`
 * (`createMessagePortDuplex`). The new path wraps the data channel as a webrun
 * `ByteChannel` (`byteChannelFromDataChannel`), multiplexes logical calls over
 * it with `emulateMux`, and bridges each call to the git transport with
 * `webrunClientDuplex` / `serveRepoOverWebrun`.
 */

import { DefaultSerializationApi, type History, isSymbolicRef } from "@statewalker/vcs-core";
import {
  type FetchResult,
  fetchOverDuplex,
  type PushResult,
  pushOverDuplex,
  type RepositoryFacade,
  serveRepoOverWebrun,
  type RefStore as TransportRefStore,
  webrunClientDuplex,
} from "@statewalker/vcs-transport";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromDataChannel } from "@statewalker/webrun-streams-signaling";

/**
 * A multiplexer over a single peer connection: each `call` opens a fresh
 * logical git exchange, `serve` registers this side as a git server. The two
 * peers pick opposite `side`s so `emulateMux` stream-ids never collide.
 */
export type PeerMux = ReturnType<typeof emulateMux>;

/**
 * Wrap an established `RTCDataChannel` as a multiplexed peer connection.
 *
 * @param channel - The open data channel to the peer.
 * @param side - `"initiator"` for the offering peer, `"responder"` for the
 *   answering peer (matches the WebRTC signaling role).
 */
export function createPeerMux(channel: RTCDataChannel, side: "initiator" | "responder"): PeerMux {
  return emulateMux(byteChannelFromDataChannel(channel), { side });
}

/**
 * Create a transport RefStore adapter from History refs.
 *
 * Adapts the core History refs interface to the transport RefStore interface.
 */
export function createRefStoreAdapter(history: History): TransportRefStore {
  const refs = history.refs;

  return {
    async get(name: string): Promise<string | undefined> {
      const ref = await refs.resolve(name);
      return ref?.objectId;
    },

    async update(name: string, oid: string): Promise<void> {
      const ZERO_OID = "0".repeat(40);
      if (oid === ZERO_OID) {
        await refs.remove(name);
      } else {
        await refs.set(name, oid);
      }
    },

    async listAll(): Promise<Iterable<[string, string]>> {
      const result: Array<[string, string]> = [];
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId) {
          result.push([ref.name, ref.objectId]);
        }
      }
      return result;
    },

    async getSymrefTarget(name: string): Promise<string | undefined> {
      const ref = await refs.get(name);
      if (ref && isSymbolicRef(ref)) {
        return ref.target;
      }
      return undefined;
    },

    async isRefTip(oid: string): Promise<boolean> {
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Create a repository facade and ref store from a History instance.
 *
 * Returns both objects needed for transport operations.
 */
export function createRepositoryContext(history: History): {
  repository: RepositoryFacade;
  refStore: TransportRefStore;
} {
  const serialization = new DefaultSerializationApi({ history });
  const repository = createVcsRepositoryFacade({ history, serialization });
  const refStore = createRefStoreAdapter(history);
  return { repository, refStore };
}

/**
 * Fetch from a peer over the multiplexed connection.
 *
 * @param mux - The peer multiplexer (see {@link createPeerMux})
 * @param history - Local History instance to fetch into
 * @param refspecs - Optional refspecs to fetch
 * @returns Fetch result
 */
export async function fetchFromPeer(
  mux: PeerMux,
  history: History,
  refspecs?: string[],
): Promise<FetchResult> {
  const { repository, refStore } = createRepositoryContext(history);

  return fetchOverDuplex({
    duplex: webrunClientDuplex(mux.call),
    repository,
    refStore,
    refspecs: refspecs ?? ["+refs/heads/*:refs/remotes/peer/*"],
  });
}

/**
 * Push to a peer over the multiplexed connection.
 *
 * @param mux - The peer multiplexer (see {@link createPeerMux})
 * @param history - Local History instance to push from
 * @param refspecs - Optional refspecs to push
 * @returns Push result
 */
export async function pushToPeer(
  mux: PeerMux,
  history: History,
  refspecs?: string[],
): Promise<PushResult> {
  const { repository, refStore } = createRepositoryContext(history);

  return pushOverDuplex({
    duplex: webrunClientDuplex(mux.call),
    repository,
    refStore,
    refspecs: refspecs ?? ["refs/heads/main:refs/heads/main"],
  });
}

/**
 * Register this side as a git server for incoming peer requests.
 *
 * Faithful to the old `servePeer`, which delegated to `serveOverDuplex` with no
 * explicit service — i.e. it served `git-upload-pack` (fetch). `serveRepoOverWebrun`
 * keeps that default. Returns the mux teardown that stops accepting new calls.
 *
 * @param mux - The peer multiplexer (see {@link createPeerMux})
 * @param history - Local History instance to serve
 * @returns Teardown that unregisters the server handler
 */
export function servePeer(mux: PeerMux, history: History): () => Promise<void> {
  const { repository, refStore } = createRepositoryContext(history);
  return mux.serve(serveRepoOverWebrun({ repository, refStore }));
}
