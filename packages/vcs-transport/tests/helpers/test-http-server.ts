/**
 * Test HTTP Server Helper
 *
 * Provides an in-memory HTTP server for testing Git HTTP protocol.
 * Inspired by JGit's test infrastructure.
 *
 * Features:
 * - In-memory HTTP server (no actual network)
 * - Configurable authentication
 * - Configurable delays and timeouts
 * - Configurable redirects
 * - Request/response capture for verification
 */

import type { RepositoryFacade } from "../../src/api/repository-facade.js";
import { TestRepository } from "./test-repository.js";

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Authentication type */
  type: "basic" | "bearer" | "none";
  /** Username for basic auth */
  username?: string;
  /** Password for basic auth */
  password?: string;
  /** Token for bearer auth */
  token?: string;
}

/**
 * Redirect configuration
 */
export interface RedirectConfig {
  /** HTTP status code (301, 302, 303, 307) */
  status: 301 | 302 | 303 | 307;
  /** Target URL */
  location: string;
  /** Number of times to redirect (default: 1) */
  count?: number;
}

/**
 * Delay configuration
 */
export interface DelayConfig {
  /** Delay before response in milliseconds */
  preResponseDelay?: number;
  /** Delay during response body streaming */
  streamDelay?: number;
}

/**
 * Captured HTTP request
 */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Map<string, string>;
  body?: Uint8Array;
  timestamp: number;
}

/**
 * Captured HTTP response
 */
export interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  body?: Uint8Array;
  timestamp: number;
}

/**
 * Captured request/response pair
 */
export interface CapturedExchange {
  request: CapturedRequest;
  response: CapturedResponse;
}

/**
 * Test HTTP server configuration
 */
export interface TestHttpServerConfig {
  /** Base URL for the server */
  baseUrl?: string;
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Redirect configuration (by path pattern) */
  redirects?: Map<string, RedirectConfig>;
  /** Delay configuration */
  delays?: DelayConfig;
  /** Custom error responses (by path pattern) */
  errors?: Map<string, { status: number; message: string }>;
  /** Enable protocol v2 */
  protocolV2?: boolean;
  /** Repository resolver */
  resolveRepository?: (path: string) => RepositoryFacade | null;
}

/**
 * Test HTTP Server for Git protocol testing
 */
export class TestHttpServer {
  private config: TestHttpServerConfig;
  private repositories = new Map<string, TestRepository>();
  private exchanges: CapturedExchange[] = [];
  private redirectCounts = new Map<string, number>();

  constructor(config: TestHttpServerConfig = {}) {
    this.config = {
      baseUrl: "http://localhost:3000",
      protocolV2: true,
      ...config,
    };
  }

  /**
   * Create a new test HTTP server
   */
  static create(config?: TestHttpServerConfig): TestHttpServer {
    return new TestHttpServer(config);
  }

  /**
   * Register a repository at a path
   */
  registerRepository(path: string, repo: TestRepository): void {
    this.repositories.set(path, repo);
  }

  /**
   * Create and register a new repository
   */
  createRepository(path: string): TestRepository {
    const repo = TestRepository.create();
    this.repositories.set(path, repo);
    return repo;
  }

  /**
   * Get a registered repository
   */
  getRepository(path: string): TestRepository | undefined {
    return this.repositories.get(path);
  }

  /**
   * Get the base URL
   */
  get baseUrl(): string {
    return this.config.baseUrl ?? "http://localhost:3000";
  }

