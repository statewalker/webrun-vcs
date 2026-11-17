/**
 * `git fsck` over the stores without files (memory, KV, SQL): the object graph checks run on
 * `history.objects`, reflogs come from the refs store and the index from the staging area.
 * And git's object checks and message severities on their own.
 */

import type { GitObjects, History, Refs } from "@statewalker/vcs-core";
import {
  createKvObjectStores,
  KVRefStore,
  KVStaging,
  MemoryKVAdapter,
} from "@statewalker/vcs-store-kv";
import {
  createMemoryObjectStores,
  MemoryRefs,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import {
  createSqlObjectStores,
  initializeSchema,
  SQLRefStore,
  SQLStaging,
} from "@statewalker/vcs-store-sql";
import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
import type { Staging } from "@statewalker/vcs-working-tree";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import {
  FsckMessageTypes,
  fsckCommit,
  fsckTag,
  fsckTree,
  Git,
  parseFsckMsgId,
  UnknownFsckMsgIdError,
} from "../src/index.js";
import { createMockWorktree } from "./mock-worktree-store.js";
import { createSimpleHistory } from "./simple-history-store.js";

interface Backend {
  git: Git;
  objects: GitObjects;
  refs: Refs;
  staging: Staging;
  cleanup?: () => Promise<void>;
}

function assemble(
  stores: ReturnType<typeof createMemoryObjectStores>,
  refs: Refs,
  staging: Staging,
): Backend {
  const history: History = createSimpleHistory({ ...stores, refs });
  Object.defineProperty(history, "objects", { value: stores.objects });
  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout: new MemoryCheckout({ staging }),
    worktree: createMockWorktree(),
  });
  return { git: Git.fromWorkingCopy(workingCopy), objects: stores.objects, refs, staging };
}

const backends: { name: string; create: () => Promise<Backend> }[] = [
  {
    name: "memory",
    create: async () =>
      assemble(createMemoryObjectStores(), new MemoryRefs(), new MemoryStagingStore()),
  },
  {
    name: "kv",
    create: async () => {
      const kv = new MemoryKVAdapter();
      return assemble(createKvObjectStores({ kv }), new KVRefStore(kv), new KVStaging(kv));
    },
  },
  {
    name: "sql",
    create: async () => {
      const db = await SqlJsAdapter.create();
      await initializeSchema(db);
      const backend = assemble(
        createSqlObjectStores({ db }),
        new SQLRefStore(db),
        new SQLStaging(db),
      );
      return { ...backend, cleanup: () => db.close() };
    },
  },
];

const enc = new TextEncoder();
const hexBytes = (id: string) => Uint8Array.from(id.match(/../g) ?? [], (h) => parseInt(h, 16));

