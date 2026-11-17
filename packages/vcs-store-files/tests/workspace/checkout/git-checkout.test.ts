/**
 * Tests for GitCheckout implementation
 *
 * Runs conformance tests against the Git file-based Checkout implementation.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRefs } from "@statewalker/vcs-core";
import { GitCheckout, type GitCheckoutFilesApi } from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi, readFile } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { Checkout, Staging } from "@statewalker/vcs-working-tree";
import { createMemoryGitStaging } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutConformanceTests } from "./checkout.conformance.test.js";

let checkout: GitCheckout;
let staging: Staging;
let refs: MemoryRefs;
let files: GitCheckoutFilesApi;

checkoutConformanceTests(
  "GitCheckout",
  async (): Promise<Checkout> => {
    // Create in-memory filesystem
    const baseFiles = createInMemoryFilesApi();

    // Create adapter to convert FilesApi to GitCheckoutFilesApi
    files = {
      // Adapt read() to return Promise<Uint8Array | undefined>
      read: async (path: string): Promise<Uint8Array | undefined> => {
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of baseFiles.read(path)) {
            chunks.push(chunk);
          }
          if (chunks.length === 0) return undefined;
          // Concatenate chunks
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        } catch {
          return undefined;
        }
      },
      stats: async (path: string): Promise<{ isDirectory: boolean } | undefined> => {
        const fileStats = await baseFiles.stats(path);
        if (!fileStats) return undefined;
        return { isDirectory: fileStats.kind === "directory" };
      },
      write: baseFiles.write.bind(baseFiles),
      mkdir: baseFiles.mkdir.bind(baseFiles),
      remove: async (path: string): Promise<void> => {
        await baseFiles.remove(path);
      },
      removeDir: async (path: string): Promise<void> => {
        await baseFiles.remove(path);
      },
    } as GitCheckoutFilesApi;

    // Create initial HEAD
    staging = createMemoryGitStaging();
    refs = new MemoryRefs();

    // Initialize HEAD to point to main branch
    await refs.setSymbolic("HEAD", "refs/heads/main");

    checkout = new GitCheckout({
      staging,
      refs,
      files,
      gitDir: "/.git",
    });

    return checkout;
  },
  async (): Promise<void> => {
    // Cleanup
    refs.clear();
  },
);

describe("GitCheckout state files survive a crash mid-write", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * A checkout over a real directory whose writes "crash" (throw) after the first byte
   * while `crashing` is set, and which records the paths it removed.
   */
  function crashingCheckout() {
    dir = mkdtempSync(join(tmpdir(), "git-checkout-crash-"));
    const base = createNodeFilesApi({ rootDir: dir });
    const removed: string[] = [];
    const state = { crashing: false };
    const crash = (content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) =>
      (async function* () {
        for await (const chunk of content) {
          yield chunk.subarray(0, 1);
          throw new Error("simulated crash");
        }
      })();
    const filesApi: GitCheckoutFilesApi = {
      read: async (path) => {
        if (!(await base.exists(path))) return undefined;
        return readFile(base, path);
      },
      stats: async (path) => {
        const s = await base.stats(path);
        return s ? { isDirectory: s.kind === "directory" } : undefined;
      },
      write: (path, content) => base.write(path, state.crashing ? crash(content) : content),
      mkdir: (path) => base.mkdir(path),
      remove: async (path) => {
        removed.push(path);
        await base.remove(path);
      },
      createExclusive: async (path, content) => {
        if (!base.createExclusive) return false;
        return base.createExclusive(path, state.crashing ? crash(content) : content);
      },
    };
    const co = new GitCheckout({
      staging: createMemoryGitStaging(),
      refs: new MemoryRefs(),
      files: filesApi,
      gitDir: ".git",
    });
    return { co, removed, state, root: dir };
  }

  it("rewrites git-rebase-todo, MERGE_MSG and author-script through a rename, the old file kept", async () => {
    const { co, removed, state, root } = crashingCheckout();
    const names = ["rebase-merge/git-rebase-todo", "MERGE_MSG", "rebase-merge/author-script"];
    for (const name of names) await co.writeStateFile(name, `old ${name}\n`);
    state.crashing = true;
    for (const name of names) {
      await expect(co.writeStateFile(name, `new ${name}\n`)).rejects.toThrow("simulated crash");
      expect(readFileSync(join(root, ".git", name), "utf8")).toBe(`old ${name}\n`);
    }
    expect(removed).toEqual([]);
  });

  it("writes git's write_file-style small files in place", async () => {
    const { co, removed, root } = crashingCheckout();
    await co.writeStateFile("rebase-merge/msgnum", "1\n");
    await co.writeStateFile("rebase-merge/msgnum", "2\n");
    expect(readFileSync(join(root, ".git/rebase-merge/msgnum"), "utf8")).toBe("2\n");
    expect(removed).toEqual([".git/rebase-merge/msgnum"]);
  });
});

describe("GitCheckout FETCH_HEAD keeps bytes that are no UTF-8", () => {
  it("a latin-1 URL read and appended to stays those bytes", async () => {
    const base = createInMemoryFilesApi();
    const co = new GitCheckout({
      staging: createMemoryGitStaging(),
      refs: new MemoryRefs(),
      files: {
        read: async (path) => ((await base.exists(path)) ? readFile(base, path) : undefined),
        stats: async (path) => {
          const s = await base.stats(path);
          return s ? { isDirectory: s.kind === "directory" } : undefined;
        },
        write: (path, content) => base.write(path, content),
        mkdir: (path) => base.mkdir(path),
      } as GitCheckoutFilesApi,
      gitDir: ".git",
    });
    const id = "a".repeat(40);
    // "/srv/caf\xe9" as git writes it from a latin-1 remote URL
    const line = [...new TextEncoder().encode(`${id}\t\tbranch 'main' of /srv/caf`), 0xe9, 0x0a];
    await base.write(".git/FETCH_HEAD", [new Uint8Array(line)]);
    const text = await co.readFetchHead();
    expect(text).toBe(`${id}\t\tbranch 'main' of /srv/caf\udce9\n`);
    await co.writeFetchHead(`${id}\tnot-for-merge\ttag 'v1' of /srv/caf\udce9\n`, { append: true });
    const bytes = await readFile(base, ".git/FETCH_HEAD");
    expect(bytes.filter((b) => b === 0xe9).length).toBe(2);
    expect(bytes.includes(0xef)).toBe(false); // no U+FFFD (EF BF BD)
  });
});
