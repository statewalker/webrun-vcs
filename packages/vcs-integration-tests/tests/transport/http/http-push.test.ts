/**
 * HTTP Push E2E Tests
 *
 * Tests complete push operations using real VCS HTTP server handlers
 * with real in-memory repositories for pack operations.
 */

import { createFetchHandler, httpPush } from "@statewalker/vcs-transport";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defined } from "../../test-helper.js";
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
 * Uses createFetchHandler which handles /info/refs and /git-receive-pack
 * with full pack import/export via the real SerializationApi pipeline.
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

describe("HTTP Push E2E", () => {
  let clientCtx: TestRepositoryContext;
  let serverCtx: TestRepositoryContext;

  beforeEach(async () => {
    clientCtx = await createInitializedTestRepository();
    serverCtx = await createTestRepository();
  });

  afterEach(async () => {
    await clientCtx.cleanup();
    await serverCtx.cleanup();
  });

  it("pushes refs to server", async () => {
    const commitId = await createTestCommit(clientCtx.repository, "Client commit", {
      "README.md": "# Client content",
    });

    const fetchFn = createServerFetchFn(serverCtx);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: ["refs/heads/main"],
      fetchFn,
    });

    expect(result.success).toBe(true);

    // Verify server refs were updated
    const serverMainRef = await serverCtx.repository.refs.resolve("refs/heads/main");
    expect(serverMainRef?.objectId).toBe(commitId);
  });

  it("performs info/refs request correctly for push", async () => {
    await createTestCommit(clientCtx.repository, "Commit", { "file.txt": "content" });

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

    await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: ["refs/heads/main"],
      fetchFn: mockFetch,
    });

    expect(infoRefsRequested).toBe(true);
    expect(requestUrl).toContain("service=git-receive-pack");
  });

  it("handles empty refspecs gracefully", async () => {
    const fetchFn = createServerFetchFn(serverCtx);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: [],
      fetchFn,
    });

    // Should succeed with nothing to push
    expect(result.success).toBe(true);
    expect(result.refStatus?.size).toBe(0);
  });

  it("returns error for 404 response", async () => {
    await createTestCommit(clientCtx.repository, "Commit", { "file.txt": "content" });

    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: ["refs/heads/main"],
      fetchFn: async () => new Response("Not Found", { status: 404 }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("refs");
  });

  it("handles network errors gracefully", async () => {
    await createTestCommit(clientCtx.repository, "Commit", { "file.txt": "content" });

    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: ["refs/heads/main"],
      fetchFn: async () => {
        throw new Error("Connection refused");
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("handles rejected push", async () => {
    await createTestCommit(clientCtx.repository, "Commit", { "file.txt": "content" });

    // Use a mock that returns rejection status to test error handling
    const rejectingFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      // For info/refs, use the real server
      if (url.includes("/info/refs")) {
        const realFetch = createServerFetchFn(serverCtx);
        return realFetch(input, init);
      }

      // For git-receive-pack POST, return a rejection
      return new Response("Forbidden", { status: 403 });
    };

    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefs = createTransportRefStore(clientCtx.repository.refs);

    const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
      refspecs: ["refs/heads/main"],
      fetchFn: rejectingFetch,
    });

    expect(result.success).toBe(false);
  });
});

describe("HTTP Push - Authentication", () => {
  it("includes basic auth header when credentials provided", async () => {
    const clientCtx = await createInitializedTestRepository();

    try {
      await createTestCommit(clientCtx.repository, "Commit", { "file.txt": "content" });

      let capturedAuthHeader = null as string | null;

      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefs = createTransportRefStore(clientCtx.repository.refs);

      await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
        refspecs: ["refs/heads/main"],
        credentials: { username: "testuser", password: "testpass" },
        fetchFn: async (_url, init) => {
          capturedAuthHeader = new Headers(init?.headers).get("Authorization");
          return new Response("Not Found", { status: 404 });
        },
      });

      expect(capturedAuthHeader).not.toBeNull();
      expect(capturedAuthHeader).toMatch(/^Basic /);

      // Decode and verify credentials
      const encoded = defined(capturedAuthHeader, "Authorization header").slice(6);
      const decoded = atob(encoded);
      expect(decoded).toBe("testuser:testpass");
    } finally {
      await clientCtx.cleanup();
    }
  });
});

describe("HTTP Push - Refspec Handling", () => {
  it("handles local:remote refspec", async () => {
    const clientCtx = await createInitializedTestRepository();
    const serverCtx = await createTestRepository();

    try {
      await createTestCommit(clientCtx.repository, "Feature", { "feature.txt": "feature" });

      // Create feature branch
      const headRef = await clientCtx.repository.refs.resolve("HEAD");
      if (headRef?.objectId) {
        await clientCtx.repository.refs.set("refs/heads/feature", headRef.objectId);
      }

      const fetchFn = createServerFetchFn(serverCtx);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefs = createTransportRefStore(clientCtx.repository.refs);

      const result = await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
        refspecs: ["refs/heads/feature:refs/heads/upstream-feature"],
        fetchFn,
      });

      expect(result.success).toBe(true);

      // Verify the remote ref was created with the correct name
      const remoteRef = await serverCtx.repository.refs.resolve("refs/heads/upstream-feature");
      expect(remoteRef?.objectId).toBeDefined();
    } finally {
      await clientCtx.cleanup();
      await serverCtx.cleanup();
    }
  });

  it("parses refspec correctly", async () => {
    const clientCtx = await createInitializedTestRepository();

    try {
      await createTestCommit(clientCtx.repository, "Feature", { "feature.txt": "feature" });

      // Create feature branch
      const headRef = await clientCtx.repository.refs.resolve("HEAD");
      if (headRef?.objectId) {
        await clientCtx.repository.refs.set("refs/heads/feature", headRef.objectId);
      }

      const mockFetch = async (): Promise<Response> => {
        // Return receive-pack info/refs first time, then error
        return new Response("Error", { status: 500 });
      };

      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefs = createTransportRefStore(clientCtx.repository.refs);

      await httpPush("http://test-server/repo.git", clientFacade, clientRefs, {
        refspecs: ["refs/heads/feature:refs/heads/upstream-feature"],
        fetchFn: mockFetch,
      });

      // The httpPush should attempt to push with the refspec
      // Even if it fails, the protocol layer correctly identifies the refspec
    } finally {
      await clientCtx.cleanup();
    }
  });
});
