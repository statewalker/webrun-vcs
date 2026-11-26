/**
 * git's builtin file system monitor daemon asked over a `MessagePort` (fsmonitor-ipc.c's
 * `fsmonitor_ipc__send_query` over simple-ipc): the request is the token, the answer the new
 * token and the changed paths, both sent as pkt-lines ended by a flush packet.
 *
 * ```typescript
 * const port = await environment.openIpcPort({ service: "fsmonitor--daemon", path });
 * const answer = await queryFsmonitorDaemon(port, "builtin:fake");
 * // answer: "<token>\0<path>\0<path>\0..." as the daemon wrote it, or undefined on failure
 * ```
 *
 * The protocol code never sees a socket: the port speaks webrun-rpc's stream tier (one
 * stream per port, bounded both ways), whatever carries it (a Unix socket through
 * `connectSocketPort` of `@statewalker/vcs-utils-node`, a `MessageChannel`, a worker).
 */

import { duplexOverPort } from "@statewalker/webrun-rpc";

/** git's `LARGE_PACKET_DATA_MAX`: the largest payload of one pkt-line. */
const LARGE_PACKET_DATA_MAX = 65520 - 4;

/** The daemon's socket in the git directory (`fsmonitor_ipc__get_default_path`). */
export const FSMONITOR_DAEMON_IPC_NAME = "fsmonitor--daemon.ipc";

const hex = (n: number) => n.toString(16).padStart(4, "0");

/**
 * `write_packetized_from_buf_no_flush` then `packet_flush`: `payload` as pkt-lines of at
 * most {@link LARGE_PACKET_DATA_MAX} bytes (none for an empty payload), then `0000`.
 */
export function encodePacketized(payload: Uint8Array): Uint8Array {
  const lines = Math.ceil(payload.byteLength / LARGE_PACKET_DATA_MAX);
  const out = new Uint8Array(payload.byteLength + lines * 4 + 4);
  let at = 0;
  for (let from = 0; from < payload.byteLength; from += LARGE_PACKET_DATA_MAX) {
    const chunk = payload.subarray(from, from + LARGE_PACKET_DATA_MAX);
    for (const c of hex(chunk.byteLength + 4)) out[at++] = c.charCodeAt(0);
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  for (let i = 0; i < 4; i++) out[at++] = 0x30;
  return out;
}

/**
 * Reads pkt-lines from `chunks` up to the first flush packet (`read_packetized_to_strbuf`):
 * their payloads joined, or undefined when the stream ends first or a length is malformed.
 */
async function readPacketized(chunks: AsyncIterator<Uint8Array>): Promise<Uint8Array | undefined> {
  let buffer = new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const fill = async (need: number): Promise<boolean> => {
    while (buffer.byteLength < need) {
      const next = await chunks.next();
      if (next.done) return false;
      const joined = new Uint8Array(buffer.byteLength + next.value.byteLength);
      joined.set(buffer);
      joined.set(next.value, buffer.byteLength);
      buffer = joined;
    }
    return true;
  };
  for (;;) {
    if (!(await fill(4))) return undefined;
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const digit = Number.parseInt(String.fromCharCode(buffer[i] as number), 16);
      if (Number.isNaN(digit)) return undefined;
      length = length * 16 + digit;
    }
    if (length === 0) break;
    // a delimiter or response-end packet, or a length shorter than its header: protocol error
    if (length < 4) return undefined;
    if (!(await fill(length))) return undefined;
    const payload = buffer.slice(4, length);
    parts.push(payload);
    size += payload.byteLength;
    buffer = buffer.subarray(length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Sends `token` to the daemon behind `port` and returns its answer (the new token, a NUL,
 * then the changed paths, each ended by a NUL); undefined when the exchange fails (the
 * stream fails or ends before the answer's flush packet), as git's
 * `ipc_client_send_command_to_connection` fails. The port is closed afterwards.
 */
export async function queryFsmonitorDaemon(
  port: MessagePort,
  token: string,
): Promise<Uint8Array | undefined> {
  let answered: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    answered = resolve;
  });
  // as git's client: the request and its flush, then the connection held open (no
  // half-close) until the answer is read
  async function* request() {
    yield encodePacketized(new TextEncoder().encode(token));
    await done;
  }
  const output = duplexOverPort(port)(request());
  port.start();
  try {
    return await readPacketized(output);
  } catch {
    return undefined;
  } finally {
    answered();
    await output.return(undefined).catch(() => undefined);
    port.close();
  }
}
