/**
 * Tests for CloneCommand
 *
 * Based on JGit's CloneCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import type { Ref } from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, TagOption } from "../src/index.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

/** pkt-line flush packet. */
const PKT_FLUSH = "0000";

/**
 * Wrap a fetch so each pkt-line payload of the `/info/refs` advertisement is
 * rewritten by `patch`.
 *
 * A pkt-line's 4-hex-digit length prefix counts itself, so an edited payload
 * has to be re-framed; patching the raw bytes in place would desynchronise
 * the parser. Throws if `patch` changed nothing, so a stale pattern cannot
 * quietly turn the test into a no-op.
 */
function withPatchedAdvertisement(
  inner: typeof globalThis.fetch,
  patch: (payload: string) => string,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await inner(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/info/refs")) return response;

    const data = new Uint8Array(await response.arrayBuffer());
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const out: string[] = [];
    let offset = 0;
    let patched = false;

    while (offset + 4 <= data.length) {
      const lengthHex = decoder.decode(data.slice(offset, offset + 4));
      if (lengthHex === PKT_FLUSH) {
        out.push(PKT_FLUSH);
        offset += 4;
        continue;
      }
      const length = Number.parseInt(lengthHex, 16);
      if (Number.isNaN(length) || length < 4 || offset + length > data.length) break;
      const payload = decoder.decode(data.slice(offset + 4, offset + length));
      offset += length;

      const next = patch(payload);
      if (next !== payload) patched = true;
      const size = encoder.encode(next).length + 4;
      out.push(size.toString(16).padStart(4, "0") + next);
    }

    if (!patched) throw new Error("advertisement patch matched nothing");

    return new Response(encoder.encode(out.join("")), {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/x-git-upload-pack-advertisement",
      },
    });
  }) as typeof globalThis.fetch;
}

