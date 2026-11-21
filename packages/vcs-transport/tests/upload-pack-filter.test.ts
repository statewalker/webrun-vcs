/**
 * Partial clone filters in upload-pack: the policy read from `uploadpack.allowFilter` and
 * `uploadpackfilter.*` (in config order), the allow-list's refusals with git's messages, the
 * `filter` capability (v0) and `fetch=... filter` feature (v2), refusals sent as `ERR` (an
 * unparsable spec only ends the connection, as git dies), the filtered pack, and the client
 * dropping a filter the server does not take with git's warning.
 */
import { describe, expect, it } from "vitest";
import { createSimpleDuplex } from "../src/adapters/http/http-duplex.js";
import {
  checkUploadPackFilter,
  explicitServerSettingsFromConfig,
  FILTER_NOT_RECOGNIZED,
  fetchPack,
  serveOverDuplex,
  serverSupportsFilter,
  type UploadPackConnection,
  type UploadPackFilterPolicy,
  uploadPackFilterPolicyOf,
  withFilterCapability,
  withFilterFeature,
} from "../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { createTransportRepo, type TransportRepo } from "./interop/helpers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** main: one commit with a file at the root and one in a directory. */
async function smallRepo(): Promise<{ repo: TransportRepo; tip: string }> {
  const repo = await createTransportRepo();
  const blob = await repo.history.blobs.store([encoder.encode("a\n")]);
  const inner = await repo.history.blobs.store([encoder.encode("b\n")]);
  const dir = await repo.history.trees.store([{ name: "b.txt", mode: 0o100644, id: inner }]);
  const tree = await repo.history.trees.store([
    { name: "a.txt", mode: 0o100644, id: blob },
    { name: "dir", mode: 0o040000, id: dir },
  ]);
  const ident = { name: "T", email: "t@example.com", timestamp: 100, tzOffset: "+0000" };
  const tip = await repo.history.commits.store({
    tree,
    parents: [],
    author: ident,
    committer: ident,
    message: "c\n",
  });
  await repo.refStore.update("refs/heads/main", tip);
  return { repo, tip };
}

/** Serves one request (all of it given up front); the raw answer as latin-1 text. */
async function serve(
  repo: TransportRepo,
  request: Uint8Array,
  options: { version: "1" | "2"; uploadPackFilter?: UploadPackFilterPolicy },
): Promise<{ text: string; error?: string }> {
  const out: Uint8Array[] = [];
  const result = await serveOverDuplex({
    duplex: createSimpleDuplex(
      (async function* () {
        yield request;
      })(),
      (data) => {
        out.push(data);
      },
    ),
    repository: repo.facade,
    refStore: repo.refStore,
    service: "git-upload-pack",
    protocolVersion: options.version,
    ...(options.uploadPackFilter ? { uploadPackFilter: options.uploadPackFilter } : {}),
  });
  return { text: decoder.decode(concat(out)), ...(result.error ? { error: result.error } : {}) };
}

function v2Fetch(args: string[]): Uint8Array {
  return concat([
    encodePacketLine("command=fetch\n"),
    encodePacketLine("object-format=sha1\n"),
    encodeDelim(),
    ...args.map((a) => encodePacketLine(`${a}\n`)),
    encodeFlush(),
  ]);
}

function v0Request(tip: string, caps: string, lines: string[]): Uint8Array {
  return concat([
    encodePacketLine(`want ${tip} ${caps}\n`),
    ...lines.map((l) => encodePacketLine(`${l}\n`)),
    encodeFlush(),
    encodePacketLine("done\n"),
  ]);
}

const ALLOW: UploadPackFilterPolicy = { allowFilter: true };

