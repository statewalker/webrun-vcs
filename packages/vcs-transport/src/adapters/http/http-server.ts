/**
 * HTTP Smart Protocol server handlers.
 *
 * Implements the Git Smart HTTP protocol:
 * - GET /info/refs?service=git-upload-pack - Ref advertisement (v0), or the capability
 *   advertisement with `Git-Protocol: version=2`
 * - POST /git-upload-pack - Pack negotiation and transfer (v0), or one stateless v2 command
 *   (`ls-refs`, `fetch`, `object-info`) with `Git-Protocol: version=2`
 * - GET /info/refs?service=git-receive-pack, POST /git-receive-pack - push (v0 only: git has
 *   no v2 push)
 */

import type { RepositoryFacade } from "../../api/repository-facade.js";
import {
  type ProcessContext as AdapterProcessContext,
  getOutput,
  setConfig,
  setOutput,
  setRefStore,
  setRepository,
  setState,
  setTransport,
} from "../../context/context-adapters.js";
import { HandlerOutput } from "../../context/handler-output.js";
import type { ProcessConfiguration } from "../../context/process-config.js";
import type { ProcessContext, RefStore } from "../../context/process-context.js";
import { ProtocolState } from "../../context/protocol-state.js";
import { createTransportApi } from "../../factories/transport-api-factory.js";
import {
  defaultUploadPackCapabilities,
  serverFetchHandlers,
  serverFetchTransitions,
} from "../../fsm/fetch/server-fetch-fsm.js";
import { peelFully } from "../../fsm/fetch/upload-pack-graph.js";
import { Fsm } from "../../fsm/fsm.js";
import { serverV2Handlers, serverV2Transitions } from "../../fsm/protocol-v2/server-v2-fsm.js";
import { SERVER_V2_CAPABILITIES } from "../../fsm/protocol-v2/types.js";
import type { ReceivePackHooks, ReceivePackLogger } from "../../fsm/push/receive-pack-types.js";
import {
  RECEIVE_PACK_CAPABILITIES,
  serverPushHandlers,
  serverPushTransitions,
} from "../../fsm/push/server-push-fsm.js";
import { ZERO_OID } from "../../protocol/constants.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import { readStreamWithIdleTimeout } from "../../utils/idle-timeout.js";
import { createSimpleDuplex } from "./http-duplex.js";

/**
 * HTTP request information needed by handlers.
 */
export interface HttpRequest {
  /** HTTP method (GET, POST) */
  method: string;
  /** Request URL path */
  path: string;
  /** Query parameters */
  query: Record<string, string>;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body as readable stream (for POST) */
  body?: ReadableStream<Uint8Array>;
}

/**
 * HTTP response to send back.
 */
export interface HttpResponse {
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
  /**
   * Response body: bytes, or a stream (`handleUploadPack` streams the pack as it is written,
   * pulled by the reader: a slow client slows the pack writer down).
   */
  body: Uint8Array | ReadableStream<Uint8Array>;
}

/**
 * Server options for HTTP handlers.
 */
export interface HttpServerOptions {
  /** Request policy for validating client wants */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";
  /** Advertised capabilities */
  capabilities?: string[];
  /**
   * Side-band keep-alive interval (ms) while upload-pack prepares the pack, until its first
   * byte (default 5000, as git's `uploadpack.keepAlive`; 0: none).
   */
  keepAliveMs?: number;
  /**
   * Largest request body accepted, in bytes after `Content-Encoding: gzip` is undone; a larger
   * one is answered 413. Default: {@link DEFAULT_MAX_UPLOAD_PACK_REQUEST_BYTES} for
   * upload-pack, {@link DEFAULT_MAX_RECEIVE_PACK_REQUEST_BYTES} for receive-pack (a push
   * carries its pack). With gzip, the compressed body is held to the same limit (plus gzip's
   * worst-case overhead). An upload-pack request is read whole before upload-pack runs (as
   * git's http-backend buffers it), so an over-limit one is always a 413.
   */
  maxRequestBodyBytes?: number;
  /**
   * Answer `Git-Protocol: version=2` upload-pack requests with protocol v2 (default true);
   * false serves them v0, as a server without v2.
   */
  protocolV2?: boolean;
  /** Capabilities of the v2 advertisement (default {@link SERVER_V2_CAPABILITIES}) */
  v2Capabilities?: string[];
  /** receive-pack (push) hooks, limits and ref policies */
  receivePack?: ReceivePackServerOptions;
  /** Logs hook failures that cannot reach the client (default: console.error) */
  logger?: ReceivePackLogger;
}

/**
 * receive-pack settings of the smart-HTTP server. The request body limit is
 * {@link HttpServerOptions.maxRequestBodyBytes}.
 *
 * @example
 * ```ts
 * createFetchHandler({
 *   resolveRepository,
 *   receivePack: {
 *     hooks: {
 *       authorize: (_commands, ctx) =>
 *         ctx.request?.headers.authorization === `Bearer ${token}` || "permission denied",
 *       postReceive: (commands) => notify(commands),
 *     },
 *     maxCommands: 1000,
 *   },
 * });
 * ```
 */
