/**
 * HTTP Smart Protocol server handlers.
 *
 * Implements the Git Smart HTTP protocol:
 * - GET /info/refs?service=git-upload-pack - Ref advertisement
 * - POST /git-upload-pack - Pack negotiation and transfer
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
import { serverFetchHandlers, serverFetchTransitions } from "../../fsm/fetch/server-fetch-fsm.js";
import { Fsm } from "../../fsm/fsm.js";
import { serverPushHandlers, serverPushTransitions } from "../../fsm/push/server-push-fsm.js";
import { ZERO_OID } from "../../protocol/constants.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import { createSimpleDuplex, readableStreamToAsyncIterable } from "./http-duplex.js";

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
  /** Response body as Uint8Array */
  body: Uint8Array;
}

/**
 * Server options for HTTP handlers.
 */
export interface HttpServerOptions {
  /** Request policy for validating client wants */
  requestPolicy?: "ADVERTISED" | "REACHABLE_COMMIT" | "TIP" | "REACHABLE_COMMIT_TIP" | "ANY";
  /** Advertised capabilities */
  capabilities?: string[];
}

const textEncoder = new TextEncoder();

/**
 * Handles GET /info/refs?service=git-upload-pack
 *
 * Returns ref advertisement in smart HTTP format.
 *
 * @param refStore - Ref store for reading refs
 * @param options - Server options
 * @returns HTTP response
 */
export async function handleInfoRefs(
  refStore: RefStore,
  options: HttpServerOptions = {},
): Promise<HttpResponse> {
  // Get all refs
  const allRefs = await refStore.listAll();
  const refs = Array.from(allRefs);

  // Build ref advertisement
  const chunks: Uint8Array[] = [];

  // Service announcement line
  chunks.push(encodePacketLine("# service=git-upload-pack\n"));
  chunks.push(encodeFlush());

  // Default capabilities
  const capabilities = options.capabilities ?? [
    "multi_ack_detailed",
    "side-band-64k",
    "thin-pack",
    "no-progress",
    "include-tag",
    "ofs-delta",
    "shallow",
    "no-done",
  ];

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
      "Content-Type": "application/x-git-upload-pack-advertisement",
      "Cache-Control": "no-cache",
    },
    body,
  };
}

/**
 * Handles POST /git-upload-pack
 *
 * Runs the fetch negotiation and sends pack data.
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
  if (!request.body) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: textEncoder.encode("Missing request body"),
    };
  }

  const state = new ProtocolState();

  // Populate refs from refStore
  const allRefs = await refStore.listAll();
  for (const [refName, oid] of allRefs) {
    state.refs.set(refName, oid);
  }

  // Set up capabilities from info/refs response
  state.capabilities.add("multi_ack_detailed");
  state.capabilities.add("side-band-64k");
  state.capabilities.add("thin-pack");
  state.capabilities.add("no-progress");
  state.capabilities.add("include-tag");
  state.capabilities.add("ofs-delta");
  state.capabilities.add("shallow");
  state.capabilities.add("no-done");

  // Collect response data
  const responseChunks: Uint8Array[] = [];
  const writer = (data: Uint8Array) => responseChunks.push(data);

  // Create duplex from request body and response writer
  const input = readableStreamToAsyncIterable(request.body);
  const duplex = createSimpleDuplex(input, writer);
  const transport = createTransportApi(duplex, state);

  const config: ProcessConfiguration = {
    requestPolicy: options.requestPolicy ?? "ADVERTISED",
    maxEmptyBatches: 10,
  };

  const ctx: ProcessContext = {
    transport,
    repository,
    refStore,
    state,
    output: new HandlerOutput(),
    config,
  };

  // Run server FSM starting from READ_WANTS state
  // (ref advertisement was already sent in GET /info/refs)
  const fsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
  fsm.setState("READ_WANTS");

  try {
    await fsm.run(ctx);

    if (ctx.output.error) {
      return {
        status: 500,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode(ctx.output.error),
      };
    }

    // Concatenate response chunks
    const totalLength = responseChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of responseChunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
      body,
    };
  } catch (error) {
    return {
      status: 500,
      headers: { "Content-Type": "text/plain" },
      body: textEncoder.encode(error instanceof Error ? error.message : String(error)),
    };
  }
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
  const capabilities = options.capabilities ?? [
    "report-status",
    "report-status-v2",
    "delete-refs",
    "side-band-64k",
    "quiet",
    "atomic",
    "ofs-delta",
    "push-options",
  ];

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
      "Cache-Control": "no-cache",
    },
    body,
  };
}

/**
 * Handles POST /git-receive-pack
 *
 * Runs the push operation to receive pack data and update refs.
 *
 * @param request - HTTP request with body
 * @param repository - Repository facade for pack import
 * @param refStore - Ref store for reading/writing refs
 * @param options - Server options
 * @returns HTTP response
 */
