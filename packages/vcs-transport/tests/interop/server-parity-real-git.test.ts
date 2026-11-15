/**
 * Server parity with native git: upload-pack's `include-tag` (v0 and v2) against
 * `git upload-pack`, hidden refs (`transfer.hideRefs`, `uploadpack.hideRefs`,
 * `receive.hideRefs`) against git with the same settings, and the upload-pack hooks over smart
 * HTTP and a duplex.
 *
 * The repository is built with native git (annotated tags, a tag chain, a tag of a blob, a
 * lightweight tag, refs to hide) and copied into a vcs-core repository object for object, so
 * both servers serve the same ids.
 */

import { execFile, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFetchHandler,
  createHttpHandler,
  fetchOverDuplex,
  type HttpHandlerOptions,
  type HttpRequest,
  type HttpResponse,
  serveOverDuplex,
  type UploadPackRequest,
  type UploadPackResult,
} from "../../src/index.js";
import { packOf, runReceivePack, ZERO } from "../helpers/receive-pack-harness.js";
import {
  cleanupDir,
  createTransportRepo,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";
import { serveFetchHandler } from "./http-server.js";

const describeGit = gitAvailable() ? describe : describe.skip;
const TIMEOUT = 60000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@example.com",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** The hidden refs of both servers: git's settings, in this order, and ours. */
const TRANSFER_HIDE = ["refs/hidden"];
const UPLOAD_HIDE = ["refs/pull", "!refs/pull/1", "^refs/internal"];
const RECEIVE_HIDE = ["refs/tags"];
const GIT_HIDE_CONFIG = [
  ...TRANSFER_HIDE.map((v) => ["transfer.hideRefs", v]),
  ...UPLOAD_HIDE.map((v) => ["uploadpack.hideRefs", v]),
  ...RECEIVE_HIDE.map((v) => ["receive.hideRefs", v]),
];
const OUR_HIDE: Partial<HttpHandlerOptions> = {
  hideRefs: TRANSFER_HIDE,
  uploadPack: { hideRefs: UPLOAD_HIDE },
  receivePack: { hideRefs: RECEIVE_HIDE },
};

function run(
  cwd: string,
  args: string[],
  options: { input?: Buffer | string; env?: Record<string, string>; config?: string[][] } = {},
): { stdout: Buffer; stderr: string; status: number | null } {
  const config = (options.config ?? []).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  const r = spawnSync("git", [...config, ...args], {
    cwd,
    input: options.input,
    env: { ...loopbackEnv(), ...GIT_ENV, ...options.env },
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // a git that answers without reading all its input (an ERR) closes stdin first: EPIPE
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "EPIPE") throw r.error;
  return { stdout: r.stdout, stderr: r.stderr?.toString() ?? "", status: r.status };
}

function git(cwd: string, args: string[], config: string[][] = []): string {
  const r = run(cwd, args, { config });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** git's async run (a client talking to our in-process server must not block the loop). */
function gitAsync(
  cwd: string,
  args: string[],
  config: string[][] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const flags = config.flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      [...flags, ...args],
      { cwd, env: { ...loopbackEnv(), ...GIT_ENV }, timeout: 30000, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
        });
      },
    );
    child.stdin?.on("error", () => {});
  });
}

