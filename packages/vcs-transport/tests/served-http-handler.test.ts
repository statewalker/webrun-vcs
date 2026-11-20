/**
 * The served smart-HTTP handler (`createServedFetchHandler`): http-backend's service rules
 * (`http.receivepack` for authenticated users by default, `http.uploadpack`, unknown services,
 * the request table's 404 and 405), the settings layered as `serveGitService` layers them
 * (operator, repository config, resolver), `around` lasting until the push's run has ended,
 * and the quarantine path handed to pre-receive.
 */

import { describe, expect, it } from "vitest";

import {
  createServedFetchHandler,
  createServedHttpHandler,
  type ServedHttpHandlerOptions,
  type ServedRepository,
  type ServerConfigReader,
} from "../src/index.js";
import {
  clientWithNewCommits,
  decodeAnswer,
  fullPackOf,
  pushRequest,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";

function configOf(values: Record<string, string>): ServerConfigReader {
  return {
    getAll: (key) => {
      const found = Object.entries(values).find(([k]) => k.toLowerCase() === key.toLowerCase());
      return found ? [found[1]] : [];
    },
  };
}

async function setup(served: Partial<ServedRepository> = {}) {
  const { repo, c2 } = await serverRepo();
  const { client, commits } = await clientWithNewCommits(2);
  const [n0, n1] = commits as [string, string];
  const pack = await fullPackOf(client, [n1], [c2]);
  const repository: ServedRepository = {
    repository: repo.facade,
    refStore: repo.refStore,
    ...served,
  };
  return { repo, repository, c2, n0, n1, pack };
}

function handlerFor(repository: ServedRepository, options: Partial<ServedHttpHandlerOptions> = {}) {
  const paths: string[] = [];
  const handler = createServedFetchHandler({
    resolveRepository: async (path) => {
      paths.push(path);
      return path === "/repo.git" ? repository : undefined;
    },
    ...options,
  });
  return { handler, paths };
}

const get = (handler: (r: Request) => Promise<Response>, path: string, headers = {}) =>
  handler(new Request(`http://localhost${path}`, { headers }));

const post = (
  handler: (r: Request) => Promise<Response>,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
      body: body as Uint8Array<ArrayBuffer>,
    }),
  );

