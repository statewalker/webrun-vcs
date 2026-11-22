/**
 * git-daemon's request line (daemon.c), `GIT_PROTOCOL` parsing, git's shell quoting of the ssh
 * command, the git:// and ssh connectors over host hooks, and `serveGitConnection`'s refusals,
 * without native git.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi, createSymlinkFilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { describe, expect, it, vi } from "vitest";
import {
  checkSshTarget,
  createBasePathResolver,
  createDefaultTransports,
  createGitDaemonConnector,
  createSshConnector,
  type Duplex,
  daemonAvoidsAlias,
  explicitServerSettingsFromConfig,
  GitDaemonRequestError,
  gitDaemonRequest,
  gitSshCommand,
  gitSshEnv,
  isUnsafeServicePath,
  layerServeSettings,
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
  serverSettingsFromConfig,
  sqDequoteWords,
  sqQuote,
  sshArgs,
} from "../src/index.js";
import { packOf, pushRequest, serverRepo, ZERO } from "./helpers/receive-pack-harness.js";

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

describe("served settings: the operator's, then what a repository's config sets", () => {
  const reader = (entries: Record<string, unknown[]>) => ({
    getAll: (key: string) => entries[key.toLowerCase()] ?? [],
  });

  it("explicitServerSettingsFromConfig gives only the keys set; serverSettingsFromConfig is unchanged", () => {
    expect(explicitServerSettingsFromConfig(reader({}))).toEqual({});
    expect(
      explicitServerSettingsFromConfig(
        reader({ "receive.denydeletes": ["false"], "uploadpack.hiderefs": ["refs/x/"] }),
      ),
    ).toEqual({ allowDeletes: true, uploadPackHideRefs: ["refs/x"] });
    expect(serverSettingsFromConfig(reader({ "receive.denydeletes": ["true"] }))).toEqual({
      allowDeletes: false,
      allowNonFastForward: true,
      denyCurrentBranch: "unconfigured",
      denyDeleteCurrent: "unconfigured",
      shallowUpdate: false,
      uploadPackHideRefs: [],
      receivePackHideRefs: [],
    });
  });

  it("layers: undefined keeps the value below, hidden ref lists concatenate", () => {
    expect(
      layerServeSettings(
        { allowDeletes: false, uploadPackHideRefs: ["refs/secret"], hideRefs: ["refs/a"] },
        { allowDeletes: undefined, uploadPackHideRefs: ["!refs/secret/open"] },
        { allowNonFastForward: true },
      ),
    ).toEqual({
      allowDeletes: false,
      allowNonFastForward: true,
      hideRefs: ["refs/a"],
      uploadPackHideRefs: ["refs/secret", "!refs/secret/open"],
    });
  });

  /** A push through `serveGitService` (implicit session), its written answer as text. */
  async function pushThrough(
    config: Record<string, unknown[]>,
    commands: string[],
    withPack: boolean,
  ): Promise<string> {
    const { repo, c1, c2 } = await serverRepo();
    await repo.refStore.update("refs/heads/other", c2);
    await repo.refStore.update("refs/secret/x", c1);
    const lines = commands.map((c) => c.replace("C1", c1).replace("C2", c2));
    const bytes = pushRequest({
      commands: lines,
      caps: "report-status",
      ...(withPack ? { pack: await packOf(repo, []) } : {}),
    });
    const duplex = serverSide(bytes);
    await serveGitService({
      duplex,
      service: "git-receive-pack",
      path: "/r.git",
      enableReceivePack: true,
      settings: {
        allowNonFastForward: false,
        allowDeletes: false,
        receivePackHideRefs: ["refs/secret"],
        bare: true,
      },
      resolveRepository: async () => ({
        repository: repo.facade,
        refStore: repo.refStore,
        config: reader(config),
      }),
    });
    return duplex.written();
  }

  it("a repository config that sets nothing keeps the operator's policies (git's defaults do not override)", async () => {
    const deleted = await pushThrough({}, [`C2 ${ZERO} refs/heads/other`], false);
    expect(deleted).toContain("ng refs/heads/other deletion prohibited");
    expect(deleted).not.toContain("refs/secret/x");
    const forced = await pushThrough({}, ["C2 C1 refs/heads/other"], true);
    expect(forced).toContain("ng refs/heads/other non-fast-forward");
  });

  it("a key the repository's config sets explicitly overrides the operator's, as git's repository config", async () => {
    const deleted = await pushThrough(
      { "receive.denydeletes": ["false"] },
      [`C2 ${ZERO} refs/heads/other`],
      false,
    );
    expect(deleted).toContain("ok refs/heads/other");
    // the repository's hidden refs add to the operator's
    const hidden = await pushThrough(
      { "receive.hiderefs": ["refs/heads/other"] },
      [`C2 ${ZERO} refs/heads/main`],
      false,
    );
    expect(hidden).not.toContain("refs/secret/x");
    expect(hidden.split("0000")[0]).not.toContain("refs/heads/other");
  });
});

