/**
 * webrun-streams git service dispatch.
 *
 * Migrated off the retired `@statewalker/vcs-port-livekit` MessagePort path.
 * The old demo multiplexed two git services (upload-pack for fetch, receive-pack
 * for push) over ONE MessagePort with a 1-byte service handshake, then ran
 * `fetchOverDuplex`/`serveOverDuplex` on top. The new path multiplexes logical
 * calls over a webrun `emulateMux` and bridges each to the git transport with
 * `webrunClientDuplex` / `serveRepoOverWebrun`.
 *
 * `serveRepoOverWebrun` serves a FIXED service, but a P2P peer must serve BOTH
 * (the remote can fetch *and* push against us). So this module keeps the old
 * 1-byte service marker, now sent as the first chunk of each mux stream: the
 * client prefixes it (`gitClientDuplex`), the server reads it and dispatches to
 * the right service (`serveGitDispatch`).
 */

import type {
  Duplex,
  RepositoryFacade,
  ServiceType,
  WebrunDuplex,
} from "@statewalker/vcs-transport";
import { type RefStore, serveRepoOverWebrun, webrunClientDuplex } from "@statewalker/vcs-transport";

const SERVICE_UPLOAD_PACK = 0x01;
const SERVICE_RECEIVE_PACK = 0x02;

function serviceMarker(service: ServiceType): Uint8Array {
  return new Uint8Array([
    service === "git-receive-pack" ? SERVICE_RECEIVE_PACK : SERVICE_UPLOAD_PACK,
  ]);
}

function markerService(byte: number): ServiceType {
  return byte === SERVICE_RECEIVE_PACK ? "git-receive-pack" : "git-upload-pack";
}

function toAsyncIterator(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterator<Uint8Array> {
  if ((input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]) {
    return (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  }
  const it = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return { next: () => Promise.resolve(it.next()) };
}

/**
 * A client `Duplex` that opens a new git call on `call`, prefixed with the
 * 1-byte `service` marker the server reads via {@link serveGitDispatch}.
 */
export function gitClientDuplex(call: WebrunDuplex, service: ServiceType): Duplex {
  const marker = serviceMarker(service);
  const prefixed: WebrunDuplex = (input) =>
    call(
      (async function* () {
        yield marker;
        yield* input;
      })(),
    );
  return webrunClientDuplex(prefixed);
}

/** Options for {@link serveGitDispatch}. */
export interface ServeGitDispatchOptions {
  repository: RepositoryFacade;
  refStore: RefStore;
  /** Invoked after each served call, with the service that was served. */
  onServed?: (service: ServiceType) => void;
}

/**
 * A server handler `Duplex` that reads the leading service marker off each
 * incoming call and delegates to `serveRepoOverWebrun` for that service.
 */
export function serveGitDispatch(options: ServeGitDispatchOptions): WebrunDuplex {
  return (input) =>
    (async function* () {
      const iter = toAsyncIterator(input);
      const first = await iter.next();
      const service: ServiceType = first.done ? "git-upload-pack" : markerService(first.value[0]);
      const remainder = first.done ? new Uint8Array(0) : first.value.subarray(1);
      const rest = (async function* () {
        if (remainder.byteLength > 0) yield remainder;
        while (true) {
          const next = await iter.next();
          if (next.done) return;
          yield next.value;
        }
      })();

      const handler = serveRepoOverWebrun({
        repository: options.repository,
        refStore: options.refStore,
        service,
      });
      try {
        yield* handler(rest);
      } finally {
        options.onServed?.(service);
      }
    })();
}
