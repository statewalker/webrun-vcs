import { describe, expect, it } from "vitest";
import type { BatchResponse } from "../src/index.js";
import { lfsDownload, serveLfs } from "../src/index.js";
import { drain, makeStore, memResolver } from "./helpers.js";

const URL = "http://lfs.test";

describe("resolver-mediated mapping", () => {
  it("download batch reports an unmapped oid as an error object, not a crash", async () => {
    const store = makeStore();
    const resolver = memResolver(); // empty — nothing mapped
    const handler = serveLfs(store, resolver);
    const oid = "d".repeat(64);

    const res = await handler(
      new Request(`${URL}/objects/batch`, {
        method: "POST",
        body: JSON.stringify({
          operation: "download",
          transfers: ["basic"],
          objects: [{ oid, size: 5 }],
        }),
      }),
    );
    const json = (await res.json()) as BatchResponse;

    expect(res.status).toBe(200);
    const o = json.objects[0];
    expect(o.oid).toBe(oid);
    expect(o.actions).toBeUndefined();
    expect(o.error?.code).toBe(404);
  });

  it("client download surfaces the missing object as an error event", async () => {
    const store = makeStore();
    const resolver = memResolver();
    const handler = serveLfs(store, resolver);
    const oid = "e".repeat(64);

    const events = await drain(
      lfsDownload(makeStore(), memResolver(), URL, [{ oid, size: 5 }], handler),
    );

    expect(events.some((e) => e.type === "error" && e.oid === oid)).toBe(true);
    expect(events.some((e) => e.type === "object-downloaded")).toBe(false);
  });

  it("GET of an unmapped oid is 404", async () => {
    const handler = serveLfs(makeStore(), memResolver());
    const res = await handler(new Request(`${URL}/objects/${"f".repeat(64)}`, { method: "GET" }));
    expect(res.status).toBe(404);
  });
});
