/**
 * Streaming request bodies (fetch's `duplex: "half"`): a push sends its pack as it is written,
 * where the runtime can. Node (undici), Deno and Bun stream a `ReadableStream` body over any
 * HTTP version, so outside browsers a push streams by default.
 *
 * Browsers collect the body first unless `streamRequestBody: true` is set: Firefox and Safari
 * do not support streaming request bodies, and Chromium passes the feature test below but
 * rejects a streamed body with a `TypeError` when the connection is HTTP/1.1 (it streams only
 * over HTTP/2 and later), which a page cannot tell in advance. When streaming was chosen and
 * `fetch` rejects with a `TypeError` before any response arrives, `fetchWithRequestBody` sends
 * the request once more with a collected body, produced again from the start.
 */

let detected: boolean | undefined;

/**
 * Whether `fetch` here sends a `ReadableStream` request body as it is produced. The usual
 * feature test: a runtime that streams bodies reads the `duplex` option of a `Request` built
 * with a stream body; one that does not ignores it and turns the stream into the text
 * "[object ReadableStream]", adding a `text/plain` content type.
 */
export function supportsRequestStreams(): boolean {
  if (detected !== undefined) return detected;
  let duplexAccessed = false;
  try {
    const init = {
      body: new ReadableStream(),
      method: "POST",
      get duplex() {
        duplexAccessed = true;
        return "half";
      },
    };
    const hasContentType = new Request("http://localhost/", init as RequestInit).headers.has(
      "Content-Type",
    );
    detected = duplexAccessed && !hasContentType;
  } catch {
    detected = false;
  }
  return detected;
}

/**
 * Whether this code runs in a browser: a window (a `document`) or a web worker (a
 * `WorkerGlobalScope`, which only workers define; `self instanceof WorkerGlobalScope` holds in
 * dedicated, shared and service workers). Node, Deno and Bun define neither.
 */
export function isBrowserContext(g: object = globalThis): boolean {
  const scope = g as { document?: unknown; WorkerGlobalScope?: unknown };
  if (typeof scope.document === "object" && scope.document !== null) return true;
  const workerScope = scope.WorkerGlobalScope;
  return typeof workerScope === "function" && g instanceof (workerScope as new () => object);
}

/**
 * Whether to stream a request body: `explicit` when it is set (`streamRequestBody`), otherwise
 * only outside browsers and where the runtime streams request bodies (see the module comment
 * for why browsers collect by default).
 */
export function shouldStreamRequestBody(
  explicit?: boolean,
  env: { browser: boolean; supported: boolean } = {
    browser: isBrowserContext(),
    supported: supportsRequestStreams(),
  },
): boolean {
  if (explicit !== undefined) return explicit;
  return !env.browser && env.supported;
}

/**
 * Sends a request whose body is `makeChunks()`: streamed when `stream`, else collected. A
 * streamed request that `send` rejects with a `TypeError` (Chromium refusing a streamed body
 * over HTTP/1.1, before any response) is sent once more with a body collected from a fresh
 * `makeChunks()`, unless the body's own source failed (that error is thrown as it is).
 *
 * @example
 * ```typescript
 * const response = await fetchWithRequestBody(
 *   () => packChunks(),
 *   (init) => fetch(url, { method: "POST", headers, ...init }),
 *   shouldStreamRequestBody(options.streamRequestBody),
 * );
 * ```
 */
export async function fetchWithRequestBody(
  makeChunks: () => AsyncIterable<Uint8Array>,
  send: (init: { body: BodyInit; duplex?: "half" }) => Promise<Response>,
  stream: boolean,
): Promise<Response> {
  if (!stream) return send(await requestBody(makeChunks(), false));
  let sourceError: { error: unknown } | undefined;
  async function* watched(): AsyncGenerator<Uint8Array> {
    try {
      yield* makeChunks();
    } catch (error) {
      sourceError = { error };
      throw error;
    }
  }
  try {
    return await send(await requestBody(watched(), true));
  } catch (error) {
    if (sourceError) throw sourceError.error;
    if (!(error instanceof TypeError)) throw error;
    return send(await requestBody(makeChunks(), false));
  }
}

/** A pull-driven stream over `chunks`: the next chunk is produced only when the request reads it. */
export function toReadableStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const r = await it.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      },
      async cancel(reason) {
        await it.return?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The `body` (and `duplex`) of a request sending `chunks`: streamed when `stream` (default:
 * `shouldStreamRequestBody()`, that is outside browsers where supported), otherwise collected
 * into one buffer.
 *
 * @example
 * ```typescript
 * const init = await requestBody(packChunks());
 * const response = await fetch(url, { method: "POST", headers, ...init });
 * ```
 */
export async function requestBody(
  chunks: AsyncIterable<Uint8Array>,
  stream = shouldStreamRequestBody(),
): Promise<{ body: BodyInit; duplex?: "half" }> {
  if (stream) return { body: toReadableStream(chunks), duplex: "half" };
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const c of chunks) {
    parts.push(c);
    length += c.length;
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  return { body };
}