export interface ReceivePackServerOptions {
  /**
   * The hooks. A push `authorize` refuses as a whole is answered 403 before its body is read;
   * `postReceive` starts once the report is written.
   */
  hooks?: ReceivePackHooks;
  /** Most commands in one push; more is a 400 (default 65536) */
  maxCommands?: number;
  /**
   * A request body that brings nothing for this long (ms) is abandoned: the push is answered
   * `unpack request idle for … ms` (default {@link DEFAULT_RECEIVE_PACK_IDLE_TIMEOUT_MS}; 0: none)
   */
  idleTimeoutMs?: number;
  /**
   * Side-band keep-alive interval (ms) while a received push is checked (default 5000, as
   * git's `receive.keepAlive`; 0: none)
   */
  keepAliveMs?: number;
  /** Allow ref deletions (default true; false: "deletion prohibited" under refs/heads/) */
  allowDeletes?: boolean;
  /** Allow non-fast-forward branch updates (default false) */
  allowNonFastForward?: boolean;
  /** Whether the repository has no working tree (default: `repository.isBare()`, else true) */
  bare?: boolean;
  /** Refuse updating the checked-out branch of a non-bare repository (default true) */
  denyCurrentBranch?: boolean;
  /** Refuse deleting the branch HEAD names (default true) */
  denyDeleteCurrent?: boolean;
  /** The branch HEAD names (default: `refStore.getSymrefTarget("HEAD")`) */
  currentBranch?: string;
  /** Accept shallow pushes (git's `receive.shallowUpdate`; default false) */
  shallowUpdate?: boolean;
}

/** Default idle timeout of a POST /git-receive-pack body. */
export const DEFAULT_RECEIVE_PACK_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Default request body limit of POST /git-upload-pack (git's `http.maxRequestBuffer`). */
export const DEFAULT_MAX_UPLOAD_PACK_REQUEST_BYTES = 10 * 1024 * 1024;

/** Default request body limit of POST /git-receive-pack. */
export const DEFAULT_MAX_RECEIVE_PACK_REQUEST_BYTES = 1024 * 1024 * 1024;

const textEncoder = new TextEncoder();

/**
 * git's http-backend `hdr_nocache`, sent with every info/refs and rpc response: neither the
 * advertisement nor a negotiation answer may come from a cache.
 */
export const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  Pragma: "no-cache",
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
};

/** A request body larger than the server's limit (answered 413). */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body larger than ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * The request body as the protocol reads it: gzip undone (git's remote-curl gzips request
 * bodies) and cut at `limit` bytes, streamed. `tooLarge()` tells whether the limit was hit.
 * Returns an HTTP error response instead for an encoding it cannot undo, or a declared
 * `Content-Length` over the limit.
 *
 * The limit holds for the inflated bytes and, with gzip, for the compressed ones too (plus
 * gzip's worst-case overhead): a decompressor takes input faster than it hands output on, so
 * the inflated count alone would let a client push far more than `limit` bytes. At the
 * limit, the source is cancelled: nothing more is read from the client.
 */
function requestBody(
  request: HttpRequest,
  body: ReadableStream<Uint8Array>,
  limit: number,
): { body: ReadableStream<Uint8Array>; tooLarge: () => boolean } | HttpResponse {
  const encoding = (header(request, "content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity" && encoding !== "gzip" && encoding !== "x-gzip") {
    return plain(415, `Unsupported Content-Encoding: ${encoding}`);
  }
  const gzip = encoding === "gzip" || encoding === "x-gzip";
  const declared = Number(header(request, "content-length") ?? Number.NaN);
  const compressedLimit = gzip ? limit + Math.ceil(limit / 16384) * 5 + 64 : limit;
  if (declared > compressedLimit) {
    return plain(413, new RequestBodyTooLargeError(limit).message);
  }
  let exceeded = false;
  const onExceeded = () => {
    exceeded = true;
  };
  const input = limitStream(body, compressedLimit, limit, onExceeded);
  const decoded = gzip
    ? limitStream(
        input.pipeThrough(
          new DecompressionStream("gzip") as unknown as ReadableWritablePair<
            Uint8Array,
            Uint8Array
          >,
        ),
        limit,
        limit,
        onExceeded,
      )
    : input;
  return { body: decoded, tooLarge: () => exceeded };
}

/**
 * `source`, pulled one chunk at a time, failing with {@link RequestBodyTooLargeError} once
 * more than `max` bytes went through; the source is cancelled then.
 */
function limitStream(
  source: ReadableStream<Uint8Array>,
  max: number,
  limit: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > max) {
          onExceeded();
          const error = new RequestBodyTooLargeError(limit);
          controller.error(error);
          await reader.cancel(error).catch(() => {});
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The whole request body (at most `limit` bytes), as git's http-backend buffers an
 * upload-pack request before upload-pack runs: an over-limit body is a 413, never a response
 * cut short after its status went out.
 */
async function bufferBody(
  body: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array } | { error: unknown }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch (error) {
    return { error };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function header(request: HttpRequest, name: string): string | undefined {
  const direct = request.headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function plain(status: number, message: string): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "text/plain" },
    body: textEncoder.encode(message),
  };
}

/** The capabilities upload-pack advertises by default (GET /info/refs). */
const DEFAULT_UPLOAD_PACK_CAPABILITIES = [
  "multi_ack_detailed",
  "side-band-64k",
  "thin-pack",
  "no-progress",
  "include-tag",
  "ofs-delta",
  "shallow",
  "no-done",
];

/**
 * Handles GET /info/refs?service=git-upload-pack
 *
 * Returns ref advertisement in smart HTTP format. With `repository` (its `peelTag`), each
 * annotated tag is followed by its peeled line (`<oid> <tag>^{}`), as git advertises them:
 * clients follow tags by the commits they point at.
 *
 * @param refStore - Ref store for reading refs
 * @param options - Server options
 * @param repository - Repository facade, to peel annotated tags
 * @returns HTTP response
 */
export async function handleInfoRefs(
  refStore: RefStore,
  options: HttpServerOptions = {},
  repository?: RepositoryFacade,
): Promise<HttpResponse> {
  // Get all refs
  const allRefs = await refStore.listAll();
  const refs = Array.from(allRefs);

  // Build ref advertisement
  const chunks: Uint8Array[] = [];

  // Service announcement line
  chunks.push(encodePacketLine("# service=git-upload-pack\n"));
  chunks.push(encodeFlush());

  // Default capabilities (copied: the symref below must not change the caller's array)
  const capabilities = [...(options.capabilities ?? DEFAULT_UPLOAD_PACK_CAPABILITIES)];

  // Add symref capability if HEAD is a symbolic ref
  if (refStore.getSymrefTarget) {
    const headTarget = await refStore.getSymrefTarget("HEAD");
    if (headTarget) {
      capabilities.push(`symref=HEAD:${headTarget}`);
    }
  }

  // First ref with capabilities
  if (refs.length > 0) {
    const [firstRefName, firstOid] = refs[0];
    const capsStr = capabilities.join(" ");
    chunks.push(encodePacketLine(`${firstOid} ${firstRefName}\0${capsStr}\n`));
    const firstPeeled = await peelFully(repository, firstOid);
    if (firstPeeled) chunks.push(encodePacketLine(`${firstPeeled} ${firstRefName}^{}\n`));

    // Remaining refs
    for (let i = 1; i < refs.length; i++) {
      const [refName, oid] = refs[i];
      chunks.push(encodePacketLine(`${oid} ${refName}\n`));
      const peeled = await peelFully(repository, oid);
      if (peeled) chunks.push(encodePacketLine(`${peeled} ${refName}^{}\n`));
    }
  } else {
    // Empty repo - send capabilities with zero OID
    const capsStr = capabilities.join(" ");
    chunks.push(encodePacketLine(`${ZERO_OID} capabilities^{}\0${capsStr}\n`));
  }

  chunks.push(encodeFlush());

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-advertisement",
      ...NO_CACHE_HEADERS,
    },
    body,
  };
}

