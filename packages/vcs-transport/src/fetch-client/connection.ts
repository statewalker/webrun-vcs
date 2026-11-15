/**
 * The I/O of a fetch: how requests reach upload-pack and its answers come back.
 *
 * One fetch implementation ({@link fetchPack}, {@link fetchFromConnection}) runs over two
 * adapters: smart HTTP (stateless, one POST per negotiation round, as git's remote-curl) and
 * a duplex (stateful, one stream for the whole exchange, as git's fetch-pack over ssh or
 * git://). Either speaks protocol v2 when the server does, protocol v0 otherwise.
 */

import type { Credentials } from "../api/credentials.js";
import type { Duplex } from "../api/duplex.js";
import { authorizationHeader } from "../operations/http-auth.js";
import { ServerError, TransportError } from "../protocol/index.js";
import { type Pkt, PktStream } from "./pkt-stream.js";

/** A ref as the server lists it (ls-refs, or the v0 advertisement). */
export interface RemoteRef {
  name: string;
  /** Its object id; undefined for an unborn HEAD (an empty repository) */
  oid?: string;
  /** For a symbolic ref (HEAD): the ref it points at */
  symref?: string;
  /** For an annotated tag: the object it peels to */
  peeled?: string;
}

/** A connection to upload-pack, after the server's first answer (capabilities, or refs). */
export interface UploadPackConnection {
  /** The protocol the server speaks: 2, or 0 (v0/v1 alike) */
  readonly version: 0 | 2;
  /**
   * Whether each request is answered on its own (smart HTTP): the server keeps no state
   * between negotiation rounds, so each round repeats the wants and the common commits.
   */
  readonly stateless: boolean;
  /**
   * Server capabilities, name to value ("" for none). v0: the advertisement's (several
   * `symref=` collapse; see `refs`). v2: the capability lines (`fetch` → "shallow filter …").
   */
  readonly capabilities: ReadonlyMap<string, string>;
  /** v0: the advertised refs (HEAD with its symref). v2 lists refs with `ls-refs` instead. */
  readonly advertisedRefs?: readonly RemoteRef[];
  /** Sends one request and returns the stream its answer is read from. */
  request(body: Uint8Array[]): Promise<PktStream>;
  /** Ends the exchange (v2 over a duplex: a final flush), releasing the stream. */
  close(): Promise<void>;
}

/** Options of {@link openHttpConnection}. */
export interface HttpConnectionOptions {
  /** Repository URL (`…/repo.git`) */
  url: string;
  auth?: Credentials;
  headers?: Record<string, string>;
  /** Bounds each wait for the server (a response, the next chunk of a body), in milliseconds */
  timeout?: number;
  /** Defaults to `globalThis.fetch` */
  fetchImpl?: (request: Request) => Promise<Response>;
  /** 2 (default): ask for protocol v2 and fall back to v0 when the server answers v0. 0: v0 only. */
  protocolVersion?: 0 | 2;
  /** Aborts every request of the connection */
  signal?: AbortSignal;
}

/**
 * Opens a smart-HTTP connection to `git-upload-pack`: `GET info/refs` with
 * `Git-Protocol: version=2`. A v2 server answers with its capabilities; any other answers
 * with the v0 ref advertisement, and the connection speaks v0.
 */