describe.each(backends)("CloneCommand ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createTestWorkingCopy(): Promise<WorkingCopy> {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    return ctx.workingCopy;
  }
  describe("basic operations", () => {
    it("should clone a repository", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create a new WorkingCopy for the clone
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        // Should have cloned something
        expect(result.fetchResult).toBeDefined();
        expect(result.fetchResult.uri).toBe(remoteUrl);
        expect(result.remoteName).toBe("origin");

        // Should have set up tracking refs
        expect(result.fetchResult.trackingRefUpdates.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should clone and set up default branch", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        // Should have default branch info
        expect(result.defaultBranch).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should clone with multiple commits", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Add more commits on server
      await addFileAndCommit(server.serverStores, "file2.txt", "content 2", "Second commit");
      await addFileAndCommit(server.serverStores, "file3.txt", "content 3", "Third commit");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        expect(result.fetchResult).toBeDefined();
        expect(result.fetchResult.bytesReceived).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("object storage", () => {
    /**
     * A clone that writes refs and HEAD but drops the pack produces a
     * repository whose HEAD names a commit that cannot be loaded.
     */
    it("should store the cloned objects, not just the refs", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Commit a real file so the pack carries a distinctive tree + blob
      // (the initial commit's tree is the well-known EMPTY tree, which some
      // stores can answer for without ever having received it).
      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        const clonedRef = (await workingCopy.history.refs.get("refs/heads/main")) as
          | Ref
          | undefined;
        expect(clonedRef?.objectId).toBe(commitId);
        expect(result.fetchResult.trackingRefUpdates.map((u) => u.newObjectId)).toContain(commitId);

        // The commit the cloned ref points at must exist locally
        const commit = await workingCopy.history.commits.load(commitId);
        expect(commit).toBeDefined();
        if (!commit) return;
        expect(commit.message).toBe("Add hello.txt");

        // ...and so must its tree
        const tree = await workingCopy.history.trees.load(commit.tree);
        expect(tree).toBeDefined();
        if (!tree) return;
        const entries = [];
        for await (const entry of tree) {
          entries.push(entry);
        }
        expect(entries.map((e) => e.name)).toContain("hello.txt");

        // ...and the blob content itself
        const blobEntry = entries.find((e) => e.name === "hello.txt");
        expect(blobEntry).toBeDefined();
        if (!blobEntry) return;
        const blob = await workingCopy.history.blobs.load(blobEntry.id);
        expect(blob).toBeDefined();
        if (!blob) return;
        const chunks: Uint8Array[] = [];
        for await (const chunk of blob) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        expect(new TextDecoder().decode(bytes)).toBe("hello from the remote");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * An empty remote sends a zero-length pack, which the pack parser rejects
     * ("Unexpected end of stream: wanted 12 bytes, have 0"). Cloning one must
     * still succeed.
     */
    it("should clone an empty remote without importing a pack", async () => {
      const server = createTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        expect(result.fetchResult.isEmpty).toBe(true);
        expect(result.fetchResult.trackingRefUpdates).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * The whole history is packed, not just the tip: an older commit and its
     * blob must be loadable too.
     */
    it("should store the whole cloned history, not only the tip", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const firstId = await addFileAndCommit(
        server.serverStores,
        "one.txt",
        "first content",
        "Add one.txt",
      );
      const secondId = await addFileAndCommit(
        server.serverStores,
        "two.txt",
        "second content",
        "Add two.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        await git.clone().setURI(remoteUrl).call();

        const tip = await workingCopy.history.commits.load(secondId);
        expect(tip?.message).toBe("Add two.txt");
        expect(tip?.parents).toContain(firstId);

        const parent = await workingCopy.history.commits.load(firstId);
        expect(parent?.message).toBe("Add one.txt");
        if (!parent) return;

        const entry = await workingCopy.history.trees.getEntry(parent.tree, "one.txt");
        expect(entry).toBeDefined();
        if (!entry) return;
        expect(await workingCopy.history.blobs.has(entry.id)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("branch option", () => {
    it("should clone specific branch", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create additional branch on server
      const mainRef = (await server.serverStores.refs.get("refs/heads/main")) as Ref | undefined;
      await server.serverStores.refs.set("refs/heads/feature", mainRef?.objectId ?? "");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setBranch("feature").call();

        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should accept full ref name for branch", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setBranch("refs/heads/main").call();

        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("shallow clone", () => {
    it("should clone with depth option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Add more commits
      await addFileAndCommit(server.serverStores, "file2.txt", "content 2", "Second commit");
      await addFileAndCommit(server.serverStores, "file3.txt", "content 3", "Third commit");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setDepth(1).call();

        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should reject invalid depth", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      expect(() => git.clone().setURI("http://example.com/repo.git").setDepth(0)).toThrow(
        "Depth must be at least 1",
      );

      expect(() => git.clone().setURI("http://example.com/repo.git").setDepth(-1)).toThrow(
        "Depth must be at least 1",
      );
    });
  });

  describe("bare clone", () => {
    it("should clone as bare repository", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setBare(true).call();

        expect(result.bare).toBe(true);
        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("HEAD", () => {
    /**
     * A non-bare clone must end up on the remote's default branch: HEAD a
     * symbolic ref to `refs/heads/<branch>`, the tip reported as headCommit,
     * and the staging area read from that commit's tree.
     *
     * The advertisement names the default branch by its symref target
     * (`refs/heads/main`), not by the bare branch name, so a command that
     * prefixes it again looks for `refs/heads/refs/heads/main` and silently
     * does none of the three.
     */
    it("should set HEAD to the default branch and populate staging", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Commit a real file: the initial commit's tree is the well-known EMPTY
      // tree, which a content-addressed store can answer for without ever
      // having received it, so staging would look "populated" either way.
      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        // HEAD is a symbolic ref to the local branch, not a detached OID and
        // not a doubly-prefixed ref name.
        const head = await workingCopy.history.refs.get("HEAD");
        expect(head).toBeDefined();
        if (!head) return;
        expect(isSymbolicRef(head)).toBe(true);
        if (!isSymbolicRef(head)) return;
        expect(head.target).toBe("refs/heads/main");

        // ...and it resolves to the cloned tip.
        const resolved = await workingCopy.history.refs.resolve("HEAD");
        expect(resolved?.objectId).toBe(commitId);
        expect(result.headCommit).toBe(commitId);

        // ...and checkoutHead() ran, so staging carries that commit's tree.
        const staged = await workingCopy.checkout.staging.getEntry("hello.txt");
        expect(staged).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * A transport that reports the bare branch name must work too:
     * normalisation strips a `refs/heads/` prefix, it does not require one.
     */
    it("should accept a bare default branch name from the transport", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const commitId = await addFileAndCommit(
        server.serverStores,
        "hello.txt",
        "hello from the remote",
        "Add hello.txt",
      );

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = withPatchedAdvertisement(server.mockFetch, (payload) =>
        payload.replace("symref=HEAD:refs/heads/main", "symref=HEAD:main"),
      );

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        expect(result.headCommit).toBe(commitId);
        const resolved = await workingCopy.history.refs.resolve("HEAD");
        expect(resolved?.objectId).toBe(commitId);
        const staged = await workingCopy.checkout.staging.getEntry("hello.txt");
        expect(staged).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("defaultBranch", () => {
    /**
     * The two results report the default branch in two different forms, and
     * each form is part of its own documented contract. They are pinned
     * separately so neither can drift into the other's shape unnoticed —
     * which is exactly how `FetchResult.defaultBranch` silently changed from
     * the advertised ref to the bare name.
     */
    it("should report the advertised ref on the fetch result", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        // The target of the advertisement's `symref=HEAD:` capability, whole.
        expect(result.fetchResult.defaultBranch).toBe("refs/heads/main");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should report the bare branch name on the clone result", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        // Usable as-is by a branch or checkout command.
        expect(result.defaultBranch).toBe("main");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("no checkout", () => {
    it("should clone without checkout", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setNoCheckout(true).call();

        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("remote name", () => {
    it("should use custom remote name", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setRemote("upstream").call();

        expect(result.remoteName).toBe("upstream");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should default to origin", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).call();

        expect(result.remoteName).toBe("origin");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("error handling", () => {
    it("should throw for missing URI", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      await expect(git.clone().call()).rejects.toThrow("URI must be specified for clone");
    });

    it("should throw for invalid remote", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response("Not Found", { status: 404 });
      };

      try {
        await expect(git.clone().setURI("http://invalid/repo.git").call()).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("options getters", () => {
    it("should return correct values for getters", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .clone()
        .setURI("http://example.com/repo.git")
        .setBranch("develop")
        .setRemote("upstream")
        .setBare(true)
        .setNoCheckout(true);

      expect(command.getURI()).toBe("http://example.com/repo.git");
      expect(command.getBranch()).toBe("develop");
      expect(command.getRemote()).toBe("upstream");
      expect(command.isBare()).toBe(true);
      expect(command.isNoCheckout()).toBe(true);
    });
  });

  describe("clone all branches", () => {
    it("should support setCloneAllBranches option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const result = await git.clone().setURI(remoteUrl).setCloneAllBranches(false).call();

        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * JGit: CloneCommandTest.testCloneRepositoryAllBranchesTakesPreference()
     */
    it("should have cloneAllBranches take precedence over branchesToClone", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      // Create additional branch on server
      const mainRef = (await server.serverStores.refs.get("refs/heads/main")) as Ref | undefined;
      await server.serverStores.refs.set("refs/heads/test", mainRef?.objectId ?? "");

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const command = git
          .clone()
          .setURI(remoteUrl)
          .setCloneAllBranches(true)
          .setBranchesToClone(["refs/heads/test"]);

        expect(command.isCloneAllBranches()).toBe(true);
        expect(command.getBranchesToClone()).toEqual(["refs/heads/test"]);

        const result = await command.call();
        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  /**
   * JGit-ported tests: Mirror mode
   */
  describe("mirror clone", () => {
    /**
     * JGit: CloneCommandTest.testBareCloneRepositoryMirror()
     */
    it("should clone with mirror option implying bare", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const command = git.clone().setURI(remoteUrl).setMirror(true);

        // Mirror implies bare
        expect(command.isMirror()).toBe(true);
        expect(command.isBare()).toBe(true);

        const result = await command.call();
        expect(result.fetchResult).toBeDefined();
        expect(result.bare).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  /**
   * JGit-ported tests: Tag options
   */
  describe("tag options", () => {
    /**
     * JGit: CloneCommandTest.testCloneNoTags()
     */
    it("should clone with no tags option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const command = git.clone().setURI(remoteUrl).setNoTags();

        expect(command.getTagOption()).toBe(TagOption.NO_TAGS);

        const result = await command.call();
        expect(result.fetchResult).toBeDefined();

        // Tags should be filtered out
        const tagRefs = result.fetchResult.trackingRefUpdates.filter((u) =>
          u.localRef.startsWith("refs/tags/"),
        );
        expect(tagRefs.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * JGit: CloneCommandTest.testCloneFollowTags()
     */
    it("should clone with fetch tags option", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const command = git.clone().setURI(remoteUrl).setTagOption(TagOption.FETCH_TAGS);

        expect(command.getTagOption()).toBe(TagOption.FETCH_TAGS);

        const result = await command.call();
        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should default to auto follow tags", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git.clone().setURI("http://example.com/repo.git");

      expect(command.getTagOption()).toBe(TagOption.AUTO_FOLLOW);
    });
  });

  /**
   * JGit-ported tests: Branches to clone
   */
  describe("branches to clone", () => {
    /**
     * JGit: CloneCommandTest.testCloneRepositoryOnlyOneBranch()
     */
    it("should clone only specified branches", async () => {
      const server = await createInitializedTestServer();
      const remoteUrl = createTestUrl(server.baseUrl);

      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = server.mockFetch;

      try {
        const command = git
          .clone()
          .setURI(remoteUrl)
          .setBranch("main")
          .setBranchesToClone(["refs/heads/main"])
          .setCloneAllBranches(false);

        expect(command.getBranchesToClone()).toEqual(["refs/heads/main"]);
        expect(command.isCloneAllBranches()).toBe(false);

        const result = await command.call();
        expect(result.fetchResult).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  /**
   * JGit-ported tests: Shallow clone options
   */
  describe("shallow clone options", () => {
    /**
     * JGit: CloneCommandTest.testCloneRepositoryWithShallowSince()
     */
    it("should support shallow since option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const date = new Date("2024-01-01");
      const command = git.clone().setURI("http://example.com/repo.git").setShallowSince(date);

      expect(command.getShallowSince()).toEqual(date);
    });

    /**
     * JGit: CloneCommandTest.testCloneRepositoryWithShallowExclude()
     */
    it("should support shallow exclude option", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const command = git
        .clone()
        .setURI("http://example.com/repo.git")
        .addShallowExclude("abc123")
        .addShallowExclude("def456");

      expect(command.getShallowExcludes()).toEqual(["abc123", "def456"]);
    });
  });

  /**
   * JGit-ported tests: Extended options getters
   */
  describe("extended options getters", () => {
    it("should return correct values for all getters", async () => {
      const workingCopy = await createTestWorkingCopy();
      const git = Git.fromWorkingCopy(workingCopy);

      const date = new Date("2024-06-15");
      const command = git
        .clone()
        .setURI("http://example.com/repo.git")
        .setBranch("develop")
        .setRemote("upstream")
        .setBare(true)
        .setNoCheckout(true)
        .setMirror(false)
        .setCloneAllBranches(true)
        .setBranchesToClone(["refs/heads/main", "refs/heads/develop"])
        .setTagOption(TagOption.FETCH_TAGS)
        .setShallowSince(date)
        .addShallowExclude("commit1")
        .addShallowExclude("commit2");

      expect(command.getURI()).toBe("http://example.com/repo.git");
      expect(command.getBranch()).toBe("develop");
      expect(command.getRemote()).toBe("upstream");
      expect(command.isBare()).toBe(true);
      expect(command.isNoCheckout()).toBe(true);
      expect(command.isMirror()).toBe(false);
      expect(command.isCloneAllBranches()).toBe(true);
      expect(command.getBranchesToClone()).toEqual(["refs/heads/main", "refs/heads/develop"]);
      expect(command.getTagOption()).toBe(TagOption.FETCH_TAGS);
      expect(command.getShallowSince()).toEqual(date);
      expect(command.getShallowExcludes()).toEqual(["commit1", "commit2"]);
    });
  });
});
