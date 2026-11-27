/**
 * The smart-HTTP client's handling of git's `http.*` settings over a mock `fetch`: what the
 * native twins (vcs-commands `http-client-config-native.test.ts`) cannot reach, such as a
 * browser's opaque redirects, header precedence and the challenge splitting.
 */

import { md5Hex } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";
import {
  type DigestChallenge,
  digestAuthorization,
  type HttpClientSettings,
  parseDigestChallenge,
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

describe("SmartHttpClient re-rooted at another origin", () => {
  it("sends none of the caller's Authorization or Cookie headers to the new origin", async () => {
    const requests: Request[] = [];
    const instance = new SmartHttpClient({
      url: "https://a.example/repo.git",
      fetchImpl: async (request) => {
        requests.push(request);
        const response = new Response("ok");
        if (request.url.startsWith("https://a.example/")) {
          Object.defineProperty(response, "url", {
            value: "https://b.example/repo.git/info/refs?service=git-upload-pack",
          });
        }
        return response;
      },
      headers: { Authorization: "Bearer T", Cookie: "c=1", "X-Other": "kept" },
      auth: { username: "u", password: "p" },
      signal: new AbortController().signal,
    });
    await instance.discover("git-upload-pack", {}, direct);
    await instance.post("git-upload-pack", {}, { body: new Uint8Array([1]) }, direct);
    const post = requests[1];
    expect(post?.url).toBe("https://b.example/repo.git/git-upload-pack");
    expect(post?.headers.get("authorization")).toBeNull();
    expect(post?.headers.get("cookie")).toBeNull();
    expect(post?.headers.get("x-other")).toBe("kept");
  });
});

describe("Digest authentication (RFC 7616)", () => {
  it("answers RFC 2617's example (3.5) and RFC 7616's MD5 example (3.9.1)", () => {
    const rfc2617 = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    expect(rfc2617).toBeDefined();
    const value = digestAuthorization(
      rfc2617 as DigestChallenge,
      { username: "Mufasa", password: "Circle Of Life" },
      { method: "GET", uri: "/dir/index.html", nc: 1, cnonce: "0a4f113b" },
    );
    expect(value).toBe(
      'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", cnonce="0a4f113b", nc=00000001, qop=auth, response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    const rfc7616 = parseDigestChallenge(
      'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
    ) as DigestChallenge;
    expect(
      digestAuthorization(
        rfc7616,
        { username: "Mufasa", password: "Circle of Life" },
        {
          method: "GET",
          uri: "/dir/index.html",
          nc: 1,
          cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        },
      ),
    ).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
    // RFC 7616 3.9.1's SHA-256 answer to the same challenge
    const sha = parseDigestChallenge(
      'Digest realm="http-auth@example.org", qop="auth", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"',
    ) as DigestChallenge;
    expect(
      digestAuthorization(
        sha,
        { username: "Mufasa", password: "Circle of Life" },
        {
          method: "GET",
          uri: "/dir/index.html",
          nc: 1,
          cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        },
      ),
    ).toContain(
      'response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1", algorithm=SHA-256',
    );
  });

  it("answers without qop (RFC 2069), with MD5-sess and with userhash; refuses unknown algorithms", () => {
    const plain = parseDigestChallenge('Digest realm="r", nonce="n"') as DigestChallenge;
    const value = digestAuthorization(
      plain,
      { username: 'a"b', password: "p" },
      { method: "POST", uri: "/x", nc: 1, cnonce: "c" },
    );
    const ha1 = md5Hex('a"b:r:p');
    expect(value).toBe(
      `Digest username="a\\"b", realm="r", nonce="n", uri="/x", response="${md5Hex(`${ha1}:n:${md5Hex("POST:/x")}`)}"`,
    );
    const sess = parseDigestChallenge(
      'Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess, userhash=true',
    ) as DigestChallenge;
    const sessValue = digestAuthorization(
      sess,
      { username: "u", password: "p" },
      { method: "GET", uri: "/", nc: 2, cnonce: "c" },
    );
    const sessHa1 = md5Hex(`${md5Hex("u:r:p")}:n:c`);
    expect(sessValue).toBe(
      `Digest username="${md5Hex("u:r")}", realm="r", nonce="n", uri="/", cnonce="c", nc=00000002, qop=auth, response="${md5Hex(`${sessHa1}:n:00000002:c:auth:${md5Hex("GET:/")}`)}", algorithm=MD5-sess, userhash=true`,
    );
    expect(
      parseDigestChallenge('Digest realm="r", nonce="n", algorithm=SHA-512-256-sess'),
    ).toBeDefined();
    expect(parseDigestChallenge('Digest realm="r", nonce="n", algorithm=SHA-1')).toBeUndefined();
    expect(parseDigestChallenge('Digest realm="r", nonce="n", qop="auth-int"')).toBeUndefined();
    expect(parseDigestChallenge('Basic realm="r"')).toBeUndefined();
    expect(parseDigestChallenge('Digest realm="r"')).toBeUndefined();
  });

  const challenge = (nonce: string, stale = false) =>
    `Digest realm="r", nonce="${nonce}", qop="auth"${stale ? ", stale=true" : ""}`;

  it("answers a stale nonce again with the new one, a refused answer once more only", async () => {
    let calls = 0;
    const { instance, requests } = client(
      (request) => {
        calls++;
        const auth = request.headers.get("authorization");
        if (!auth)
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": challenge("one") },
          });
        if (auth.includes('nonce="one"')) {
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": challenge("two", true) },
          });
        }
        return new Response("ok");
      },
      {},
      { credentialHelper: { fill: () => ({ username: "u", password: "p" }) } },
    );
    await instance.discover("git-upload-pack", {}, direct);
    expect(calls).toBe(3);
    const answers = requests.map((r) => r.headers.get("authorization") ?? "");
    expect(answers[1]).toMatch(/nonce="one".*nc=00000001/);
    expect(answers[2]).toMatch(/nonce="two".*nc=00000001/);

    const refused = client(
      () => new Response(null, { status: 401, headers: { "WWW-Authenticate": challenge("n") } }),
      {},
      { credentialHelper: { fill: () => ({ username: "u", password: "bad" }) } },
    );
    await expect(refused.instance.discover("git-upload-pack", {}, direct)).rejects.toThrow(
      /Authentication failed/,
    );
    expect(
      refused.requests.map((r) => r.headers.get("authorization")?.match(/nc=\w+/)?.[0] ?? ""),
    ).toEqual(["", "nc=00000001", "nc=00000002"]);
  });

  it("prefers Digest to Basic when both are offered, and keeps a helper's authtype as it is", async () => {
    const offered = { "WWW-Authenticate": `Basic realm="r", ${challenge("n")}` };
    const both = client(
      (request) =>
        request.headers.get("authorization")?.startsWith("Digest ")
          ? new Response("ok")
          : new Response(null, { status: 401, headers: offered }),
      {},
      { credentialHelper: { fill: () => ({ username: "u", password: "p" }) } },
    );
    await both.instance.discover("git-upload-pack", {}, direct);
    expect(both.requests).toHaveLength(2);
    const bearer = client(
      (request) =>
        request.headers.get("authorization") === "Bearer t"
          ? new Response("ok")
          : new Response(null, { status: 401, headers: offered }),
      {},
      { credentialHelper: { fill: () => ({ authtype: "Bearer", credential: "t" }) } },
    );
    await bearer.instance.discover("git-upload-pack", {}, direct);
    expect(bearer.requests).toHaveLength(2);
  });
});

