/**
 * The core CheckoutCommand never writes into the repository's own `.git`, whatever spelling a
 * crafted tree or index entry uses (git's verify_path, CVE-2014-9390).
 */
import { type Blobs, FileMode, type FilesApi } from "@statewalker/vcs-core";
import type { Staging } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import { CheckoutCommand, type CheckoutCommandOptions } from "../src/core-commands/index.js";

describe("core CheckoutCommand refuses paths that name .git", () => {
  for (const path of [".git/config", "sub/.GIT/hooks/post-checkout", "git~1/config", "ok.txt"]) {
    it(`${path === "ok.txt" ? "writes" : "refuses"} ${JSON.stringify(path)}`, async () => {
      const blobId = "a".repeat(40);
      const written: string[] = [];
      const files = {
        mkdir: async () => {},
        write: async (p: string, content: AsyncIterable<Uint8Array>) => {
          for await (const _ of content);
          written.push(p);
        },
      } as unknown as FilesApi;
      const blobs = {
        load: async () => [new TextEncoder().encode("evil")],
      } as unknown as Blobs;
      const staging = {
        getEntry: async (p: string) =>
          p === path ? { path: p, objectId: blobId, mode: FileMode.REGULAR_FILE } : undefined,
      } as unknown as Staging;
      const checkout = new CheckoutCommand({
        files,
        workTreeRoot: "/repo",
        blobs,
        staging,
      } as unknown as CheckoutCommandOptions);

      const result = await checkout.checkoutPaths([path]);

      if (path === "ok.txt") {
        expect(result.updated).toEqual([path]);
        expect(written).toEqual(["/repo/ok.txt"]);
      } else {
        expect(result.conflicts).toEqual([path]);
        expect(written).toEqual([]);
      }
    });
  }
});
