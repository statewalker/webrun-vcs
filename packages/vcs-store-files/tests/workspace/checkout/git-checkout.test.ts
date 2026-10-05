/**
 * Tests for GitCheckout implementation
 *
 * Runs conformance tests against the Git file-based Checkout implementation.
 */

import { MemoryRefs } from "@statewalker/vcs-core";
import { GitCheckout, type GitCheckoutFilesApi } from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import type { Checkout, Staging } from "@statewalker/vcs-working-tree";
import { createMemoryGitStaging } from "@statewalker/vcs-working-tree";
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
      remove: baseFiles.remove.bind(baseFiles),
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