  /**
   * Process an HTTP request
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Capture request
    const capturedRequest: CapturedRequest = {
      method: request.method,
      url: request.url,
      headers: new Map<string, string>(),
      timestamp: Date.now(),
    };

    request.headers.forEach((value, key) => {
      capturedRequest.headers.set(key.toLowerCase(), value);
    });

    if (request.body) {
      capturedRequest.body = new Uint8Array(await request.arrayBuffer());
    }

    // Apply delays
    if (this.config.delays?.preResponseDelay) {
      await this.delay(this.config.delays.preResponseDelay);
    }

    // Check for custom errors
    if (this.config.errors) {
      for (const [pattern, error] of this.config.errors) {
        if (path.includes(pattern) || new RegExp(pattern).test(path)) {
          const response = new Response(error.message, {
            status: error.status,
            statusText: error.message,
          });
          this.captureExchange(capturedRequest, response);
          return response;
        }
      }
    }

    // Check for redirects
    if (this.config.redirects) {
      for (const [pattern, redirect] of this.config.redirects) {
        if (path.includes(pattern) || new RegExp(pattern).test(path)) {
          const key = `${pattern}:${request.url}`;
          const count = this.redirectCounts.get(key) ?? 0;
          const maxCount = redirect.count ?? 1;

          if (count < maxCount) {
            this.redirectCounts.set(key, count + 1);
            const response = new Response(null, {
              status: redirect.status,
              headers: { Location: redirect.location },
            });
            this.captureExchange(capturedRequest, response);
            return response;
          }
        }
      }
    }

    // Check authentication
    if (this.config.auth && this.config.auth.type !== "none") {
      const authResult = this.checkAuth(request);
      if (!authResult.authorized) {
        const response = new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": authResult.challenge ?? "Basic" },
        });
        this.captureExchange(capturedRequest, response);
        return response;
      }
    }

    // Handle Git protocol requests
    try {
      const response = await this.handleGitRequest(request, path);
      this.captureExchange(capturedRequest, response);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal Server Error";
      const response = new Response(message, { status: 500 });
      this.captureExchange(capturedRequest, response);
      return response;
    }
  }

  /**
   * Create a mock fetch function
   */
  createFetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (input instanceof Request) {
        url = input.url;
      } else {
        throw new Error(`Invalid fetch input: ${typeof input}`);
      }