describe("createServedFetchHandler: http-backend's service rules", () => {
  it("receive-pack: refused to anonymous users, served with a remote user or http.receivepack", async () => {
    const { repository } = await setup();
    const anonymous = handlerFor(repository).handler;
    const refused = await get(anonymous, "/repo.git/info/refs?service=git-receive-pack");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("");
    expect(refused.headers.get("cache-control")).toContain("no-cache");

    const user = handlerFor(repository, { remoteUser: () => "alice" }).handler;
    expect((await get(user, "/repo.git/info/refs?service=git-receive-pack")).status).toBe(200);

    const configured = handlerFor({
      ...repository,
      config: configOf({ "http.receivepack": "true" }),
    });
    expect(
      (await get(configured.handler, "/repo.git/info/refs?service=git-receive-pack")).status,
    ).toBe(200);
    // the repository's config overrides the operator's
    const off = handlerFor(
      { ...repository, config: configOf({ "http.receivepack": "false" }) },
      { enableReceivePack: true },
    );
    expect((await get(off.handler, "/repo.git/info/refs?service=git-receive-pack")).status).toBe(
      403,
    );
    // ... unless overrides are not allowed
    const forced = handlerFor(
      { ...repository, config: configOf({ "http.receivepack": "false" }) },
      { enableReceivePack: true, allowOverride: false },
    );
    expect((await get(forced.handler, "/repo.git/info/refs?service=git-receive-pack")).status).toBe(
      200,
    );
  });

  it("upload-pack: served by default, refused by http.uploadpack=false; unknown services 403", async () => {
    const { repository } = await setup();
    const open = handlerFor(repository).handler;
    expect((await get(open, "/repo.git/info/refs?service=git-upload-pack")).status).toBe(200);
    const off = handlerFor({ ...repository, config: configOf({ "http.uploadpack": "0" }) });
    expect((await get(off.handler, "/repo.git/info/refs?service=git-upload-pack")).status).toBe(
      403,
    );
    expect((await get(open, "/repo.git/info/refs?service=git-frobnicate")).status).toBe(403);
    expect((await get(open, "/repo.git/info/refs?service=upload-pack")).status).toBe(403);
    expect((await post(open, "/repo.git/git-upload-archive", new Uint8Array(0))).status).toBe(403);
  });

  it("the request table: 404 for unknown paths and repositories, 405 for the wrong method", async () => {
    const { repository } = await setup();
    const { handler, paths } = handlerFor(repository);
    expect((await get(handler, "/repo.git/whatever")).status).toBe(404);
    expect((await get(handler, "/nope.git/info/refs?service=git-upload-pack")).status).toBe(404);
    // an aliased path never reaches the resolver
    expect((await get(handler, "//repo.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect(paths).toEqual(["/nope.git"]);
    const wrong = await get(handler, "/repo.git/git-upload-pack");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    const wrongGet = await post(handler, "/repo.git/info/refs", new Uint8Array(0));
    expect(wrongGet.status).toBe(405);
    expect(wrongGet.headers.get("allow")).toBe("GET, HEAD");
  });

  it("the dumb protocol: HEAD and info/refs from the refs, refused by http.getanyfile=false", async () => {
    const { repository, repo } = await setup();
    const { handler } = handlerFor(repository, { getAnyFile: true });
    const head = await get(handler, "/repo.git/HEAD");
    expect(head.status).toBe(200);
    const target = await repo.refStore.getSymrefTarget?.("HEAD");
    expect(await head.text()).toBe(`ref: ${target}\n`);
    const refs = await get(handler, "/repo.git/info/refs");
    expect(await refs.text()).toContain(
      `${await repo.refStore.get("refs/heads/main")}\trefs/heads/main\n`,
    );
    const off = handlerFor(
      { ...repository, config: configOf({ "http.getanyfile": "false" }) },
      { getAnyFile: true },
    );
    expect((await get(off.handler, "/repo.git/HEAD")).status).toBe(403);
    expect((await get(off.handler, "/repo.git/info/refs")).status).toBe(403);
  });
});

describe("createServedFetchHandler: settings, hooks and around", () => {
  it("layers operator settings, the repository config and the resolver's settings", async () => {
    const { repository, c2, n1, pack } = await setup();
    // the operator allows deletes, the repository's config denies them
    const served: ServedRepository = {
      ...repository,
      config: configOf({ "receive.denyDeletes": "true", "http.receivepack": "true" }),
    };
    const { handler } = handlerFor(served, { settings: { allowDeletes: true } });
    const response = await post(
      handler,
      "/repo.git/git-receive-pack",
      pushRequest({
        commands: [`${c2} ${ZERO} refs/heads/main`, `${ZERO} ${n1} refs/heads/x`],
        pack,
      }),
    );
    const answer = decodeAnswer(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer.report).toEqual([
      "unpack ok",
      "ng refs/heads/main deletion prohibited",
      "ok refs/heads/x",
    ]);
  });

  it("around lasts until the push has ended; pre-receive is told the quarantine", async () => {
    const events: string[] = [];
    let quarantineSeen: string | undefined = "unset";
    const { repository, c2, n1, pack, repo } = await setup();
    const served: ServedRepository = {
      ...repository,
      config: configOf({ "http.receivepack": "true" }),
      settings: {
        hooks: {
          preReceive: (_commands, ctx) => {
            quarantineSeen = ctx.quarantinePath;
            events.push("pre-receive");
          },
        },
      },
      around: async (service, serve) => {
        events.push(`enter ${service}`);
        try {
          return await serve();
        } finally {
          events.push(`leave ${service}`);
        }
      },
    };
    const { handler } = handlerFor(served);
    const response = await post(
      handler,
      "/repo.git/git-receive-pack",
      pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack }),
    );
    // the response head is out while the push is still read
    expect(events).toEqual(["enter git-receive-pack"]);
    const answer = decodeAnswer(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["enter git-receive-pack", "pre-receive", "leave git-receive-pack"]);
    // an in-memory repository keeps no quarantine directory
    expect(quarantineSeen).toBeUndefined();
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
  });
});

describe("createServedFetchHandler: the dumb protocol off by default, hidden refs, operator's false", () => {
  it("HEAD and info/refs are refused unless getAnyFile or http.getanyfile turns them on", async () => {
    const { repository } = await setup();
    const { handler } = handlerFor(repository);
    expect((await get(handler, "/repo.git/HEAD")).status).toBe(403);
    expect((await get(handler, "/repo.git/info/refs")).status).toBe(403);
    // left unset by the operator, the repository's config turns it on (as http-backend)
    const configured = handlerFor({
      ...repository,
      config: configOf({ "http.getanyfile": "true" }),
    });
    expect((await get(configured.handler, "/repo.git/info/refs")).status).toBe(200);
    // the operator's false wins over the repository's true
    const closed = handlerFor(
      { ...repository, config: configOf({ "http.getanyfile": "true" }) },
      { getAnyFile: false },
    );
    expect((await get(closed.handler, "/repo.git/HEAD")).status).toBe(403);
    expect((await get(closed.handler, "/repo.git/info/refs")).status).toBe(403);
  });

  it("info/refs hides what upload-pack hides; refused where upload-pack is not served", async () => {
    const { repository, repo } = await setup();
    const main = await repo.refStore.get("refs/heads/main");
    await repo.refStore.update("refs/secret/x", main as string);
    await repo.refStore.update("refs/private/y", main as string);
    const { handler } = handlerFor(
      { ...repository, config: configOf({ "uploadpack.hideRefs": "refs/private" }) },
      { getAnyFile: true, settings: { hideRefs: ["refs/secret"] } },
    );
    const text = await (await get(handler, "/repo.git/info/refs")).text();
    expect(text).toContain("\trefs/heads/main\n");
    expect(text).not.toContain("refs/secret");
    expect(text).not.toContain("refs/private");
    const noUpload = handlerFor(
      { ...repository, config: configOf({ "http.uploadpack": "false" }) },
      { getAnyFile: true },
    );
    expect((await get(noUpload.handler, "/repo.git/info/refs")).status).toBe(403);
    expect((await get(noUpload.handler, "/repo.git/HEAD")).status).toBe(403);
    const operatorOff = handlerFor(repository, { getAnyFile: true, enableUploadPack: false });
    expect((await get(operatorOff.handler, "/repo.git/info/refs")).status).toBe(403);
  });

  it("the operator's enableReceivePack / enableUploadPack false wins over http.* = true", async () => {
    const { repository } = await setup();
    const config = configOf({ "http.receivepack": "true", "http.uploadpack": "true" });
    const { handler } = handlerFor(
      { ...repository, config },
      { enableReceivePack: false, enableUploadPack: false, remoteUser: () => "alice" },
    );
    expect((await get(handler, "/repo.git/info/refs?service=git-receive-pack")).status).toBe(403);
    expect((await get(handler, "/repo.git/info/refs?service=git-upload-pack")).status).toBe(403);
    expect((await post(handler, "/repo.git/git-upload-pack", new Uint8Array(0))).status).toBe(403);
  });
});

describe("createServedFetchHandler: decoded paths, failures", () => {
  it("percent-decodes each segment; encoded '/', '\\', NUL and bad escapes are 404 unasked", async () => {
    const { repository } = await setup();
    const paths: string[] = [];
    const handler = createServedFetchHandler({
      resolveRepository: async (path) => {
        paths.push(path);
        return path === "/my repo/d\u00e9p\u00f4t.git" ? repository : undefined;
      },
    });
    const ok = await get(
      handler,
      "/my%20repo/d%C3%A9p%C3%B4t.git/info/refs?service=git-upload-pack",
    );
    expect(ok.status).toBe(200);
    for (const path of ["/a%2Fb.git", "/a%2fb.git", "/a%5Cb.git", "/a%00b.git", "/a%zzb.git"]) {
      expect((await get(handler, `${path}/info/refs?service=git-upload-pack`)).status, path).toBe(
        404,
      );
    }
    expect(paths).toEqual(["/my repo/d\u00e9p\u00f4t.git"]);
    // a decoded `..` or `.` (a raw request path the URL parser did not normalise) is unsafe
    const raw = createServedHttpHandler({
      resolveRepository: async (path) => {
        paths.push(path);
        return repository;
      },
    });
    for (const path of ["/%2E%2E/repo.git", "/x/%2e/repo.git"]) {
      const response = await raw({
        method: "GET",
        path: `${path}/info/refs`,
        query: { service: "git-upload-pack" },
        headers: {},
      });
      expect(response.status, path).toBe(404);
    }
    expect(paths).toEqual(["/my repo/d\u00e9p\u00f4t.git"]);
  });

  it("an around that never serves is a 500; failures never leak their message", async () => {
    const { repository } = await setup();
    const errors: string[] = [];
    const logger = { info: () => {}, error: (msg: string) => errors.push(msg) };
    const silent = handlerFor(
      { ...repository, around: (async () => undefined) as unknown as ServedRepository["around"] },
      { logger },
    );
    const hung = await get(silent.handler, "/repo.git/info/refs?service=git-upload-pack");
    expect(hung.status).toBe(500);
    expect(await hung.text()).toBe("Internal server error");

    const throwing = handlerFor(
      {
        ...repository,
        around: async () => {
          throw new Error("secret detail /srv/git");
        },
      },
      { logger },
    );
    const failed = await get(throwing.handler, "/repo.git/info/refs?service=git-upload-pack");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("Internal server error");

    const badUser = handlerFor(repository, {
      logger,
      remoteUser: () => {
        throw new Error("token store down");
      },
    });
    const refused = await get(badUser.handler, "/repo.git/info/refs?service=git-upload-pack");
    expect(refused.status).toBe(500);
    expect(await refused.text()).toBe("Internal server error");
    expect(errors.length).toBe(3);
  });

  it("the remote user and address reach receive-pack's hooks and around", async () => {
    const { repository, c2, n1, pack } = await setup();
    const seen: unknown[] = [];
    const served: ServedRepository = {
      ...repository,
      settings: {
        hooks: {
          preReceive: (_commands, ctx) => {
            seen.push({ user: ctx.remoteUser, addr: ctx.remoteAddr });
          },
        },
      },
      around: async (_service, serve, context) => {
        seen.push(context);
        return serve();
      },
    };
    const { handler } = handlerFor(served, {
      remoteUser: () => "alice",
      remoteAddr: () => "10.0.0.7",
    });
    const response = await post(
      handler,
      "/repo.git/git-receive-pack",
      pushRequest({ commands: [`${c2} ${n1} refs/heads/main`], pack }),
    );
    const answer = decodeAnswer(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(seen).toEqual([
      { http: true, remoteUser: "alice", remoteAddr: "10.0.0.7" },
      { user: "alice", addr: "10.0.0.7" },
    ]);
  });
});
