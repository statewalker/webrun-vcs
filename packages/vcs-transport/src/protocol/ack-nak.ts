/**
 * ACK/NAK parsing for git protocol negotiation.
 *
 * During fetch negotiation, the server responds with ACK/NAK
 * to indicate which commits it has in common with the client.
 *
 * Based on JGit's PacketLineIn.readACK() and parseACKv2()
 */

import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { OBJECT_ID_STRING_LENGTH, PACKET_ACK, PACKET_ERR, PACKET_NAK } from "./constants.js";
import { PackProtocolError } from "./errors.js";
import { packetDataToString } from "./pkt-line-codec.js";
import type { AckNackResult, Packet } from "./types.js";

/**
 * Parse an ACK/NAK response line (protocol v0/v1).
 *
 * Formats:
 * - "NAK"
 * - "ACK <object-id>"
 * - "ACK <object-id> continue"
 * - "ACK <object-id> common"
 * - "ACK <object-id> ready"
 */
export function parseAckNak(line: string): AckNackResult {
  if (line === PACKET_NAK || line === "NAK") {
    return { type: "NAK" };
  }

  if (line.startsWith(PACKET_ACK) || line.startsWith("ACK ")) {
    const rest = line.slice(4); // Skip "ACK "
    const parts = rest.split(" ");
    const idHex = parts[0];

    if (idHex.length !== OBJECT_ID_STRING_LENGTH) {
      throw new PackProtocolError(`Expected ACK/NAK, got: ${line}`);
    }

    const objectId = hexToBytes(idHex);
    const modifier = parts[1];

    switch (modifier) {
      case "continue":
        return { type: "ACK_CONTINUE", objectId };
      case "common":
        return { type: "ACK_COMMON", objectId };
      case "ready":
        return { type: "ACK_READY", objectId };
      case undefined:
        return { type: "ACK", objectId };
      default:
        throw new PackProtocolError(`Expected ACK/NAK, got: ${line}`);
    }
  }

  if (line.startsWith(PACKET_ERR) || line.startsWith("ERR ")) {
    const message = line.slice(4);
    throw new PackProtocolError(message);
  }

  throw new PackProtocolError(`Expected ACK/NAK, got: ${line}`);
}

/**
 * Parse an ACK/NAK response (protocol v2).
 *
 * In v2, the format is slightly different:
 * - "NAK"
 * - "ACK <object-id>" (implies common)
 * - "ready" (server is ready to send pack)
 */
export function parseAckNakV2(line: string): AckNackResult {
  if (line === PACKET_NAK || line === "NAK") {
    return { type: "NAK" };
  }

  if (line === "ready") {
    // Object ID is not updated in ready response
    return { type: "ACK_READY", objectId: new Uint8Array(20) };
  }

  if (line.startsWith(PACKET_ACK) || line.startsWith("ACK ")) {
    const idHex = line.slice(4).trim();

    if (idHex.length !== OBJECT_ID_STRING_LENGTH) {
      throw new PackProtocolError(`Expected ACK/NAK, got: ${line}`);
    }

    const objectId = hexToBytes(idHex);
    // In v2, ACK always means ACK_COMMON
    return { type: "ACK_COMMON", objectId };
  }

  if (line.startsWith(PACKET_ERR) || line.startsWith("ERR ")) {
    const message = line.slice(4);
    throw new PackProtocolError(message);
  }

  throw new PackProtocolError(`Expected ACK/NAK, got: ${line}`);
}

/**
 * Read ACK/NAK from a packet.
 * Returns null for flush/delim/end packets.
 */
export function readAckFromPacket(packet: Packet): AckNackResult | null {
  if (packet.type !== "data") {
    return null;
  }

  const line = packetDataToString(packet);
  return parseAckNak(line);
}

/**
 * Format an ACK response for sending.
 */
export function formatAck(objectId: Uint8Array, modifier?: string): string {
  const idHex = bytesToHex(objectId);
  if (modifier) {
    return `ACK ${idHex} ${modifier}\n`;
  }
  return `ACK ${idHex}\n`;
}

/**
 * Format a NAK response for sending.
 */
export function formatNak(): string {
  return "NAK\n";
}