describe("post_rpc's large requests (http.postBuffer, probe_rpc)", () => {
  const unauthorized = () =>
    new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="r"' } });
  const guarded = (request: Request) =>
    request.method === "POST" && request.headers.get("authorization") === null
      ? unauthorized()
      : new Response("ok");
  const helper = { fill: () => ({ username: "u", password: "p" }) };

  async function* chunks(sizes: number[], produced: number[]) {
    for (const size of sizes) {
      produced.push(size);
      yield new Uint8Array(size);
    }
  }

  async function run(sizes: number[], postBuffer?: number) {
    const { instance, requests } = client(guarded, postBuffer === undefined ? {} : { postBuffer }, {
      credentialHelper: helper,
    });
    await instance.discover("git-receive-pack", {}, direct);
    const produced: number[] = [];
    const sent: string[] = [];
    const answer = await instance.postRpc(
      chunks(sizes, produced),
      () =>
        instance.post("git-receive-pack", {}, { body: new TextEncoder().encode("0000") }, direct),
      async (body, large) => {
        let length = 0;
        if (body instanceof Uint8Array) length = body.length;
        else for await (const chunk of body) length += chunk.length;
        sent.push(`${large ? "large" : "small"} ${length}`);
        return instance.post("git-receive-pack", {}, { body: new Uint8Array(length) }, direct);
      },
    );
    const shape = requests.map((r) => `${r.method} ${r.headers.get("authorization") ?? "-"}`);
    return { answer, produced, sent, shape };
  }

  it("a request within the buffer is sent whole and again after the 401, produced once", async () => {
    const outcome = await run([65520, 65520]);
    expect(outcome.answer.status).toBe(200);
    expect(outcome.produced).toEqual([65520, 65520]);
    expect(outcome.sent).toEqual(["small 131040", "small 131040"]);
    expect(outcome.shape).toEqual(["GET -", "POST -", "POST Basic dTpw"]);
  });

  it("a larger one is probed, then sent once (default buffer: 16 * 65520, less 65520)", async () => {
    // 982800 bytes still fit, one more does not
    const fits = await run([982800]);
    expect(fits.sent).toEqual(["small 982800", "small 982800"]);
    const outcome = await run([982800, 1, 5]);
    expect(outcome.answer.status).toBe(200);
    expect(outcome.produced).toEqual([982800, 1, 5]);
    expect(outcome.sent).toEqual(["large 982806"]);
    // the probe (401, then with the helper's credentials), then the request
    expect(outcome.shape).toEqual(["GET -", "POST -", "POST Basic dTpw", "POST Basic dTpw"]);
  });

  it("http.postBuffer sets the limit (at least LARGE_PACKET_MAX: any request is large)", async () => {
    const outcome = await run([10], 65520);
    expect(outcome.sent).toEqual(["large 10"]);
  });

  it("a probe refused gives its answer back and sends nothing", async () => {
    const { instance } = client(() => unauthorized(), {}, {});
    let sent = false;
    const answer = await instance.postRpc(
      new Uint8Array(2_000_000),
      () => instance.post("git-receive-pack", {}, { body: new Uint8Array(4) }, direct),
      async () => {
        sent = true;
        return new Response("ok");
      },
    );
    expect(answer.status).toBe(401);
    expect(sent).toBe(false);
  });

  it("a large request answering 401 is not sent again", async () => {
    let posts = 0;
    const { instance } = client(
      (request) => {
        if (request.method !== "POST") return new Response("ok");
        posts++;
        return posts === 1 ? new Response("ok") : unauthorized();
      },
      {},
      { credentialHelper: helper },
    );
    let sends = 0;
    const answer = await instance.postRpc(
      new Uint8Array(2_000_000),
      () => instance.post("git-receive-pack", {}, { body: new Uint8Array(4) }, direct),
      async () => {
        sends++;
        return instance.post("git-receive-pack", {}, { body: new Uint8Array(1) }, direct);
      },
    );
    expect(answer.status).toBe(401);
    expect(sends).toBe(1);
  });
});