describe("upload-pack filter policy", () => {
  it("reads uploadpack.allowFilter and uploadpackfilter.* in config order", () => {
    expect(uploadPackFilterPolicyOf([])).toBeUndefined();
    expect(uploadPackFilterPolicyOf([{ key: "uploadpack.allowfilter", value: null }])).toEqual({
      allowFilter: true,
    });
    const policy = uploadPackFilterPolicyOf([
      { key: "uploadpack.allowFilter", value: "true" },
      { key: "uploadpackfilter.allow", value: "false" },
      { key: "uploadpackfilter.blob:none.allow", value: "true" },
      { key: "uploadpackfilter.tree.maxdepth", value: "2" },
      // a later tree.allow undoes the maxDepth's allowing, as git reads them in order
      { key: "uploadpackfilter.tree.allow", value: "false" },
    ]);
    expect(policy).toEqual({
      allowFilter: true,
      allowByDefault: false,
      choices: { "blob:none": true, tree: false },
      treeMaxDepth: 2,
    });
    expect(
      uploadPackFilterPolicyOf([{ key: "uploadpackfilter.tree.maxDepth", value: "1k" }])
        ?.treeMaxDepth,
    ).toBe(1024);
  });

  it("is part of the settings a repository's config sets", () => {
    const values: Record<string, unknown[]> = {
      "uploadpack.allowfilter": ["true"],
      "uploadpackfilter.tree.maxdepth": ["0"],
    };
    const config = { getAll: (key: string) => values[key.toLowerCase()] ?? [] };
    expect(explicitServerSettingsFromConfig(config).uploadPackFilter).toEqual({
      allowFilter: true,
      choices: { tree: true },
      treeMaxDepth: 0,
    });
    expect(explicitServerSettingsFromConfig({ getAll: () => [] }).uploadPackFilter).toBeUndefined();
  });

  it("refuses with git's messages", () => {
    const policy: UploadPackFilterPolicy = {
      allowFilter: true,
      allowByDefault: false,
      choices: { "blob:none": true, tree: true, combine: true },
      treeMaxDepth: 1,
    };
    expect(checkUploadPackFilter("blob:none", policy)).toBeUndefined();
    expect(checkUploadPackFilter("tree:1", policy)).toBeUndefined();
    expect(checkUploadPackFilter("tree:2", policy)).toEqual({
      message: "tree filter allows max depth 1, but got 2",
      reported: true,
    });
    expect(checkUploadPackFilter("object:type=blob", policy)).toEqual({
      message: "filter 'object:type' not supported",
      reported: true,
    });
    // a combine's own choice first, then each of its filters
    expect(checkUploadPackFilter("combine:blob:none+blob:limit=1", policy)?.message).toBe(
      "filter 'blob:limit' not supported",
    );
    expect(
      checkUploadPackFilter("combine:blob:none", { ...policy, choices: { "blob:none": true } })
        ?.message,
    ).toBe("filter 'combine' not supported");
    // an unparsable spec: git dies without a packet
    expect(checkUploadPackFilter("tree:x", policy)).toEqual({
      message: "expected 'tree:<depth>'",
      reported: false,
    });
    expect(checkUploadPackFilter("blob:limit=9", undefined)).toBeUndefined();
  });

  it("adds the capability and the feature only with allowFilter", () => {
    expect(withFilterCapability(["a", "b"], ALLOW)).toEqual(["a", "b", "filter"]);
    expect(withFilterCapability(["a"], { allowFilter: false })).toEqual(["a"]);
    expect(withFilterFeature(["fetch=shallow wait-for-done", "x"], ALLOW)).toEqual([
      "fetch=shallow wait-for-done filter",
      "x",
    ]);
    expect(withFilterFeature(["fetch=shallow"], undefined)).toEqual(["fetch=shallow"]);
  });
});

describe("upload-pack serving filters", () => {
  it("v2: advertises fetch=... filter and packs without the blobs", async () => {
    const { repo, tip } = await smallRepo();
    const caps = await serve(repo, encodeFlush(), { version: "2", uploadPackFilter: ALLOW });
    expect(caps.text).toContain("fetch=shallow wait-for-done filter");
    const full = await serve(repo, v2Fetch([`want ${tip}`, "done"]), {
      version: "2",
      uploadPackFilter: ALLOW,
    });
    const filtered = await serve(repo, v2Fetch([`want ${tip}`, "filter blob:none", "done"]), {
      version: "2",
      uploadPackFilter: ALLOW,
    });
    const count = (text: string) => {
      const at = text.indexOf("PACK");
      return at < 0 ? -1 : (text.charCodeAt(at + 10) << 8) | text.charCodeAt(at + 11);
    };
    expect(count(full.text)).toBe(5);
    expect(count(filtered.text)).toBe(3);
  });

  it("v2: refuses as git does", async () => {
    const { repo, tip } = await smallRepo();
    const policy = { allowFilter: true, allowByDefault: false };
    const refused = await serve(repo, v2Fetch([`want ${tip}`, "filter tree:0", "done"]), {
      version: "2",
      uploadPackFilter: policy,
    });
    expect(refused.text).toContain("ERR filter 'tree' not supported");
    expect(refused.text).not.toContain("packfile");
    // not advertised: an unexpected line
    const off = await serve(repo, v2Fetch([`want ${tip}`, "filter blob:none", "done"]), {
      version: "2",
    });
    expect(off.text).toContain("ERR unexpected line: 'filter blob:none'");
    // unparsable, or two of them: git dies without a packet
    for (const args of [["filter tree:x"], ["filter blob:none", "filter tree:0"]]) {
      const died = await serve(repo, v2Fetch([`want ${tip}`, ...args, "done"]), {
        version: "2",
        uploadPackFilter: ALLOW,
      });
      expect(died.text).not.toContain("ERR");
      expect(died.text).not.toContain("packfile");
      expect(died.error).toBeDefined();
    }
  });

  it("v0: advertises filter, needs it negotiated, refuses with ERR", async () => {
    const { repo, tip } = await smallRepo();
    const caps = "multi_ack_detailed side-band-64k ofs-delta";
    const served = await serve(repo, v0Request(tip, `${caps} filter`, ["filter blob:none"]), {
      version: "1",
      uploadPackFilter: ALLOW,
    });
    expect(served.text.split("\n")[0]).toContain(" filter");
    expect(served.text).toContain("PACK");
    // the filter line without the capability: git dies
    const unasked = await serve(repo, v0Request(tip, caps, ["filter blob:none"]), {
      version: "1",
      uploadPackFilter: ALLOW,
    });
    expect(unasked.error).toBe("git upload-pack: filtering capability not negotiated");
    expect(unasked.text).not.toContain("PACK");
    const refused = await serve(repo, v0Request(tip, `${caps} filter`, ["filter tree:3"]), {
      version: "1",
      uploadPackFilter: { allowFilter: true, treeMaxDepth: 2 },
    });
    expect(refused.text).toContain("ERR tree filter allows max depth 2, but got 3");
    expect(refused.text).not.toContain("PACK");
  });
});