      const requestInit = init?.body ? { ...init, duplex: "half" } : init;
      const request = new Request(url, requestInit as RequestInit);
      return this.fetch(request);
    };
  }

  /**
   * Get all captured exchanges
   */
  getExchanges(): CapturedExchange[] {
    return [...this.exchanges];
  }

  /**
   * Get the last captured exchange
   */
  getLastExchange(): CapturedExchange | undefined {
    return this.exchanges[this.exchanges.length - 1];
  }

  /**
   * Clear captured exchanges
   */
  clearExchanges(): void {
    this.exchanges.length = 0;
  }

  /**
   * Clear redirect counts
   */
  clearRedirectCounts(): void {
    this.redirectCounts.clear();
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.clearExchanges();
    this.clearRedirectCounts();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleGitRequest(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url);
    const service = url.searchParams.get("service");

    // Extract repository path
    const repoPath = this.extractRepoPath(path);
    const repo = this.resolveRepository(repoPath);

    if (!repo) {
      return new Response("Repository not found", { status: 404 });
    }

    // Handle info/refs request
    if (path.endsWith("/info/refs")) {
      return this.handleInfoRefs(repo, service, request);
    }

    // Handle git-upload-pack
    if (path.endsWith("/git-upload-pack")) {
      return this.handleUploadPack(repo, request);
    }

    // Handle git-receive-pack
    if (path.endsWith("/git-receive-pack")) {
      return this.handleReceivePack(repo, request);
    }

    return new Response("Not Found", { status: 404 });
  }

  private extractRepoPath(path: string): string {
    // Remove /info/refs, /git-upload-pack, /git-receive-pack suffixes
    return path
      .replace(/\/info\/refs$/, "")
      .replace(/\/git-upload-pack$/, "")
      .replace(/\/git-receive-pack$/, "")
      .replace(/^\//, "");
  }

  private resolveRepository(path: string): TestRepository | null {
    // Try custom resolver first
    if (this.config.resolveRepository) {
      const result = this.config.resolveRepository(path);
      if (result instanceof TestRepository) {
        return result;
      }
    }

    // Try registered repositories
    if (this.repositories.has(path)) {
      return this.repositories.get(path) ?? null;
    }

    // Try with .git suffix
    if (this.repositories.has(path.replace(/\.git$/, ""))) {
      return this.repositories.get(path.replace(/\.git$/, "")) ?? null;
    }

    return null;
  }

  private handleInfoRefs(repo: TestRepository, service: string | null, request: Request): Response {
    const refs = repo.getAllRefs();

    // Check for protocol v2
    const gitProtocol = request.headers.get("Git-Protocol");
    const isV2 = this.config.protocolV2 && gitProtocol === "version=2";

    if (service === "git-upload-pack") {
      return this.createUploadPackAdvertisement(refs, isV2);
    }

    if (service === "git-receive-pack") {
      return this.createReceivePackAdvertisement(refs, isV2);
    }

    // Dumb HTTP - return refs as plain text
    const lines: string[] = [];
    for (const [name, oid] of refs) {
      lines.push(`${oid}\t${name}\n`);
    }

    return new Response(lines.join(""), {
      headers: { "Content-Type": "text/plain" },
    });
  }

  private createUploadPackAdvertisement(refs: Map<string, string>, isV2: boolean): Response {
    const capabilities = [
      "multi_ack_detailed",
      "thin-pack",
      "side-band",
      "side-band-64k",
      "ofs-delta",
      "shallow",
      "deepen-since",
      "deepen-not",
      "deepen-relative",
      "no-progress",
      "include-tag",
      "filter",
      "object-format=sha1",
    ];

    if (isV2) {
      capabilities.push("object-info");
      capabilities.push("fetch=shallow filter");
    }

    const lines: string[] = [];
    lines.push("# service=git-upload-pack\n");
    lines.push("0000");

    let first = true;
    for (const [name, oid] of refs) {
      if (first) {
        lines.push(this.pktLine(`${oid} ${name}\0${capabilities.join(" ")}\n`));
        first = true;
      } else {
        lines.push(this.pktLine(`${oid} ${name}\n`));
      }
    }

    if (refs.size === 0) {
      // Empty repository
      lines.push(this.pktLine(`${"0".repeat(40)} capabilities^{}\0${capabilities.join(" ")}\n`));
    }

    lines.push("0000");

    return new Response(lines.join(""), {
      headers: {
        "Content-Type": "application/x-git-upload-pack-advertisement",
        "Cache-Control": "no-cache",
      },
    });
  }

  private createReceivePackAdvertisement(refs: Map<string, string>, _isV2: boolean): Response {
    const capabilities = [
      "report-status",
      "report-status-v2",
      "delete-refs",
      "side-band-64k",
      "quiet",
      "atomic",
      "ofs-delta",
      "push-options",
      "object-format=sha1",
    ];

    const lines: string[] = [];
    lines.push("# service=git-receive-pack\n");
    lines.push("0000");

    let first = true;
    for (const [name, oid] of refs) {
      if (first) {
        lines.push(this.pktLine(`${oid} ${name}\0${capabilities.join(" ")}\n`));
        first = false;
      } else {
        lines.push(this.pktLine(`${oid} ${name}\n`));
      }
    }

    if (refs.size === 0) {
      // Empty repository
      lines.push(this.pktLine(`${"0".repeat(40)} capabilities^{}\0${capabilities.join(" ")}\n`));
    }

    lines.push("0000");

    return new Response(lines.join(""), {
      headers: {
        "Content-Type": "application/x-git-receive-pack-advertisement",
        "Cache-Control": "no-cache",
      },
    });
  }

  private async handleUploadPack(repo: TestRepository, request: Request): Promise<Response> {
    // Parse request body to extract wants
    const body = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(body);

    const wants = new Set<string>();
    const haves = new Set<string>();

    for (const line of text.split("\n")) {
      if (line.startsWith("want ")) {
        const oid = line.slice(5).split(" ")[0];
        wants.add(oid);
      } else if (line.startsWith("have ")) {
        const oid = line.slice(5).trim();
        haves.add(oid);
      }
    }

    // Generate pack data
    const packChunks: Uint8Array[] = [];
    for await (const chunk of repo.exportPack(wants, haves)) {
      packChunks.push(chunk);
    }

    // Concatenate pack data
    const totalLength = packChunks.reduce((sum, c) => sum + c.length, 0);
    const packData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of packChunks) {
      packData.set(chunk, offset);
      offset += chunk.length;
    }

    // Create response with sideband
    const response: string[] = [];
    response.push(this.pktLine("NAK\n"));

    // Send pack data on sideband 1
    const sidebandChunks = this.createSidebandChunks(packData, 1);
    for (const chunk of sidebandChunks) {
      response.push(chunk);
    }

    // Send completion message on sideband 2
    response.push(this.pktLine("\x02Done\n"));
    response.push("0000");

    return new Response(response.join(""), {
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  }

  private async handleReceivePack(repo: TestRepository, request: Request): Promise<Response> {
    // Parse push commands from request
    const body = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(body);

    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];

    for (const line of text.split("\n")) {
      const match = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
      if (match) {
        commands.push({
          oldOid: match[1],
          newOid: match[2],
          ref: match[3].split("\0")[0],
        });
      }
    }

    // Apply commands
    const results: string[] = [];
    for (const cmd of commands) {
      // Check if old OID matches current ref
      const currentOid = repo.getRef(cmd.ref) ?? "0".repeat(40);

      if (cmd.oldOid !== "0".repeat(40) && currentOid !== cmd.oldOid) {
        results.push(this.pktLine(`ng ${cmd.ref} non-fast-forward\n`));
        continue;
      }

      if (cmd.newOid === "0".repeat(40)) {
        // Delete ref
        repo.deleteRef(cmd.ref);
      } else {
        // Update/create ref
        repo.setRef(cmd.ref, cmd.newOid);
      }

      results.push(this.pktLine(`ok ${cmd.ref}\n`));
    }

    // Create response
    const response: string[] = [];
    response.push(this.pktLine("unpack ok\n"));
    response.push(...results);
    response.push("0000");

    return new Response(response.join(""), {
      headers: {
        "Content-Type": "application/x-git-receive-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  }

  private checkAuth(request: Request): { authorized: boolean; challenge?: string } {
    const authHeader = request.headers.get("Authorization");

    if (this.config.auth?.type === "basic") {
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        return { authorized: false, challenge: 'Basic realm="Git"' };
      }

      const encoded = authHeader.slice(6);
      const decoded = atob(encoded);
      const [username, password] = decoded.split(":");

      if (username === this.config.auth.username && password === this.config.auth.password) {
        return { authorized: true };
      }

      return { authorized: false, challenge: 'Basic realm="Git"' };
    }

    if (this.config.auth?.type === "bearer") {
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return { authorized: false, challenge: "Bearer" };
      }

      const token = authHeader.slice(7);
      if (token === this.config.auth.token) {
        return { authorized: true };
      }

      return { authorized: false, challenge: "Bearer" };
    }

    return { authorized: true };
  }

  private pktLine(data: string): string {
    const length = data.length + 4;
    return length.toString(16).padStart(4, "0") + data;
  }

  private createSidebandChunks(data: Uint8Array, channel: number): string[] {
    const chunks: string[] = [];
    const maxChunkSize = 65515; // Max pkt-line payload - 1 for channel byte

    for (let i = 0; i < data.length; i += maxChunkSize) {
      const chunk = data.slice(i, i + maxChunkSize);
      const length = chunk.length + 5; // 4 for length + 1 for channel
      const header = length.toString(16).padStart(4, "0");
      const channelByte = String.fromCharCode(channel);

      // Concatenate header + channel + chunk
      chunks.push(header + channelByte + new TextDecoder().decode(chunk));
    }

    return chunks;
  }

  private async captureExchange(request: CapturedRequest, response: Response): Promise<void> {
    const capturedResponse: CapturedResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: new Map<string, string>(),
      timestamp: Date.now(),
    };

    response.headers.forEach((value, key) => {
      capturedResponse.headers.set(key.toLowerCase(), value);
    });

    this.exchanges.push({
      request,
      response: capturedResponse,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a simple test HTTP server with a repository
 */
export function createTestHttpServer(config?: TestHttpServerConfig): {
  server: TestHttpServer;
  repo: TestRepository;
  fetch: typeof globalThis.fetch;
} {
  const server = TestHttpServer.create(config);
  const repo = server.createRepository("test.git");

  return {
    server,
    repo,
    fetch: server.createFetch(),
  };
}

/**
 * Create a test HTTP server with an initialized repository
 */
export async function createInitializedHttpServer(): Promise<{
  server: TestHttpServer;
  repo: TestRepository;
  fetch: typeof globalThis.fetch;
  initialCommit: string;
}> {
  const { server, repo, fetch } = createTestHttpServer();

  const initialCommit = repo.createEmptyCommit("Initial commit");
  repo.setRef("refs/heads/main", initialCommit);
  repo.setHead("main");

  return { server, repo, fetch, initialCommit };
}