/**
 * Whether a `Git-Protocol` header asks for protocol v2. The value holds `key=value` parameters
 * separated by `:` (git's `GIT_PROTOCOL`), e.g. `version=2` or `version=2:object-format=sha1`.
 * As git's `determine_protocol_version_server`, the entries are split on `:` exactly and not
 * trimmed: `foo : version=2` asks for no version (v0).
 */
export function requestsProtocolV2(gitProtocol: string | undefined): boolean {
  if (!gitProtocol) return false;
  return gitProtocol.split(":").some((param) => param === "version=2");
}

/** Whether `request` carries `Git-Protocol: version=2` (and v2 is not switched off). */
export function isProtocolV2Request(
  request: HttpRequest,
  options: HttpServerOptions = {},
): boolean {
  return options.protocolV2 !== false && requestsProtocolV2(header(request, "git-protocol"));
}

/**
 * Handles GET /info/refs?service=git-upload-pack with `Git-Protocol: version=2`.
 *
 * Returns the v2 capability advertisement: `version 2`, one capability per line and a flush.
 * As git's http-backend, without the smart-HTTP `# service=git-upload-pack` preamble, which it
 * writes only for v0.
 *
 * @example
 * ```ts
 * const response = handleInfoRefsV2();
 * // "version 2", "agent=…", "ls-refs=unborn", "fetch=shallow wait-for-done", …, flush
 * ```
 */
export function handleInfoRefsV2(options: HttpServerOptions = {}): HttpResponse {
  const chunks: Uint8Array[] = [encodePacketLine("version 2\n")];
  for (const capability of options.v2Capabilities ?? SERVER_V2_CAPABILITIES) {
    chunks.push(encodePacketLine(`${capability}\n`));
  }
  chunks.push(encodeFlush());
  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-advertisement",
      ...NO_CACHE_HEADERS,
    },
    body: concatBytes(chunks),
  };
}

/**
 * Handles POST /git-upload-pack
 *
 * Runs the fetch negotiation and sends pack data (protocol v0; see
 * {@link handleUploadPackV2} for a `Git-Protocol: version=2` request).
 *
 * @param request - HTTP request with body
 * @param repository - Repository facade for pack export
 * @param refStore - Ref store for reading refs
 * @param options - Server options
 * @returns HTTP response
 */