describe("fetch client and filters", () => {
  it("drops a filter the server does not take, with git's warning", async () => {
    const warnings: string[] = [];
    let sent = "";
    const connection: UploadPackConnection = {
      version: 2,
      stateless: true,
      capabilities: new Map([["fetch", "shallow"]]),
      async request(body) {
        sent = decoder.decode(concat(body));
        throw new Error("stop");
      },
      async close() {},
    };
    expect(serverSupportsFilter(connection)).toBe(false);
    await expect(
      fetchPack(
        connection,
        { getCommitInfo: async () => undefined },
        {
          wants: ["1".repeat(40)],
          localTips: [],
          filter: "blob:none",
          onWarning: (line) => warnings.push(line),
          importPack: async () => ({
            objectsImported: 0,
            blobsWithDelta: 0,
            treesImported: 0,
            commitsImported: 0,
            tagsImported: 0,
          }),
        },
      ),
    ).rejects.toThrow("stop");
    expect(warnings).toEqual([FILTER_NOT_RECOGNIZED]);
    expect(sent).not.toContain("filter");
  });
});

describe("upload-pack filter config git cannot read", () => {
  it("records the first value git dies on, with git's message", () => {
    const error = (key: string, value: unknown) =>
      uploadPackFilterPolicyOf([{ key, value }])?.configError;
    expect(error("uploadpackfilter.allow", "garbage")).toBe(
      "bad boolean config value 'garbage' for 'uploadpackfilter.allow'",
    );
    expect(error("uploadpack.allowFilter", "maybe")).toBe(
      "bad boolean config value 'maybe' for 'uploadpack.allowfilter'",
    );
    expect(error("uploadpackfilter.blob:none.allow", "x")).toBe(
      "bad boolean config value 'x' for 'uploadpackfilter.blob:none.allow'",
    );
    for (const value of ["10x", "-1", "", "1.5"]) {
      expect(error("uploadpackfilter.tree.maxDepth", value)).toBe(
        `bad numeric config value '${value}' for 'uploadpackfilter.tree.maxdepth' in file config: invalid unit`,
      );
    }
    expect(error("uploadpackfilter.tree.maxDepth", "99999999999999999999")).toBe(
      "bad numeric config value '99999999999999999999' for 'uploadpackfilter.tree.maxdepth' in file config: out of range",
    );
    expect(error("uploadpackfilter.tree.maxDepth", null)).toBe(
      "missing value for 'uploadpackfilter.tree.maxdepth'",
    );
    // git_parse_ulong: hex, octal, units
    const depth = (value: string) =>
      uploadPackFilterPolicyOf([{ key: "uploadpackfilter.tree.maxDepth", value }])?.treeMaxDepth;
    expect(depth("0x10")).toBe(16);
    expect(depth("010")).toBe(8);
    expect(depth("2k")).toBe(2048);
    // booleans as git_config_bool reads them
    expect(uploadPackFilterPolicyOf([{ key: "uploadpackfilter.allow", value: "0" }])).toEqual({
      allowFilter: false,
      allowByDefault: false,
    });
  });

  it("refuses to serve: nothing is advertised (v0 and v2)", async () => {
    const { repo } = await smallRepo();
    const policy = uploadPackFilterPolicyOf([
      { key: "uploadpack.allowFilter", value: "true" },
      { key: "uploadpackfilter.allow", value: "garbage" },
    ]);
    for (const version of ["1", "2"] as const) {
      const served = await serve(repo, encodeFlush(), {
        version,
        ...(policy ? { uploadPackFilter: policy } : {}),
      });
      expect(served.text).toBe("");
      expect(served.error).toBe("bad boolean config value 'garbage' for 'uploadpackfilter.allow'");
    }
  });
});