describe("served paths are client input", () => {
  it("isUnsafeServicePath: git-daemon's aliases, NUL and backslash; relative paths in an implicit session", () => {
    for (const path of ["/../../etc", "/a//b", "/a/./b", "/a/..", "/a/.", "/a\0b", "/a\\b", "x"]) {
      expect(isUnsafeServicePath(path), path).toBe(true);
    }
    for (const path of ["/a/b.git", "/a/...b", "~alice/r", "/"]) {
      expect(isUnsafeServicePath(path), path).toBe(false);
    }
    expect(isUnsafeServicePath("~/r")).toBe(true); // git-daemon has no current user
    for (const path of ["../x", "a/../../x", "a//b", "~/../x", "r\0"]) {
      expect(isUnsafeServicePath(path, { implicit: true }), path).toBe(true);
    }
    for (const path of ["r.git", "~/r.git", "~bob/r.git", "/srv/r.git"]) {
      expect(isUnsafeServicePath(path, { implicit: true }), path).toBe(false);
    }
  });

  it("both modes refuse an alias before resolveRepository; implicit refusals are uniform", async () => {
    const asked: string[] = [];
    const resolveRepository = async (path: string) => {
      asked.push(path);
      return undefined;
    };
    for (const path of ["../x", "a/../../etc", "/a//b", "x\0y"]) {
      const duplex = serverSide();
      await serveGitService({ duplex, service: "git-upload-pack", path, resolveRepository });
      expect(duplex.written()).toBe(line(`ERR '${path}' does not appear to be a git repository`));
    }
    expect(asked).toEqual([]);
    // receive-pack not enabled: the same text unless informative
    const push = serverSide();
    await serveGitService({
      duplex: push,
      service: "git-receive-pack",
      path: "r",
      resolveRepository,
    });
    expect(push.written()).toBe(line("ERR 'r' does not appear to be a git repository"));
    const informative = serverSide();
    await serveGitService({
      duplex: informative,
      service: "git-receive-pack",
      path: "r",
      resolveRepository,
      informativeErrors: true,
    });
    expect(informative.written()).toBe(line("ERR service not enabled: r"));
  });

  it("an implicit session ignores daemon.* unless allowOverride", async () => {
    const repo = async () => ({
      repository: {} as never,
      refStore: {} as never,
      config: { getAll: (key: string) => (key === "daemon.uploadpack" ? ["false"] : []) },
    });
    const off = serverSide();
    await serveGitService({
      duplex: off,
      service: "git-upload-pack",
      path: "r",
      resolveRepository: repo,
      allowOverride: true,
    });
    expect(off.written()).toBe(line("ERR 'r' does not appear to be a git repository"));
    // default: the override is not read, upload-pack is served (and fails on the fake repo)
    const served = serverSide();
    const result = await serveGitService({
      duplex: served,
      service: "git-upload-pack",
      path: "r",
      resolveRepository: repo,
    });
    expect(result.refused).toBeUndefined();
  });
});

