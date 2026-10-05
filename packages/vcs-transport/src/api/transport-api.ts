/**
 * Git transport protocol I/O interface.
 *
 * Provides abstraction over the Git wire protocol:
 * - Pkt-line framing (4-byte hex length prefix)
 * - Special packets (flush, delimiter)
 * - Sideband multiplexing (channels 1-3)
 * - Pack data streaming
 *
 * All methods are pure I/O - no protocol state management.
 */
export interface TransportApi {
  // ─────────────────────────────────────────────────────────────
  // Pkt-line level (Git protocol framing)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reads the next pkt-line from the transport.
   * @returns Parsed pkt-line result
   */
  readPktLine(): Promise<PktLineResult>;

  /**
   * Writes a pkt-line with proper length prefix.
   * @param data - String or bytes to send
   */
  writePktLine(data: string | Uint8Array): Promise<void>;

  /**
   * Writes a flush packet (0000).
   * Signals end of a message or section.
   */
  writeFlush(): Promise<void>;

  /**
   * Writes a delimiter packet (0001).
   * Used in protocol v2 to separate sections.
   */
  writeDelimiter(): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Line level (convenience methods)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reads a single text line from the transport.
   * @returns Line content or null if flush packet
   */
  readLine(): Promise<string | null>;

  /**
   * Writes a text line with newline suffix.
   * @param line - Line to send (newline added automatically)
   */
  writeLine(line: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Sideband (multiplexed channels)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reads from sideband multiplexed stream.
   * Used when side-band-64k capability is negotiated.
   * @returns Channel number and data
   */
  readSideband(): Promise<SidebandResult>;

  /**
   * Writes to sideband multiplexed stream.
   * @param channel - 1=pack data, 2=progress, 3=error
   * @param data - Bytes to send on the channel
   */
  writeSideband(channel: 1 | 2 | 3, data: Uint8Array): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Pack streaming (pure byte I/O, no parsing)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reads pack data as a byte stream.
   * Handles sideband extraction if negotiated.
   * @yields Pack data chunks
   */
  readPack(): AsyncGenerator<Uint8Array>;

  /**
   * Reads raw pack data (bypasses sideband, always reads raw bytes).
   * Used by server-side receive-pack where client sends raw pack data
   * after pkt-line commands, regardless of sideband capability.
   * @yields Pack data chunks
   */
  readRawPack(): AsyncGenerator<Uint8Array>;

  /**
   * Writes pack data stream.
   * Handles sideband wrapping if negotiated.
   * @param data - Pack data chunks
   */
  writePack(data: AsyncIterable<Uint8Array>): Promise<void>;

  /**
   * Writes raw pack data (bypasses sideband).
   * Used by push clients where sideband is server→client only.
   * @param data - Pack data chunks
   */
  writeRawPack(data: AsyncIterable<Uint8Array>): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Closes the underlying transport connection.
   * After calling close(), all read/write operations should complete
   * gracefully or throw an error.
   *
   * @returns Promise that resolves when the connection is closed
   */
  close?(): Promise<void>;
}

/**
 * Result from reading a pkt-line.
 */
export type PktLineResult =
  | { type: "data"; payload: Uint8Array; text: string }
  | { type: "flush" }
  | { type: "delim" }
  | { type: "eof" };

/**
 * Result from reading a sideband packet.
 */
export type SidebandResult =
  | { channel: 1; data: Uint8Array } // Pack data
  | { channel: 2; data: Uint8Array } // Progress messages
  | { channel: 3; data: Uint8Array }; // Error messages
