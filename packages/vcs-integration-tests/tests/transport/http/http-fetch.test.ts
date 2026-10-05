/**
 * HTTP Fetch E2E Tests
 *
 * Tests complete fetch operations using real VCS HTTP server handlers
 * with real in-memory repositories for pack operations.
 */

import { createFetchHandler, httpFetch } from "@statewalker/vcs-transport";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTestRepository,
  createTransportRefStore,
  type TestRepositoryContext,
} from "../helpers/index.js";

/**
 * Create a fetch function backed by our real VCS HTTP server handler.
 *
 * Uses createFetchHandler which handles /info/refs and /git-upload-pack
 * with full pack export/import via the real SerializationApi pipeline.
 */
function createServerFetchFn(serverCtx: TestRepositoryContext): typeof fetch {
  const serverFacade = createRepositoryFacade(serverCtx.repository);
  const serverRefs = createTransportRefStore(serverCtx.repository.refs);

  const handler = createFetchHandler({
    async resolveRepository() {
      return { repository: serverFacade, refStore: serverRefs };
    },
  });

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return handler(new Request(input, init));
  };
}

describe("HTTP Fetch E2E", () => {
  let serverCtx: TestRepositoryContext;
  let clientCtx: TestRepositoryContext;

  beforeEach(async () => {
    serverCtx = await createInitializedTestRepository();
    clientCtx = await createTestRepository();
  });

  afterEach(async () => {
    await serverCtx.cleanup();
    await clientCtx.cleanup();
  });

  it("fetches refs from server", async () => {
    await createTestCommit(serverCtx.repository, "Server commit", {
      "README.md": "# Server content",
    });

    const fetchFn = createServerFetchFn(serverCtx);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpFetch("http://test-server/repo.git", clientFacade, clientRefs, {
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.objectsImported).toBeGreaterThan(0);
  });

  it("performs info/refs request correctly", async () => {
    await createTestCommit(serverCtx.repository, "Server commit", {
      "README.md": "# Server content",
    });

    let infoRefsRequested = false;
    let requestUrl = "";

    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestUrl = url;
      if (url.includes("/info/refs")) {
        infoRefsRequested = true;
      }
      return new Response("Not Found", { status: 404 });
    };

    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    await httpFetch("http://test-server/repo.git", clientFacade, clientRefs, {
      fetchFn: mockFetch,
    });

    expect(infoRefsRequested).toBe(true);
    expect(requestUrl).toContain("service=git-upload-pack");
  });

  it("handles empty server repository", async () => {
    const emptyServerCtx = await createTestRepository();

    try {
      const fetchFn = createServerFetchFn(emptyServerCtx);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefs = createTransportRefStore(clientCtx.repository.refs);

      const result = await httpFetch("http://test-server/repo.git", clientFacade, clientRefs, {
        fetchFn,
      });

      expect(result.success).toBe(true);
    } finally {
      await emptyServerCtx.cleanup();
    }
  });

  it("returns error for 404 response", async () => {
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpFetch("http://test-server/repo.git", clientFacade, clientRefs, {
      fetchFn: async () => new Response("Not Found", { status: 404 }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  it("handles network errors gracefully", async () => {
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpFetch("http://test-server/repo.git", clientFacade, clientRefs, {
      fetchFn: async () => {
        throw new Error("Network error");
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });
});

describe("HTTP Fetch - Repository Sync", () => {
  it("syncs repository facade correctly", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      const commitId = await createTestCommit(serverCtx.repository, "Test commit", {
        "file.txt": "content",
      });

      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const clientFacade = createRepositoryFacade(clientCtx.repository);

      expect(await serverFacade.has(commitId)).toBe(true);
      expect(await clientFacade.has(commitId)).toBe(false);

      const ancestors: string[] = [];
      for await (const oid of serverFacade.walkAncestors(commitId)) {
        ancestors.push(oid);
      }
      expect(ancestors.length).toBeGreaterThan(0);
      expect(ancestors).toContain(commitId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