export async function handleUploadPack(
  request: HttpRequest,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpServerOptions = {},
): Promise<HttpResponse> {
  const requestBytes = await readUploadPackRequest(request, options);
  if (!(requestBytes instanceof Uint8Array)) return requestBytes;

  const state = new ProtocolState();

  // Populate refs from refStore
  const allRefs = await refStore.listAll();
  for (const [refName, oid] of allRefs) {
    state.refs.set(refName, oid);
  }

  // What GET /info/refs advertised; the client's first want line picks from it (the FSM sets
  // `state.capabilities` to that request, possibly empty)
  for (const cap of options.capabilities ?? DEFAULT_UPLOAD_PACK_CAPABILITIES) {
    state.advertisedCapabilities.add(cap);
  }

  const config: ProcessConfiguration = {
    requestPolicy: options.requestPolicy ?? "ADVERTISED",
    maxEmptyBatches: 10,
    keepAliveMs: options.keepAliveMs,
    // each POST is one request of a stateless negotiation (git's --stateless-rpc)
    statelessRpc: true,
  };

  // Run server FSM starting from READ_WANTS state
  // (ref advertisement was already sent in GET /info/refs)
  const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
  fsm.setState("READ_WANTS");
  return streamUploadPack(requestBytes, fsm, { repository, refStore, state, config });
}

/**
 * Handles POST /git-upload-pack with `Git-Protocol: version=2`.
 *
 * Runs one v2 command (`ls-refs`, `fetch` or `object-info`) with the v2 server FSM and streams
 * its response. Stateless, as git's http-backend: every request starts from a fresh state and
 * reads the command at once (GET /info/refs sent the capability advertisement), and a `fetch`
 * round carries all the client's haves, so nothing is kept between requests. The request body
 * is read whole first (gzip undone, at most `maxRequestBodyBytes`); the pack is streamed as
 * it is written.
 *
 * @example
 * ```ts
 * if (isProtocolV2Request(request)) {
 *   return handleUploadPackV2(request, repository, refStore);
 * }
 * ```
 */
export async function handleUploadPackV2(
  request: HttpRequest,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpServerOptions = {},
): Promise<HttpResponse> {
  const requestBytes = await readUploadPackRequest(request, options);
  if (!(requestBytes instanceof Uint8Array)) return requestBytes;

  const state = new ProtocolState();
  // The v2 packfile section is always side-band-64k multiplexed (never advertised in v2)
  state.capabilities.add("side-band-64k");

  const config: ProcessConfiguration = {
    serverCapabilities: options.v2Capabilities,
    // git's upload-pack serves a stateless client any commit reachable from a ref
    requestPolicy: options.requestPolicy ?? "REACHABLE_COMMIT",
    keepAliveMs: options.keepAliveMs,
    // one command per request (git's serve loop with --stateless-rpc); more are ignored
    statelessRpc: true,
  };

  const fsm = new Fsm(serverV2Transitions, serverV2Handlers);
  fsm.setState("READ_COMMAND");
  return streamUploadPack(requestBytes, fsm, { repository, refStore, state, config });
}

/**
 * The upload-pack request body, read whole (as git's http-backend buffers it, so an
 * over-limit body is a 413, never a response cut short after its status went out), or the
 * error response.
 */
async function readUploadPackRequest(
  request: HttpRequest,
  options: HttpServerOptions,
): Promise<Uint8Array | HttpResponse> {
  if (!request.body) return plain(400, "Missing request body");
  const maxBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_UPLOAD_PACK_REQUEST_BYTES;
  const input = requestBody(request, request.body, maxBytes);
  if ("status" in input) return input;
  const buffered = await bufferBody(input.body);
  if ("error" in buffered) {
    if (input.tooLarge()) return plain(413, new RequestBodyTooLargeError(maxBytes).message);
    return plain(400, `Cannot read request body: ${String(buffered.error)}`);
  }
  return buffered.bytes;
}

/**
 * Runs an upload-pack FSM over `requestBytes` and streams what it writes as the response
 * body: each write waits until the reader pulled the previous chunk (a slow client slows the
 * pack writer down; the pack is never buffered).
 *
 * A failure before the first write is a 500 (git's http-backend answers an empty 200 there,
 * its upload-pack having died before writing; the 500 carries the message). After the first
 * write the status is out, so every failure must still reach the client: one the FSM reported
 * in band (`errorReported`: an `ERR` line, or band 3 of the side-band) ends the response
 * normally; any other is written as an `ERR <message>` pkt-line, which git's client takes as
 * a remote error wherever a pkt-line may come; and where no pkt-line can come (raw pack bytes
 * were out, `streamBroken`) or the FSM threw, the response stream is aborted.
 */
