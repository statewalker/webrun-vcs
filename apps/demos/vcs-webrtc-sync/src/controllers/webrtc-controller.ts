/**
 * WebRTC Controller
 *
 * Manages WebRTC peer-to-peer connections for repository synchronization.
 *
 * Migrated off the retired `@statewalker/vcs-port-webrtc` to
 * `@statewalker/webrun-streams-signaling`:
 *  - the old `PeerManager` (single-connection lifecycle) is now `PeerConnection`
 *    (identical method surface: `on`/`connect`/`handleSignal`/`waitForIceGathering`/
 *    `getLocalDescription`/`getCollectedCandidates`/`getDataChannel`/`close`);
 *  - the old `QrSignaling.createPayload`/`.parsePayload` are now the standalone
 *    `encodeSignal(createCompressedSignal(...))` / `parseCompressedSignal(decodeSignal(...))`
 *    functions keyed by a `generateSessionId()` session id.
 * On data-channel open the channel is wrapped as a multiplexed webrun connection
 * (`createPeerMux`) that `sync-controller` drives with the git transport.
 */

import {
  createCompressedSignal,
  decodeSignal,
  encodeSignal,
  generateSessionId,
  PeerConnection,
  parseCompressedSignal,
  type SignalingMessage,
} from "@statewalker/webrun-streams-signaling";
import { getActivityLogModel, getConnectionModel, getSharingFormModel } from "../models/index.js";
import { createPeerMux, newAdapter, newRegistry, type PeerMux } from "../utils/index.js";

// Adapters for WebRTC state
export const [getPeerManager, setPeerManager] = newAdapter<PeerConnection | null>(
  "peer-manager",
  () => null,
);

export const [getSessionId, setSessionId] = newAdapter<string | null>("qr-session-id", () => null);

export const [getMux, setMux] = newAdapter<PeerMux | null>("peer-mux", () => null);

/**
 * Create the WebRTC controller.
 * Returns cleanup function.
 */
export function createWebRtcController(ctx: Map<string, unknown>): () => void {
  const [register, cleanup] = newRegistry();

  register(() => {
    const peer = getPeerManager(ctx);
    if (peer) {
      peer.close();
      void getMux(ctx)?.close();
      setPeerManager(ctx, null);
      setSessionId(ctx, null);
      setMux(ctx, null);
    }
  });

  return cleanup;
}

/**
 * Create an offer to initiate a P2P connection.
 * Returns the signaling payload to share with the peer.
 */
export async function createOffer(ctx: Map<string, unknown>): Promise<string | null> {
  const connectionModel = getConnectionModel(ctx);
  const sharingModel = getSharingFormModel(ctx);
  const logModel = getActivityLogModel(ctx);

  // Close any existing connection
  const existingPeer = getPeerManager(ctx);
  if (existingPeer) {
    existingPeer.close();
  }

  sharingModel.startShare();
  connectionModel.setConnecting("initiator");

  try {
    const sessionId = generateSessionId();
    const peer = new PeerConnection("initiator");

    setSessionId(ctx, sessionId);
    setPeerManager(ctx, peer);

    // Collect signals
    const signals: SignalingMessage[] = [];
    peer.on("signal", (msg) => signals.push(msg));

    // Handle state changes
    peer.on("stateChange", (state) => {
      logModel.info(`Connection state: ${state}`);
      if (state === "connected") {
        connectionModel.setConnected();
      } else if (state === "failed" || state === "closed") {
        connectionModel.setDisconnected();
      }
    });

    // Handle data channel open
    peer.on("open", () => {
      logModel.success("Data channel opened!");
      const channel = peer.getDataChannel();
      if (channel) {
        setMux(ctx, createPeerMux(channel, "initiator"));
      }
    });

    peer.on("error", (err) => {
      logModel.error(`WebRTC error: ${err.message}`);
      connectionModel.setFailed(err.message);
    });

    // Start connection
    logModel.info("Creating offer...");
    await peer.connect();

    // Wait for ICE gathering
    logModel.info("Gathering ICE candidates...");
    await peer.waitForIceGathering();

    // Create compact signal payload
    const description = peer.getLocalDescription();
    if (!description) {
      throw new Error("Failed to get local description");
    }
    const candidates = peer.getCollectedCandidates();
    const payload = encodeSignal(
      createCompressedSignal(sessionId, "initiator", description, candidates),
    );

    sharingModel.setLocalSignal(payload);
    logModel.info(`Offer created (${payload.length} chars)`);

    return payload;
  } catch (error) {
    logModel.error(`Failed to create offer: ${(error as Error).message}`);
    connectionModel.setFailed((error as Error).message);
    sharingModel.reset();
    return null;
  }
}

