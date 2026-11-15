/**
 * Conformance suite for `GitObjects.beginQuarantine` (git's receive-pack `tmp_objdir`): objects
 * written through a quarantine stay invisible to the store until `commit`, `discard` removes
 * them all, reads through the quarantine see both, `importPack` with `quarantine: true` keeps a
 * received pack aside (and leaves nothing behind when the pack is refused), and gc's sweep
 * removes what a crashed process left.
 */

import {
  createGitObjects,
  type GitObjects,
  importPack,
  MemoryRawStorage,
  type ObjectTypeString,
  RAW_QUARANTINE_PREFIX,
  type RawStorage,
  rawStorageStaging,
  sweepStaleRawStaging,
  writePack,
} from "@statewalker/vcs-core";
import { timestampedId } from "@statewalker/vcs-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface ObjectQuarantineTestContext {
  /** The repository's object kernel, with `beginQuarantine` */
  objects: GitObjects;
  /** How many quarantines (key groups, directories) the backend holds right now */
  quarantines(): Promise<number>;
  /** Plants what a crashed quarantine leaves behind, `ageMs` old, holding one object */
  plantLeftover(ageMs: number): Promise<void>;
  /** Runs the backend's sweep of stale leftovers (what gc calls); returns how many went */
  sweep(olderThanMs: number): Promise<number>;
  cleanup?: () => Promise<void>;
}

/**
 * The context helpers for a kernel over `rawStorageStaging(raw)` (memory, KV, SQL): a
 * quarantine is the `incoming-<timestampedId>/` keys of `raw`, swept by
 * `sweepStaleRawStaging` (what `GitObjects.sweepStale` runs for gc).
 *
 * @example
 * ```typescript
 * createObjectQuarantineTests("Memory", async () => {
 *   const raw = new MemoryRawStorage();
 *   return { objects: createGitObjects(rawStorageStaging(raw)), ...rawQuarantineHelpers(raw) };
 * });
 * ```
 */
export function rawQuarantineHelpers(
  raw: RawStorage,
): Pick<ObjectQuarantineTestContext, "quarantines" | "plantLeftover" | "sweep"> {
  return {
    async quarantines() {
      const prefixes = new Set<string>();
      for await (const key of raw.keys()) {
        if (key.startsWith(RAW_QUARANTINE_PREFIX)) prefixes.add(key.slice(0, key.indexOf("/")));
      }
      return prefixes.size;
    },
    async plantLeftover(ageMs) {
      const prefix = `${RAW_QUARANTINE_PREFIX}${timestampedId(Date.now() - ageMs)}/`;
      await raw.store(
        `${prefix}${"ab".repeat(20)}`,
        (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })(),
      );
    },
    sweep: (olderThanMs) => sweepStaleRawStaging(raw, { olderThanMs }),
  };
}

const enc = new TextEncoder();
const HOUR = 60 * 60 * 1000;

async function readAll(objects: GitObjects, id: string): Promise<string> {
  const obj = await objects.get(id);
  if (!obj) throw new Error(`missing ${id}`);
  let text = "";
  const dec = new TextDecoder();
  for await (const c of obj.content) text += dec.decode(c, { stream: true });
  return text + dec.decode();
}

async function listAll(objects: GitObjects): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const id of objects.list()) ids.add(id);
  return ids;
}