describe("post_rpc's re-authentication and http.proactiveAuth", () => {
  it("asks the helper when a POST answers 401 and sends it again, approving what worked", async () => {
    const log: string[] = [];
    const { instance, requests } = client(
      (request) =>
        request.method === "POST" && request.headers.get("authorization") === null
          ? new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="r"' } })
          : new Response("ok"),
      {},
      {
        credentialHelper: {
          fill: (r) => {
            log.push(`fill ${r.wwwAuthenticate.join(";")}`);
            return { username: "u", password: "p" };
          },
          approve: (_c, r) => {
            log.push(`approve ${r.wwwAuthenticate.join(";")}`);
          },
        },
      },
    );
    await instance.discover("git-upload-pack", {}, direct);
    const answer = await instance.postAuthorized(() =>
      instance.post("git-upload-pack", {}, { body: new Uint8Array([48, 48, 48, 48]) }, direct),
    );
    expect(answer.status).toBe(200);
    expect(requests.map((r) => `${r.method} ${r.headers.get("authorization") ?? "-"}`)).toEqual([
      "GET -",
      "POST -",
      "POST Basic dTpw",
    ]);
    expect(log).toEqual(['fill Basic realm="r"', "approve "]);
  });

  it("rejects credentials a POST refuses and gives the 401 back", async () => {
    const rejected: string[] = [];
    const { instance } = client(
      (request) =>
        request.method === "POST"
          ? new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="r"' } })
          : new Response("ok"),
      {},
      {
        credentialHelper: {
          fill: () => ({ username: "u", password: "bad" }),
          reject: (c) => {
            rejected.push(c.password ?? "");
          },
        },
      },
    );
    await instance.discover("git-upload-pack", {}, direct);
    const answer = await instance.postAuthorized(() =>
      instance.post("git-upload-pack", {}, { body: new Uint8Array(0) }, direct),
    );
    expect(answer.status).toBe(401);
    expect(rejected).toEqual(["bad"]);
  });

  it("asks the helper before the first request under basic and auto, not under none", async () => {
    for (const [mode, wwwauth, asked] of [
      ["basic", "Basic", true],
      ["auto", "", true],
      ["none", "", false],
    ] as const) {
      const fills: string[] = [];
      const { instance, requests } = client(
        (request) =>
          request.headers.get("authorization")
            ? new Response("ok")
            : new Response(null, { status: 403 }),
        { proactiveAuth: mode },
        {
          credentialHelper: {
            fill: (r) => {
              fills.push(r.wwwAuthenticate.join(";"));
              return { username: "u", password: "p" };
            },
          },
        },
      );
      const discovered = instance.discover("git-upload-pack", {}, direct);
      if (asked) {
        await discovered;
        expect(fills).toEqual([wwwauth]);
        expect(requests[0]?.headers.get("authorization")).toBe("Basic dTpw");
      } else {
        await expect(discovered).rejects.toThrow(/403/);
        expect(fills).toEqual([]);
      }
    }
  });
});
