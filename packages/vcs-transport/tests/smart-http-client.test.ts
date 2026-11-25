/**
 * The smart-HTTP client's handling of git's `http.*` settings over a mock `fetch`: what the
 * native twins (vcs-commands `http-client-config-native.test.ts`) cannot reach, such as a
 * browser's opaque redirects, header precedence and the challenge splitting.
 */

import { describe, expect, it } from "vitest";
import {
  type HttpClientSettings,
  retryAfterOf,
  SmartHttpClient,
  splitChallenges,
} from "../src/http-client/index.js";

const direct = <T>(next: () => Promise<T>) => next();

function client(
  respond: (request: Request) => Response,
  settings: HttpClientSettings = {},
  extra: Partial<ConstructorParameters<typeof SmartHttpClient>[0]> = {},
) {
  const requests: Request[] = [];
  const instance = new SmartHttpClient({
    url: "https://git.example.com/repo.git",
    fetchImpl: async (request) => {
      requests.push(request);
      return respond(request);
    },
    settings,
    signal: new AbortController().signal,
    ...extra,
  });
  return { instance, requests };
}

describe("SmartHttpClient", () => {
  it("lets http.extraHeader lines override the client's own headers, in order", async () => {
    const { instance, requests } = client(
      () => new Response("ok"),
      {
        userAgent: "git/2.56.1",
        extraHeaders: ["Authorization: Bearer from-config", "X-A: 1", "X-A: 2", "User-Agent:"],
      },
      { auth: { username: "u", password: "p" }, headers: { "X-Caller": "c" } },
    );
    await instance.discover("git-upload-pack", { Accept: "x" }, direct);
    const headers = requests[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer from-config");
    expect(headers?.get("x-a")).toBe("1, 2");
    expect(headers?.get("user-agent")).toBeNull();
    expect(headers?.get("x-caller")).toBe("c");
    expect(headers?.get("accept")).toBe("x");
  });

  it("asks for no redirect on later requests unless http.followRedirects=true", async () => {
    for (const [mode, expected] of [
      [undefined, ["follow", "manual"]],
      ["none", ["manual", "manual"]],
      ["always", ["follow", "follow"]],
    ] as const) {
      const { instance, requests } = client(
        () => new Response("ok"),
        mode ? { followRedirects: mode } : {},
      );
      await instance.discover("git-upload-pack", {}, direct);
      await instance.post("git-upload-pack", {}, { body: new Uint8Array([1]) }, direct);
      expect(requests.map((r) => r.redirect)).toEqual(expected);
    }
  });

  it("takes a browser's opaque redirect of info/refs for git's redirect error", async () => {
    const { instance } = client(
      () => {
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "type", { value: "opaqueredirect" });
        Object.defineProperty(response, "status", { value: 0 });
        Object.defineProperty(response, "ok", { value: false });
        return response;
      },
      { followRedirects: "none" },
    );
    await expect(instance.discover("git-upload-pack", {}, direct)).rejects.toThrow(
      "fatal: unable to access 'https://git.example.com/repo.git/': The requested URL returned error: 302",
    );
  });

  it("gives a 401 to the credential helper and approves what worked", async () => {
    const events: string[] = [];
    const { instance, requests } = client(
      (request) =>
        request.headers.get("authorization") === "Bearer t"
          ? new Response("ok")
          : new Response("no", {
              status: 401,
              headers: { "WWW-Authenticate": 'Basic realm="x", Bearer scope="repo"' },
            }),
      {},
      {
        credentialHelper: {
          fill: ({ host, wwwAuthenticate }) => {
            events.push(`fill ${host} ${wwwAuthenticate.join(" | ")}`);
            return { authtype: "Bearer", credential: "t" };
          },
          approve: (c) => {
            events.push(`approve ${c.authtype}`);
          },
          reject: () => {
            events.push("reject");
          },
        },
      },
    );
    await instance.discover("git-upload-pack", {}, direct);
    expect(events).toEqual([
      'fill git.example.com Basic realm="x" | Bearer scope="repo"',
      "approve Bearer",
    ]);
    expect(requests.map((r) => r.headers.get("authorization"))).toEqual([null, "Bearer t"]);
  });

  it("never hands static credentials to the helper", async () => {
    const events: string[] = [];
    const { instance } = client(
      () => new Response("no", { status: 401 }),
      {},
      {
        auth: { token: "static" },
        credentialHelper: {
          fill: () => {
            events.push("fill");
            return undefined;
          },
          reject: () => {
            events.push("reject");
          },
        },
      },
    );
    await expect(instance.discover("git-upload-pack", {}, direct)).rejects.toThrow(
      "Authentication failed for 'https://git.example.com/repo.git/'",
    );
    expect(events).toEqual([]);
  });

  it("retries a 429 with http.maxRetries requests in all, waiting as told", async () => {
    const waits: number[] = [];
    const warnings: string[] = [];
    let count = 0;
    const { instance } = client(
      () =>
        count++ < 2
          ? new Response("slow", { status: 429, headers: { "Retry-After": "2" } })
          : new Response("ok"),
      {
        maxRetries: 3,
        sleep: async (ms) => {
          waits.push(ms);
        },
        onWarning: (line) => warnings.push(line),
      },
    );
    await instance.discover("git-upload-pack", {}, direct);
    expect(waits).toEqual([2000, 2000]);
    expect(warnings).toEqual([
      "warning: rate limited, waiting 2 seconds before retry",
      "warning: rate limited, waiting 2 seconds before retry",
    ]);
  });

  it("answers a 429 as git 2.43 without rate-limit retries", async () => {
    const { instance, requests } = client(() => new Response("slow", { status: 429 }), {
      maxRetries: 5,
      rateLimitRetries: false,
    });
    await expect(instance.discover("git-upload-pack", {}, direct)).rejects.toThrow(
      "The requested URL returned error: 429",
    );
    expect(requests).toHaveLength(1);
  });
});

describe("splitChallenges", () => {
  it("splits challenges joined by a Headers object, keeping their parameters", () => {
    expect(splitChallenges('Basic realm="a, b", charset="UTF-8", Bearer x=1, Negotiate')).toEqual([
      'Basic realm="a, b", charset="UTF-8"',
      "Bearer x=1",
      "Negotiate",
    ]);
    expect(splitChallenges(null)).toEqual([]);
  });
});

describe("retryAfterOf", () => {
  it("reads seconds or an HTTP date, as curl's CURLINFO_RETRY_AFTER", () => {
    const at = (value: string) =>
      retryAfterOf(new Response(null, { status: 429, headers: { "Retry-After": value } }));
    expect(at("5")).toBe(5);
    expect(at("0")).toBe(-1);
    expect(at(new Date(Date.now() + 10_500).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(at("Mon, 01 Jan 2001 00:00:00 GMT")).toBe(-1);
    expect(at("soon")).toBe(-1);
  });
});
