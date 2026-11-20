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
    const { handler } = handlerFor(repository);
    const head = await get(handler, "/repo.git/HEAD");
    expect(head.status).toBe(200);
    const target = await repo.refStore.getSymrefTarget?.("HEAD");
    expect(await head.text()).toBe(`ref: ${target}\n`);
    const refs = await get(handler, "/repo.git/info/refs");
    expect(await refs.text()).toContain(
      `${await repo.refStore.get("refs/heads/main")}\trefs/heads/main\n`,
    );
    const off = handlerFor({ ...repository, config: configOf({ "http.getanyfile": "false" }) });
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