/** A small history (blobs, a tree, a commit) in a scratch store, and its pack. */
async function samplePack(blobCount: number, tag = "q") {
  const scratch = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
  const ids: string[] = [];
  const entries: Uint8Array[] = [];
  for (let i = 0; i < blobCount; i++) {
    const body = enc.encode(`${tag} blob ${i}\n${"x".repeat(i * 13)}\n`);
    const id = await scratch.put("blob", body.length, [body]);
    ids.push(id);
    const name = enc.encode(`100644 f${String(i).padStart(4, "0")}\0`);
    const raw = new Uint8Array(20);
    for (let k = 0; k < 20; k++) raw[k] = Number.parseInt(id.slice(k * 2, k * 2 + 2), 16);
    entries.push(name, raw);
  }
  const treeBody = new Uint8Array(entries.reduce((n, e) => n + e.length, 0));
  let at = 0;
  for (const e of entries) {
    treeBody.set(e, at);
    at += e.length;
  }
  const tree = await scratch.put("tree", treeBody.length, [treeBody]);
  const commitBody = enc.encode(
    `tree ${tree}\nauthor T <t@x> 1 +0000\ncommitter T <t@x> 1 +0000\n\n${tag}\n`,
  );
  const commit = await scratch.put("commit", commitBody.length, [commitBody]);
  ids.push(tree, commit);
  const chunks: Uint8Array[] = [];
  for await (const c of writePack(scratch, ids)) chunks.push(c);
  const pack = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  at = 0;
  for (const c of chunks) {
    pack.set(c, at);
    at += c.length;
  }
  return { ids, commit, pack };
}

function streamOf(bytes: Uint8Array, chunk = 997): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
  })();
}

/**
 * @param name Implementation name (e.g. "Memory", "Files")
 * @param factory Creates an empty repository kernel per test
 */