async function streamUploadPack(
  requestBytes: Uint8Array,
  fsm: Fsm<ProcessContext>,
  parts: Pick<ProcessContext, "repository" | "refStore" | "state" | "config">,
): Promise<HttpResponse> {
  // An identity TransformStream with no readable buffer
  const pipe = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  const out = pipe.writable.getWriter();
  let started: (() => void) | undefined;
  const firstWrite = new Promise<"started">((resolve) => {
    started = () => resolve("started");
  });
  const writer = (data: Uint8Array) => {
    started?.();
    return out.write(data);
  };

  const duplex = createSimpleDuplex(
    (async function* () {
      if (requestBytes.length > 0) yield requestBytes;
    })(),
    writer,
  );
  const ctx: ProcessContext = {
    ...parts,
    transport: createTransportApi(duplex, parts.state),
    output: new HandlerOutput(),
  };

  type Failure = { error: Error; how: "reported" | "err-line" | "abort" };
  const run: Promise<Failure | undefined> = fsm.run(ctx).then(
    () => {
      const output = ctx.output;
      if (!output.error) return undefined;
      const error = new Error(output.error);
      if (output.streamBroken) return { error, how: "abort" };
      return { error, how: output.errorReported ? "reported" : "err-line" };
    },
    (error: unknown) => ({
      error: error instanceof Error ? error : new Error(String(error)),
      how: "abort",
    }),
  );
  // Until the FSM writes, a failure can still be a 500; after that the status is sent
  const first = await Promise.race([run.then(() => "finished" as const), firstWrite]);
  if (first === "finished") {
    const failure = await run;
    if (failure) {
      await out.abort(failure.error).catch(() => {});
      return plain(500, failure.error.message);
    }
  }
  void run.then(async (failure) => {
    if (failure?.how === "abort") {
      await out.abort(failure.error).catch(() => {});
      return;
    }
    if (failure?.how === "err-line") {
      try {
        await out.write(encodePacketLine(`ERR ${failure.error.message}\n`));
      } catch {
        // the client is gone
      }
    }
    await out.close().catch(() => {});
  });

  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      ...NO_CACHE_HEADERS,
    },
    body: pipe.readable,
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * Handles GET /info/refs?service=git-receive-pack
 *
 * Returns ref advertisement for push operations.
 *
 * @param refStore - Ref store for reading refs
 * @param options - Server options
 * @returns HTTP response
 */
export async function handleReceivePackInfoRefs(
  refStore: RefStore,
  options: HttpServerOptions = {},
): Promise<HttpResponse> {
  // Get all refs
  const allRefs = await refStore.listAll();
  const refs = Array.from(allRefs);

  // Build ref advertisement
  const chunks: Uint8Array[] = [];

  // Service announcement line
  chunks.push(encodePacketLine("# service=git-receive-pack\n"));
  chunks.push(encodeFlush());

  // Default capabilities for receive-pack
  const capabilities = options.capabilities ?? RECEIVE_PACK_CAPABILITIES;

  // First ref with capabilities
  if (refs.length > 0) {
    const [firstRefName, firstOid] = refs[0];
    const capsStr = capabilities.join(" ");
    chunks.push(encodePacketLine(`${firstOid} ${firstRefName}\0${capsStr}\n`));

    // Remaining refs
    for (let i = 1; i < refs.length; i++) {
      const [refName, oid] = refs[i];
      chunks.push(encodePacketLine(`${oid} ${refName}\n`));
    }
  } else {
    // Empty repo - send capabilities with zero OID
    const capsStr = capabilities.join(" ");
    chunks.push(encodePacketLine(`${ZERO_OID} capabilities^{}\0${capsStr}\n`));
  }

  chunks.push(encodeFlush());

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-receive-pack-advertisement",
      ...NO_CACHE_HEADERS,
    },
    body,
  };
}

/**
 * Handles POST /git-receive-pack
 *
 * Runs receive-pack over the request body and streams its answer. The commands are read
 * first and handed to the `authorize` hook: until then a failure is an HTTP error (400 for a
 * malformed request or too many commands, 403 for a push `authorize` refuses as a whole, 413
 * for a body over the limit), and the pack is not read. Once the commands are authorized the
 * response head goes out at once, before the pack is read, so a relay that bounds a call by
 * its response head does not time out a long push; side-band keep-alive packets follow while
 * the push is checked, then the report. From then on every failure is answered in band (an
 * `unpack <error>` line for a pack that could not be read: over the limit, idle, corrupt).
 * The `postReceive` hook starts once the report is written.
 *
 * @param request - HTTP request with body
 * @param repository - Repository facade for pack import
 * @param refStore - Ref store for reading/writing refs
 * @param options - Server options
 * @param context - The repository path (for the hooks)
 * @returns HTTP response
 */