function pkt(text: string): string {
  return (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
}

/** The pkt-lines of a response: text lines up to the pack, then the band-1 pack bytes. */
function parseResponse(body: Buffer): { lines: string[]; pack: Buffer } {
  const lines: string[] = [];
  const pack: Buffer[] = [];
  let pos = 0;
  let inPack = false;
  while (pos + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(pos, pos + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      if (!inPack) lines.push(len === 0 ? "0000" : "0001");
      pos += 4;
      continue;
    }
    const payload = body.subarray(pos + 4, pos + len);
    pos += len;
    const band = payload[0];
    if (inPack || band === 1 || band === 2) {
      inPack = true;
      if (band === 1) pack.push(payload.subarray(1));
      continue;
    }
    const text = payload.toString("latin1").replace(/\n$/, "");
    lines.push(text);
    if (text === "packfile") inPack = true;
  }
  return { lines, pack: Buffer.concat(pack) };
}

/** The objects of a pack, id → type (`git verify-pack -v`). */
function packObjects(scratch: string, pack: Buffer): Map<string, string> {
  const file = join(scratch, `p-${Date.now()}-${Math.random().toString(16).slice(2)}.pack`);
  writeFileSync(file, pack);
  git(scratch, ["index-pack", file]);
  const out = git(scratch, ["verify-pack", "-v", file.replace(/\.pack$/, ".idx")]);
  const objects = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) (commit|tree|blob|tag) /.exec(line);
    if (m) objects.set(m[1] as string, m[2] as string);
  }
  return objects;
}

async function bodyBytes(response: HttpResponse): Promise<Buffer> {
  if (response.body instanceof ReadableStream) {
    return Buffer.from(await new Response(response.body).arrayBuffer());
  }
  return Buffer.from(response.body);
}

function post(body: string, v2: boolean, service = "git-upload-pack"): HttpRequest {
  return {
    method: "POST",
    path: `/r.git/${service}`,
    query: {},
    headers: {
      "content-type": `application/x-${service}-request`,
      ...(v2 ? { "git-protocol": "version=2" } : {}),
    },
    body: new Response(Buffer.from(body, "latin1")).body as ReadableStream<Uint8Array>,
  };
}

function get(service: string): HttpRequest {
  return { method: "GET", path: "/r.git/info/refs", query: { service }, headers: {} };
}

/** The ref lines of a v0 advertisement: capabilities (after the NUL) dropped. */
function refLines(advertisement: Buffer): string[] {
  return parseResponse(advertisement)
    .lines.filter((l) => l !== "0000" && !l.startsWith("# service="))
    .map((l) => l.split("\0")[0] as string);
}

