import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { push } from "@statewalker/vcs-transport";
import {
  type BatchResponse,
  createFilesLfsStore,
  createLfsPointer,
  type FetchLike,
  formatLfsPointer,
  type LfsObjectStore,
  lfsDownload,
  lfsUpload,
} from "@statewalker/vcs-transport-lfs";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type GiteaServer, startGitea } from "../src/index.js";
import {
  collect,
  commitFiles,
  describeGitea,
  nativeGit,
  nativeGitEnv,
  noise,
  ourRepo,
  requireNativeTools,
  sameBytes,
  sha256,
  tempDirs,
} from "./helpers.js";

/**
 * G2–G4 — Git LFS against Gitea with our vcs-transport-lfs client: our upload
 * smudged by a native clone, git-lfs's upload downloaded (and resumed with a
 * Range) by us, and the verification and error paths. Gitea's LFS actions
 * carry `Authorization` (capital A): our client must merge it with its own
 * `authorization` by name, or both go out joined by a comma and every
 * transfer is a 401.
 */
describeGitea("Gitea oracle · G2–G4 Git LFS", () => {
  const tmp = tempDirs();
  let gitea: GiteaServer;
  let env: NodeJS.ProcessEnv;
  let repoCount = 0;
  const newRepo = () => gitea.createRepo(`lfs${++repoCount}`);
  const auth = () => ({ headers: { authorization: gitea.authorization } });
  const nodeStore = (): LfsObjectStore =>
    createFilesLfsStore(createNodeFilesApi({ rootDir: tmp.make("gitea-lfs-store-") }));
  const read = async (store: LfsObjectStore, oid: string) => {
    const parts: Uint8Array[] = [];
    for await (const c of store.read(oid)) parts.push(c);
    return new Uint8Array(Buffer.concat(parts));
  };

  beforeAll(async () => {
    gitea = await startGitea();
    env = nativeGitEnv(tmp.make("gitea-home-"));
  });
  afterAll(async () => {
    await gitea?.stop();
    tmp.cleanup();
  });

  requireNativeTools();

  it("G2 our LFS upload and push: a native clone smudges the file; a second upload sends nothing", async () => {
    const repo = await newRepo();
    const content = noise(3 << 20, 1);
    const pointer = await createLfsPointer(content);
    const store = createFilesLfsStore(new MemFilesApi());
    expect((await store.put(content, pointer)).ok).toBe(true);

    const requests: { method: string; url: string; authorization: string | null }[] = [];
    const recording: FetchLike = (req) => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.get("authorization"),
      });
      return fetch(req);
    };
    const events = await collect(lfsUpload(store, repo.lfsUrl, [pointer], recording, auth()));
    expect(events).toContainEqual({ type: "object-uploaded", oid: pointer.oid });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const methods = requests.map((r) => r.method);
    // the batch, the PUT and Gitea's verify action
    expect(methods).toEqual(["POST", "PUT", "POST"]);
    expect(requests[2]?.url).toMatch(/\/verify$/);
    // one authorization each, never two joined by a comma (the case-insensitive merge)
    for (const r of requests) expect(r.authorization).toMatch(/^Basic [^,]+$/);

    const ours = await ourRepo();
    try {
      await commitFiles(ours, "lfs", {
        ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        "big.bin": formatLfsPointer(pointer),
      });
      const pushed = await push({
        url: repo.cloneUrl,
        repository: ours.facade,
        refStore: ours.refStore,
        refspecs: ["refs/heads/main:refs/heads/main"],
        auth: { username: gitea.user, password: gitea.password },
      });
      expect(pushed.ok, JSON.stringify(pushed.updates)).toBe(true);
    } finally {
      await ours.close();
    }

    const clone = join(tmp.make(), "c");
    nativeGit(env, tmp.make(), ["clone", "-q", repo.authenticatedUrl, clone]);
    const smudged = new Uint8Array(readFileSync(join(clone, "big.bin")));
    expect(smudged.length).toBe(content.length);
    expect(sameBytes(smudged, content)).toBe(true);
    expect(nativeGit(env, clone, ["lfs", "fsck"])).toContain("Git LFS fsck OK");

    requests.length = 0;
    const second = await collect(lfsUpload(store, repo.lfsUrl, [pointer], recording, auth()));
    expect(second.filter((e) => e.type !== "batch")).toEqual([]);
    expect(requests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("G3 what git-lfs pushed, our download stores byte-identical; a cut download resumes with a 206", async () => {
    const repo = await newRepo();
    const work = join(tmp.make(), "w");
    nativeGit(env, tmp.make(), ["init", "-q", "-b", "main", work]);
    nativeGit(env, work, ["lfs", "install", "--local"]);
    nativeGit(env, work, ["lfs", "track", "*.bin"]);
    const big = noise(4 << 20, 2);
    writeFileSync(join(work, "n.bin"), big);
    nativeGit(env, work, ["add", "-A"]);
    nativeGit(env, work, ["commit", "-q", "-m", "n"]);
    nativeGit(env, work, ["push", "-q", repo.authenticatedUrl, "main"]);
    const obj = { oid: sha256(big), size: big.length };

    // a private repository: no credentials, no batch
    await expect(collect(lfsDownload(nodeStore(), repo.lfsUrl, [obj]))).rejects.toThrow(/\b401\b/);

    const whole = createFilesLfsStore(new MemFilesApi());
    const got = await collect(lfsDownload(whole, repo.lfsUrl, [obj], undefined, auth()));
    expect(got).toContainEqual({ type: "object-downloaded", oid: obj.oid });
    expect(sha256(await read(whole, obj.oid))).toBe(obj.oid);

    // cut after 1 MiB, then resumed from the bytes held
    const store = nodeStore();
    const gets: { range: string | null; status: number; contentRange: string; bytes: number }[] =
      [];
    let cut = true;
    const watched: FetchLike = async (req) => {
      const res = await fetch(req);
      if (req.method !== "GET" || !res.body) return res;
      const entry = {
        range: req.headers.get("range"),
        status: res.status,
        contentRange: res.headers.get("content-range") ?? "",
        bytes: 0,
      };
      gets.push(entry);
      const cutHere = cut;
      cut = false;
      const reader = res.body.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            const r = await reader.read();
            if (r.done) return c.close();
            if (cutHere && entry.bytes >= 1 << 20) {
              await reader.cancel();
              return c.error(new Error("link lost"));
            }
            entry.bytes += r.value.length;
            c.enqueue(r.value);
          },
        }),
        { status: res.status, headers: res.headers },
      );
    };
    const broken = await collect(lfsDownload(store, repo.lfsUrl, [obj], watched, auth()));
    expect(broken.find((e) => e.type === "error")).toMatchObject({ oid: obj.oid });
    expect(await store.size(obj.oid)).toBeUndefined();
    const held = gets[0]?.bytes ?? 0;
    expect(held).toBeGreaterThanOrEqual(1 << 20);
    expect(held).toBeLessThan(obj.size);

    const resumed = await collect(lfsDownload(store, repo.lfsUrl, [obj], watched, auth()));
    expect(resumed).toContainEqual({ type: "object-downloaded", oid: obj.oid });
    const second = gets[1];
    expect(second?.range).toBe(`bytes=${held}-`);
    expect(second?.status).toBe(206);
    // Gitea 1.22 reports the total as size − start (bytes 1048576-4194303/3145728):
    // the client reads only the start
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(second?.contentRange ?? "");
    expect(Number(m?.[1])).toBe(held);
    expect([obj.size, obj.size - held]).toContain(Number(m?.[3]));
    expect(held + (second?.bytes ?? 0)).toBe(obj.size);
    expect(sha256(await read(store, obj.oid))).toBe(obj.oid);
  });

  it("G4 missing objects are not found; altered bytes are refused; Gitea refuses bytes that are not their oid", async () => {
    const repo = await newRepo();
    const missing = await collect(
      lfsDownload(
        createFilesLfsStore(new MemFilesApi()),
        repo.lfsUrl,
        [{ oid: "1".repeat(64), size: 10 }],
        undefined,
        auth(),
      ),
    );
    expect(missing.find((e) => e.type === "error")).toMatchObject({
      oid: "1".repeat(64),
      reason: expect.stringMatching(/not found/i),
    });

    // altered in transit from Gitea: refused, nothing kept
    const content = noise(200_000, 3);
    const pointer = await createLfsPointer(content);
    const source = createFilesLfsStore(new MemFilesApi());
    await source.put(content, pointer);
    const up = await collect(lfsUpload(source, repo.lfsUrl, [pointer], undefined, auth()));
    expect(up).toContainEqual({ type: "object-uploaded", oid: pointer.oid });
    const flip: FetchLike = async (req) => {
      const res = await fetch(req);
      if (req.method !== "GET") return res;
      const b = new Uint8Array(await res.arrayBuffer());
      b[0] = (b[0] as number) ^ 1;
      return new Response(b, { status: res.status, headers: res.headers });
    };
    for (const target of [createFilesLfsStore(new MemFilesApi()), nodeStore()]) {
      const events = await collect(lfsDownload(target, repo.lfsUrl, [pointer], flip, auth()));
      expect(events.find((e) => e.type === "error")).toMatchObject({
        oid: pointer.oid,
        reason: "sha256 mismatch",
      });
      expect(await target.size(pointer.oid)).toBeUndefined();
    }

    // bytes that are not their oid, sent straight to Gitea's upload href
    const wrong = noise(1000, 4);
    const claimed = sha256(noise(1000, 5));
    const batchRes = await gitea.fetch(`${repo.lfsUrl}/objects/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.git-lfs+json",
        accept: "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({ operation: "upload", objects: [{ oid: claimed, size: 1000 }] }),
    });
    expect(batchRes.status).toBe(200);
    const batch = (await batchRes.json()) as BatchResponse;
    const action = batch.objects[0]?.actions?.upload;
    expect(action?.href).toBeTruthy();
    const put = await fetch(action?.href as string, {
      method: "PUT",
      headers: action?.header,
      body: wrong as BodyInit,
    });
    expect(put.status).toBe(422); // "content hash does not match OID"
    const after = await collect(
      lfsDownload(
        createFilesLfsStore(new MemFilesApi()),
        repo.lfsUrl,
        [{ oid: claimed, size: 1000 }],
        undefined,
        auth(),
      ),
    );
    expect(after.find((e) => e.type === "error")).toMatchObject({
      reason: expect.stringMatching(/not found/i),
    });
  });
});