export async function handleReceivePack(
  request: HttpRequest,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpServerOptions = {},
  context: { repoPath?: string } = {},
): Promise<HttpResponse> {
  if (!request.body) return plain(400, "Missing request body");

  const limit = options.maxRequestBodyBytes ?? DEFAULT_MAX_RECEIVE_PACK_REQUEST_BYTES;
  const input = requestBody(request, request.body, limit);
  if ("status" in input) return input;
  const rp = options.receivePack ?? {};

  const state = new ProtocolState();
  for (const [refName, oid] of await refStore.listAll()) {
    state.refs.set(refName, oid);
  }
  // state.capabilities stays empty: READ_COMMANDS takes the client's request from the first
  // command (assuming a capability it did not ask for would misread the body)

  // An identity TransformStream with no readable buffer: each write waits for the reader
  const pipe = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  const out = pipe.writable.getWriter();
  // one reader for the whole body: a stalled read cancels it, a refused pack is drained
  const body = readStreamWithIdleTimeout(
    input.body,
    rp.idleTimeoutMs ?? DEFAULT_RECEIVE_PACK_IDLE_TIMEOUT_MS,
  );
  const duplex = createSimpleDuplex(body, (data) => out.write(data));

  let authorized: (() => void) | undefined;
  const onAuthorized = new Promise<"authorized">((resolve) => {
    authorized = () => resolve("authorized");
  });
  const afterReport: Array<() => Promise<void>> = [];

  const config: ProcessConfiguration = {
    requestPolicy: options.requestPolicy ?? "ADVERTISED",
    maxEmptyBatches: 10,
    allowDeletes: rp.allowDeletes ?? true,
    allowNonFastForward: rp.allowNonFastForward ?? false,
    denyCurrentBranch: rp.denyCurrentBranch ?? true,
    currentBranch: rp.currentBranch,
    receivePack: {
      hooks: rp.hooks,
      maxCommands: rp.maxCommands,
      keepAliveMs: rp.keepAliveMs,
      bare: rp.bare,
      denyDeleteCurrent: rp.denyDeleteCurrent,
      shallowUpdate: rp.shallowUpdate,
      logger: options.logger,
      request: {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
      },
      repoPath: context.repoPath,
      // a push refused as a whole is a 403, its body unread
      authorizeFailure: "fatal",
      // a pack refused once the head is out is read and dropped (at most the body limit):
      // a client cut off mid-upload would never see the report
      drainRefusedPack: true,
      discardPack: () => body.discard(),
      onAuthorized: () => authorized?.(),
      afterReport: (task) => afterReport.push(task),
    },
  };

  const ctx: AdapterProcessContext = {};
  setTransport(ctx, createTransportApi(duplex, state));
  setRepository(ctx, repository);
  setRefStore(ctx, refStore);
  setState(ctx, state);
  setOutput(ctx, new HandlerOutput());
  setConfig(ctx, config);

  // The ref advertisement was sent by GET /info/refs: start at the commands
  const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
  fsm.setState("READ_COMMANDS");
  const run: Promise<{ thrown?: unknown }> = fsm.run(ctx).then(
    () => ({}),
    (thrown: unknown) => ({ thrown }),
  );

  const first = await Promise.race([run.then(() => "finished" as const), onAuthorized]);
  if (first === "finished") {
    // nothing was written: the answer is still an HTTP status
    const { thrown } = await run;
    const output = getOutput(ctx);
    const error = thrown ?? (output.error ? new Error(output.error) : undefined);
    await out.abort().catch(() => {});
    if (input.tooLarge()) return plain(413, new RequestBodyTooLargeError(limit).message);
    if (output.authorizationDenied !== undefined) return plain(403, output.authorizationDenied);
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      return plain(output.protocolError ? 400 : 500, message);
    }
    // no commands: an empty answer, as git's receive-pack
    return {
      status: 200,
      headers: { "Content-Type": "application/x-git-receive-pack-result", ...NO_CACHE_HEADERS },
      body: new Uint8Array(0),
    };
  }

  void run.then(async ({ thrown }) => {
    const output = getOutput(ctx);
    const reported = (state as ProtocolState & { reportSent?: boolean }).reportSent === true;
    if (thrown !== undefined || (output.error && !reported)) {
      // the status is out and no report could be written: break the response
      const error = thrown ?? new Error(output.error);
      options.logger?.error("receive-pack failed", error);
      await out.abort(error).catch(() => {});
      return;
    }
    await out.close().catch(() => {});
    // git's post-receive: once the report is written, apart from the response
    for (const task of afterReport) setTimeout(() => void task(), 0);
  });

  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      ...NO_CACHE_HEADERS,
    },
    body: pipe.readable,
  };
}

/**
 * Parsed Git request information.
 */
export interface ParsedGitRequest {
  /** Repository path extracted from URL */
  repoPath: string;
  /** Git service type */
  service: "git-upload-pack" | "git-receive-pack";
  /** Whether this is an info/refs discovery request */
  isInfoRefs: boolean;
}

/**
 * Parses a Git HTTP request URL to extract repository path, service, and request type.
 *
 * Handles URLs in these formats:
 * - /repo.git/info/refs?service=git-upload-pack
 * - /repo.git/git-upload-pack
 * - /repo.git/git-receive-pack
 * - /path/to/repo.git/info/refs?service=git-receive-pack
 *
 * @param path - The URL path
 * @param query - Query parameters
 * @returns Parsed request info, or null if not a valid Git request
 */
export function parseGitRequest(
  path: string,
  query: Record<string, string>,
): ParsedGitRequest | null {
  // Check for info/refs request
  if (path.endsWith("/info/refs")) {
    const service = query.service;
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return null;
    }
    const repoPath = path.slice(0, -"/info/refs".length);
    return {
      repoPath: repoPath || "/",
      service,
      isInfoRefs: true,
    };
  }

  // Check for git-upload-pack or git-receive-pack POST request
  if (path.endsWith("/git-upload-pack")) {
    return {
      repoPath: path.slice(0, -"/git-upload-pack".length) || "/",
      service: "git-upload-pack",
      isInfoRefs: false,
    };
  }

  if (path.endsWith("/git-receive-pack")) {
    return {
      repoPath: path.slice(0, -"/git-receive-pack".length) || "/",
      service: "git-receive-pack",
      isInfoRefs: false,
    };
  }

  return null;
}

