/**
 * The I/O of a push: how the request reaches receive-pack and its report comes back.
 *
 * One push implementation ({@link pushToConnection}) runs over two adapters: smart HTTP
 * (`GET info/refs?service=git-receive-pack`, then one `POST git-receive-pack` carrying the
 * commands and the pack, as git's remote-curl) and a duplex (one stream for the whole
 * exchange, as git's send-pack over ssh or git://). receive-pack speaks protocol v0 only.
 */

import { fetchWithRequestBody, shouldStreamRequestBody } from "@statewalker/vcs-utils/streams";
import type { Credentials } from "../api/credentials.js";
import { type Duplex, endDuplex } from "../api/duplex.js";
import { looksLikeInfoRefs } from "../fetch-client/dumb-http.js";
import { anonymizeUrl } from "../fetch-client/fetch-head.js";
// the idle timer is internal to the clients: not exported from the package
import { abortErrorOf, IdleTimer } from "../fetch-client/idle-timer.js";
import { PktStream, type RemoteRef, readServerGreeting } from "../fetch-client/index.js";
import {
  type HttpClientSettings,
  type HttpCredentialHelper,
  SmartHttpClient,
} from "../http-client/index.js";
import { AuthenticationError, TransportError } from "../protocol/index.js";

/** A connection to receive-pack, after its ref advertisement. */
export interface ReceivePackConnection {
  /** Whether the request goes out as one HTTP request (smart HTTP) */
  readonly stateless: boolean;
  /** The advertised capabilities, name to value ("" for none) */
  readonly capabilities: ReadonlyMap<string, string>;
  /** The advertised refs (`.have` lines and `capabilities^{}` left out) */
  readonly advertisedRefs: readonly RemoteRef[];
  /**
   * Objects the server has without a ref to them (`.have` lines: the refs of its alternates).
   * A push treats them as remote tips, the pack's edges.
   */
  readonly extraHaves: readonly string[];
  /**
   * Sends the request (commands, push options, pack) as `body()` produces it, and returns the
   * stream the answer is read from. Called at most once. `body` may be called twice over smart
   * HTTP: a streamed request a browser refuses is sent again with a collected body.
   */
  send(body: () => AsyncIterable<Uint8Array>): Promise<PktStream>;
  /**
   * Ends the exchange. A duplex connection that sent nothing writes the flush that tells
   * receive-pack there is nothing to update, as git's send-pack does.
   */
  close(): Promise<void>;
}

/** Options of {@link openHttpReceivePackConnection}. */
export interface HttpReceivePackOptions {
  /** Repository URL (`…/repo.git`) */
  url: string;
  auth?: Credentials;
  headers?: Record<string, string>;
  /**
   * 1: ask for protocol v1 (`Git-Protocol: version=1` on every request, as git's remote-curl
   * sends for `protocol.version=1`; the server's `version 1` line is accepted). Default 0.
   */
  protocolVersion?: 0 | 1;
  /**
   * Bounds each wait for the server, in milliseconds: the advertisement, the time the server
   * takes to read each chunk of the request, the report's next chunk (receive-pack's side-band
   * keep-alives count as chunks). Not the whole push.
   */
  timeout?: number;
  /** Defaults to `globalThis.fetch` (read when the connection opens) */
  fetchImpl?: (request: Request) => Promise<Response>;
  /**
   * Stream the request body (`duplex: "half"`), so the pack is sent as it is written and never
   * held whole in memory. Default: outside browsers, where the runtime supports it (Node's
   * undici, Deno, Bun); browsers collect the body first, since Chromium streams request bodies
   * only over HTTP/2 and Firefox and Safari not at all (a streamed request a browser refuses is
   * sent again with a collected body). `false` collects the body first, so the request has a
   * `Content-Length`: for servers or proxies that refuse chunked requests.
   */
  streamRequestBody?: boolean;
  /** Aborts every request of the connection */
  signal?: AbortSignal;
  /** git's `http.*` settings for the URL (extra headers, user agent, redirects, retries) */
  http?: HttpClientSettings;
  /** Asked for credentials after a 401, told whether they worked */
  credentialHelper?: HttpCredentialHelper;
}

