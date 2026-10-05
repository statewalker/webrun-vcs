/**
 * Direction A (push): our transport client ↔ real `git receive-pack`.
 *
 * Builds a small history in a transport-side in-memory vcs-core repo, spawns
 * the real `git receive-pack <bare>` over stdio, and drives it with the
 * transport's `pushOverDuplex`. Compatibility is asserted against the real git
 * CLI on the receiving bare repo: `rev-parse` (ref moved), `cat-file -t/-p`
 * (objects landed), and `fsck` (integrity). Fast-forward rules are exercised
 * with `receive.denyNonFastForwards`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pushOverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  commitInRepo,
  createTransportRepo,
  git,
  gitAvailable,
  makeBareRepo,
  makeTmpDir,
  spawnGitService,
  type TransportRepo,
} from "./helpers.js";

const HAS_GIT = gitAvailable();
const describeGit = HAS_GIT ? describe : describe.skip;

describeGit("Interop A · push → real git receive-pack", () => {
  let root: string;
  let bare: string;
  let server: TransportRepo;

  beforeEach(async () => {
    root = makeTmpDir("vcs-interop-push-");
    bare = makeBareRepo(root);
    server = await createTransportRepo();
  });
  afterEach(async () => {
    await server.close();
    cleanupDir(root);
  });

  async function push(refspec: string) {
    const duplex = spawnGitService("receive-pack", bare);
    try {
      return await pushOverDuplex({
        duplex,
        repository: server.facade,
        refStore: server.refStore,
        refspecs: [refspec],
      });
    } finally {
      await duplex.close();
    }
  }

  it("creates a ref in the bare repo and lands every object", async () => {
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    await server.refStore.update("refs/heads/main", c1);

    const result = await push("refs/heads/main:refs/heads/main");
    expect(result.success, `push failed: ${result.error}`).toBe(true);

    // Ref moved to exactly the oid we pushed.
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(c1);
    // Objects landed with the right types and content.
    expect(git(bare, ["cat-file", "-t", c1])).toBe("commit");
    const body = git(bare, ["cat-file", "-p", c1]);
    expect(body).toContain("c1");
    expect(body).toMatch(/^tree [0-9a-f]{40}$/m);
    // Full connectivity/integrity check by real git.
    expect(() => git(bare, ["fsck", "--strict"])).not.toThrow();
  });

  it("fast-forwards an existing ref", async () => {
    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    await server.refStore.update("refs/heads/main", c1);
    expect((await push("refs/heads/main:refs/heads/main")).success).toBe(true);
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(c1);

    // c2 descends from c1 ⇒ fast-forward, accepted.
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    expect((await push("refs/heads/main:refs/heads/main")).success).toBe(true);
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(c2);
    expect(() => git(bare, ["fsck", "--strict"])).not.toThrow();
  });

  it("rejects a non-fast-forward update (denyNonFastForwards), leaving the ref intact", async () => {
    git(bare, ["config", "receive.denyNonFastForwards", "true"]);

    const c1 = await commitInRepo(server, "c1", { "a.txt": "hello\n" });
    const c2 = await commitInRepo(server, "c2", { "b.txt": "world\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2);
    expect((await push("refs/heads/main:refs/heads/main")).success).toBe(true);
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(c2);

    // A sibling of c2 (shares parent c1) is NOT a descendant of c2 ⇒ non-ff.
    const c2x = await commitInRepo(server, "c2x", { "c.txt": "diverge\n" }, [c1]);
    await server.refStore.update("refs/heads/main", c2x);
    const result = await push("refs/heads/main:refs/heads/main");

    // Ground truth: real git kept the ref at c2 (the non-ff update was rejected).
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(c2);
    // And our client surfaced the rejection as a failed push.
    expect(result.success).toBe(false);
  });
});
