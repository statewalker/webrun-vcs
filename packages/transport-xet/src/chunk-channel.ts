/**
 * The one integration subtlety: bridging `content-transfer`'s webrun
 * {@link Duplex} onto the LFS/HTTP surface.
 *
 * `content-transfer` speaks a `Duplex = (input) => AsyncGenerator<Uint8Array>`
 * where one call carries exactly one request→response (see its `protocol.ts`:
 * the client emits a complete framed request, the server reads it whole and
 * replies). That is precisely one HTTP `POST`: request body = the outgoing
 * frame, response body = the reply frame. Because each op is a self-delimiting,
 * request-complete-then-response exchange, we buffer per call (one small frame,
 * at most a single chunk's bytes) — no streaming request body needed, which
 * keeps the loopback (handler-as-fetch) path robust in-process.
 *
 * The real-HTTP binding is the SAME pair over `@statewalker/webrun-http-streams`
 * (`serveFetchOverDuplex` / `fetchOverDuplex`); here both ends are expressed
 * directly so a test can pass a `serveXet` handler as the client `fetchImpl`.
 */

import type { ByteStream } from "@statewalker/content-store";
import type { FetchLike } from "@statewalker/vcs-transport-lfs";
import type { Duplex } from "@statewalker/webrun-streams";

/** Collect a byte stream into one contiguous `ArrayBuffer`-backed buffer (a
 * valid `BodyInit`) — one small protocol frame per call. */
async function collect(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for await (const chunk of input as AsyncIterable<Uint8Array>) parts.push(chunk);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function* one(bytes: Uint8Array): ByteStream {
  if (bytes.byteLength) yield bytes;
}

/**
 * CLIENT: a {@link Duplex} that carries each content-transfer call as one HTTP
 * `POST <href>` through `fetchImpl`. Pass it to `content-transfer.remoteStore`.
 */
export function httpChunkChannel(fetchImpl: FetchLike, href: string): Duplex {
  return (input) =>
    (async function* (): AsyncGenerator<Uint8Array> {
      const body = await collect(input);
      const res = await fetchImpl(new Request(href, { method: "POST", body }));
      const reply = new Uint8Array(await res.arrayBuffer());
      yield* one(reply);
    })();
}

/**
 * SERVER: run one `POST` body through a content-transfer {@link Duplex}
 * (`serveStore(...)`) and return its reply as the response body.
 */
export async function serveChunkChannel(duplex: Duplex, request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const reply = await collect(duplex(one(body)));
  return new Response(reply, { status: 200 });
}