/**
 * Opens a smart-HTTP connection to `git-receive-pack`: `GET info/refs?service=git-receive-pack`
 * and its ref advertisement. A 401 or 403 is an {@link AuthenticationError}.
 */
export async function openHttpReceivePackConnection(
  options: HttpReceivePackOptions,
): Promise<ReceivePackConnection> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = {};
  if (options.protocolVersion === 1) headers["Git-Protocol"] = "version=1";

  const { signal } = options;
  if (signal?.aborted) throw abortError(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const idle = new IdleTimer(options.timeout, () => controller.abort(), signal, "Push aborted");
  const wait = <T>(next: () => Promise<T>): Promise<T> => idle.wait(next);
  try {
    const client = new SmartHttpClient({
      url: options.url,
      fetchImpl: doFetch,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.http ? { settings: options.http } : {}),
      ...(options.credentialHelper ? { credentialHelper: options.credentialHelper } : {}),
      signal: controller.signal,
    });
    return await openHttp(options, client, headers, idle, wait, () =>
      signal?.removeEventListener("abort", onAbort),
    );
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }
}

async function openHttp(
  options: HttpReceivePackOptions,
  client: SmartHttpClient,
  headers: Record<string, string>,
  idle: IdleTimer,
  wait: <T>(next: () => Promise<T>) => Promise<T>,
  release: () => void,
): Promise<ReceivePackConnection> {
  const response = await client.discover(
    "git-receive-pack",
    { ...headers, Accept: "application/x-git-receive-pack-advertisement" },
    wait,
  );
  if (!response.body) throw new TransportError("Empty response from info/refs");
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  let advertBody: ReadableStream<Uint8Array> = response.body;
  if (type !== "application/x-git-receive-pack-advertisement") {
    const body = new Uint8Array(await wait(() => response.arrayBuffer()));
    if (looksLikeInfoRefs(body)) {
      // a dumb server: git would push with http-push over WebDAV, which is not implemented
      throw new TransportError(
        `fatal: ${anonymizeUrl(client.base)}/: not a smart-HTTP git server (a dumb one: pushing over WebDAV, git's http-push, is not supported)`,
      );
    }
    advertBody = new Response(body).body as ReadableStream<Uint8Array>;
  }
  const advert = new PktStream(advertBody, wait);
  let first = await advert.read();
  if (first?.type === "data" && first.text.startsWith("# service=")) {
    if (first.text !== "# service=git-receive-pack") {
      throw new TransportError(`Unexpected service line: ${first.text}`);
    }
    const flush = await advert.read();
    if (flush?.type !== "flush") throw new TransportError("No flush after the service line");
    first = await advert.read();
  } else {
    // git: a server that does not announce the service is not a smart-HTTP server
    throw new TransportError(`${client.base}: not a smart-HTTP git server (no service line)`);
  }
  const greeting = await readServerGreeting(advert, first);
  await advert.cancel();
  const { refs, extraHaves } = splitAdvertisement(greeting.refs ?? []);

  let answer: PktStream | undefined;
  return {
    stateless: true,
    capabilities: greeting.capabilities,
    advertisedRefs: refs,
    extraHaves,
    async send(body) {
      if (answer) throw new Error("A push connection sends one request");
      // the idle timer times the server only: it is paused while the pack is produced here
      // (listing objects, the delta search) and re-armed each time a chunk waits for the
      // request to take it, and once the body is sent; a large pack is not bounded as a
      // whole, a server that stops reading or answering is
      const watched = () => idle.serverPaced(body());
      // a 401 asks the helper and sends the pack again, produced anew (post_rpc's retry)
      const res = await client.postAuthorized(() =>
        wait(() =>
          fetchWithRequestBody(
            watched,
            (init) =>
              client.post(
                "git-receive-pack",
                {
                  ...headers,
                  "Content-Type": "application/x-git-receive-pack-request",
                  Accept: "application/x-git-receive-pack-result",
                },
                init,
                (next) => next(),
              ),
            shouldStreamRequestBody(options.streamRequestBody),
          ),
        ),
      );
      await checkResponse(res, "Failed to receive-pack");
      if (!res.body) throw new TransportError("Empty response from git-receive-pack");
      answer = new PktStream(res.body, wait);
      return answer;
    },
    async close() {
      await answer?.cancel();
      release();
    },
  };
}