describeGit("Interop · server parity with native git", { timeout: TIMEOUT }, () => {
  let root: string;
  /** The native repository (bare) */
  let bare: string;
  let ours: TransportRepo;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    root = makeTmpDir("vcs-parity-");
    const work = join(root, "work");
    git(root, ["init", "-q", "--initial-branch=main", "work"]);
    const commit = (file: string, content: string) => {
      writeFileSync(join(work, file), content);
      git(work, ["add", file]);
      git(work, ["commit", "-q", "-m", file]);
      return git(work, ["rev-parse", "HEAD"]);
    };
    ids.c1 = commit("a.txt", "1\n");
    ids.c2 = commit("b.txt", "2\n");
    ids.c3 = commit("c.txt", "3\n");
    ids.blob = git(work, ["rev-parse", "HEAD:c.txt"]);
    ids.c4 = commit("d.txt", "4\n");
    const tag = (name: string, target: string) => {
      git(work, ["tag", "-a", name, "-m", name, target], [["advice.nestedTag", "false"]]);
      return git(work, ["rev-parse", `refs/tags/${name}`]);
    };
    ids.v1 = tag("v1", ids.c1);
    ids.v3 = tag("v3", ids.c3);
    ids.inner = tag("inner", ids.c4);
    ids.outer = tag("outer", ids.inner);
    ids.blobtag = tag("blobtag", ids.blob);
    git(work, ["tag", "light", ids.c4]);
    // refs to hide, on a side branch
    git(work, ["checkout", "-q", "-b", "side", ids.c1]);
    ids.s1 = commit("s.txt", "s\n");
    // a commit only a hidden ref names
    ids.h1 = commit("h.txt", "h\n");
    git(work, ["checkout", "-q", "main"]);
    git(work, ["update-ref", "refs/hidden/secret", ids.h1]);
    for (const ref of ["refs/pull/1/head", "refs/pull/2/head", "refs/pullx", "refs/internal/x"]) {
      git(work, ["update-ref", ref, ids.s1]);
    }
    git(work, ["branch", "-D", "side"]);
    git(root, ["clone", "-q", "--mirror", work, "r.git"]);
    bare = join(root, "r.git");

    // the same objects and refs in ours
    ours = await createTransportRepo();
    const pack = run(bare, ["pack-objects", "--revs", "--all", "--stdout"], { input: "" }).stdout;
    await ours.facade.importPack(
      (async function* () {
        yield new Uint8Array(pack);
      })(),
    );
    for (const line of git(bare, ["for-each-ref", "--format=%(objectname) %(refname)"]).split(
      "\n",
    )) {
      const [oid, name] = line.split(" ") as [string, string];
      await ours.refStore.update(name, oid);
    }
    await ours.history.refs.setSymbolic("HEAD", "refs/heads/main");
  }, TIMEOUT);

  afterAll(async () => {
    await ours?.close();
    if (root) cleanupDir(root);
  });

  function handler(options: Partial<HttpHandlerOptions> = {}) {
    return createHttpHandler({
      resolveRepository: async () => ({ repository: ours.facade, refStore: ours.refStore }),
      ...options,
    });
  }

  /** The same stateless upload-pack request to git and to ours. */
  async function bothUploadPack(
    body: string,
    v2: boolean,
    options: Partial<HttpHandlerOptions> = {},
    config: string[][] = [],
  ): Promise<[Buffer, Buffer]> {
    const native = run(root, ["upload-pack", "--stateless-rpc", bare], {
      input: Buffer.from(body, "latin1"),
      env: v2 ? { GIT_PROTOCOL: "version=2" } : {},
      config,
    }).stdout;
    const response = await handler(options)(post(body, v2));
    return [native, await bodyBytes(response)];
  }

  function v0Fetch(wants: string[], haves: string[], caps: string): string {
    const lines = wants.map((w, i) => pkt(i === 0 ? `want ${w} ${caps}\n` : `want ${w}\n`));
    return `${lines.join("")}0000${haves.map((h) => pkt(`have ${h}\n`)).join("")}${pkt("done\n")}`;
  }

  function v2Fetch(wants: string[], haves: string[], args: string[]): string {
    return (
      pkt("command=fetch\n") +
      pkt("object-format=sha1\n") +
      "0001" +
      [
        ...wants.map((w) => `want ${w}\n`),
        ...haves.map((h) => `have ${h}\n`),
        ...args.map((a) => `${a}\n`),
        "done\n",
      ]
        .map(pkt)
        .join("") +
      "0000"
    );
  }

  describe("include-tag", () => {
    for (const v2 of [false, true]) {
      it(`protocol v${v2 ? 2 : 0}: the pack holds the same objects, tags included, as git's`, async () => {
        const request = v2
          ? v2Fetch([ids.c4 as string], [ids.c2 as string], ["ofs-delta", "include-tag"])
          : v0Fetch([ids.c4 as string], [ids.c2 as string], "side-band-64k ofs-delta include-tag");
        const [native, our] = await bothUploadPack(request, v2);
        const nativeObjects = packObjects(root, parseResponse(native).pack);
        const ourObjects = packObjects(root, parseResponse(our).pack);
        const tags = (m: Map<string, string>) =>
          [...m]
            .filter(([, t]) => t === "tag")
            .map(([id]) => id)
            .sort();
        // v3 (c3), inner and outer (a chain to c4), blobtag (a blob of c3); not v1 (the
        // client's c1), not the lightweight tag
        const expected = [ids.v3, ids.inner, ids.outer, ids.blobtag].sort();
        expect(tags(nativeObjects)).toEqual(expected);
        expect(tags(ourObjects)).toEqual(expected);
        expect([...ourObjects.keys()].sort()).toEqual([...nativeObjects.keys()].sort());
      });

      it(`protocol v${v2 ? 2 : 0}: no tag without include-tag, as git`, async () => {
        const request = v2
          ? v2Fetch([ids.c4 as string], [ids.c2 as string], ["ofs-delta"])
          : v0Fetch([ids.c4 as string], [ids.c2 as string], "side-band-64k ofs-delta");
        const [native, our] = await bothUploadPack(request, v2);
        const types = (b: Buffer) => [...packObjects(root, parseResponse(b).pack).values()];
        expect(types(native)).not.toContain("tag");
        expect(types(our)).not.toContain("tag");
      });
    }

    it("a hidden tag is not included (git would include it: pack-objects ignores hideRefs)", async () => {
      const request = v0Fetch([ids.c4 as string], [ids.c2 as string], "side-band-64k include-tag");
      const our = await bodyBytes(
        await handler({ hideRefs: ["refs/tags/outer"] })(post(request, false)),
      );
      const tags = [...packObjects(root, parseResponse(our).pack)]
        .filter(([, t]) => t === "tag")
        .map(([id]) => id)
        .sort();
      // inner is still visible (refs/tags/inner), outer is not
      expect(tags).toEqual([ids.v3, ids.inner, ids.blobtag].sort());
    });

    for (const version of ["0", "2"]) {
      it(`native git fetch (protocol v${version}) from our server follows tags without a backfill request`, async () => {
        const server = await serveFetchHandler(
          createFetchHandler({
            resolveRepository: async () => ({ repository: ours.facade, refStore: ours.refStore }),
          }),
        );
        const dir = join(root, `follow-v${version}`);
        try {
          git(root, ["init", "-q", "--bare", dir]);
          const config = [["protocol.version", version]];
          const r = await gitAsync(
            dir,
            ["fetch", `${server.baseUrl}/r.git`, "+refs/heads/main:refs/remotes/origin/main"],
            config,
          );
          expect(r.code, r.stderr).toBe(0);
          // the annotated tags of fetched commits came along (auto-follow)
          const tags = git(dir, ["for-each-ref", "--format=%(refname)", "refs/tags"]).split("\n");
          expect(tags).toEqual(
            expect.arrayContaining([
              "refs/tags/v1",
              "refs/tags/v3",
              "refs/tags/inner",
              "refs/tags/outer",
            ]),
          );
          expect(git(dir, ["cat-file", "-t", ids.outer as string])).toBe("tag");
          // one fetch request: v0 one POST; v2 ls-refs and fetch. A server ignoring
          // include-tag gets a second fetch (git's tag backfill)
          const posts = server.requests.filter(
            (q) => q.method === "POST" && q.url.includes("git-upload-pack"),
          );
          expect(posts.length).toBe(version === "2" ? 2 : 1);
        } finally {
          await server.close();
        }
      });
    }
  });

  describe("hidden refs", () => {
    it("v0 upload-pack advertisement: the same refs as git with the same hideRefs", async () => {
      const native = run(root, ["upload-pack", "--stateless-rpc", "--advertise-refs", bare], {
        config: GIT_HIDE_CONFIG,
      }).stdout;
      const our = await bodyBytes(await handler(OUR_HIDE)(get("git-upload-pack")));
      const lines = refLines(our);
      expect(lines).toEqual(refLines(native));
      expect(lines.join("\n")).not.toMatch(/refs\/(hidden|internal|pull\/2)/);
      expect(lines.join("\n")).toContain("refs/pull/1/head");
      expect(lines.join("\n")).toContain("refs/pullx");
    });

    it("v2 ls-refs: byte for byte git's answer with the same hideRefs", async () => {
      for (const args of [["symrefs", "peel"], ["peel", "ref-prefix refs/pull"], []]) {
        const body = `${pkt("command=ls-refs\n")}${pkt("object-format=sha1\n")}0001${args
          .map((a) => pkt(`${a}\n`))
          .join("")}0000`;
        const [native, our] = await bothUploadPack(body, true, OUR_HIDE, GIT_HIDE_CONFIG);
        expect(our.toString("latin1"), args.join(",")).toBe(native.toString("latin1"));
        expect(our.toString("latin1")).not.toContain("refs/hidden");
      }
    });

    it("receive-pack advertisement: the same refs as git with the same hideRefs", async () => {
      const native = run(root, ["receive-pack", "--stateless-rpc", "--advertise-refs", bare], {
        config: GIT_HIDE_CONFIG,
      }).stdout;
      const our = await bodyBytes(await handler(OUR_HIDE)(get("git-receive-pack")));
      const lines = refLines(our).filter((l) => !l.endsWith(" HEAD"));
      expect(lines).toEqual(refLines(native));
      // receive.hideRefs=refs/tags: no tags for pushes, all of them for fetches
      expect(lines.join("\n")).not.toContain("refs/tags/");
    });

    it("v0: a want of a hidden tip is refused as git refuses it", async () => {
      // h1: only refs/hidden/secret names it; s1: hidden refs and the shown refs/pullx
      const hidden = v0Fetch([ids.h1 as string], [], "side-band-64k");
      const [native, our] = await bothUploadPack(hidden, false, OUR_HIDE, GIT_HIDE_CONFIG);
      expect(parseResponse(our).lines[0]).toBe(parseResponse(native).lines[0]);
      expect(parseResponse(our).lines[0]).toBe(`ERR upload-pack: not our ref ${ids.h1}`);
      const shown = v0Fetch([ids.s1 as string], [], "side-band-64k");
      const [native2, our2] = await bothUploadPack(shown, false, OUR_HIDE, GIT_HIDE_CONFIG);
      expect(parseResponse(native2).lines[0]).toBe("NAK");
      expect(parseResponse(our2).lines[0]).toBe("NAK");
      // allowTipSHA1InWant: hidden tips are served (git's "TIP" policy)
      const [native3, our3] = await bothUploadPack(
        hidden,
        false,
        { ...OUR_HIDE, requestPolicy: "TIP" },
        [...GIT_HIDE_CONFIG, ["uploadpack.allowTipSHA1InWant", "true"]],
      );
      expect(parseResponse(native3).lines[0]).toBe("NAK");
      expect(parseResponse(our3).lines[0]).toBe("NAK");
    });

    it("v2: a want-ref of a hidden ref is an unknown ref, as git", async () => {
      const body = v2Fetch([], [], ["want-ref refs/hidden/secret"]);
      const [native, our] = await bothUploadPack(body, true, OUR_HIDE, [
        ...GIT_HIDE_CONFIG,
        ["uploadpack.allowRefInWant", "true"],
      ]);
      expect(parseResponse(our).lines[0]).toBe(parseResponse(native).lines[0]);
      expect(parseResponse(our).lines[0]).toBe("ERR unknown ref refs/hidden/secret");
    });

    it("receive-pack refuses a push to a hidden ref with git's report", async () => {
      const server = await serveFetchHandler(
        createFetchHandler({
          resolveRepository: async () => ({ repository: ours.facade, refStore: ours.refStore }),
          ...OUR_HIDE,
        }),
      );
      const target = join(root, "push-target.git");
      git(root, ["clone", "-q", "--bare", bare, target]);
      git(target, ["update-ref", "refs/hidden/secret", ids.h1 as string]);
      git(target, ["update-ref", "refs/internal/x", ids.s1 as string]);
      // a local push clears GIT_CONFIG_PARAMETERS for receive-pack: the target's own config
      for (const [key, value] of GIT_HIDE_CONFIG) git(target, ["config", "--add", key, value]);
      try {
        const work = join(root, "work");
        const pushes = [
          `${ids.c4}:refs/hidden/secret`, // exists, hidden by transfer.hideRefs
          `${ids.c4}:refs/hidden/new`, // new, hidden
          `${ids.c4}:refs/internal/x`, // ^refs/internal is upload-pack's only: accepted
        ];
        const nativeRun = await gitAsync(
          work,
          ["push", "--porcelain", target, ...pushes],
          GIT_HIDE_CONFIG,
        );
        const ourRun = await gitAsync(work, [
          "push",
          "--porcelain",
          `${server.baseUrl}/r.git`,
          ...pushes,
        ]);
        const report = (out: string) =>
          out
            .split("\n")
            .filter((l) => /^[!*= +-]\t/.test(l))
            .sort();
        expect(report(ourRun.stdout)).toEqual(report(nativeRun.stdout));
        expect(ourRun.stdout).toContain(
          `!\t${ids.c4}:refs/hidden/secret\t[remote rejected] (deny updating a hidden ref)`,
        );
        expect(await ours.refStore.get("refs/hidden/secret")).toBe(ids.h1);
        expect(await ours.refStore.get("refs/hidden/new")).toBeUndefined();
      } finally {
        await server.close();
        await ours.refStore.update("refs/internal/x", ids.s1 as string);
      }
    });

    it("receive-pack refuses deleting a hidden ref (git's 'deny deleting a hidden ref')", async () => {
      const answer = await runReceivePack(
        ours,
        { commands: [`${ids.h1} ${ZERO} refs/hidden/secret`] },
        { hideRefs: ["refs/hidden"] },
      );
      expect(answer.report).toContain("ng refs/hidden/secret deny deleting a hidden ref");
      expect(await ours.refStore.get("refs/hidden/secret")).toBe(ids.h1);
    });

    for (const strictAtomic of [false, true]) {
      it(`an atomic push with a hidden ref: ${strictAtomic ? "strictAtomic refuses all" : "the others still land (as git)"}`, async () => {
        const target = await createTransportRepo();
        try {
          const pack = run(bare, ["pack-objects", "--revs", "--all", "--stdout"], { input: "" });
          await target.facade.importPack(
            (async function* () {
              yield new Uint8Array(pack.stdout);
            })(),
          );
          await target.refStore.update("refs/hidden/secret", ids.h1 as string);
          const answer = await runReceivePack(
            target,
            {
              commands: [
                `${ids.h1} ${ids.c4} refs/hidden/secret`,
                `${ZERO} ${ids.c4} refs/heads/new`,
              ],
              caps: "report-status atomic",
              // the objects are there: an empty pack, as git's send-pack sends
              pack: await packOf(target, []),
            },
            { hideRefs: ["refs/hidden"], strictAtomic },
          );
          expect(answer.report).toContain("ng refs/hidden/secret deny updating a hidden ref");
          if (strictAtomic) {
            expect(answer.report).toContain("ng refs/heads/new atomic push failure");
            expect(await target.refStore.get("refs/heads/new")).toBeUndefined();
          } else {
            expect(answer.report).toContain("ok refs/heads/new");
            expect(await target.refStore.get("refs/heads/new")).toBe(ids.c4);
          }
          expect(await target.refStore.get("refs/hidden/secret")).toBe(ids.h1);
        } finally {
          await target.close();
        }
      });
    }

    it("v2 fetch: ADVERTISED refuses a hidden tip, TIP serves it (ours: git's v2 serves any object)", async () => {
      const body = v2Fetch([ids.h1 as string], [], ["ofs-delta"]);
      const advertised = parseResponse(
        await bodyBytes(
          await handler({ ...OUR_HIDE, requestPolicy: "ADVERTISED" })(post(body, true)),
        ),
      );
      expect(advertised.lines[0]).toBe(`ERR upload-pack: not our ref ${ids.h1}`);
      const tip = parseResponse(
        await bodyBytes(await handler({ ...OUR_HIDE, requestPolicy: "TIP" })(post(body, true))),
      );
      expect(tip.lines[0]).toBe("packfile");
      expect(tip.pack.length).toBeGreaterThan(12);
      // a want of a shown tip is served under ADVERTISED
      const shown = parseResponse(
        await bodyBytes(
          await handler({ ...OUR_HIDE, requestPolicy: "ADVERTISED" })(
            post(v2Fetch([ids.c4 as string], [], []), true),
          ),
        ),
      );
      expect(shown.lines[0]).toBe("packfile");
    });

    it("HEAD naming a hidden branch is still advertised, as git (hideRefs is no access control)", async () => {
      const config = [["transfer.hideRefs", "refs/heads/main"]];
      const native = run(root, ["upload-pack", "--stateless-rpc", "--advertise-refs", bare], {
        config,
      }).stdout;
      const our = await bodyBytes(
        await handler({ hideRefs: ["refs/heads/main"] })(get("git-upload-pack")),
      );
      expect(refLines(our)).toEqual(refLines(native));
      expect(refLines(our)[0]).toBe(`${ids.c4} HEAD`);
      expect(refLines(our).join("\n")).not.toContain("refs/heads/main");
    });
  });

  describe("upload-pack hooks", () => {
    it("authorize sees a v2 want-ref (and every ref of the wants, hidden ones too), and refuses it", async () => {
      const seen: UploadPackRequest[] = [];
      const h = handler({
        ...OUR_HIDE,
        uploadPack: {
          ...OUR_HIDE.uploadPack,
          hooks: {
            authorize: (request) => {
              seen.push(request);
              return request.refs.some((r) => r.startsWith("refs/hidden/")) ? "no" : undefined;
            },
          },
        },
      });
      const wantRef = parseResponse(
        await bodyBytes(await h(post(v2Fetch([], [], ["want-ref refs/heads/main"]), true))),
      );
      expect(wantRef.lines).toContain("packfile");
      expect([...(seen[0]?.wantRefs ?? [])]).toEqual([["refs/heads/main", ids.c4]]);
      expect(seen[0]?.refs).toEqual(expect.arrayContaining(["HEAD", "refs/heads/main"]));
      // a hidden tip wanted by id (v2 serves any object): its hidden ref is named
      const hidden = parseResponse(
        await bodyBytes(await h(post(v2Fetch([ids.h1 as string], [], ["deepen-since 1"]), true))),
      );
      expect(hidden.lines[0]).toBe("ERR no");
      expect(seen[1]?.refs).toEqual(["refs/hidden/secret"]);
      expect(seen[1]?.deepenSince).toBe(1);
      expect(seen[1]?.capabilities).not.toBe(seen[0]?.capabilities);
    });

    it("authorize runs on every round of a stateless v0 negotiation, and may refuse a later one", async () => {
      const calls: UploadPackRequest[] = [];
      const server = await serveFetchHandler(
        createFetchHandler({
          resolveRepository: async () => ({ repository: ours.facade, refStore: ours.refStore }),
          uploadPack: {
            hooks: {
              authorize: (request) => {
                calls.push(request);
                return calls.length > 1 ? "second round refused" : undefined;
              },
            },
          },
        }),
      );
      const dir = join(root, "rounds");
      try {
        git(root, ["init", "-q", "--bare", dir]);
        git(dir, ["fetch", "-q", bare, `${ids.c1}:refs/heads/main`]);
        // 100 local commits: the negotiation needs more than one POST
        let stream = "";
        for (let i = 0; i < 100; i++) {
          const message = `l${i}\n`;
          stream += `commit refs/heads/main\ncommitter T <t@example.com> ${1_900_000_000 + i} +0000\n`;
          stream += `data ${message.length}\n${message}`;
          if (i === 0) stream += `from ${ids.c1}\n`;
          stream += `M 100644 inline l.txt\ndata ${message.length}\n${message}\n`;
        }
        run(dir, ["fast-import", "--quiet"], { input: stream });
        const r = await gitAsync(
          dir,
          ["fetch", `${server.baseUrl}/r.git`, "+refs/heads/main:refs/remotes/origin/main"],
          [["protocol.version", "0"]],
        );
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("remote error: second round refused");
        expect(calls.length).toBe(2);
        expect(calls.every((c) => c.wants.includes(ids.c4 as string))).toBe(true);
      } finally {
        await server.close();
      }
    });

    for (const version of ["0", "2"]) {
      it(`over smart HTTP (protocol v${version}): authorize refuses with ERR, postUpload reports a fetch`, async () => {
        const seen: UploadPackRequest[] = [];
        const uploads: UploadPackResult[] = [];
        let uploaded: (() => void) | undefined;
        const firstUpload = new Promise<void>((resolve) => {
          uploaded = resolve;
        });
        let refuse = true;
        const server = await serveFetchHandler(
          createFetchHandler({
            resolveRepository: async () => ({ repository: ours.facade, refStore: ours.refStore }),
            uploadPack: {
              hooks: {
                authorize: (request, ctx) => {
                  seen.push(request);
                  expect(ctx.repoPath).toBe("/r.git");
                  expect(ctx.request?.method).toBe("POST");
                  return refuse ? "fetching is not allowed" : undefined;
                },
                postUpload: (result) => {
                  uploads.push(result);
                  uploaded?.();
                },
              },
            },
          }),
        );
        try {
          const config = [["protocol.version", version]];
          const denied = await gitAsync(
            root,
            ["clone", "-q", "--bare", `${server.baseUrl}/r.git`, join(root, `denied-v${version}`)],
            config,
          );
          expect(denied.code).not.toBe(0);
          expect(denied.stderr).toContain("remote error: fetching is not allowed");
          expect(seen[0]?.protocolVersion).toBe(Number(version));
          expect(seen[0]?.wants).toContain(ids.c4);
          expect(seen[0]?.refs).toContain("refs/heads/main");
          expect(uploads).toEqual([]);

          refuse = false;
          const ok = await gitAsync(
            root,
            ["clone", "-q", "--bare", `${server.baseUrl}/r.git`, join(root, `allowed-v${version}`)],
            config,
          );
          expect(ok.code, ok.stderr).toBe(0);
          await firstUpload;
          expect(uploads).toHaveLength(1);
          expect(uploads[0]?.refs).toContain("refs/heads/main");
          expect(uploads[0]?.packBytes).toBeGreaterThan(0);
        } finally {
          await server.close();
        }
      });
    }

    for (const v of ["1", "2"] as const) {
      it(`over a duplex (protocol v${v}): a refusing authorize fails the fetch with its message`, async () => {
        const client = await createTransportRepo();
        const toServer: Uint8Array[] = [];
        const toClient: Uint8Array[] = [];
        let wakeServer: (() => void) | undefined;
        let wakeClient: (() => void) | undefined;
        let serverEnded = false;
        let clientEnded = false;
        const iterate = (
          queue: Uint8Array[],
          ended: () => boolean,
          setWake: (w: () => void) => void,
        ) =>
          async function* () {
            while (true) {
              const next = queue.shift();
              if (next) {
                yield next;
                continue;
              }
              if (ended()) return;
              await new Promise<void>((r) => setWake(r));
            }
          };
        try {
          const served = serveOverDuplex({
            duplex: {
              [Symbol.asyncIterator]: iterate(
                toServer,
                () => serverEnded,
                (w) => {
                  wakeServer = w;
                },
              ),
              write: (d) => {
                toClient.push(d.slice());
                wakeClient?.();
              },
            },
            repository: ours.facade,
            refStore: ours.refStore,
            service: "git-upload-pack",
            protocolVersion: v,
            uploadPackHooks: { authorize: () => ({ ok: false, message: "no fetching here" }) },
          }).finally(() => {
            clientEnded = true;
            wakeClient?.();
          });
          const result = await fetchOverDuplex({
            duplex: {
              [Symbol.asyncIterator]: iterate(
                toClient,
                () => clientEnded,
                (w) => {
                  wakeClient = w;
                },
              ),
              write: (d) => {
                toServer.push(d.slice());
                wakeServer?.();
              },
              close: async () => {
                serverEnded = true;
                wakeServer?.();
              },
            },
            repository: client.facade,
            refStore: client.refStore,
            refspecs: ["+refs/heads/main:refs/remotes/peer/main"],
          });
          expect(result.success).toBe(false);
          expect(result.error).toContain("no fetching here");
          const outcome = await served;
          expect(outcome.success).toBe(false);
          expect(await client.refStore.get("refs/remotes/peer/main")).toBeUndefined();
        } finally {
          await client.close();
        }
      });
    }
  });
});
