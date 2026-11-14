/**
 * Streaming request bodies (fetch's `duplex: "half"`): a push sends its pack as it is written,
 * where the runtime can. Chromium, Node (undici), Deno and Bun stream a `ReadableStream` body;
 * Firefox and Safari do not support streaming request bodies, so there the body is collected
 * first and sent whole.
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
 * The `body` (and `duplex`) of a request sending `chunks`: streamed where `supportsRequestStreams()`,
 * otherwise collected into one buffer (Firefox, Safari).
 *
 * @example
 * ```typescript
 * const init = await requestBody(packChunks());
 * const response = await fetch(url, { method: "POST", headers, ...init });
 * ```
 */
export async function requestBody(
  chunks: AsyncIterable<Uint8Array>,
  stream = supportsRequestStreams(),
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