/**
 * Accept an offer from a peer and create an answer.
 * Returns the answer payload to share back.
 */
export async function acceptOffer(
  ctx: Map<string, unknown>,
  offerPayload: string,
): Promise<string | null> {
  const connectionModel = getConnectionModel(ctx);
  const sharingModel = getSharingFormModel(ctx);
  const logModel = getActivityLogModel(ctx);

  // Close any existing connection
  const existingPeer = getPeerManager(ctx);
  if (existingPeer) {
    existingPeer.close();
  }

  connectionModel.setConnecting("responder");

  try {
    const parsed = parseCompressedSignal(decodeSignal(offerPayload));
    const { description, candidates } = parsed;

    const peer = new PeerConnection("responder");

    setSessionId(ctx, parsed.sessionId);
    setPeerManager(ctx, peer);

    // Collect signals
    const signals: SignalingMessage[] = [];
    peer.on("signal", (msg) => signals.push(msg));

    // Handle state changes
    peer.on("stateChange", (state) => {
      logModel.info(`Connection state: ${state}`);
      if (state === "connected") {
        connectionModel.setConnected();
      } else if (state === "failed" || state === "closed") {
        connectionModel.setDisconnected();
      }
    });

    // Handle data channel open
    peer.on("open", () => {
      logModel.success("Data channel opened!");
      const channel = peer.getDataChannel();
      if (channel) {
        setMux(ctx, createPeerMux(channel, "responder"));
      }
    });

    peer.on("error", (err) => {
      logModel.error(`WebRTC error: ${err.message}`);
      connectionModel.setFailed(err.message);
    });

    // Handle the offer
    logModel.info("Processing offer...");
    await peer.handleSignal({ type: "offer", sdp: description.sdp });

    // Add ICE candidates
    for (const candidate of candidates) {
      await peer.handleSignal({ type: "candidate", candidate });
    }

    // Wait for ICE gathering
    logModel.info("Gathering ICE candidates...");
    await peer.waitForIceGathering();

    // Create answer
    const answerDescription = peer.getLocalDescription();
    if (!answerDescription) {
      throw new Error("Failed to get local description");
    }
    const answerCandidates = peer.getCollectedCandidates();
    const answerPayload = encodeSignal(
      createCompressedSignal(parsed.sessionId, "responder", answerDescription, answerCandidates),
    );

    sharingModel.setLocalSignal(answerPayload);
    logModel.info(`Answer created (${answerPayload.length} chars)`);

    return answerPayload;
  } catch (error) {
    logModel.error(`Failed to accept offer: ${(error as Error).message}`);
    connectionModel.setFailed((error as Error).message);
    sharingModel.reset();
    return null;
  }
}

/**
 * Accept an answer from a peer to complete the connection.
 */
export async function acceptAnswer(
  ctx: Map<string, unknown>,
  answerPayload: string,
): Promise<boolean> {
  const peer = getPeerManager(ctx);
  const sessionId = getSessionId(ctx);
  const connectionModel = getConnectionModel(ctx);
  const sharingModel = getSharingFormModel(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!peer || !sessionId) {
    logModel.error("No pending connection");
    return false;
  }

  try {
    const { description, candidates } = parseCompressedSignal(decodeSignal(answerPayload));

    logModel.info("Processing answer...");

    // Handle the answer
    await peer.handleSignal({ type: "answer", sdp: description.sdp });

    // Add ICE candidates
    for (const candidate of candidates) {
      await peer.handleSignal({ type: "candidate", candidate });
    }

    logModel.info("Answer accepted, waiting for connection...");
    sharingModel.reset();

    return true;
  } catch (error) {
    logModel.error(`Failed to accept answer: ${(error as Error).message}`);
    connectionModel.setFailed((error as Error).message);
    return false;
  }
}

/**
 * Close the current WebRTC connection.
 */
export function closeConnection(ctx: Map<string, unknown>): void {
  const peer = getPeerManager(ctx);
  const connectionModel = getConnectionModel(ctx);
  const sharingModel = getSharingFormModel(ctx);
  const logModel = getActivityLogModel(ctx);

  if (peer) {
    peer.close();
    void getMux(ctx)?.close();
    setPeerManager(ctx, null);
    setSessionId(ctx, null);
    setMux(ctx, null);
  }

  connectionModel.reset();
  sharingModel.reset();
  logModel.info("Connection closed");
}

/**
 * Check if a peer connection is established and ready.
 */
export function isConnected(ctx: Map<string, unknown>): boolean {
  const connectionModel = getConnectionModel(ctx);
  return connectionModel.isConnected;
}
