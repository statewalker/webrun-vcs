/**
 * Direction A (fetch): our transport client ↔ real `git upload-pack`.
 *
 * Spawns the real `git upload-pack <repo>` over stdio (protocol v1 pkt-line)
 * and drives it with the transport's `fetchOverDuplex`, cloning into a fresh
 * in-memory vcs-core repository. Compatibility is asserted against the real
 * git CLI: advertised refs (`show-ref`), imported object identity
 * (`rev-list --objects --all`), and incremental transfer with a "have".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchOverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  type Fixture,
  git,
  gitAvailable,
  makeC1OnlyRepo,
  makeFixtureRepo,
  spawnGitService,
} from "./helpers.js";

const HAS_GIT = gitAvailable();
const describeGit = HAS_GIT ? describe : describe.skip;

if (!HAS_GIT) {
  // eslint-disable-next-line no-console
  console.warn("[interop] real `git` binary not found — skipping real-git interop tests");
}

describeGit("Interop A · fetch ← real git upload-pack", () => {
  let fx: Fixture;

  beforeAll(() => {
    fx = makeFixtureRepo();
  });
  afterAll(() => {
    cleanupDir(fx.root);
  });

  it("clones every object real git has, with identical git oids", async () => {
    const client = await createTransportRepo();
    const duplex = spawnGitService("upload-pack", fx.dir);
    try {
      const result = await fetchOverDuplex({
        duplex,
        repository: client.facade,
        refStore: client.refStore,
      });

      expect(result.success, `fetch failed: ${result.error}\n${duplex.stderr()}`).toBe(true);

      // (a) advertised refs/oids EQUAL `git show-ref`
      const showRef = parseShowRef(git(fx.dir, ["show-ref"]));
      const updated = result.updatedRefs ?? new Map<string, string>();
      for (const [name, oid] of showRef) {
        expect(updated.get(name), `ref ${name}`).toBe(oid);
      }

      // (b) every object real git has imports under the SAME oid
      const allOids = parseRevListObjects(git(fx.dir, ["rev-list", "--objects", "--all"]));
      for (const oid of allOids) {
        expect(await client.facade.has(oid), `object ${oid} missing after clone`).toBe(true);
      }
    } finally {
      await duplex.close();
      await client.close();
    }
  });

  it("transfers only the missing objects when the client already has c1", async () => {
    // A separate real repo holding ONLY c1 (deterministic ⇒ identical c1 oid).
    const old = makeC1OnlyRepo();
    const client = await createTransportRepo();

    // Full baseline count: how many objects a fresh clone of the full repo pulls.
    const baselineRepo = await createTransportRepo();
    let baselineImported: number;
    const baseDuplex = spawnGitService("upload-pack", fx.dir);
    try {
      const base = await fetchOverDuplex({
        duplex: baseDuplex,
        repository: baselineRepo.facade,
        refStore: baselineRepo.refStore,
      });
      expect(base.success).toBe(true);
      baselineImported = baselineRepo.imports.at(-1)?.objectsImported ?? 0;
      expect(baselineImported).toBeGreaterThan(0);
    } finally {
      await baseDuplex.close();
      await baselineRepo.close();
    }

    try {
      // Step 1: clone the c1-only repo ⇒ client holds exactly c1's objects.
      const cloneOld = spawnGitService("upload-pack", old.dir);
      try {
        const r = await fetchOverDuplex({
          duplex: cloneOld,
          repository: client.facade,
          refStore: client.refStore,
        });
        expect(r.success, `clone-old failed: ${r.error}\n${cloneOld.stderr()}`).toBe(true);
      } finally {
        await cloneOld.close();
      }
      expect(await client.facade.has(fx.c1)).toBe(true);
      expect(await client.facade.has(fx.c2)).toBe(false);

      // Step 2: incremental fetch from the FULL repo, offering c1 as a "have".
      const inc = spawnGitService("upload-pack", fx.dir);
      try {
        const result = await fetchOverDuplex({
          duplex: inc,
          repository: client.facade,
          refStore: client.refStore,
          localHead: "refs/heads/main",
        });
        expect(result.success, `incremental failed: ${result.error}\n${inc.stderr()}`).toBe(true);
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