function tree(entries: [string, string, string][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [mode, name, id] of entries) parts.push(enc.encode(`${mode} ${name}\0`), hexBytes(id));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const put = (
  objects: GitObjects,
  type: "blob" | "tree" | "commit" | "tag",
  content: Uint8Array | string,
) => {
  const bytes = typeof content === "string" ? enc.encode(content) : content;
  return objects.put(type, bytes.length, [bytes]);
};

const ident = "A U Thor <a@example.com> 1700000000 +0000";
const commitText = (treeId: string, parents: string[] = [], message = "m\n") =>
  `tree ${treeId}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${ident}\ncommitter ${ident}\n\n${message}`;

for (const { name, create } of backends) {
  describe(`fsck over the ${name} store`, () => {
    let backend: Backend | undefined;
    afterEach(async () => {
      await backend?.cleanup?.();
      backend = undefined;
    });

    async function repo() {
      backend = await create();
      const { objects, refs } = backend;
      const blob = await put(objects, "blob", "hello\n");
      const root = await put(objects, "tree", tree([["100644", "hello.txt", blob]]));
      const c1 = await put(objects, "commit", commitText(root));
      const blob2 = await put(objects, "blob", "hello again\n");
      const root2 = await put(objects, "tree", tree([["100644", "hello.txt", blob2]]));
      const c2 = await put(objects, "commit", commitText(root2, [c1]));
      await refs.set("refs/heads/main", c2);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      return { ...backend, blob, root, c1, c2, blob2, root2 };
    }

    it("a sound repository has nothing to report", async () => {
      const { git } = await repo();
      const r = await git.fsck().call();
      expect(r).toMatchObject({ exitCode: 0, output: "", errorOutput: "" });
      const all = await (await create()).git.fsck().setRoot(true).call();
      // a store without HEAD, as git with a missing .git/HEAD
      expect(all.errorOutput).toBe("error: invalid HEAD\nnotice: No default references\n");
      expect(all.exitCode).toBe(8);
    });

    it("lists dangling and unreachable objects, and roots", async () => {
      const { git, objects, root, c1 } = await repo();
      const loose = await put(objects, "blob", "nobody\n");
      const orphan = await put(objects, "commit", commitText(root, [c1], "orphan\n"));
      const r = await git.fsck().call();
      expect(r.exitCode).toBe(0);
      expect(r.output.split("\n").filter(Boolean).sort()).toEqual(
        [`dangling blob ${loose}`, `dangling commit ${orphan}`].sort(),
      );
      const roots = await git.fsck().setRoot(true).setDangling(false).call();
      expect(roots.output).toBe(`root ${c1}\n`);
      const unreachable = await git.fsck().setUnreachable(true).call();
      expect(
        unreachable.findings
          .filter((f) => f.kind === "unreachable")
          .map((f) => f.objectId)
          .sort(),
      ).toEqual([loose, orphan].sort());
    });

    it("reports a missing blob with the tree that points to it", async () => {
      const { git, objects, refs, c2 } = await repo();
      const ghost = "1234567890123456789012345678901234567890";
      const broken = await put(objects, "tree", tree([["100644", "ghost", ghost]]));
      const c3 = await put(objects, "commit", commitText(broken, [c2]));
      await refs.set("refs/heads/main", c3);
      const r = await git.fsck().setNameObjects(true).call();
      expect(r.exitCode).toBe(2);
      expect(r.output).toBe(
        `broken link from    tree ${broken} (refs/heads/main:)\n` +
          `              to    blob ${ghost} (refs/heads/main:ghost)\n` +
          `missing blob ${ghost} (refs/heads/main:ghost)\n`,
      );
      const c = await git.fsck().setConnectivityOnly(true).call();
      expect(c.exitCode).toBe(2);
      expect(c.findings.filter((f) => f.kind === "missing").map((f) => f.objectId)).toEqual([
        ghost,
      ]);
    });

    it("checks objects with git's message ids, severities and config", async () => {
      const { git, objects, blob } = await repo();
      const dup = await put(
        objects,
        "tree",
        tree([
          ["100644", "a", blob],
          ["100644", "a", blob],
        ]),
      );
      const padded = await put(objects, "tree", tree([["0100644", "a", blob]]));
      let r = await git.fsck().call();
      expect(r.exitCode).toBe(1);
      expect(r.errorOutput.split("\n").filter(Boolean).sort()).toEqual(
        [
          `error in tree ${dup}: duplicateEntries: contains duplicate file entries`,
          `warning in tree ${padded}: zeroPaddedFilemode: contains zero-padded file modes`,
        ].sort(),
      );
      r = await git.fsck().setStrict(true).setMessageType("duplicateEntries", "ignore").call();
      expect(r.errorOutput).toBe(
        `error in tree ${padded}: zeroPaddedFilemode: contains zero-padded file modes\n`,
      );
      expect(r.findings.find((f) => f.kind === "object")).toMatchObject({
        msgId: "zeroPaddedFilemode",
        severity: "error",
        objectId: padded,
      });
      expect(() => git.fsck().setMessageType("noSuchThing", "warn")).not.toThrow();
      await expect(git.fsck().setMessageType("noSuchThing", "warn").call()).rejects.toThrow(
        UnknownFsckMsgIdError,
      );
    });

    it("roots in the reflogs and the index keep objects reachable", async () => {
      const { git, objects, staging } = await repo();
      const staged = await put(objects, "blob", "staged\n");
      await staging.setEntry({ path: "staged.txt", mode: 0o100644, objectId: staged });
      const r = await git.fsck().setUnreachable(true).call();
      expect(r.findings.some((f) => f.objectId === staged)).toBe(false);
    });
  });
}

describe("fsck object checks", () => {
  const collect = (strict = false) => {
    const types = new FsckMessageTypes({ strict });
    const found: string[] = [];
    const report = (id: Parameters<Parameters<typeof fsckCommit>[1]>[0], message: string) => {
      const severity = types.severity(id);
      if (severity === "ignore") return 0;
      found.push(`${severity}: ${id}: ${message}`);
      return severity === "error" ? 1 : 0;
    };
    return { types, found, report };
  };
  const blob = "ce013625030ba8dba906f756967f9e9ca394464a";

  it("parses message ids as git does", () => {
    expect(parseFsckMsgId("duplicateentries")).toBe("duplicateEntries");
    expect(parseFsckMsgId("DUPLICATE_ENTRIES")).toBe("duplicateEntries");
    expect(parseFsckMsgId("nope")).toBeUndefined();
    const types = new FsckMessageTypes();
    expect(() => types.set("nulInHeader", "warn")).toThrow(/Cannot demote/);
    types.set("largePathname", "error:10");
    expect(types.maxTreeEntryLength).toBe(10);
    expect(types.severity("largePathname")).toBe("error");
    expect(types.severity("badFilemode")).toBe("warning");
    expect(types.severity("extraHeaderEntry")).toBe("ignore");
  });

  it("checks commits in git's order, stopping at the first error", () => {
    const { found, report } = collect();
    expect(fsckCommit(enc.encode(`tree ${blob}\nauthor A <a@x> 1 +0000\n\nm\n`), report)).toBe(1);
    expect(found).toEqual(["error: missingCommitter: invalid format - expected 'committer' line"]);
    found.length = 0;
    fsckCommit(
      enc.encode(`tree ${blob}\nauthor A <a@x> 1 +000\ncommitter C <c@x> 1 +0000\n\nm\n`),
      report,
    );
    expect(found).toEqual(["error: badTimezone: invalid author/committer line - bad time zone"]);
    found.length = 0;
    fsckCommit(
      enc.encode(`tree ${blob}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000`),
      report,
    );
    expect(found).toEqual(["error: unterminatedHeader: unterminated header"]);
  });

  it("checks tags", () => {
    const { found, report } = collect();
    fsckTag(enc.encode(`object ${blob}\ntype blob\ntag v1\n\nm\n`), report);
    expect(found).toEqual(["warning: missingTaggerEntry: invalid format - expected 'tagger' line"]);
  });

  it("checks trees: names, modes, order", () => {
    const { types, found, report } = collect(true);
    const bytes = tree([
      ["100664", "b", blob],
      ["100644", ".git", blob],
      ["40000", "a", blob],
    ]);
    const gitmodules: string[] = [];
    fsckTree(bytes, types, report, () => {}, { gitmodules, gitattributes: [] });
    expect(found).toEqual([
      "error: hasDotgit: contains '.git'",
      "warning: badFilemode: contains bad file modes",
      "error: treeNotSorted: not properly sorted",
    ]);
  });
});
