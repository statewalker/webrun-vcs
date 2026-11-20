/**
 * The registry that picks a transport connector for a remote URL.
 */

import type { GitTransportConnector } from "./connector.js";
import { type GitUrl, parseGitUrl } from "./git-url.js";

/** Options of {@link GitTransportRegistry.register}. */
export interface RegisterTransportOptions {
  /**
   * Higher priorities are asked first (default 0); among equal ones, the connector
   * registered last wins, so a registration overrides a default one for the same scheme.
   */
  priority?: number;
}

interface Entry {
  connector: GitTransportConnector;
  priority: number;
  order: number;
}

/**
 * Connectors by URL: {@link resolve} returns the first one whose schemes name the URL's
 * scheme or whose `matches` accepts it.
 *
 * @example
 * ```ts
 * const transports = createDefaultTransports();          // http and https
 * transports.register(myWebSocketConnector);            // schemes: ["ws", "wss"]
 * transports.resolve("wss://peer.example/repo")?.name;  // "websocket"
 * ```
 */
export class GitTransportRegistry {
  private entries: Entry[] = [];
  private counter = 0;

  /**
   * Adds a connector.
   *
   * @returns a function that unregisters it
   */
  register(connector: GitTransportConnector, options: RegisterTransportOptions = {}): () => void {
    this.entries.push({ connector, priority: options.priority ?? 0, order: this.counter++ });
    this.entries.sort((a, b) => b.priority - a.priority || b.order - a.order);
    return () => {
      this.unregister(connector);
    };
  }

  /**
   * Removes a connector, given itself or its name (every connector of that name).
   *
   * @returns whether one was removed
   */
  unregister(connector: GitTransportConnector | string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) =>
      typeof connector === "string" ? e.connector.name !== connector : e.connector !== connector,
    );
    return this.entries.length !== before;
  }

  /** The connector serving a URL, or undefined when none does. */
  resolve(url: GitUrl | string): GitTransportConnector | undefined {
    const parsed = typeof url === "string" ? parseGitUrl(url) : url;
    const scheme = parsed.scheme.toLowerCase();
    for (const { connector } of this.entries) {
      if (connector.schemes?.some((s) => s.toLowerCase() === scheme)) return connector;
      if (connector.matches?.(parsed)) return connector;
    }
    return undefined;
  }

  /** The registered connectors, in the order {@link resolve} asks them. */
  list(): GitTransportConnector[] {
    return this.entries.map((e) => e.connector);
  }

  /** A registry holding the same connectors (with their priorities), to extend separately. */
  clone(): GitTransportRegistry {
    const copy = new GitTransportRegistry();
    copy.entries = [...this.entries];
    copy.counter = this.counter;
    return copy;
  }
}

/** Options of {@link createHttpConnector}. */
export interface HttpConnectorOptions {
  /** How requests are sent (default: `globalThis.fetch`, looked up at each request) */
  fetchImpl?: (request: Request) => Promise<Response>;
  /** Headers added to every request */
  headers?: Record<string, string>;
}

/**
 * Smart HTTP for `http://` and `https://` URLs: a session whose requests go through
 * `fetchImpl` (git's remote-curl).
 */
export function createHttpConnector(options: HttpConnectorOptions = {}): GitTransportConnector {
  const fetchImpl = options.fetchImpl ?? ((request: Request) => globalThis.fetch(request));
  return {
    name: "http",
    schemes: ["http", "https"],
    async connect(request) {
      return {
        kind: "http",
        baseUrl: request.url.raw,
        fetchImpl,
        ...(options.headers ? { headers: { ...options.headers } } : {}),
      };
    },
  };
}

/**
 * The transports every remote command starts with: smart HTTP over the global `fetch` for
 * `http(s)://` URLs. Local paths and `file://` URLs never reach the registry (they are served
 * in process by git's local transport).
 *
 * @example
 * ```ts
 * const transports = createDefaultTransports();
 * transports.register(connector, { priority: 10 });
 * const git = Git.fromWorkingCopy(workingCopy, { transports });
 * ```
 */
export function createDefaultTransports(options: HttpConnectorOptions = {}): GitTransportRegistry {
  const registry = new GitTransportRegistry();
  registry.register(createHttpConnector(options));
  return registry;
}
