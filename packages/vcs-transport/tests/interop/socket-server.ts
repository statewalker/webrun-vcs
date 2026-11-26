/**
 * A TCP server for interop tests through the socket adapter (vcs-utils-node's
 * `listenSocketPorts`): each accepted socket is a `MessagePort`, read and written as a
 * `Duplex` (`messagePortDuplex` with the serving side's draining close), so tests never wire
 * a `net.Socket` to a duplex by hand.
 */

import { listenSocketPorts } from "@statewalker/vcs-utils-node/files";
import { DEFAULT_PORT_DRAIN_TIMEOUT, type Duplex, messagePortDuplex } from "../../src/index.js";

/** A listening server: its TCP port on 127.0.0.1, and its `close`. */
export interface DuplexServer {
  port: number;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1 and runs `serve` per connection; the duplex is closed once it settles. */
export async function listenDuplexes(
  serve: (duplex: Duplex) => Promise<unknown>,
): Promise<DuplexServer> {
  const server = await listenSocketPorts({ host: "127.0.0.1", port: 0 }, (port) => {
    const duplex = messagePortDuplex(port, { drainTimeout: DEFAULT_PORT_DRAIN_TIMEOUT });
    void serve(duplex)
      .catch(() => {})
      .finally(() => duplex.close?.());
  });
  const address = server.address;
  return { port: typeof address === "object" ? address.port : 0, close: () => server.close() };
}