describe("createBasePathResolver: git-daemon's path rules", () => {
  const enc2 = new TextEncoder();
  /** A storage with git directories at `dirs` (each with `objects/`, `refs/`, `HEAD`). */
  async function storage(dirs: string[], exported: string[] = dirs) {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    for (const dir of dirs) {
      await files.mkdir(`${dir}/objects`);
      await files.mkdir(`${dir}/refs`);
      await files.write(`${dir}/HEAD`, [enc2.encode("ref: refs/heads/main\n")]);
    }
    for (const dir of exported) await files.write(`${dir}/git-daemon-export-ok`, []);
    return files;
  }
  const request = (path: string) => ({ service: "git-upload-pack", path, version: 0 as const });
  const opened = (gitDir: string) => ({ gitDir }) as never;
  const resolverOf = (
    files: Awaited<ReturnType<typeof storage>>,
    options: Partial<Parameters<typeof createBasePathResolver>[0]> = {},
  ) => {
    const resolve = createBasePathResolver({
      files,
      basePath: "/srv",
      openRepository: async (gitDir) => opened(gitDir),
      ...options,
    });
    return async (path: string) =>
      ((await resolve(path, request(path))) as { gitDir?: string } | undefined)?.gitDir;
  };

  it("joins the base, tries enter_repo's suffixes, needs git-daemon-export-ok", async () => {
    const files = await storage(
      ["/srv/a/.git", "/srv/b", "/srv/c.git", "/srv/d.git/.git", "/srv/hidden.git"],
      ["/srv/a/.git", "/srv/b", "/srv/c.git", "/srv/d.git/.git"],
    );
    const resolve = resolverOf(files);
    expect(await resolve("/a")).toBe("/srv/a/.git");
    expect(await resolve("/b/")).toBe("/srv/b");
    expect(await resolve("/c")).toBe("/srv/c.git");
    expect(await resolve("/d")).toBe("/srv/d.git/.git");
    expect(await resolve("/hidden")).toBeUndefined();
    expect(await resolverOf(files, { exportAll: true })("/hidden")).toBe("/srv/hidden.git");
    expect(await resolve("/nope")).toBeUndefined();
    // an implicit session's relative path, read below the base too
    expect(await resolve("b")).toBe("/srv/b");
  });

  it("refuses aliases, ~user without userPath, and paths leaving the base", async () => {
    const files = await storage(["/srv/r.git", "/etc/x.git", "/home/root/pub/x.git"]);
    const resolve = resolverOf(files);
    for (const path of [
      "/../../etc",
      "../x",
      "/../etc/x",
      "~root/x",
      "/a//b",
      "/r\0",
      "/r.git\\",
    ]) {
      expect(await resolve(path), path).toBeUndefined();
    }
    const users = resolverOf(files, {
      userPath: (user) => (user === "root" ? "/home/root/pub" : undefined),
    });
    expect(await users("~root/x")).toBe("/home/root/pub/x.git");
    expect(await users("~bob/x")).toBeUndefined();
    expect(await users("~root/../../etc/x")).toBeUndefined();
  });

  it("strict paths and the whitelist", async () => {
    const files = await storage(["/srv/r.git", "/srv/team/t.git"]);
    expect(await resolverOf(files, { strictPaths: true })("/r.git")).toBeUndefined();
    const strict = resolverOf(files, { strictPaths: true, whitelist: ["/srv/r.git"] });
    expect(await strict("/r.git")).toBe("/srv/r.git");
    expect(await strict("/r")).toBeUndefined();
    const listed = resolverOf(files, { whitelist: ["/srv/team"] });
    expect(await listed("/team/t")).toBe("/srv/team/t.git");
    expect(await listed("/r")).toBeUndefined();
  });

  it("symbolic links: followed inside the base, refused when they lead out", async () => {
    const files = await storage(["/srv/real.git", "/outside/r.git"]);
    await files.symlink?.(enc2.encode("real.git"), "/srv/alias.git");
    await files.symlink?.(enc2.encode("../outside/r.git"), "/srv/evil.git");
    await files.symlink?.(enc2.encode("/outside/r.git"), "/srv/abs.git");
    const resolve = resolverOf(files);
    expect(await resolve("/alias")).toBe("/srv/real.git");
    expect(await resolve("/evil")).toBeUndefined();
    expect(await resolve("/abs")).toBeUndefined();

    // on disk, through the Node FilesApi
    const root = mkdtempSync(join(tmpdir(), "base-path-"));
    try {
      for (const dir of ["srv/real.git", "outside/r.git"]) {
        mkdirSync(join(root, dir, "objects"), { recursive: true });
        mkdirSync(join(root, dir, "refs"));
        writeFileSync(join(root, dir, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(root, dir, "git-daemon-export-ok"), "");
      }
      symlinkSync("real.git", join(root, "srv/alias.git"));
      symlinkSync("../outside/r.git", join(root, "srv/evil.git"));
      const disk = resolverOf(createNodeFilesApi({ rootDir: root }) as never);
      expect(await disk("/real")).toBe("/srv/real.git");
      expect(await disk("/alias")).toBe("/srv/real.git");
      expect(await disk("/evil")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ssh targets that look like options", () => {
  it("refuses a host or user starting with '-', in git's words", async () => {
    const execs: unknown[] = [];
    const transports = createDefaultTransports({
      exec: async (target) => {
        execs.push(target);
        return serverSide();
      },
    });
    for (const [url, userAndHost] of [
      ["u@-oProxyCommand=x:r.git", "u@-oProxyCommand=x"],
      ["ssh://u@-oX/r", "u@-oX"],
      ["ssh://-u@h/r", "-u@h"],
    ] as const) {
      const connector = transports.resolve(url);
      await expect(
        connector?.connect({
          url: parseGitUrl(url),
          service: "git-upload-pack",
          protocolVersion: 0,
        }),
      ).rejects.toThrow(`fatal: strange hostname '${userAndHost}' blocked`);
    }
    expect(execs).toEqual([]);
    expect(() => checkSshTarget({ host: "h", user: "-l" })).toThrow("strange hostname '-l@h'");
  });

  it("sshArgs: the port checked, `--` before one user@host argument", () => {
    expect(sshArgs({ host: "example.com", port: 2222, user: "git" })).toEqual([
      "-p",
      "2222",
      "--",
      "git@example.com",
    ]);
    expect(sshArgs({ host: "::1" })).toEqual(["--", "::1"]);
    expect(() => sshArgs({ host: "h", port: 1.5 })).toThrow("strange port '1.5' blocked");
    expect(() => sshArgs({ host: "h", port: 70000 })).toThrow("strange port");
    expect(() => sshArgs({ host: "-oProxyCommand=x" })).toThrow("strange hostname");
  });

  it("an invalid port stays in the host, as git's get_host_and_port leaves it", () => {
    expect(parseGitUrl("ssh://h:-1/r")).toMatchObject({ host: "h:-1", path: "/r" });
    expect(parseGitUrl("ssh://h:-1/r").port).toBeUndefined();
    expect(sshArgs({ host: "h:-1" })).toEqual(["--", "h:-1"]);
  });

  it("parseGitServiceCommand: one quoted argument, nothing after it, as git-shell's sq_dequote", () => {
    expect(parseGitServiceCommand("git-upload-pack '/r' ")).toBeUndefined();
    expect(parseGitServiceCommand("git-upload-pack  '/r'")).toBeUndefined();
    expect(parseGitServiceCommand("git-upload-pack /r")).toBeUndefined();
    expect(parseGitServiceCommand("git-upload-pack '-x'")).toBeUndefined();
    expect(parseGitServiceCommand("git\tupload-pack '/r'")).toEqual({
      service: "git-upload-pack",
      path: "/r",
    });
  });
});

describe("serveGitConnection time limits", () => {
  /** A duplex whose client sends `parts` and then stalls, never ending. */
  function stalling(...parts: Uint8Array[]): Duplex & { written(): string; closed: boolean } {
    const out: Uint8Array[] = [];
    const duplex = {
      closed: false,
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const part of parts) yield part;
          await new Promise(() => {});
        })()[Symbol.asyncIterator](),
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

  it("initTimeout: no request line in time, closed without an answer", async () => {
    const duplex = stalling(enc.encode("00"));
    const result = await serveGitConnection({
      duplex,
      initTimeout: 20,
      resolveRepository: async () => undefined,
    });
    expect(result).toMatchObject({
      success: false,
      refused: "timed out waiting for the request line",
    });
    expect(duplex.written()).toBe("");
    expect(duplex.closed).toBe(true);
  });

  it("timeout: a client that stops sending mid-service is cut off", async () => {
    const { repo } = await serverRepo();
    const duplex = stalling(pkt("git-receive-pack /r\0host=h\0"));
    const result = await serveGitConnection({
      duplex,
      enableReceivePack: true,
      timeout: 30,
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
    });
    expect(result).toMatchObject({ success: false, error: "timed out waiting for the client" });
    expect(duplex.closed).toBe(true);
    expect(duplex.written()).toContain("refs/heads/main");
  });
});

describe("the resolver's hidden refs are the last word", () => {
  const reader = (entries: Record<string, unknown[]>) => ({
    getAll: (key: string) => entries[key.toLowerCase()] ?? [],
  });
  /** The effective list of a service, as serveOverDuplex builds it. */
  const effective = (
    settings: ReturnType<typeof layerServeSettings>,
    service: "upload" | "receive",
  ) => [
    ...(settings.hideRefs ?? []),
    ...((service === "upload" ? settings.uploadPackHideRefs : settings.receivePackHideRefs) ?? []),
  ];
  /** git's isRefHidden: the last matching pattern decides. */
  const hidden = (patterns: string[], ref: string) => {
    let out = false;
    for (const p of patterns) {
      const neg = p.startsWith("!");
      const pattern = neg ? p.slice(1) : p;
      if (ref === pattern || ref.startsWith(`${pattern}/`)) out = !neg;
    }
    return out;
  };

  it("layerServeSettings: an earlier layer's service !pattern does not unhide a later hideRefs", () => {
    const settings = layerServeSettings(
      { allowDeletes: false },
      {},
      { uploadPackHideRefs: ["!refs/secret"], receivePackHideRefs: ["!refs/secret"] },
      { hideRefs: ["refs/secret"] },
    );
    expect(hidden(effective(settings, "upload"), "refs/secret")).toBe(true);
    expect(hidden(effective(settings, "receive"), "refs/secret")).toBe(true);
    const one = layerServeSettings(
      { allowDeletes: false },
      {},
      { uploadPackHideRefs: ["!refs/secret"] },
      { hideRefs: ["refs/secret"] },
    );
    expect(hidden(effective(one, "upload"), "refs/secret")).toBe(true);
    expect(hidden(effective(one, "receive"), "refs/secret")).toBe(true);
    // a later layer's !pattern still unhides an earlier one
    const later = layerServeSettings(
      { hideRefs: ["refs/secret"] },
      { uploadPackHideRefs: ["!refs/secret"] },
    );
    expect(hidden(effective(later, "upload"), "refs/secret")).toBe(false);
    expect(hidden(effective(later, "receive"), "refs/secret")).toBe(true);
  });

  it("serveGitService: a repository config's !refs/secret leaves the resolver's refs/secret hidden", async () => {
    const { repo, c1 } = await serverRepo();
    await repo.refStore.update("refs/secret/x", c1);
    const config = reader({
      "uploadpack.hiderefs": ["!refs/secret"],
      "receive.hiderefs": ["!refs/secret"],
      "transfer.hiderefs": ["!refs/secret"],
    });
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const duplex = serverSide();
      await serveGitService({
        duplex,
        service,
        path: "/r.git",
        enableReceivePack: true,
        resolveRepository: async () => ({
          repository: repo.facade,
          refStore: repo.refStore,
          config,
          settings: { hideRefs: ["refs/secret"] },
        }),
      });
      expect(duplex.written(), service).toContain("refs/heads/main");
      expect(duplex.written(), service).not.toContain("refs/secret");
    }
  });
});

describe("serveGitConnection timeout covers writes", () => {
  /** A duplex sending `parts`, then stalling; its writes never complete (the client stopped reading). */
  function deaf(withClose: boolean, ...parts: Uint8Array[]) {
    const state = { closed: false, ended: false, writes: 0 };
    const duplex: Duplex = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const part of parts) yield part;
          await new Promise(() => {});
        })()[Symbol.asyncIterator](),
      write() {
        state.writes++;
        return new Promise<void>(() => {});
      },
      async end() {
        state.ended = true;
      },
      ...(withClose
        ? {
            async close() {
              state.closed = true;
            },
          }
        : {}),
    };
    return { duplex, state };
  }

  it("a client that stops reading is cut off, and no timer is left behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { repo } = await serverRepo();
      const { duplex, state } = deaf(true, pkt("git-upload-pack /r\0host=h\0"));
      const serving = serveGitConnection({
        duplex,
        timeout: 30,
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await serving;
      expect(result).toMatchObject({ success: false, error: "timed out waiting for the client" });
      expect(state.writes).toBe(1);
      expect(state.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stream without close is ended", async () => {
    const { repo } = await serverRepo();
    const { duplex, state } = deaf(false, pkt("git-receive-pack /r\0host=h\0"));
    const result = await serveGitConnection({
      duplex,
      enableReceivePack: true,
      timeout: 20,
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
    });
    expect(result).toMatchObject({ success: false, error: "timed out waiting for the client" });
    expect(state.ended).toBe(true);
  });
});

describe("createBasePathResolver: empty users and paths", () => {
  async function storage() {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    for (const dir of ["/srv", "/srv/r.git", "/home/x", "/home/x/r.git"]) {
      await files.mkdir(`${dir}/objects`);
      await files.mkdir(`${dir}/refs`);
      await files.write(`${dir}/HEAD`, [enc.encode("ref: refs/heads/main\n")]);
      await files.write(`${dir}/git-daemon-export-ok`, []);
    }
    return files;
  }

  it("~ and ~/x never ask userPath for the empty user, in either mode", async () => {
    const files = await storage();
    const asked: string[] = [];
    const resolve = createBasePathResolver({
      files,
      basePath: "/srv",
      openRepository: async (gitDir) => ({ gitDir }) as never,
      userPath: (user) => {
        asked.push(user);
        return "/home/x";
      },
    });
    for (const path of ["~", "~/", "~/r.git"]) {
      expect(await resolve(path, { service: "git-upload-pack", path, version: 0 }), path).toBe(
        undefined,
      );
    }
    expect(asked).toEqual([]);
    expect(
      await resolve("~x/r.git", { service: "git-upload-pack", path: "~x/r.git", version: 0 }),
    ).toBeDefined();
    // the standard refusal through both servers
    for (const [refusal, path, text] of [
      ["daemon", "~", "ERR access denied or repository not exported: ~"],
      ["implicit", "~/r.git", "ERR '~/r.git' does not appear to be a git repository"],
    ] as const) {
      const duplex = serverSide();
      await serveGitService({
        duplex,
        service: "git-upload-pack",
        path,
        refusal,
        resolveRepository: resolve,
      });
      expect(duplex.written()).toBe(line(text));
    }
    expect(asked).toEqual(["x"]);
  });

  it("an empty path is refused, not the base directory", async () => {
    const files = await storage();
    const resolve = createBasePathResolver({
      files,
      basePath: "/srv",
      exportAll: true,
      openRepository: async (gitDir) => ({ gitDir }) as never,
    });
    expect(isUnsafeServicePath("", { implicit: true })).toBe(true);
    expect(isUnsafeServicePath("")).toBe(true);
    expect(await resolve("", { service: "git-upload-pack", path: "", version: 0 })).toBeUndefined();
    const duplex = serverSide();
    let asked = false;
    await serveGitService({
      duplex,
      service: "git-upload-pack",
      path: "",
      resolveRepository: async (path, request) => {
        asked = true;
        return resolve(path, request);
      },
    });
    expect(asked).toBe(false);
    expect(duplex.written()).toBe(line("ERR '' does not appear to be a git repository"));
  });
});

describe("serveGitConnection: a repository another user owns", () => {
  const dubious = async () => {
    const error = new Error("fatal: detected dubious ownership in repository at '/srv/r.git'");
    error.name = "DubiousOwnershipError";
    throw error;
  };

  it("drops the connection without an ERR line, as git daemon's child dies", async () => {
    for (const informativeErrors of [false, true]) {
      const duplex = serverSide(pkt("git-upload-pack /r.git\0host=h\0"));
      const result = await serveGitConnection({
        duplex,
        resolveRepository: dubious,
        informativeErrors,
      });
      expect(duplex.written()).toBe("");
      expect(duplex.closed).toBe(true);
      expect(result).toMatchObject({ success: false, request: { path: "/r.git" } });
      expect(result.error).toContain("dubious ownership");
    }
  });

  it("any other resolver error is still the not-a-repository refusal", async () => {
    const duplex = serverSide(pkt("git-upload-pack /r.git\0host=h\0"));
    await serveGitConnection({
      duplex,
      resolveRepository: async () => {
        throw new Error("boom");
      },
    });
    expect(duplex.written()).toBe(line("ERR access denied or repository not exported: /r.git"));
  });
});
