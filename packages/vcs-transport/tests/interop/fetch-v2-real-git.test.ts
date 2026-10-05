/**
 * Direction A (fetch), protocol **v2**: our transport client ↔ real
 * `git upload-pack` speaking Git protocol v2.
 *
 * Spawns real `git upload-pack <repo>` with `GIT_PROTOCOL=version=2` over stdio
 * and drives it with the transport's `fetchV2OverDuplex`, cloning into a fresh
 * in-memory vcs-core repository. Compatibility is asserted against the real git
 * CLI: the v2 `ls-refs` result (`show-ref`), imported object identity
 * (`rev-list --objects --all`), and incremental transfer with a "have".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchV2OverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  type Fixture,
  git,
  gitAvailable,
  makeC1OnlyRepo,
  makeFixtureRepo,
  spawnGitServiceV2,
} from "./helpers.js";

const HAS_GIT = gitAvailable();
const describeGit = HAS_GIT ? describe : describe.skip;

if (!HAS_GIT) {
  // eslint-disable-next-line no-console
  console.warn("[interop] real `git` binary not found — skipping real-git v2 interop tests");
}

describeGit("Interop A · fetch ← real git upload-pack (protocol v2)", () => {
  let fx: Fixture;

  beforeAll(() => {
    fx = makeFixtureRepo();
  });
  afterAll(() => {
    cleanupDir(fx.root);
  });

  it("clones every object real git has over protocol v2, with identical git oids", async () => {
    const client = await createTransportRepo();
    const duplex = spawnGitServiceV2("upload-pack", fx.dir);
    try {
      const result = await fetchV2OverDuplex({
        duplex,
        repository: client.facade,
        refStore: client.refStore,
      });

      expect(result.success, `v2 fetch failed: ${result.error}\n${duplex.stderr()}`).toBe(true);

      // (a) v2 ls-refs result EQUALS `git show-ref` (refs + oids).
      const showRef = parseShowRef(git(fx.dir, ["show-ref"]));
      const updated = result.updatedRefs ?? new Map<string, string>();
      expect(updated.size).toBe(showRef.size);
      for (const [name, oid] of showRef) {
        expect(updated.get(name), `ref ${name}`).toBe(oid);
      }
      expect(updated.get("refs/heads/main")).toBe(fx.c2);

      // (b) every object real git has imports under the SAME git oid.
      const allOids = parseRevListObjects(git(fx.dir, ["rev-list", "--objects", "--all"]));
      for (const oid of allOids) {
        expect(await client.facade.has(oid), `object ${oid} missing after v2 clone`).toBe(true);
      }
    } finally {
      await duplex.close();
      await client.close();
    }
  });

  it("transfers only the missing objects over v2 when the client already has c1", async () => {
    // A separate real repo holding ONLY c1 (deterministic ⇒ identical c1 oid).
    const old = makeC1OnlyRepo();
    const client = await createTransportRepo();

    // Full baseline: how many objects a fresh v2 clone of the full repo pulls.
    const baselineRepo = await createTransportRepo();
    let baselineImported: number;
    const baseDuplex = spawnGitServiceV2("upload-pack", fx.dir);
    try {
      const base = await fetchV2OverDuplex({
        duplex: baseDuplex,
        repository: baselineRepo.facade,
        refStore: baselineRepo.refStore,
      });
      expect(base.success, `v2 baseline failed: ${base.error}\n${baseDuplex.stderr()}`).toBe(true);
      baselineImported = baselineRepo.imports.at(-1)?.objectsImported ?? 0;
      expect(baselineImported).toBeGreaterThan(0);
    } finally {
      await baseDuplex.close();
      await baselineRepo.close();
    }

    try {
      // Step 1: v2-clone the c1-only repo ⇒ client holds exactly c1's objects.
      const cloneOld = spawnGitServiceV2("upload-pack", old.dir);
      try {
        const r = await fetchV2OverDuplex({
          duplex: cloneOld,
          repository: client.facade,
          refStore: client.refStore,
        });
        expect(r.success, `v2 clone-old failed: ${r.error}\n${cloneOld.stderr()}`).toBe(true);
      } finally {
        await cloneOld.close();
      }
      expect(await client.facade.has(fx.c1)).toBe(true);
      expect(await client.facade.has(fx.c2)).toBe(false);

      // Step 2: incremental v2 fetch from the FULL repo, offering c1 as a "have".
      const inc = spawnGitServiceV2("upload-pack", fx.dir);
      try {
        const result = await fetchV2OverDuplex({
          duplex: inc,
          repository: client.facade,
          refStore: client.refStore,
          localHead: "refs/heads/main",
        });
        expect(result.success, `v2 incremental failed: ${result.error}\n${inc.stderr()}`).toBe(
          true,
        );
        expect(await client.facade.has(fx.c2)).toBe(true);
        expect(result.updatedRefs?.get("refs/heads/main")).toBe(fx.c2);
        // Negotiation worked: real git omitted c1's already-held objects, so the
        // incremental pack carried strictly fewer objects than a full clone.
        const incImported = client.imports.at(-1)?.objectsImported ?? 0;
        expect(incImported).toBeGreaterThan(0);
        expect(incImported).toBeLessThan(baselineImported);
      } finally {
        await inc.close();
      }
    } finally {
      cleanupDir(old.root);
      await client.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// git CLI output parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseShowRef(out: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [oid, name] = line.split(" ");
    refs.set(name, oid);
  }
  return refs;
}

function parseRevListObjects(out: string): string[] {
  const oids: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    oids.push(line.split(" ")[0]);
  }
  return oids;
}
