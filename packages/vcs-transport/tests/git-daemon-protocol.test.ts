/**
 * git-daemon's request line (daemon.c), `GIT_PROTOCOL` parsing, git's shell quoting of the ssh
 * command, the git:// and ssh connectors over host hooks, and `serveGitConnection`'s refusals,
 * without native git.
 */

import { describe, expect, it } from "vitest";
import {
  createDefaultTransports,
  createGitDaemonConnector,
  createSshConnector,
  type Duplex,
  daemonAvoidsAlias,
  GitDaemonRequestError,
  gitDaemonRequest,
  gitSshCommand,
  gitSshEnv,
  openDuplexConnection,
  openDuplexReceivePackConnection,
  openHttpConnection,
  openHttpReceivePackConnection,
  parseGitDaemonRequest,
  parseGitProtocolEnv,
  parseGitServiceCommand,
  parseGitUrl,
  readGitDaemonRequest,
  serveGitConnection,
  serveGitService,
  sqDequoteWords,
  sqQuote,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** The pkt-line of `payload`, as text. */
const line = (payload: string) => dec.decode(pkt(payload));
const pkt = (payload: string) => {
  const bytes = enc.encode(payload);
  return enc.encode(`${(bytes.length + 4).toString(16).padStart(4, "0")}${payload}`);
};

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

/** An in-memory duplex: the client's bytes given, what the server writes collected. */
function serverSide(...input: Uint8Array[]): Duplex & { written(): string; closed: boolean } {
  const out: Uint8Array[] = [];
  const duplex = {
    closed: false,
    [Symbol.asyncIterator]: () => chunks(...input)[Symbol.asyncIterator](),
    write(data: Uint8Array) {
      out.push(data.slice());
    },
    async close() {
      duplex.closed = true;
    },
    written: () => out.map((c) => dec.decode(c)).join(""),
  };
  return duplex;
}

describe("git-daemon's request line", () => {
  it("reads command, path, host, port and the parameters after the second NUL", () => {
    expect(
      parseGitDaemonRequest(
        enc.encode("git-upload-pack /r.git\0host=Example.COM:9418\0\0version=2\0x=y\0"),
      ),
    ).toEqual({
      command: "git-upload-pack",
      path: "/r.git",
      host: "example.com",
      port: "9418",
      gitProtocol: "version=2:x=y",
    });
    expect(parseGitDaemonRequest(enc.encode("git-receive-pack /a b\n"))).toEqual({
      command: "git-receive-pack",
      path: "/a b",
    });
    // no host, parameters after an empty field
    expect(parseGitDaemonRequest(enc.encode("git-upload-pack /r\0\0version=1\0"))).toEqual({
      command: "git-upload-pack",
      path: "/r",
      gitProtocol: "version=1",
    });
    // a bracketed host, its port; a host's directory separators and leading dots dropped
    expect(
      parseGitDaemonRequest(enc.encode("git-upload-pack /r\0host=[::1]:1234\0")),
    ).toMatchObject({
      host: "::1",
      port: "1234",
    });
    expect(parseGitDaemonRequest(enc.encode("git-upload-pack /r\0host=../a/b.\0"))).toMatchObject({
      host: "ab",
    });
    // the host key is matched without case; an empty host names none
    expect(parseGitDaemonRequest(enc.encode("git-upload-pack /r\0HOST=h\0"))).toMatchObject({
      host: "h",
    });
    expect(parseGitDaemonRequest(enc.encode("git-upload-pack /r\0host=\0"))).toEqual({
      command: "git-upload-pack",
      path: "/r",
    });
  });

  it("refuses what git-daemon dies on", () => {
    const refused = (text: string) => {
      try {
        parseGitDaemonRequest(enc.encode(text));
      } catch (e) {
        expect(e).toBeInstanceOf(GitDaemonRequestError);
        return (e as Error).message;
      }
      return undefined;
    };
    // a field after host= that is not behind the second NUL
    expect(refused("git-upload-pack /r\0host=h\0version=2\0")).toBe("Invalid request");
    // a first field other than host=
    expect(refused("git-upload-pack /r\0version=2\0")).toBe("Invalid request");
    expect(refused("git-upload-pack /r\0host=[::1\0")).toBe("Invalid request ('[' without ']')");
    expect(refused("git-upload-pack /r\0host=[::1]x\0")).toBe("Garbage after end of host part");
    // no command word
    expect(refused("upload-pack /r\0")).toBe("Protocol error: 'upload-pack /r'");
    expect(refused("git-upload-pack\0")).toBe("Protocol error: 'git-upload-pack'");
  });

  it("reads the first pkt-line without losing what follows, split anywhere", async () => {
    const first = pkt("git-upload-pack /r\0host=h\0");
    const all = new Uint8Array([...first, ...enc.encode("0000rest")]);
    for (const cut of [1, 3, 5, first.length, first.length + 2]) {
      const { request, input } = await readGitDaemonRequest(
        chunks(all.subarray(0, cut), all.subarray(cut)),
      );
      expect(request).toEqual({ command: "git-upload-pack", path: "/r", host: "h" });
      let rest = "";
      for await (const c of input) rest += dec.decode(c);
      expect(rest).toBe("0000rest");
    }
    // an iteration left early does not end the stream for the next one
    const { input } = await readGitDaemonRequest(chunks(first, enc.encode("a"), enc.encode("b")));
    for await (const c of input) {
      expect(dec.decode(c)).toBe("a");
      break;
    }
    for await (const c of input) expect(dec.decode(c)).toBe("b");
  });

  it("refuses an oversized line, a flush, a bad length, a stream that ends first", async () => {
    const message = async (...parts: Uint8Array[]) =>
      readGitDaemonRequest(chunks(...parts)).then(
        () => undefined,
        (e: Error) => e.message,
      );
    expect(await message(enc.encode("fff1"))).toBe("protocol error: bad line length 65521");
    expect(await message(enc.encode("0000"))).toBe("Protocol error: ''");
    expect(await message(enc.encode("zzzz"))).toBe("protocol error: bad line length character");
    expect(await message(enc.encode("0020git-up"))).toBe("the peer hung up before its request");
    // the longest line git-daemon reads is read
    const longest = `git-upload-pack /${"x".repeat(65520 - 4 - 17)}`;
    const ok = await readGitDaemonRequest(chunks(pkt(longest)));
    expect(ok.request.path.length).toBe(65520 - 4 - 16);
  });

  it("round-trips the line our client writes", () => {
    const written = gitDaemonRequest({
      url: parseGitUrl("git://h:9419/~u/r.git"),
      service: "git-upload-pack",
      protocolVersion: 2,
    });
    expect(parseGitDaemonRequest(written.subarray(4))).toEqual({
      command: "git-upload-pack",
      path: "~u/r.git",
      host: "h",
      port: "9419",
      gitProtocol: "version=2",
    });
    // --upload-pack names the program in the line, as git_connect_git writes it
    const custom = gitDaemonRequest({
      url: parseGitUrl("git://h/r"),
      service: "git-upload-pack",
      protocolVersion: 0,
      program: "git-upload-pack-x",
    });
    expect(dec.decode(custom)).toBe(line("git-upload-pack-x /r\0host=h\0"));
  });

  it("GIT_PROTOCOL: the greatest version asked for", () => {
    expect(parseGitProtocolEnv("version=2:foo=bar")).toEqual({
      version: 2,
      params: ["version=2", "foo=bar"],
    });
    expect(parseGitProtocolEnv("version=2:version=1").version).toBe(2);
    expect(parseGitProtocolEnv("version=3").version).toBe(0);
    expect(parseGitProtocolEnv(undefined)).toEqual({ version: 0, params: [] });
    expect(parseGitProtocolEnv("").version).toBe(0);
  });

  it("daemon_avoid_alias", () => {
    for (const p of ["/r", "/a/b.git", "~u/r", "/a/.../b", "/.x", "/a."]) {
      expect(daemonAvoidsAlias(p), p).toBe(false);
    }
    for (const p of ["r", "/a//b", "/a/./b", "/a/../b", "/a/..", "/a/.", "//"]) {
      expect(daemonAvoidsAlias(p), p).toBe(true);
    }
  });
});

describe("git's shell quoting of the ssh command", () => {
  it("quotes as sq_quote_buf and reads it back as git-shell", () => {
    expect(sqQuote("/srv/r.git")).toBe("'/srv/r.git'");
    expect(sqQuote("it's !x")).toBe("'it'\\''s '\\!'x'");
    expect(sqDequoteWords(sqQuote("it's !x"))).toEqual(["it's !x"]);
    expect(sqDequoteWords("'a' 'b'")).toEqual(["a", "b"]);
    expect(sqDequoteWords("a")).toBeUndefined();
    expect(sqDequoteWords("'a")).toBeUndefined();
    expect(parseGitServiceCommand("git-upload-pack '/r'")).toEqual({
      service: "git-upload-pack",
      path: "/r",
    });
    expect(parseGitServiceCommand("git receive-pack '~/x y'")).toEqual({
      service: "git-receive-pack",
      path: "~/x y",
    });
    expect(parseGitServiceCommand("git-upload-pack '/r' '/s'")).toBeUndefined();
    expect(parseGitServiceCommand("sh -c x")).toBeUndefined();
  });

  it("builds connect.c's command and environment", () => {
    const request = (
      url: string,
      service: "git-upload-pack" | "git-receive-pack",
      v: 0 | 1 | 2,
    ) => ({
      url: parseGitUrl(url),
      service,
      protocolVersion: v,
    });
    expect(gitSshCommand(request("host:~/r.git", "git-upload-pack", 2))).toBe(
      "git-upload-pack '~/r.git'",
    );
    expect(gitSshCommand(request("ssh://h/~u/r", "git-receive-pack", 0))).toBe(
      "git-receive-pack '~u/r'",
    );
    expect(gitSshCommand({ ...request("host:/r", "git-upload-pack", 2), program: "/opt/up" })).toBe(
      "/opt/up '/r'",
    );
    expect(gitSshEnv(request("h:r", "git-upload-pack", 2))).toEqual({ GIT_PROTOCOL: "version=2" });
    expect(gitSshEnv(request("h:r", "git-upload-pack", 1))).toEqual({ GIT_PROTOCOL: "version=1" });
    expect(gitSshEnv(request("h:r", "git-receive-pack", 2))).toEqual({});
    expect(gitSshEnv(request("h:r", "git-upload-pack", 0))).toEqual({});
    expect(() => gitSshCommand(request("h:-r", "git-upload-pack", 0))).toThrow(
      "fatal: strange pathname '-r' blocked",
    );
  });
});

describe("connectors over host hooks", () => {
  const nothing: Duplex = {
    [Symbol.asyncIterator]: () => chunks()[Symbol.asyncIterator](),
    write() {},
  };

  it("git:// opens host:port (9418 by default); ssh runs the command with GIT_PROTOCOL", async () => {
    const sockets: string[] = [];
    const git = createGitDaemonConnector({
      openSocket: async (host, port) => {
        sockets.push(`${host} ${port}`);
        return nothing;
      },
    });
    const a = await git.connect({
      url: parseGitUrl("git://h/r"),
      service: "git-upload-pack",
      protocolVersion: 2,
    });
    await git.connect({
      url: parseGitUrl("git://[::1]:7/r"),
      service: "git-upload-pack",
      protocolVersion: 2,
    });
    expect(sockets).toEqual(["h 9418", "::1 7"]);
    expect(a).toMatchObject({ kind: "native", handshake: "git-daemon" });

    const runs: unknown[] = [];
    const ssh = createSshConnector({
      exec: async (target, command, env) => {
        runs.push([target, command, env]);
        return nothing;
      },
    });
    const s = await ssh.connect({
      url: parseGitUrl("ssh://me@h:22/srv/r.git"),
      service: "git-upload-pack",
      protocolVersion: 2,
    });
    expect(s).toMatchObject({ kind: "native", handshake: "implicit" });
    expect(runs).toEqual([
      [
        { host: "h", port: 22, user: "me" },
        "git-upload-pack '/srv/r.git'",
        { GIT_PROTOCOL: "version=2" },
      ],
    ]);
    await expect(
      ssh.connect({
        url: parseGitUrl("ssh://-oProxyCommand=x/r"),
        service: "git-upload-pack",
        protocolVersion: 0,
      }),
    ).rejects.toThrow("fatal: strange hostname '-oProxyCommand=x' blocked");
  });

  it("the default transports register them only when the host gives the hook", () => {
    const plain = createDefaultTransports();
    expect(plain.resolve("git://h/r")).toBeUndefined();
    expect(plain.resolve("h:r")).toBeUndefined();
    const full = createDefaultTransports({
      openSocket: async () => nothing,
      exec: async () => nothing,
    });
    expect(full.resolve("git://h/r")?.name).toBe("git");
    expect(full.resolve("h:r")?.name).toBe("ssh");
    expect(full.resolve("git+ssh://h/r")?.name).toBe("ssh");
    expect(full.resolve("https://h/r")?.name).toBe("http");
  });
});

describe("serveGitConnection refusals", () => {
  const resolveNone = async () => undefined;

  it("an unknown repository: git-daemon's ERR, informative or not", async () => {
    const duplex = serverSide(pkt("git-upload-pack /nope\0host=h\0"));
    const result = await serveGitConnection({ duplex, resolveRepository: resolveNone });
    expect(duplex.written()).toBe(line("ERR access denied or repository not exported: /nope"));
    expect(result).toMatchObject({ success: false, request: { path: "/nope", host: "h" } });
    expect(duplex.closed).toBe(true);

    const informative = serverSide(pkt("git-upload-pack /nope\0host=h\0"));
    await serveGitConnection({
      duplex: informative,
      resolveRepository: resolveNone,
      informativeErrors: true,
    });
    expect(informative.written()).toBe(line("ERR no such repository: /nope"));
  });

  it("receive-pack unless enabled (or a repository's daemon.receivepack); upload-archive", async () => {
    let asked = 0;
    const repo = (config: Record<string, string[]>) => async () => {
      asked++;
      return {
        repository: {} as never,
        refStore: {} as never,
        config: { getAll: (key: string) => config[key.toLowerCase()] ?? [] },
      };
    };
    const push = serverSide(pkt("git-receive-pack /r\0host=h\0"));
    await serveGitConnection({
      duplex: push,
      resolveRepository: repo({}),
      informativeErrors: true,
    });
    expect(push.written()).toBe(line("ERR service not enabled: /r"));
    // --forbid-override: refused before the repository is looked for
    asked = 0;
    const forbidden = serverSide(pkt("git-receive-pack /r\0host=h\0"));
    await serveGitConnection({
      duplex: forbidden,
      resolveRepository: repo({}),
      allowOverride: false,
    });
    expect(forbidden.written()).toBe(line("ERR access denied or repository not exported: /r"));
    expect(asked).toBe(0);
    // a repository turning upload-pack off
    const off = serverSide(pkt("git-upload-pack /r\0host=h\0"));
    await serveGitConnection({
      duplex: off,
      resolveRepository: repo({ "daemon.uploadpack": ["false"] }),
      informativeErrors: true,
    });
    expect(off.written()).toBe(line("ERR service not enabled: /r"));
    const archive = serverSide(pkt("git-upload-archive /r\0host=h\0"));
    await serveGitConnection({
      duplex: archive,
      resolveRepository: repo({ "daemon.uploadarch": ["true"] }),
      informativeErrors: true,
    });
    expect(archive.written()).toBe(line("ERR service not enabled: /r"));
  });

  it("no answer to what git-daemon dies on; an alias refused before the lookup", async () => {
    for (const request of [
      pkt("git-frobnicate /r\0"),
      pkt("git-upload-pack /r\0host=h\0x=y\0"),
      enc.encode("0000"),
    ]) {
      const duplex = serverSide(request);
      const result = await serveGitConnection({ duplex, resolveRepository: resolveNone });
      expect(duplex.written()).toBe("");
      expect(duplex.closed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.refused).toBeDefined();
    }
    let asked = false;
    const alias = serverSide(pkt("git-upload-pack /a/../b\0"));
    await serveGitConnection({
      duplex: alias,
      resolveRepository: async () => {
        asked = true;
        return undefined;
      },
    });
    expect(asked).toBe(false);
    expect(alias.written()).toBe(line("ERR access denied or repository not exported: /a/../b"));
  });

  it("an implicit session refuses as a server that cannot open the repository", async () => {
    const duplex = serverSide();
    const result = await serveGitService({
      duplex,
      service: "git-upload-pack",
      path: "~/nope",
      gitProtocol: "version=2",
      resolveRepository: resolveNone,
    });
    expect(duplex.written()).toBe(line("ERR '~/nope' does not appear to be a git repository"));
    expect(result.request).toEqual({
      service: "git-upload-pack",
      path: "~/nope",
      version: 2,
      gitProtocol: "version=2",
    });
  });
});

describe("half-close (Duplex.end) in the native clients", () => {
  /** A duplex whose server side says `greeting`, recording writes and the half-close. */
  function recording(greeting: string): Duplex & { events: string[] } {
    const events: string[] = [];
    return {
      events,
      [Symbol.asyncIterator]: () => chunks(enc.encode(greeting))[Symbol.asyncIterator](),
      write(data: Uint8Array) {
        events.push(`write ${dec.decode(data)}`);
      },
      async end() {
        events.push("end");
      },
    };
  }

  it("upload-pack: the final flush, then the write side ends", async () => {
    const duplex = recording(`${line("version 2\n")}${line("ls-refs\n")}0000`);
    const connection = await openDuplexConnection(duplex);
    await connection.close();
    expect(duplex.events).toEqual(["write 0000", "end"]);
    // a duplex without end is left as it is
    const plain = recording(`${line("version 2\n")}0000`);
    delete (plain as { end?: unknown }).end;
    await (await openDuplexConnection(plain)).close();
    expect(plain.events).toEqual(["write 0000"]);
  });

  it("receive-pack: the request written, then the write side ends", async () => {
    const oid = "1".repeat(40);
    const duplex = recording(`${line(`${oid} refs/heads/main\0report-status\n`)}0000`);
    const connection = await openDuplexReceivePackConnection(duplex);
    await connection.send(async function* () {
      yield enc.encode("0000");
    });
    expect(duplex.events).toEqual(["write 0000", "end"]);
    await connection.close();
    expect(duplex.events).toEqual(["write 0000", "end"]);
  });
});

describe("smart-HTTP info/refs failures in git's words", () => {
  const failing =
    (status: number, body = "", type = "text/plain") =>
    async () =>
      new Response(body, { status, headers: { "content-type": type } });
  const message = (status: number, body?: string, type?: string) =>
    openHttpConnection({
      url: "https://example.test/r.git/",
      fetchImpl: failing(status, body, type),
    }).then(
      () => undefined,
      (e: Error) => `${e.name}: ${e.message}`,
    );

  it("404, 401, 403 and others, as remote-curl's discover_refs dies", async () => {
    expect(await message(404)).toBe(
      "TransportError: fatal: repository 'https://example.test/r.git/' not found",
    );
    expect(await message(404, "No such repo\nreally\n")).toBe(
      "TransportError: remote: No such repo\nremote: really\nfatal: repository 'https://example.test/r.git/' not found",
    );
    // only a text/plain body is shown
    expect(await message(401, "<html>", "text/html")).toBe(
      "AuthenticationError: fatal: Authentication failed for 'https://example.test/r.git/'",
    );
    expect(await message(403)).toBe(
      "AuthenticationError: fatal: unable to access 'https://example.test/r.git/': The requested URL returned error: 403",
    );
    expect(await message(500)).toBe(
      "TransportError: fatal: unable to access 'https://example.test/r.git/': The requested URL returned error: 500",
    );
    // a push's info/refs alike
    const push = await openHttpReceivePackConnection({
      url: "https://example.test/r.git",
      fetchImpl: failing(404),
    }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    expect(push).toBe("fatal: repository 'https://example.test/r.git/' not found");
  });
});