/**
 * Options for createHttpHandler.
 */
export interface HttpHandlerOptions {
  /** Resolve repository by path */
  resolveRepository: (repoPath: string) => Promise<{
    repository: RepositoryFacade;
    refStore: RefStore;
  } | null>;
  /** Optional request policy */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";
  /** Largest request body accepted (see {@link HttpServerOptions.maxRequestBodyBytes}) */
  maxRequestBodyBytes?: number;
  /** Serve protocol v2 to `Git-Protocol: version=2` (see {@link HttpServerOptions.protocolV2}) */
  protocolV2?: boolean;
  /** Capabilities of the v2 advertisement (see {@link HttpServerOptions.v2Capabilities}) */
  v2Capabilities?: string[];
  /** receive-pack hooks, limits and ref policies (see {@link ReceivePackServerOptions}) */
  receivePack?: ReceivePackServerOptions;
  /** Optional logger */
  logger?: {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
}

/**
 * Creates an HTTP handler for Git smart protocol requests.
 *
 * This is the main entry point for handling Git HTTP requests.
 * It parses the request, resolves the repository, and routes
 * to the appropriate handler (info/refs or service).
 *
 * @param options - Handler options including repository resolver
 * @returns An async function that handles HTTP requests
 *
 * @example
 * ```ts
 * const handleGit = createHttpHandler({
 *   async resolveRepository(repoPath) {
 *     const repo = await openRepository(repoPath);
 *     if (!repo) return null;
 *     return { repository: repo.facade, refStore: repo.refs };
 *   },
 * });
 *
 * // In your HTTP server
 * const response = await handleGit(request);
 * ```
 */
export function createHttpHandler(
  options: HttpHandlerOptions,
): (request: HttpRequest) => Promise<HttpResponse> {
  const {
    resolveRepository,
    requestPolicy,
    maxRequestBodyBytes,
    protocolV2,
    v2Capabilities,
    receivePack,
    logger,
  } = options;

  return async (request: HttpRequest): Promise<HttpResponse> => {
    // Parse the Git request
    const parsed = parseGitRequest(request.path, request.query);

    if (!parsed) {
      logger?.info(`Invalid Git request: ${request.method} ${request.path}`);
      return {
        status: 400,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode("Invalid Git request"),
      };
    }

    const serverOptions: HttpServerOptions = {
      requestPolicy,
      maxRequestBodyBytes,
      protocolV2,
      v2Capabilities,
      receivePack,
      logger,
    };
    // git has no v2 push: receive-pack is v0 whatever the client asks
    const v2 = parsed.service === "git-upload-pack" && isProtocolV2Request(request, serverOptions);

    logger?.info(
      `Git ${parsed.service} request for ${parsed.repoPath} (info/refs: ${parsed.isInfoRefs}, protocol: ${v2 ? "v2" : "v0"})`,
    );

    // Resolve repository
    let resolved: { repository: RepositoryFacade; refStore: RefStore } | null;
    try {
      resolved = await resolveRepository(parsed.repoPath);
    } catch (err) {
      logger?.error(`Error resolving repository ${parsed.repoPath}`, err);
      return {
        status: 500,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode("Internal server error"),
      };
    }

    if (!resolved) {
      logger?.info(`Repository not found: ${parsed.repoPath}`);
      return {
        status: 404,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode("Repository not found"),
      };
    }

    const { repository, refStore } = resolved;
    // v0 upload-pack advertises (and accepts) only what it implements for this repository
    const uploadPackOptions: HttpServerOptions = {
      ...serverOptions,
      capabilities: defaultUploadPackCapabilities(requestPolicy ?? "ADVERTISED", repository),
    };

    try {
      if (parsed.isInfoRefs) {
        // Handle GET /info/refs
        if (request.method !== "GET") {
          return {
            status: 405,
            headers: { "Content-Type": "text/plain", Allow: "GET" },
            body: textEncoder.encode("Method not allowed"),
          };
        }

        if (v2) return handleInfoRefsV2(serverOptions);
        if (parsed.service === "git-upload-pack") {
          return await handleInfoRefs(refStore, uploadPackOptions, repository);
        } else {
          // git-receive-pack info/refs
          return await handleReceivePackInfoRefs(refStore, serverOptions);
        }
      } else {
        // Handle POST /git-upload-pack or /git-receive-pack
        if (request.method !== "POST") {
          return {
            status: 405,
            headers: { "Content-Type": "text/plain", Allow: "POST" },
            body: textEncoder.encode("Method not allowed"),
          };
        }

        if (v2) return await handleUploadPackV2(request, repository, refStore, serverOptions);
        if (parsed.service === "git-upload-pack") {
          return await handleUploadPack(request, repository, refStore, uploadPackOptions);
        } else {
          return await handleReceivePack(request, repository, refStore, serverOptions, {
            repoPath: parsed.repoPath,
          });
        }
      }
    } catch (err) {
      logger?.error(`Error handling ${parsed.service} request`, err);
      return {
        status: 500,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode(err instanceof Error ? err.message : "Internal server error"),
      };
    }
  };
}

/**
 * Options for creating a Git HTTP server.
 */
export interface GitHttpServerOptions {
  /** Resolve repository by path, returning facade and ref store */
  resolveRepository: (
    repoPath: string,
  ) => Promise<{ repository: RepositoryFacade; refStore: RefStore } | null>;
  /** Optional request policy */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";
  /** Largest request body accepted (see {@link HttpServerOptions.maxRequestBodyBytes}) */
  maxRequestBodyBytes?: number;
  /** Serve protocol v2 to `Git-Protocol: version=2` (see {@link HttpServerOptions.protocolV2}) */
  protocolV2?: boolean;
  /** Capabilities of the v2 advertisement (see {@link HttpServerOptions.v2Capabilities}) */
  v2Capabilities?: string[];
  /** receive-pack hooks, limits and ref policies (see {@link ReceivePackServerOptions}) */
  receivePack?: ReceivePackServerOptions;
  /** Optional logger */
  logger?: {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
}

/**
 * Git HTTP server interface.
 */
export interface GitHttpServer {
  /** Handle an HTTP request */
  handleRequest: (request: HttpRequest) => Promise<HttpResponse>;
  /** Stop the server */
  close: () => Promise<void>;
}

/**
 * Create a Git HTTP server that handles Git protocol requests.
 *
 * Wraps createHttpHandler into a server object with a handleRequest
 * method and a close lifecycle hook.
 *
 * @param options - Server options
 * @returns A Git HTTP server
 *
 * @example
 * ```ts
 * const server = createGitHttpServer({
 *   async resolveRepository(repoPath) {
 *     const repo = await openRepository(repoPath);
 *     if (!repo) return null;
 *     return { repository: repo.facade, refStore: repo.refs };
 *   },
 * });
 *
 * const response = await server.handleRequest(request);
 * ```
 */
export function createGitHttpServer(options: GitHttpServerOptions): GitHttpServer {
  const handler = createHttpHandler({
    resolveRepository: options.resolveRepository,
    requestPolicy: options.requestPolicy,
    maxRequestBodyBytes: options.maxRequestBodyBytes,
    protocolV2: options.protocolV2,
    v2Capabilities: options.v2Capabilities,
    receivePack: options.receivePack,
    logger: options.logger,
  });

  return {
    handleRequest: handler,
    async close(): Promise<void> {
      // No persistent resources to clean up for the HTTP handler
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch API Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a Fetch API Request to our HttpRequest format.
 *
 * @param request - Fetch API Request object
 * @returns HttpRequest suitable for createHttpHandler
 */
export function fetchRequestToHttpRequest(request: Request): HttpRequest {
  const url = new URL(request.url);

  // Parse query parameters
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Convert headers
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    method: request.method,
    path: url.pathname,
    query,
    headers,
    body: request.body ?? undefined,
  };
}

/**
 * Converts our HttpResponse to a Fetch API Response.
 *
 * @param response - Our HttpResponse object
 * @returns Fetch API Response object
 */
export function httpResponseToFetchResponse(response: HttpResponse): Response {
  if (response.body instanceof ReadableStream) {
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  // Create a new ArrayBuffer from the Uint8Array for Response constructor compatibility
  const buffer = new ArrayBuffer(response.body.length);
  const view = new Uint8Array(buffer);
  view.set(response.body);
  return new Response(buffer, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Creates a Fetch API compatible handler for Git HTTP requests.
 *
 * This adapter wraps createHttpHandler for use in environments that use
 * the Fetch API (Workers, Deno, Bun, etc.).
 *
 * @param options - Handler options including repository resolver
 * @returns An async function that handles Fetch API Request and returns Response
 *
 * @example Cloudflare Worker
 * ```ts
 * const handleGit = createFetchHandler({
 *   async resolveRepository(repoPath) {
 *     return { repository: myRepo, refStore: myRefStore };
 *   },
 * });
 *
 * export default {
 *   async fetch(request: Request) {
 *     return handleGit(request);
 *   },
 * };
 * ```
 *
 * @example Deno
 * ```ts
 * const handleGit = createFetchHandler({
 *   async resolveRepository(repoPath) {
 *     return { repository: myRepo, refStore: myRefStore };
 *   },
 * });
 *
 * Deno.serve((request) => handleGit(request));
 * ```
 *
 * @example Bun
 * ```ts
 * const handleGit = createFetchHandler({
 *   async resolveRepository(repoPath) {
 *     return { repository: myRepo, refStore: myRefStore };
 *   },
 * });
 *
 * Bun.serve({ fetch: handleGit });
 * ```
 */
export function createFetchHandler(
  options: HttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const httpHandler = createHttpHandler(options);

  return async (request: Request): Promise<Response> => {
    // Convert Fetch API Request to HttpRequest
    const httpRequest = fetchRequestToHttpRequest(request);

    // Handle with core handler
    const httpResponse = await httpHandler(httpRequest);

    // Convert HttpResponse to Fetch API Response
    return httpResponseToFetchResponse(httpResponse);
  };
}
