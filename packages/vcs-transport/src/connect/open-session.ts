/**
 * The pack protocol over a {@link GitSession}: the existing smart-HTTP and duplex openers,
 * picked by the session's kind, with git://'s request line first where the peer wants it.
 */

import {
  openDuplexConnection,
  openHttpConnection,
  type UploadPackConnection,
} from "../fetch-client/index.js";
import { encodeGitProtocolRequest, TransportError } from "../protocol/index.js";
import {
  openDuplexReceivePackConnection,
  openHttpReceivePackConnection,
  type ReceivePackConnection,
} from "../push-client/index.js";
import type { GitConnectRequest, GitNativeSession, GitService, GitSession } from "./connector.js";

/** Options of {@link openUploadPack} and {@link openReceivePack} the session does not carry. */
export interface OpenSessionOptions {
  /** Smart HTTP: gzip large upload-pack request bodies (default true, as git) */
  gzipRequests?: boolean;
  /** Smart HTTP: stream the push request body (see `HttpReceivePackOptions.streamRequestBody`) */
  streamRequestBody?: boolean;
}

/**
 * The protocol version a service is asked for (git_connect): receive-pack has no v2, so a
 * push configured for v2 asks for v0; v0 and v1 stay.
 *
 * @example
 * ```ts
 * protocolVersionFor("git-receive-pack", 2); // 0
 * protocolVersionFor("git-upload-pack", 2);  // 2
 * ```
 */
export function protocolVersionFor(service: GitService, version: 0 | 1 | 2): 0 | 1 | 2 {
  return version === 2 && service !== "git-upload-pack" ? 0 : version;
}

/**
 * The request line git sends to git-daemon (connect.c's `git_connect_git`):
 * `<service> <path>\0host=<host>\0`, then for protocol v1 and v2 a second NUL and
 * `version=<n>\0`, then the request's extra parameters.
 *
 * @example
 * ```ts
 * gitDaemonRequest({ url: parseGitUrl("git://h/r.git"), service: "git-upload-pack", protocolVersion: 2 });
 * // "0029git-upload-pack /r.git\0host=h\0\0version=2\0"
 * ```
 */
export function gitDaemonRequest(request: GitConnectRequest): Uint8Array {
  const host = request.url.authority ?? request.url.host ?? "";
  const path = request.url.path;
  if (host.includes("\n") || path.includes("\n")) {
    throw new TransportError("newline is forbidden in git:// hosts and repo paths");
  }
  // a NUL would end the field early and smuggle in parameters (git's C strings hold none)
  if (host.includes("\0") || path.includes("\0")) {
    throw new TransportError("NUL is forbidden in git:// hosts and repo paths");
  }
  const extraParams = new Map<string, string>();
  const version = protocolVersionFor(request.service, request.protocolVersion);
  if (version > 0) extraParams.set("version", String(version));
  for (const [key, value] of Object.entries(request.extraParams ?? {})) {
    if (key.includes("\0") || value.includes("\0")) {
      throw new TransportError("NUL is forbidden in git:// extra parameters");
    }
    extraParams.set(key, value);
  }
  return encodeGitProtocolRequest({
    // git_connect_git writes the program asked for (`--upload-pack`) where the service goes
    service: (request.program ?? request.service) as GitService,
    path,
    host,
    ...(extraParams.size > 0 ? { extraParams } : {}),
  });
}

/** Writes git-daemon's request line on a session that wants one. */
async function handshake(session: GitNativeSession, request: GitConnectRequest): Promise<void> {
  if (session.handshake !== "git-daemon") return;
  try {
    await session.duplex.write(gitDaemonRequest(request));
  } catch (error) {
    await session.duplex.close?.();
    throw error;
  }
}

/**
 * Opens upload-pack over a session: smart HTTP (`GET info/refs`, protocol v2 when asked for
 * and answered), or a native stream (git-daemon's request line first when the session wants
 * it; the server speaks first and its greeting decides the protocol). Closing the connection
 * closes a native session's stream.
 *
 * @example
 * ```ts
 * const session = await connector.connect(request);
 * const connection = await openUploadPack(session, request);
 * try {
 *   const refs = await lsRefs(connection, ["refs/heads/"]);
 * } finally {
 *   await connection.close();
 * }
 * ```
 */
export async function openUploadPack(
  session: GitSession,
  request: GitConnectRequest,
  options: OpenSessionOptions = {},
): Promise<UploadPackConnection> {
  if (session.kind === "http") {
    return openHttpConnection({
      url: session.baseUrl,
      fetchImpl: session.fetchImpl,
      ...(session.headers || request.headers
        ? { headers: { ...session.headers, ...request.headers } }
        : {}),
      ...(request.credentials ? { auth: request.credentials } : {}),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(options.gzipRequests !== undefined ? { gzipRequests: options.gzipRequests } : {}),
      protocolVersion: request.protocolVersion,
    });
  }
  await handshake(session, request);
  try {
    return await openDuplexConnection(session.duplex, {
      closeDuplex: true,
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    await session.duplex.close?.();
    throw error;
  }
}

/**
 * Opens receive-pack over a session: smart HTTP (`GET info/refs?service=git-receive-pack`),
 * or a native stream (git-daemon's request line first when the session wants it, protocol v0
 * or v1). Closing the connection closes a native session's stream.
 */
export async function openReceivePack(
  session: GitSession,
  request: GitConnectRequest,
  options: OpenSessionOptions = {},
): Promise<ReceivePackConnection> {
  if (session.kind === "http") {
    return openHttpReceivePackConnection({
      url: session.baseUrl,
      fetchImpl: session.fetchImpl,
      ...(session.headers || request.headers
        ? { headers: { ...session.headers, ...request.headers } }
        : {}),
      ...(request.credentials ? { auth: request.credentials } : {}),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(options.streamRequestBody !== undefined
        ? { streamRequestBody: options.streamRequestBody }
        : {}),
      ...(protocolVersionFor(request.service, request.protocolVersion) === 1
        ? { protocolVersion: 1 as const }
        : {}),
    });
  }
  await handshake(session, request);
  try {
    return await openDuplexReceivePackConnection(session.duplex, {
      closeDuplex: true,
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    await session.duplex.close?.();
    throw error;
  }
}