/** Options of {@link openDuplexReceivePackConnection}. */
export interface DuplexReceivePackOptions {
  /** Whether {@link ReceivePackConnection.close} also closes the duplex (default false) */
  closeDuplex?: boolean;
  /**
   * Bounds each wait for the server, in milliseconds (its advertisement, a write it does not
   * take, the report's next chunk), not the time the pack takes to produce here; on expiry the
   * duplex is closed
   */
  timeout?: number;
  /** Aborts the push: the pending wait fails (the duplex is closed with `closeDuplex`) */
  signal?: AbortSignal;
}

/**
 * Opens a connection over a duplex whose other end runs receive-pack (our `serveOverDuplex`, a
 * spawned `git receive-pack`): the server speaks first, with its ref advertisement.
 *
 * The request is written before the answer is read, as git's send-pack does without
 * side-band: a transport whose `write` waits for the other end to read (backpressure) must
 * not depend on the server reading while it answers.
 */
export async function openDuplexReceivePackConnection(
  duplex: Duplex,
  options: DuplexReceivePackOptions = {},
): Promise<ReceivePackConnection> {
  const { signal } = options;
  if (signal?.aborted) throw abortError(signal);
  const idle = new IdleTimer(
    options.timeout,
    () => {
      void duplex.close?.();
    },
    signal,
    "Push aborted",
  );
  const wait = <T>(next: () => Promise<T>): Promise<T> => idle.wait(next);
  const onAbort = () => {
    if (options.closeDuplex) void duplex.close?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const release = () => signal?.removeEventListener("abort", onAbort);
  const pkts = new PktStream(duplex, wait);
  let greeting: Awaited<ReturnType<typeof readServerGreeting>>;
  try {
    greeting = await readServerGreeting(pkts, await pkts.read());
  } catch (error) {
    release();
    throw error;
  }
  if (greeting.version !== 0) {
    throw new TransportError("receive-pack answered with protocol v2, which has no push");
  }
  const { refs, extraHaves } = splitAdvertisement(greeting.refs ?? []);
  let sent = false;
  let closed = false;
  return {
    stateless: false,
    capabilities: greeting.capabilities,
    advertisedRefs: refs,
    extraHaves,
    async send(body) {
      if (sent) throw new Error("A push connection sends one request");
      sent = true;
      for await (const chunk of idle.serverPaced(body())) {
        await wait(async () => duplex.write(chunk));
      }
      // the request is complete: git's send-pack closes its end once the pack is written
      // (pack-objects owns the descriptor), so receive-pack sees the end of its input
      await endDuplex(duplex);
      return pkts;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!sent) {
        try {
          await duplex.write(new TextEncoder().encode("0000"));
        } catch {
          // the other end is gone already
        }
        await endDuplex(duplex);
      }
      release();
      if (options.closeDuplex) await duplex.close?.();
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return abortErrorOf(signal, "Push aborted");
}

/** The advertised refs without `.have` lines, and the `.have` object ids. */
function splitAdvertisement(all: readonly RemoteRef[]): {
  refs: RemoteRef[];
  extraHaves: string[];
} {
  const refs: RemoteRef[] = [];
  const extraHaves: string[] = [];
  for (const ref of all) {
    if (ref.name === ".have") {
      if (ref.oid) extraHaves.push(ref.oid);
    } else {
      refs.push(ref);
    }
  }
  return { refs, extraHaves };
}

async function checkResponse(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  const status = `${response.status} ${response.statusText}`.trim();
  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(`${what}: ${status}`);
  }
  throw new TransportError(`${what}: ${status}`);
}