export async function openHttpConnection(
  options: HttpConnectionOptions,
): Promise<UploadPackConnection> {
  const baseUrl = options.url.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const wantV2 = (options.protocolVersion ?? 2) === 2;
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth) headers.Authorization = authorizationHeader(options.auth);

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const wait = <T>(next: () => Promise<T>): Promise<T> =>
    withTimeout(next, options.timeout, controller);

  const response = await wait(() =>
    doFetch(
      new Request(`${baseUrl}/info/refs?service=git-upload-pack`, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "application/x-git-upload-pack-advertisement",
          ...(wantV2 ? { "Git-Protocol": "version=2" } : {}),
        },
        signal: controller.signal,
      }),
    ),
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TransportError(`Failed to get refs: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new TransportError("Empty response from info/refs");
  const advert = new PktStream(response.body, wait);
  let first = await advert.read();
  if (first?.type === "data" && first.text.startsWith("# service=")) {
    const flush = await advert.read();
    if (flush?.type !== "flush") throw new TransportError("No flush after the service line");
    first = await advert.read();
  }
  const greeting = await readServerGreeting(advert, first);
  await advert.cancel();

  let current: PktStream | undefined;
  return {
    version: greeting.version,
    stateless: true,
    capabilities: greeting.capabilities,
    advertisedRefs: greeting.refs,
    async request(body) {
      await current?.cancel();
      const payload = await gzipLargeBody(concat(body));
      const res = await wait(() =>
        doFetch(
          new Request(`${baseUrl}/git-upload-pack`, {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/x-git-upload-pack-request",
              Accept: "application/x-git-upload-pack-result",
              ...(greeting.version === 2 ? { "Git-Protocol": "version=2" } : {}),
              ...(payload.gzip ? { "Content-Encoding": "gzip" } : {}),
            },
            body: payload.bytes,
            signal: controller.signal,
          }),
        ),
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new TransportError(`Failed to upload-pack: ${res.status} ${res.statusText}`);
      }
      if (!res.body) throw new TransportError("Empty response from git-upload-pack");
      current = new PktStream(res.body, wait);
      return current;
    },
    async close() {
      await current?.cancel();
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Options of {@link openDuplexConnection}. */
export interface DuplexConnectionOptions {
  /** Whether {@link UploadPackConnection.close} also closes the duplex (default false: the caller owns it) */
  closeDuplex?: boolean;
}

/**
 * Opens a stateful connection over a duplex whose other end runs upload-pack (our
 * `serveOverDuplex`, a spawned `git upload-pack`): the server speaks first, with its v2
 * capabilities (`version 2`) or its v0 ref advertisement, and the connection follows.
 */
export async function openDuplexConnection(
  duplex: Duplex,
  options: DuplexConnectionOptions = {},
): Promise<UploadPackConnection> {
  const pkts = new PktStream(duplex);
  const greeting = await readServerGreeting(pkts, await pkts.read());
  let closed = false;
  let requested = false;
  return {
    version: greeting.version,
    stateless: false,
    capabilities: greeting.capabilities,
    advertisedRefs: greeting.refs,
    async request(body) {
      requested = true;
      for (const chunk of body) await duplex.write(chunk);
      return pkts;
    },
    async close() {
      if (closed) return;
      closed = true;
      // A flush ends the session, as git's fetch-pack sends it: v2, after the last command;
      // v0, when nothing was wanted (upload-pack still waits for wants after its
      // advertisement). A v0 exchange that got its pack is over already.
      if (greeting.version === 2 || !requested) {
        try {
          await duplex.write(new TextEncoder().encode("0000"));
        } catch {
          // the other end is gone already
        }
      }
      if (options.closeDuplex) await duplex.close?.();
    },
  };
}

/** A server's first answer: its protocol, capabilities and (v0) refs. */
export interface ServerGreeting {
  version: 0 | 2;
  capabilities: Map<string, string>;
  /** v0: the advertised refs (HEAD with its symref; `.have` lines as refs named `.have`) */
  refs?: RemoteRef[];
}

/**
 * The server's first answer: v2 capabilities, or a v0 advertisement (`first` is its first
 * packet). upload-pack and receive-pack advertise alike.
 */
export async function readServerGreeting(
  pkts: PktStream,
  first: Pkt | undefined,
): Promise<ServerGreeting> {
  if (!first) throw new TransportError("The server closed the connection without an answer");
  if (first.type === "data" && first.text.startsWith("ERR ")) {
    throw new ServerError(first.text.slice(4));
  }
  if (first.type === "data" && first.text === "version 2") {
    const capabilities = new Map<string, string>();
    for (let line = await pkts.readLine(); line !== undefined; line = await pkts.readLine()) {
      const eq = line.indexOf("=");
      capabilities.set(eq < 0 ? line : line.slice(0, eq), eq < 0 ? "" : line.slice(eq + 1));
    }
    return { version: 2, capabilities };
  }
  // v0 (or "version 1" first)
  const capabilities = new Map<string, string>();
  const symrefs = new Map<string, string>();
  const refs: RemoteRef[] = [];
  const byName = new Map<string, RemoteRef>();
  let pkt: Pkt | undefined = first;
  if (pkt.type === "data" && pkt.text === "version 1") pkt = await pkts.read();
  let firstLine = true;
  while (pkt && pkt.type !== "flush") {
    if (pkt.type !== "data")
      throw new TransportError(`Unexpected ${pkt.type} in the advertisement`);
    let line = pkt.text;
    if (line.startsWith("ERR ")) throw new ServerError(line.slice(4));
    if (firstLine) {
      firstLine = false;
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(" ")) {
          if (!cap) continue;
          const eq = cap.indexOf("=");
          const name = eq < 0 ? cap : cap.slice(0, eq);
          const value = eq < 0 ? "" : cap.slice(eq + 1);
          if (name === "symref") {
            const colon = value.indexOf(":");
            if (colon > 0) symrefs.set(value.slice(0, colon), value.slice(colon + 1));
          }
          capabilities.set(name, value);
        }
        line = line.slice(0, nul);
      }
    }
    const space = line.indexOf(" ");
    if (space === 40) {
      const oid = line.slice(0, 40);
      const name = line.slice(41);
      if (name.endsWith("^{}")) {
        const tag = byName.get(name.slice(0, -3));
        if (tag) tag.peeled = oid;
      } else if (name !== "capabilities^{}") {
        const ref: RemoteRef = { name, oid };
        refs.push(ref);
        byName.set(name, ref);
      }
    }
    pkt = await pkts.read();
  }
  if (!pkt) throw new TransportError("The advertisement ended without a flush");
  for (const [name, target] of symrefs) {
    const ref = byName.get(name);
    if (ref) ref.symref = target;
  }
  return { version: 0, capabilities, refs };
}

/**
 * Runs `next`, failing with "Request timeout" (and aborting `controller`) when it takes more
 * than `timeout` milliseconds; no bound without `timeout`.
 */
export async function withTimeout<T>(
  next: () => Promise<T>,
  timeout: number | undefined,
  controller: AbortController,
): Promise<T> {
  if (!timeout) return next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  // rejects on its own as well as aborting: a fetchImpl or body that ignores the signal
  // would otherwise leave a stalled server waited on forever
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new TransportError("Request timeout"));
      controller.abort();
    }, timeout);
  });
  try {
    return await Promise.race([next(), timedOut]);
  } catch (error) {
    // the abort may fail the request before the timer's rejection is seen
    if (expired) throw new TransportError("Request timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Request bodies above this many bytes are sent gzipped (git's remote-curl: over 1024). */
export const GZIP_REQUEST_MIN_BYTES = 1024;

/**
 * A request body as git's remote-curl sends it: gzipped (`Content-Encoding: gzip`) when longer
 * than {@link GZIP_REQUEST_MIN_BYTES} (a large have-batch) and the platform has
 * `CompressionStream`; otherwise as it is.
 */
async function gzipLargeBody(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; gzip: boolean }> {
  if (bytes.length <= GZIP_REQUEST_MIN_BYTES || typeof CompressionStream === "undefined") {
    return { bytes, gzip: false };
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gzip: true };
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
