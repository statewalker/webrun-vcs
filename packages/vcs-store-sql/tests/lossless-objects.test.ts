/**
 * The SQL native stores keep commits and tags byte for byte (statewalker/webrun-vcs#399): an
 * object the parsed columns cannot rebuild (a `mergetag` header, an unknown `change-id` header,
 * a Latin-1 author name, a tag with an extra header and a non-UTF-8 message) keeps its bytes in
 * the row's `raw` column, so `importObject` and `importPack` give back the object's own id and
 * `exportObject` its own bytes. The three commits are git.git's (fixtures/git-git-commits/,
 * `git cat-file commit <id>`), found by the census over git.git.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HistoryWithOperations,
  ObjectIdMismatchError,
  type ObjectTypeString,
  writePack,
} from "@statewalker/vcs-core";
import { bytesToHex, createSha1 } from "@statewalker/vcs-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import type { DatabaseClient } from "../src/database-client.js";
import { getSchemaVersion, initializeSchema, rollbackMigration } from "../src/migrations/index.js";
import { createSqlObjectStores } from "../src/object-storage/index.js";
import { SQLHistoryFactory } from "../src/sql-storage-backend.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "git-git-commits");
const COMMITS = readdirSync(FIXTURES).map((id) => ({
  id,
  bytes: new Uint8Array(readFileSync(join(FIXTURES, id))),
}));

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A tag with an extra header (`x-extra`) and a Latin-1 message. */
const TAG = latin1(
  "object 7eb93c89651c47c8095d476251f2e4314656b292\n" +
    "type commit\n" +
    "tag v-latin1\n" +
    "tagger David K\xe5gedal <davidk@lysator.liu.se> 1126078160 +0200\n" +
    "x-extra kept\n" +
    "\n" +
    "Gr\xfc\xdfe aus K\xe5gedal\n",
);

function idOf(type: ObjectTypeString, data: Uint8Array): string {
  return bytesToHex(
    createSha1()
      .update(new TextEncoder().encode(`${type} ${data.length}\0`))
      .update(data)
      .digest(),
  );
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function exported(history: HistoryWithOperations, id: string) {
  const { type, content } = await history.serialization.exportObject(id);
  return { type, bytes: await collect(content) };
}

describe("SQL native stores keep commits and tags byte for byte (#399)", () => {
  let db: DatabaseClient;
  let history: HistoryWithOperations;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    history = await new SQLHistoryFactory().createHistory({ db });
    await history.initialize();
  });

  afterEach(async () => {
    await history.close();
  });

  it.each(COMMITS.map((c) => [c.id, c] as const))(
    "importObject keeps git.git's commit %s",
    async (id, { bytes }) => {
      expect(idOf("commit", bytes)).toBe(id);
      expect(await history.serialization.importObject("commit", once(bytes), bytes.length)).toBe(
        id,
      );
      const out = await exported(history, id);
      expect(out.type).toBe("commit");
      expect(Buffer.from(out.bytes).equals(Buffer.from(bytes))).toBe(true);
      // the parsed view still answers
      const commit = await history.commits.load(id);
      expect(commit?.parents.length).toBeGreaterThan(0);
      expect(await history.commits.getTree(id)).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("importObject keeps a tag with an extra header and a Latin-1 message", async () => {
    const id = idOf("tag", TAG);
    expect(await history.serialization.importObject("tag", once(TAG), TAG.length)).toBe(id);
    const out = await exported(history, id);
    expect(out.type).toBe("tag");
    expect(Buffer.from(out.bytes).equals(Buffer.from(TAG))).toBe(true);
    expect((await history.tags.load(id))?.tag).toBe("v-latin1");
    expect(await history.tags.getTarget(id)).toBe("7eb93c89651c47c8095d476251f2e4314656b292");
  });

  it("importPack keeps every one of them, and a pack written back holds the same objects", async () => {
    const source = createSqlObjectStores({ db: await initialized() });
    const ids: string[] = [];
    for (const { bytes } of COMMITS)
      ids.push(await source.objects.put("commit", bytes.length, [bytes]));
    ids.push(await source.objects.put("tag", TAG.length, [TAG]));
    expect(ids).toEqual([...COMMITS.map((c) => c.id), idOf("tag", TAG)]);

    const pack = await collect(writePack(source.objects, ids));
    const result = await history.serialization.importPack(
      (async function* () {
        yield pack;
      })(),
    );
    expect(result.objectsImported).toBe(ids.length);
    for (const { id, bytes } of COMMITS) {
      expect(Buffer.from((await exported(history, id)).bytes).equals(Buffer.from(bytes))).toBe(
        true,
      );
    }
    expect(Buffer.from((await exported(history, ids[3])).bytes).equals(Buffer.from(TAG))).toBe(
      true,
    );

    // exported through the SQL stores and imported elsewhere: the same ids
    const back = await collect(history.serialization.createPack(list(ids)));
    const other = await new SQLHistoryFactory().createHistory({ db: await SqlJsAdapter.create() });
    await other.initialize();
    await other.serialization.importPack(
      (async function* () {
        yield back;
      })(),
    );
    for (const id of ids) expect(await other.serialization.exportObject(id)).toBeTruthy();
    await other.close();
  });

  it("keeps only what the columns cannot rebuild in `raw`", async () => {
    const plain = latin1(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
        "author A U Thor <author@example.com> 1112911993 -0700\n" +
        "committer C O Mitter <committer@example.com> 1112911993 -0700\n" +
        "\ninitial\n",
    );
    await history.serialization.importObject("commit", once(plain), plain.length);
    for (const { bytes } of COMMITS)
      await history.serialization.importObject("commit", once(bytes), bytes.length);
    const rows = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM vcs_commit WHERE raw IS NOT NULL",
    );
    expect(rows[0].n).toBe(COMMITS.length);
  });

  it("commits.storeRaw refuses bytes that are not a commit", async () => {
    await expect(history.commits.storeRaw?.(latin1("not a commit\n"))).rejects.toThrow();
  });

  it("importObject over typed stores that cannot keep the bytes refuses instead of storing another id", async () => {
    const { DefaultSerializationApi } = await import("@statewalker/vcs-core");
    const commits = history.commits;
    const lossy = new Proxy(commits, {
      get: (target, key) =>
        key === "storeRaw" || key === "raw"
          ? undefined
          : (Reflect.get(target, key) as unknown as { bind?: unknown }) instanceof Function
            ? (Reflect.get(target, key) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, key),
    });
    const api = new DefaultSerializationApi({
      history: { blobs: history.blobs, trees: history.trees, commits: lossy, tags: history.tags },
    });
    const { bytes } = COMMITS[0];
    await expect(api.importObject("commit", once(bytes), bytes.length)).rejects.toBeInstanceOf(
      ObjectIdMismatchError,
    );
    expect(await commits.has(COMMITS[0].id)).toBe(false);
  });
});

