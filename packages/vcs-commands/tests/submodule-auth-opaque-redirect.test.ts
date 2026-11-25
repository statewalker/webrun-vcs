/**
 * The credential guard of submodule and multi-remote commands (`guardSubmoduleTransports`)
 * under a browser's `fetch`, whose `redirect: "manual"` answers an opaque redirect that hides
 * its target (statewalker/webrun-vcs#313): a redirect within the approved origin succeeds,
 * and nothing the guard adds reaches another origin.
 */

import { type Credentials, GitTransportRegistry, parseGitUrl } from "@statewalker/vcs-transport";
import { describe, expect, it } from "vitest";
import {
  createSubmoduleAuthPolicy,
  guardSubmoduleTransports,
} from "../src/commands/submodule-auth.js";

const CREDENTIALS: Credentials = { username: "u", password: "p" };
const AUTH = `Basic ${btoa("u:p")}`;

/** Where each path redirects: same origin, or another one. */
const REDIRECTS: Record<string, string> = {
  "https://trusted.example/moved/repo.git/info/refs": "https://trusted.example/repo.git/info/refs",
  "https://trusted.example/away/repo.git/info/refs": "https://evil.example/repo.git/info/refs",
};

/** A browser-like fetch: manual redirects are opaque, followed ones show only where they ended. */
function browserFetch(seen: Array<{ url: string; auth: string | null; secret: string | null }>) {
  return async (request: Request): Promise<Response> => {
    let url = request.url.replace(/\?.*$/, "");
    seen.push({
      url,
      auth: request.headers.get("authorization"),
      secret: request.headers.get("x-secret"),
    });
    let redirected = false;
    while (REDIRECTS[url]) {
      if (request.redirect === "manual") {
        const opaque = new Response(null, { status: 200 });
        Object.defineProperties(opaque, {
          type: { value: "opaqueredirect" },
          status: { value: 0 },
          ok: { value: false },
        });
        return opaque;
      }
      // a browser strips Authorization across origins, never a custom header
      url = REDIRECTS[url] as string;
      redirected = true;
      seen.push({
        url,
        auth: url.startsWith("https://trusted.example/")
          ? request.headers.get("authorization")
          : null,
        secret: request.headers.get("x-secret"),
      });
    }
    const ok =
      url.startsWith("https://trusted.example/") && request.headers.get("authorization") === AUTH;
    const response = new Response(ok ? "ok" : "no", { status: ok ? 200 : 401 });
    Object.defineProperties(response, {
      url: { value: url },
      redirected: { value: redirected },
    });
    return response;
  };
}

function guarded(seen: Parameters<typeof browserFetch>[0]) {
  const registry = new GitTransportRegistry();
  registry.register({
    name: "http",
    schemes: ["https"],
    async connect(request) {
      return { kind: "http", baseUrl: request.url.raw, fetchImpl: browserFetch(seen) };
    },
  });
  return guardSubmoduleTransports(
    registry,
    createSubmoduleAuthPolicy({
      credentials: CREDENTIALS,
      headers: { "X-Secret": "s" },
      origins: ["https://trusted.example"],
    }),
  );
}

async function get(path: string, seen: Parameters<typeof browserFetch>[0]): Promise<Response> {
  const transports = guarded(seen);
  const url = parseGitUrl(`https://trusted.example/${path}`);
  const connector = transports.resolve(url);
  if (!connector) throw new Error("no connector");
  const session = await connector.connect({ url, service: "git-upload-pack", protocolVersion: 2 });
  if (session.kind !== "http") throw new Error("not http");
  return session.fetchImpl(new Request(`${session.baseUrl}/info/refs?service=git-upload-pack`));
}

describe("guardSubmoduleTransports and a browser's opaque redirects (webrun-vcs#313)", () => {
  it("follows a redirect within the approved origin with the credentials", async () => {
    const seen: Parameters<typeof browserFetch>[0] = [];
    const response = await get("moved/repo.git", seen);
    expect(response.status).toBe(200);
    expect(seen.at(-1)).toEqual({
      url: "https://trusted.example/repo.git/info/refs",
      auth: AUTH,
      secret: "s",
    });
  });

  it("sends nothing it adds to another origin", async () => {
    const seen: Parameters<typeof browserFetch>[0] = [];
    const response = await get("away/repo.git", seen);
    expect(response.status).toBe(401);
    const elsewhere = seen.filter((s) => s.url.startsWith("https://evil.example/"));
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere.every((s) => s.auth === null && s.secret === null)).toBe(true);
  });
});
