/**
 * Type definitions for the git transport protocol.
 */

/**
 * Packet type markers in the pkt-line protocol.
 */
export type PacketType = "data" | "flush" | "delim" | "end";

/**
 * A single packet in the pkt-line protocol.
 *
 * Data packets contain a payload; control packets (flush, delim, end)
 * have no data.
 */
export interface Packet {
  type: PacketType;
  data?: Uint8Array;
}

/**
 * ACK/NAK result from server during negotiation.
 */
export type AckNackResult =
  | { type: "NAK" }
  | { type: "ACK"; objectId: Uint8Array }
  | { type: "ACK_CONTINUE"; objectId: Uint8Array }
  | { type: "ACK_COMMON"; objectId: Uint8Array }
  | { type: "ACK_READY"; objectId: Uint8Array };

/**
 * Sideband message with channel identifier.
 */
export interface SidebandMessage {
  channel: number;
  data: Uint8Array;
}

/**
 * Reference advertised by the server.
 */
export interface AdvertisedRef {
  name: string;
  objectId: Uint8Array;
  peeled?: Uint8Array;
}

/**
 * Result of parsing server's ref advertisement.
 */
export interface RefAdvertisement {
  /** Map of ref name to object ID */
  refs: Map<string, Uint8Array>;
  /** Server capabilities */
  capabilities: Set<string>;
  /** Symbolic ref mappings (e.g., HEAD -> refs/heads/main) */
  symrefs: Map<string, string>;
  /** Agent string if advertised */
  agent?: string;
}

/**
 * Progress information from server.
 */
export interface ProgressInfo {
  stage: string;
  current: number;
  total?: number;
  percent?: number;
}

/**
 * Refspec for mapping remote refs to local refs.
 */
export interface RefSpec {
  source: string | null;
  destination: string | null;
  force: boolean;
  wildcard: boolean;
  negative: boolean;
}

/**
 * Parsed git URL components.
 */
export interface GitUrl {
  protocol: "https" | "http" | "git" | "ssh" | "file";
  host: string;
  port?: number;
  path: string;
  user?: string;
  password?: string;
}

/**
 * Transport service type.
 */
export type ServiceType = "git-upload-pack" | "git-receive-pack";