describe("migration 10 (raw commit and tag bytes)", () => {
  it("rows written before keep reading; a rollback refuses while raw bytes would be lost", async () => {
    const db = await SqlJsAdapter.create();
    await initializeSchema(db);
    expect(await getSchemaVersion(db)).toBe(10);

    await rollbackMigration(db, 9);
    expect(await getSchemaVersion(db)).toBe(9);
    const history = await new SQLHistoryFactory().createHistory({ db, autoMigrate: false });
    await history.initialize();
    const plain = latin1(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
        "author A U Thor <author@example.com> 1112911993 -0700\n" +
        "committer C O Mitter <committer@example.com> 1112911993 -0700\n" +
        "\nwritten at version 9\n",
    );
    // a row of the old schema, as the old store wrote it
    await db.execute(
      `INSERT INTO vcs_commit (commit_id, tree_id, author_name, author_email, author_timestamp,
        author_tz, committer_name, committer_email, committer_timestamp, committer_tz, message,
        created_at) VALUES (?, ?, 'A U Thor', 'author@example.com', 1112911993, '-0700',
        'C O Mitter', 'committer@example.com', 1112911993, '-0700', 'written at version 9\n', 0)`,
      [idOf("commit", plain), "4b825dc642cb6eb9a060e54bf8d69288fbee4904"],
    );

    await initializeSchema(db);
    expect(await getSchemaVersion(db)).toBe(10);
    const out = await exported(history, idOf("commit", plain));
    expect(Buffer.from(out.bytes).equals(Buffer.from(plain))).toBe(true);

    // nothing raw yet: the rollback goes through and the column goes
    await rollbackMigration(db, 9);
    expect(await getSchemaVersion(db)).toBe(9);
    await initializeSchema(db);

    const { id, bytes } = COMMITS[0];
    expect(await history.serialization.importObject("commit", once(bytes), bytes.length)).toBe(id);
    await expect(rollbackMigration(db, 9)).rejects.toThrow(/raw/);
    expect(await getSchemaVersion(db)).toBe(10);
    await history.close();
  });
});

async function initialized() {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  return db;
}

async function* once(bytes: Uint8Array) {
  yield bytes;
}

async function* list(ids: string[]) {
  yield* ids;
}