describe("upload-pack filter parity", () => {
  it("v0: checks a filter line as it is read, in the loop of the wants", async () => {
    const { repo, tip } = await smallRepo();
    const caps = "multi_ack_detailed side-band-64k ofs-delta";
    // git dies at the filter line (not negotiated) before it reads the bad deepen
    const served = await serve(repo, v0Request(tip, caps, ["filter blob:none", "deepen 0"]), {
      version: "1",
      uploadPackFilter: ALLOW,
    });
    expect(served.error).toBe("git upload-pack: filtering capability not negotiated");
    expect(served.text).not.toContain("ERR");
    // a refused filter is sent as ERR before a later bad deepen
    const refused = await serve(
      repo,
      v0Request(tip, `${caps} filter`, ["filter tree:3", "deepen 0"]),
      { version: "1", uploadPackFilter: { allowFilter: true, treeMaxDepth: 2 } },
    );
    expect(refused.text).toContain("ERR tree filter allows max depth 2, but got 3");
    expect(refused.text).not.toContain("Invalid deepen");
  });

  it("resolves a sparse:oid name as get_oid: abbreviated, upper-case hex, revision suffixes", async () => {
    const { repo, tip } = await smallRepo();
    const tree = (await repo.history.commits.load(tip))?.tree as string;
    let blobId = "";
    for await (const e of (await repo.history.trees.load(tree)) ?? []) {
      if (e.name === "a.txt") blobId = e.id;
    }
    const fetchWith = (name: string) =>
      serve(repo, v2Fetch([`want ${tip}`, `filter sparse:oid=${name}`, "done"]), {
        version: "2",
        uploadPackFilter: ALLOW,
      });
    // resolved: the facade has no pattern parser, so pack-objects dies parsing it
    for (const name of [
      blobId,
      blobId.toUpperCase(),
      blobId.slice(0, 7),
      blobId.slice(0, 9).toUpperCase(),
      "main:a.txt",
      "main^{tree}:a.txt",
      `${tip.slice(0, 8)}:a.txt`,
      "refs/heads/main~0:a.txt",
    ]) {
      const served = await fetchWith(name);
      expect(served.text, name).toContain(`fatal: unable to parse sparse filter data in ${blobId}`);
    }
    const missing = await fetchWith("main~1:a.txt");
    expect(missing.text).toContain("fatal: unable to access sparse blob in 'main~1:a.txt'");
  });

  it("ignores a sparse:oid blob over dir.c's 100 MiB, as git's pack-objects warns and dies", async () => {
    const { repo, tip } = await smallRepo();
    const big = await repo.history.blobs.store([new Uint8Array(100 * 1024 * 1024 + 1)]);
    const served = await serve(repo, v2Fetch([`want ${tip}`, `filter sparse:oid=${big}`, "done"]), {
      version: "2",
      uploadPackFilter: ALLOW,
    });
    const warning = served.text.indexOf(`warning: ignoring excessively large pattern blob: ${big}`);
    expect(warning).toBeGreaterThan(0);
    expect(
      served.text.indexOf(`fatal: unable to parse sparse filter data in ${big}`),
    ).toBeGreaterThan(warning);
  });
});

describe("what a partial clone's filter promises", () => {
  it("names the kinds of objects a filter may leave out", async () => {
    const { filterPromises } = await import("../src/index.js");
    expect(filterPromises("blob:none")).toEqual({ tree: false, blob: true });
    expect(filterPromises("blob:limit=1k")).toEqual({ tree: false, blob: true });
    expect(filterPromises("sparse:oid=main:spec")).toEqual({ tree: false, blob: true });
    expect(filterPromises("tree:0")).toEqual({ tree: true, blob: true });
    expect(filterPromises("object:type=commit")).toEqual({ tree: true, blob: true });
    expect(filterPromises("combine:blob:none+tree:2")).toEqual({ tree: true, blob: true });
    // commits or tags may be left out: no walk
    expect(filterPromises("object:type=blob")).toBeUndefined();
    expect(filterPromises("combine:blob:none+object:type=tag")).toBeUndefined();
    expect(filterPromises("bogus")).toBeUndefined();
  });
});