export async function handleReceivePack(
  request: HttpRequest,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpServerOptions = {},
): Promise<HttpResponse> {
  if (!request.body) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: textEncoder.encode("Missing request body"),
    };
  }

  const state = new ProtocolState();

  // Populate refs from refStore
  const allRefs = await refStore.listAll();
  for (const [refName, oid] of allRefs) {
    state.refs.set(refName, oid);
  }

  // NOTE: Do NOT pre-populate state.capabilities here.
  // The client's negotiated capabilities will be parsed from the first
  // command line by the READ_COMMANDS FSM handler. Pre-populating would
  // cause the FSM to assume capabilities the client didn't negotiate
  // (e.g., push-options would make the FSM try to read push option
  // pkt-lines even when the client sends raw pack data instead).

  // Collect response data
  const responseChunks: Uint8Array[] = [];
  const writer = (data: Uint8Array) => responseChunks.push(data);

  // Create duplex from request body and response writer
  const input = readableStreamToAsyncIterable(request.body);
  const duplex = createSimpleDuplex(input, writer);
  const transport = createTransportApi(duplex, state);

  const config: ProcessConfiguration = {
    requestPolicy: options.requestPolicy ?? "ADVERTISED",
    maxEmptyBatches: 10,
    allowDeletes: true,
    allowNonFastForward: false,
  };

  const ctx: AdapterProcessContext = {};
  setTransport(ctx, transport);
  setRepository(ctx, repository);
  setRefStore(ctx, refStore);
  setState(ctx, state);
  setOutput(ctx, new HandlerOutput());
  setConfig(ctx, config);

  // Run server push FSM starting from READ_COMMANDS state
  // (ref advertisement was already sent in GET /info/refs)
  const fsm = new Fsm(serverPushTransitions, serverPushHandlers);
  fsm.setState("READ_COMMANDS");

  try {
    await fsm.run(ctx);

    // Only return 500 if the FSM errored without producing a proper
    // protocol response (e.g., it never reached SEND_STATUS).
    // When SEND_STATUS runs, responseChunks will contain pkt-line data
    // even if earlier stages (like UNPACK) set output.error.
    const output = getOutput(ctx);
    if (output.error && responseChunks.length === 0) {
      return {
        status: 500,
        headers: { "Content-Type": "text/plain" },
        body: textEncoder.encode(output.error),
      };
    }

    // Concatenate response chunks
    const totalLength = responseChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of responseChunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-receive-pack-result",
        "Cache-Control": "no-cache",
      },
      body,
    };
  } catch (error) {
    return {
      status: 500,
      headers: { "Content-Type": "text/plain" },
      body: textEncoder.encode(error instanceof Error ? error.message : String(error)),
    };
  }
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
  const { resolveRepository, requestPolicy, logger } = options;

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

    logger?.info(
      `Git ${parsed.service} request for ${parsed.repoPath} (info/refs: ${parsed.isInfoRefs})`,
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
    const serverOptions: HttpServerOptions = { requestPolicy };

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

        if (parsed.service === "git-upload-pack") {
          return await handleInfoRefs(refStore, serverOptions);
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

        if (parsed.service === "git-upload-pack") {
          return await handleUploadPack(request, repository, refStore, serverOptions);
        } else {
          return await handleReceivePack(request, repository, refStore, serverOptions);
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
