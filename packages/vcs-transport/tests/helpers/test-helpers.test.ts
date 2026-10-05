/**
 * Tests for Test Helpers
 *
 * Verifies that the test infrastructure works correctly.
 */

import { describe, expect, it } from "vitest";
import {
  createInitializedHttpServer,
  createTestHttpServer,
  TestHttpServer,
} from "./test-http-server.js";

import {
  createMockRefStore,
  createMockTransport,
  createTestContext,
  ProtocolMessages,
  packets,
  randomOid,
  testOid,
  verifyPackets,
} from "./test-protocol.js";
import {
  createComplexRepository,
  createInitializedRepository,
  createTestRepository,
  TestRepository,
} from "./test-repository.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Repository Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TestRepository", () => {
  describe("creation", () => {
    it("should create an empty repository", () => {
      const repo = TestRepository.create();
      expect(repo.objectCount()).toBe(0);
    });

    it("should create with factory function", () => {
      const repo = createTestRepository();
      expect(repo.objectCount()).toBe(0);
    });
  });

  describe("blob storage", () => {
    it("should store and retrieve blobs", () => {
      const repo = TestRepository.create();
      const oid = repo.storeBlob("Hello, World!");

      expect(oid).toHaveLength(40);
      expect(repo.objectCount()).toBe(1);

      const obj = repo.getObject(oid);
      expect(obj).toBeDefined();
      expect(obj?.type).toBe("blob");
    });

    it("should store blobs from Uint8Array", () => {
      const repo = TestRepository.create();
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const oid = repo.storeBlob(data);

      expect(repo.getObject(oid)).toBeDefined();
    });
  });

  describe("commit creation", () => {
    it("should create commits with files", () => {
      const repo = TestRepository.create();
      const oid = repo.createCommitWithFile("README.md", "# Test", "Initial commit");

      expect(oid).toHaveLength(40);
      expect(repo.objectCount()).toBeGreaterThan(1); // blob + tree + commit
    });

    it("should create empty commits", () => {
      const repo = TestRepository.create();
      const oid = repo.createEmptyCommit("Empty commit");

      const commit = repo.getCommit(oid);
      expect(commit).toBeDefined();
      expect(commit?.message).toBe("Empty commit");
      expect(commit?.parents).toHaveLength(0);
    });

    it("should create commit chains", () => {
      const repo = TestRepository.create();
      const oids = repo.createCommitChain(3, "Commit");

      expect(oids).toHaveLength(3);

      // Verify parent chain
      const commit1 = repo.getCommit(oids[0]);
      const commit2 = repo.getCommit(oids[1]);
      const commit3 = repo.getCommit(oids[2]);

      expect(commit1?.parents).toHaveLength(0);
      expect(commit2?.parents).toContain(oids[0]);
      expect(commit3?.parents).toContain(oids[1]);
    });
  });

  describe("ref management", () => {
    it("should set and get refs", () => {
      const repo = TestRepository.create();
      const oid = repo.createEmptyCommit("Test");

      repo.setRef("refs/heads/main", oid);
      expect(repo.getRef("refs/heads/main")).toBe(oid);
    });

    it("should delete refs", () => {
      const repo = TestRepository.create();
      const oid = repo.createEmptyCommit("Test");

      repo.setRef("refs/heads/main", oid);
      repo.deleteRef("refs/heads/main");

      expect(repo.getRef("refs/heads/main")).toBeUndefined();
    });

    it("should list all refs", () => {
      const repo = TestRepository.create();
      const oid1 = repo.createEmptyCommit("Commit 1");
      const oid2 = repo.createEmptyCommit("Commit 2");

      repo.setRef("refs/heads/main", oid1);
      repo.setRef("refs/heads/feature", oid2);

      const refs = repo.getAllRefs();
      expect(refs.size).toBe(2);
      expect(refs.get("refs/heads/main")).toBe(oid1);
      expect(refs.get("refs/heads/feature")).toBe(oid2);
    });
  });

  describe("RepositoryFacade implementation", () => {
    it("should check object existence", async () => {
      const repo = TestRepository.create();
      const oid = repo.storeBlob("test");

      expect(await repo.has(oid)).toBe(true);
      expect(await repo.has("nonexistent")).toBe(false);
    });

    it("should walk ancestors", async () => {
      const repo = TestRepository.create();
      const oids = repo.createCommitChain(3);

      const ancestors: string[] = [];
      for await (const oid of repo.walkAncestors(oids[2])) {
        ancestors.push(oid);
      }

      expect(ancestors).toContain(oids[0]);
      expect(ancestors).toContain(oids[1]);
      expect(ancestors).toContain(oids[2]);
    });

    it("should export pack data", async () => {
      const repo = TestRepository.create();
      const oid = repo.createEmptyCommit("Test");

      const chunks: Uint8Array[] = [];
      for await (const chunk of repo.exportPack(new Set([oid]), new Set())) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      // Check pack header
      const header = chunks[0];
      expect(header[0]).toBe(0x50); // 'P'
      expect(header[1]).toBe(0x41); // 'A'
      expect(header[2]).toBe(0x43); // 'C'
      expect(header[3]).toBe(0x4b); // 'K'
    });
  });

  describe("factory functions", () => {
    it("should create initialized repository", async () => {
      const { repo, initialCommit } = await createInitializedRepository();

      expect(repo.getRef("refs/heads/main")).toBe(initialCommit);
      expect(repo.getCommit(initialCommit)).toBeDefined();
    });

    it("should create complex repository", async () => {
      const { repo, commits } = await createComplexRepository();

      expect(commits.main).toHaveLength(3);
      expect(commits.feature).toHaveLength(2);
      expect(repo.getRef("refs/heads/main")).toBe(commits.main[2]);
      expect(repo.getRef("refs/heads/feature")).toBe(commits.feature[1]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Protocol Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MockTransport", () => {
  it("should create mock transport", () => {
    const transport = createMockTransport();
    expect(transport).toBeDefined();
    expect(transport.readLine).toBeDefined();
    expect(transport.writeLine).toBeDefined();
  });

  it("should read preset packets", async () => {
    const transport = createMockTransport();
    transport._setPackets([
      { type: "data", text: "hello" },
      { type: "data", text: "world" },
      { type: "flush" },
    ]);

    expect(await transport.readLine()).toBe("hello");
    expect(await transport.readLine()).toBe("world");
    expect(await transport.readLine()).toBeNull();
  });

  it("should capture written lines", async () => {
    const transport = createMockTransport();

    await transport.writeLine("hello");
    await transport.writeLine("world");
    await transport.writeFlush();

    const lines = transport._getWrittenLines();
    expect(lines).toContain("hello");
    expect(lines).toContain("world");
  });

  it("should reset state", async () => {
    const transport = createMockTransport();
    await transport.writeLine("test");

    transport._reset();

    expect(transport._getWrittenLines()).toHaveLength(0);
    expect(transport.writeLine).not.toHaveBeenCalled();
  });
});

describe("MockRefStore", () => {
  it("should store and retrieve refs", async () => {
    const store = createMockRefStore();
    store._setRef("refs/heads/main", "abc123");

    expect(await store.get("refs/heads/main")).toBe("abc123");
  });

  it("should update refs", async () => {
    const store = createMockRefStore();
    await store.update("refs/heads/main", "abc123");

    expect(await store.get("refs/heads/main")).toBe("abc123");
  });
});

describe("createTestContext", () => {
  it("should create context with all required fields", () => {
    const ctx = createTestContext();

    expect(ctx.transport).toBeDefined();
    expect(ctx.repository).toBeDefined();
    expect(ctx.refStore).toBeDefined();
    expect(ctx.state).toBeDefined();
    expect(ctx.output).toBeDefined();
    expect(ctx.config).toBeDefined();
  });

  it("should allow overriding fields", () => {
    const customTransport = createMockTransport();
    const ctx = createTestContext({ transport: customTransport });

    expect(ctx.transport).toBe(customTransport);
  });
});

describe("packets builder", () => {
  it("should build packet sequences", () => {
    const pkts = packets().data("hello").data("world").flush().build();

    expect(pkts).toHaveLength(3);
    expect(pkts[0].type).toBe("data");
    expect(pkts[0].text).toBe("hello");
    expect(pkts[2].type).toBe("flush");
  });
});

describe("ProtocolMessages", () => {
  it("should create ref advertisement", () => {
    const pkt = ProtocolMessages.refAdvertisement("abc123", "refs/heads/main", "multi_ack");
    expect(pkt.type).toBe("data");
    expect(pkt.text).toContain("abc123");
    expect(pkt.text).toContain("refs/heads/main");
    expect(pkt.text).toContain("multi_ack");
  });

  it("should create want line", () => {
    const pkt = ProtocolMessages.want("abc123");
    expect(pkt.text).toBe("want abc123");
  });

  it("should create have line", () => {
    const pkt = ProtocolMessages.have("abc123");
    expect(pkt.text).toBe("have abc123");
  });

  it("should create ACK/NAK", () => {
    expect(ProtocolMessages.ack("abc123").text).toBe("ACK abc123");
    expect(ProtocolMessages.ack("abc123", "common").text).toBe("ACK abc123 common");
    expect(ProtocolMessages.nak().text).toBe("NAK");
  });
});

describe("verifyPackets", () => {
  it("should pass for matching packets", () => {
    const actual = [{ type: "data" as const, text: "hello" }, { type: "flush" as const }];

    expect(() =>
      verifyPackets(actual, [{ type: "data", text: "hello" }, { type: "flush" }]),
    ).not.toThrow();
  });

  it("should fail for mismatched length", () => {
    const actual = [{ type: "data" as const, text: "hello" }];

    expect(() => verifyPackets(actual, [{ type: "data" }, { type: "flush" }])).toThrow();
  });

  it("should support pattern matching", () => {
    const actual = [{ type: "data" as const, text: "want abc123" }];

    expect(() =>
      verifyPackets(actual, [{ type: "data", pattern: /^want [a-f0-9]+$/ }]),
    ).not.toThrow();
  });
});

describe("OID helpers", () => {
  it("should generate random OIDs", () => {
    const oid1 = randomOid();
    const oid2 = randomOid();

    expect(oid1).toHaveLength(40);
    expect(oid2).toHaveLength(40);
    expect(oid1).not.toBe(oid2);
  });

  it("should generate deterministic test OIDs", () => {
    const oid1 = testOid("test");
    const oid2 = testOid("test");

    expect(oid1).toHaveLength(40);
    expect(oid1).toBe(oid2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test HTTP Server Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TestHttpServer", () => {
  describe("creation", () => {
    it("should create server with default config", () => {
      const server = TestHttpServer.create();
      expect(server.baseUrl).toBe("http://localhost:3000");
    });

    it("should create server with custom base URL", () => {
      const server = TestHttpServer.create({ baseUrl: "http://example.com" });
      expect(server.baseUrl).toBe("http://example.com");
    });
  });

  describe("repository management", () => {
    it("should register and retrieve repositories", () => {
      const server = TestHttpServer.create();
      const repo = TestRepository.create();

      server.registerRepository("test.git", repo);
      expect(server.getRepository("test.git")).toBe(repo);
    });

    it("should create new repositories", () => {
      const server = TestHttpServer.create();
      const repo = server.createRepository("test.git");

      expect(repo).toBeInstanceOf(TestRepository);
      expect(server.getRepository("test.git")).toBe(repo);
    });
  });

  describe("HTTP request handling", () => {
    it("should return 404 for unknown repository", async () => {
      const server = TestHttpServer.create();

      const response = await server.fetch(
        new Request("http://localhost:3000/unknown.git/info/refs?service=git-upload-pack"),
      );

      expect(response.status).toBe(404);
    });

    it("should handle info/refs request for known repository", async () => {
      const { server, repo } = createTestHttpServer();

      repo.setRef("refs/heads/main", "abc123".repeat(7).slice(0, 40));

      const response = await server.fetch(
        new Request("http://localhost:3000/test.git/info/refs?service=git-upload-pack"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/x-git-upload-pack-advertisement",
      );
    });
  });

  describe("authentication", () => {
    it("should require basic auth when configured", async () => {
      const server = TestHttpServer.create({
        auth: { type: "basic", username: "user", password: "pass" },
      });
      server.createRepository("test.git");

      const response = await server.fetch(
        new Request("http://localhost:3000/test.git/info/refs?service=git-upload-pack"),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
    });

    it("should accept valid credentials", async () => {
      const server = TestHttpServer.create({
        auth: { type: "basic", username: "user", password: "pass" },
      });
      server.createRepository("test.git");

      const response = await server.fetch(
        new Request("http://localhost:3000/test.git/info/refs?service=git-upload-pack", {
          headers: { Authorization: `Basic ${btoa("user:pass")}` },
        }),
      );

      expect(response.status).toBe(200);
    });
  });

  describe("redirects", () => {
    it("should handle redirects", async () => {
      const server = TestHttpServer.create({
        redirects: new Map([
          ["/old.git", { status: 301, location: "http://localhost:3000/new.git/info/refs" }],
        ]),
      });
      server.createRepository("new.git");

      const response = await server.fetch(
        new Request("http://localhost:3000/old.git/info/refs?service=git-upload-pack"),
      );

      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe("http://localhost:3000/new.git/info/refs");
    });
  });

  describe("exchange capture", () => {
    it("should capture request/response pairs", async () => {
      const { server } = createTestHttpServer();

      await server.fetch(
        new Request("http://localhost:3000/test.git/info/refs?service=git-upload-pack"),
      );

      const exchanges = server.getExchanges();
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].request.method).toBe("GET");
      expect(exchanges[0].response.status).toBe(200);
    });

    it("should clear exchanges", async () => {
      const { server } = createTestHttpServer();

      await server.fetch(
        new Request("http://localhost:3000/test.git/info/refs?service=git-upload-pack"),
      );
      server.clearExchanges();

      expect(server.getExchanges()).toHaveLength(0);
    });
  });

  describe("factory functions", () => {
    it("should create test server with repository", () => {
      const { server, repo, fetch } = createTestHttpServer();

      expect(server).toBeInstanceOf(TestHttpServer);
      expect(repo).toBeInstanceOf(TestRepository);
      expect(typeof fetch).toBe("function");
    });

    it("should create initialized server", async () => {
      const { repo, initialCommit } = await createInitializedHttpServer();

      expect(initialCommit).toHaveLength(40);
      expect(repo.getRef("refs/heads/main")).toBe(initialCommit);
    });
  });
});