export function createObjectQuarantineTests(
  name: string,
  factory: () => Promise<ObjectQuarantineTestContext>,
): void {
  describe(`GitObjects quarantine [${name}]`, () => {
    let ctx: ObjectQuarantineTestContext;
    let objects: GitObjects;

    beforeEach(async () => {
      ctx = await factory();
      objects = ctx.objects;
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    const begin = () => {
      if (!objects.beginQuarantine) throw new Error(`${name}: no beginQuarantine`);
      return objects.beginQuarantine();
    };

    const put = (o: GitObjects, type: ObjectTypeString, text: string) => {
      const bytes = enc.encode(text);
      return o.put(type, bytes.length, [bytes]);
    };

    it("quarantined objects are invisible to the store until commit, visible after", async () => {
      expect(objects.beginQuarantine).toBeTypeOf("function");
      const q = await begin();
      const a = await put(q.objects, "blob", "quarantined a\n");
      const b = await q.objects.putUnsized("blob", [enc.encode("quarantined b\n")]);
      expect(await q.objects.has(a)).toBe(true);
      expect(await objects.has(a)).toBe(false);
      expect(await objects.has(b)).toBe(false);
      expect(await objects.get(a)).toBeUndefined();
      expect((await listAll(objects)).has(a)).toBe(false);
      expect(await ctx.quarantines()).toBe(1);

      await q.commit();
      expect(await objects.has(a)).toBe(true);
      expect(await objects.has(b)).toBe(true);
      expect(await readAll(objects, a)).toBe("quarantined a\n");
      expect((await listAll(objects)).has(b)).toBe(true);
      expect(await ctx.quarantines()).toBe(0);
    });

    it("discard removes every quarantined object", async () => {
      const q = await begin();
      const ids = [
        await put(q.objects, "blob", "gone 1\n"),
        await put(q.objects, "blob", "gone 2\n"),
        await put(q.objects, "tree", ""),
      ];
      await q.discard();
      await q.discard(); // twice is fine
      for (const id of ids) expect(await objects.has(id)).toBe(false);
      expect(await listAll(objects)).toEqual(new Set());
      expect(await ctx.quarantines()).toBe(0);
    });

    it("reads through the quarantine see the quarantined objects and the store's", async () => {
      const published = await put(objects, "blob", "published\n");
      const q = await begin();
      const pending = await put(q.objects, "blob", "pending\n");
      expect(await readAll(q.objects, published)).toBe("published\n");
      expect(await readAll(q.objects, pending)).toBe("pending\n");
      expect(await q.objects.has(published)).toBe(true);
      expect(await listAll(q.objects)).toEqual(new Set([published, pending]));
      // the view never removes a published object
      expect(await q.objects.remove(published)).toBe(false);
      expect(await objects.has(published)).toBe(true);
      // an object the store has is not written into the quarantine again
      await put(q.objects, "blob", "published\n");
      await q.discard();
      expect(await objects.has(published)).toBe(true);
      expect(await objects.has(pending)).toBe(false);
    });

    it("commit keeps an object published meanwhile, and publishes the rest", async () => {
      const q = await begin();
      const twice = await put(q.objects, "blob", "pushed twice\n");
      const once = await put(q.objects, "blob", "pushed once\n");
      await put(objects, "blob", "pushed twice\n"); // another push published it first
      await q.commit();
      expect(await readAll(objects, twice)).toBe("pushed twice\n");
      expect(await readAll(objects, once)).toBe("pushed once\n");
      expect(await ctx.quarantines()).toBe(0);
    });

    for (const unpackLimit of [1, 1000]) {
      const how = unpackLimit === 1 ? "kept as a pack where the backend keeps packs" : "unpacked";
      it(`importPack({ quarantine: true }) keeps a received pack aside (${how})`, async () => {
        const { ids, pack } = await samplePack(6);
        const result = await importPack(objects, streamOf(pack), { quarantine: true, unpackLimit });
        expect(result.count).toBe(ids.length);
        const q = result.quarantine;
        if (!q) throw new Error("no quarantine");
        for (const id of ids) {
          expect(await objects.has(id)).toBe(false);
          expect(await q.objects.has(id)).toBe(true);
        }
        await q.commit();
        for (const id of ids) expect(await objects.has(id)).toBe(true);
        expect(await ctx.quarantines()).toBe(0);
      });

      it(`importPack({ quarantine: true }) of a refused pack leaves nothing (${how})`, async () => {
        const { ids, pack } = await samplePack(6, "refused");
        // the trailer is broken: every object was read, the pack is refused at its end
        const broken = pack.slice();
        broken[broken.length - 1] = ((broken[broken.length - 1] as number) + 1) & 0xff;
        await expect(
          importPack(objects, streamOf(broken), { quarantine: true, unpackLimit }),
        ).rejects.toThrow();
        for (const id of ids) expect(await objects.has(id)).toBe(false);
        expect(await listAll(objects)).toEqual(new Set());
        expect(await ctx.quarantines()).toBe(0);
      });
    }

    it("a client gone mid-pack leaves nothing", async () => {
      const { ids, pack } = await samplePack(6, "cut");
      const cut = (async function* () {
        yield pack.subarray(0, Math.floor(pack.length / 2));
        throw new Error("connection reset");
      })();
      await expect(importPack(objects, cut, { quarantine: true })).rejects.toThrow();
      for (const id of ids) expect(await objects.has(id)).toBe(false);
      expect(await ctx.quarantines()).toBe(0);
    });

    it("the sweep removes a crashed quarantine once stale, never an open one", async () => {
      await ctx.plantLeftover(2 * HOUR);
      const q = await begin();
      const open = await put(q.objects, "blob", "still open\n");
      expect(await ctx.quarantines()).toBe(2);
      expect(await ctx.sweep(HOUR)).toBe(1);
      expect(await ctx.quarantines()).toBe(1);
      // even an expiry of 0 leaves the open quarantine alone
      await ctx.sweep(0);
      expect(await q.objects.has(open)).toBe(true);
      await q.commit();
      expect(await objects.has(open)).toBe(true);
      expect(await ctx.quarantines()).toBe(0);
    });

    it("a fresh leftover is kept until it is older than the expiry", async () => {
      await ctx.plantLeftover(0);
      expect(await ctx.sweep(HOUR)).toBe(0);
      expect(await ctx.quarantines()).toBe(1);
      expect(await ctx.sweep(0)).toBe(1);
      expect(await ctx.quarantines()).toBe(0);
    });
  });
}
