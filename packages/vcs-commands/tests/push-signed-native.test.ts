/**
 * Signed pushes (statewalker/statewalker-root#377) against native git: `push --signed`,
 * `--signed=if-asked`, `push.gpgSign`, receive-pack's `push-cert=<nonce>` (`receive.certNonceSeed`)
 * and the `GIT_PUSH_CERT*` variables its hooks get.
 *
 * Scenarios from git's t5534-push-signed.sh, each pushed four ways from identical repositories:
 * native git to a native receive-pack (a local path), ours to ours (a local path), native git to
 * our git:// server and ours to native `git daemon`; the receiving hooks log what they are told
 * (the certificate read back with `git cat-file blob $GIT_PUSH_CERT`, its date and nonce
 * normalised: both are the clock's) and the logs must agree. Signing goes through a
 * deterministic `gpg.program` (it signs and verifies with fixed output), ssh signing through a
 * throwaway Ed25519 key and ssh-keygen. Crafted certificates (JGit's PushCertificateParserTest
 * inputs: UNSOLICITED, MISSING and BAD nonces, inconsistent push options, malformed
 * certificates) are fed to native `git receive-pack` and to our server alike.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPushCertNonce,
  createBasePathResolver,
  createDefaultTransports,
  isValidPushCertNonce,
  pushCertNonce,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import { SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
  createNodeSigner,
  createNodeVerifier,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { GitApiError, type PushResult, servedRepositoryOf } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { daemonOpener, gitAsync, openTcpSocket, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const itSsh =
  spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined ? it : it.skip;

let root: string;
let counter = 0;
let daemon: { port: number; close(): Promise<void> };
const compatibility = nativeIs25x ? "2.56" : "2.43";

const env = () => testEnv(root);
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

/** Our host environment: hooks, the signer and the verifier run the programs native git runs. */
function hostEnvironment() {
  const e = env();
  return createNodeGitHostEnvironment({
    env: e,
    hookRunner: createNodeHookRunner({ env: e, compatibility }),
    signer: createNodeSigner({ env: e }),
    verifier: createNodeVerifier({ env: e, compatibility }),
  });
}

/**
 * The receiving hook: logs the push certificate variables (nonces as `<nonce>` once they have
 * git's shape), the certificate read back from its blob (date, nonce and pushee normalised),
 * whether its nonce is the one the hook is told, and its stdin; in `hooks.log` of the git dir.
 * An ssh signature's lines are left out: ssh signs the certificate's date and nonce, which are
 * the clock's.
 */
const RECEIVE_HOOK = String.raw`#!/bin/sh
n=$(basename "$0")
{
  printf '== %s' "$n"; for a in "$@"; do printf ' [%s]' "$a"; done; echo
  for v in GIT_PUSH_CERT_SIGNER GIT_PUSH_CERT_KEY GIT_PUSH_CERT_STATUS GIT_PUSH_CERT_NONCE_STATUS GIT_PUSH_CERT_NONCE_SLOP; do
    if printenv "$v" >/dev/null; then echo "$v=$(printenv "$v")"; fi
  done
  if printenv GIT_PUSH_CERT_NONCE >/dev/null; then
    echo "GIT_PUSH_CERT_NONCE=$(printenv GIT_PUSH_CERT_NONCE | sed 's/^[1-9][0-9]*-[0-9a-f]\{40\}$/<nonce>/')"
  fi
  if printenv GIT_PUSH_CERT >/dev/null; then
    echo "GIT_PUSH_CERT is a blob: $(git cat-file -t "$GIT_PUSH_CERT")"
    if git cat-file blob "$GIT_PUSH_CERT" | grep -qx "nonce $GIT_PUSH_CERT_NONCE"; then echo "nonce told"; fi
    git cat-file blob "$GIT_PUSH_CERT" | sed -e 's/^\(pusher .*\) [0-9]* [-+][0-9]\{4\}$/\1 <date>/' \
      -e 's/^nonce [1-9][0-9]*-[0-9a-f]\{40\}$/nonce <nonce>/' -e 's/^pushee .*/pushee <url>/' \
      -e '/^-----BEGIN SSH SIGNATURE-----$/,/^-----END SSH SIGNATURE-----$/{/^-----/!d;}'
    echo "<end>"
  fi
  cat
} >> hooks.log
exit 0
`;

/**
 * A `gpg.program` with fixed answers: signing logs its arguments and stdin to `<cwd>.gpg-log`
 * (git signs in its working directory) and prints `SIGNATURE`; `--verify` prints a good
 * signature of key 13B6F51ECDDE430D by C O Mitter. `FAIL=1` in its directory's `gpg-fail`
 * makes signing fail with a status line.
 */
function fakeGpg(): string {
  const path = join(root, "fake-gpg");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *" --verify "*)',
      "    cat >/dev/null",
      `    printf '[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG 13B6F51ECDDE430D C O Mitter <committer@example.com>\\n[GNUPG:] TRUST_ULTIMATE 0 pgp\\n'`,
      "    exit 0 ;;",
      "esac",
      'log="$(pwd).gpg-log"',
      'echo "args: $*" >> "$log"',
      'cat >> "$log"',
      'if [ -f "$(pwd).gpg-fail" ]; then echo "[GNUPG:] KEY_CONSIDERED 1234 2" >&2; echo "gpg: signing failed: No secret key" >&2; exit 2; fi',
      `printf '[GNUPG:] KEY_CONSIDERED 1234 2\\n[GNUPG:] SIG_CREATED D 22 10 00 1 2\\n' >&2`,
      `printf -- '-----BEGIN PGP SIGNATURE-----\\n\\niHUEABYKAB0WIQRzSmc1\\n=AbCd\\n-----END PGP SIGNATURE-----\\n'`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** The four ways a push goes: native→native, ours→ours, native→our server, ours→native daemon. */
const WAYS = ["n", "o", "d", "e"] as const;
type Way = (typeof WAYS)[number];

interface Fixture {
  k: string;
  dirs: Record<Way, string>;
}

/**
 * t5534's setup and prepare_dst, once per way: `<way>/src` with commits on `main`, `ff` and
 * `noff`, `<way>/dst` a bare repository holding `main`, `ff`, `noff` and `gone`, with the
 * logging receive hooks and `dstConfig`; `srcConfig` in the pusher.
 */
function fixture(
  dstConfig: Record<string, string> = {},
  srcConfig: Record<string, string> = {},
): Fixture {
  const k = `t${counter++}`;
  const base = join(root, k, "base");
  mkdirSync(base, { recursive: true });
  const src = join(base, "src");
  git(base, "init", "-q", "-b", "main", "src");
  noMaintenance(src);
  for (const name of ["one", "two"]) {
    putFile(src, `${name}.t`, `${name}\n`);
    git(src, "add", `${name}.t`);
    git(src, "commit", "-qm", name);
  }
  git(src, "branch", "ff");
  git(src, "branch", "noff");
  git(src, "branch", "gone");
  git(base, "clone", "-q", "--bare", "--no-local", "src", "dst");
  const dst = join(base, "dst");
  noMaintenance(dst);
  // the pusher moves ff forward and rewrites noff
  git(src, "checkout", "-q", "ff");
  putFile(src, "three.t", "three\n");
  git(src, "add", "three.t");
  git(src, "commit", "-qm", "three");
  git(src, "checkout", "-q", "noff");
  git(src, "reset", "-q", "--hard", "HEAD^");
  putFile(src, "four.t", "four\n");
  git(src, "add", "four.t");
  git(src, "commit", "-qm", "four");
  git(src, "checkout", "-q", "main");
  for (const [key, value] of Object.entries(dstConfig)) git(dst, "config", key, value);
  for (const [key, value] of Object.entries(srcConfig)) git(src, "config", key, value);
  for (const name of ["pre-receive", "update", "post-receive"]) {
    writeFileSync(join(dst, "hooks", name), RECEIVE_HOOK);
    chmodSync(join(dst, "hooks", name), 0o755);
  }
  const dirs = {} as Record<Way, string>;
  for (const way of WAYS) {
    dirs[way] = join(root, k, way);
    cpSync(base, dirs[way], { recursive: true });
  }
  return { k, dirs };
}

interface Outcome {
  status: number;
  stderr: string[];
  log: string;
  gpgLog: string;
  refs: string;
}

/** What a push left: the receiving hooks' log, the signing program's log, dst's refs. */
function leftBy(f: Fixture, way: Way, status: number, stderr: string[]): Outcome {
  const dir = f.dirs[way];
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "latin1") : "");
  return {
    status,
    stderr,
    log: read(join(dir, "dst", "hooks.log")),
    gpgLog: read(join(dir, "src.gpg-log")),
    refs: git(join(dir, "dst"), "for-each-ref", "--format=%(objectname) %(refname)"),
  };
}

/** The `git push` arguments after `push` as our command's calls. */
function configure(p: ReturnType<Awaited<ReturnType<typeof openOurs>>["push"]>, args: string[]) {
  const positional: string[] = [];
  const options: string[] = [];
  for (const a of args) {
    if (a === "--signed" || a === "--signed=yes") p.setSigned(true);
    else if (a === "--signed=if-asked") p.setSigned("if-asked");
    else if (a === "--no-signed") p.setSigned(false);
    else if (a === "--atomic") p.setAtomic(true);
    else if (a.startsWith("--push-option=")) options.push(a.slice("--push-option=".length));
    else if (a.startsWith("-")) throw new Error(`unmapped option ${a}`);
    else positional.push(a);
  }
  if (options.length > 0) p.setPushOptions(options);
  const [remote, ...refspecs] = positional;
  p.setRemote(remote as string).setRefSpecs(...refspecs);
  return p;
}

/**
 * The lines both pushers print alike: the ref report, deaths, warnings, gpg's lines (not the
 * hung-up line of a local receive-pack, the summary errors and advice)
 */
function stderrOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        /^( [-!+*= ] |fatal: |warning: |error: gpg|\[GNUPG|gpg: )/.test(l) &&
        l !== "fatal: the remote end hung up unexpectedly",
    );
}

/** Our push in `<way>/src`: its exit status and git's stderr lines (no report header). */
async function oursPush(f: Fixture, way: Way, url: string, args: string[], transports?: boolean) {
  const ours = await openOurs(f.dirs[way], hostEnvironment(), undefined, "src");
  const p = configure(ours.push(), [url, ...args]);
  if (transports) {
    p.setTransports(createDefaultTransports({ openSocket: daemonOpener(root, root) }));
  }
  let result: PushResult | undefined;
  try {
    result = await p.call();
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode ?? 1, stderr: stderrOf(error.message) };
  }
  const refused =
    result.remoteUpdates.some((u) => u.status !== "ok" && u.status !== "up-to-date") ||
    !!result.failed;
  return {
    status: refused ? 1 : 0,
    stderr: stderrOf(
      [...(result.warnings ?? []), ...(result.display ?? []), ...(result.errors ?? [])].join("\n"),
    ),
  };
}

/** `git push <args>` the four ways; every outcome must match native git's to a local path. */
async function pushFourWays(f: Fixture, args: string[]): Promise<Record<Way, Outcome>> {
  const native = await gitAsync(root, join(f.dirs.n, "src"), ["push", "../dst", ...args]);
  const out = {} as Record<Way, Outcome>;
  out.n = leftBy(f, "n", native.status ?? 1, stderrOf(native.stderr));
  const o = await oursPush(f, "o", "../dst", args);
  out.o = leftBy(f, "o", o.status, o.stderr);
  const d = await gitAsync(root, join(f.dirs.d, "src"), [
    "push",
    `git://127.0.0.1:${daemon.port}/${f.k}/d/dst`,
    ...args,
  ]);
  out.d = leftBy(f, "d", d.status ?? 1, stderrOf(d.stderr));
  const e = await oursPush(f, "e", `git://127.0.0.1:9418/${f.k}/e/dst`, args, true);
  out.e = leftBy(f, "e", e.status, e.stderr);
  const label = `git push ${args.join(" ")}`;
  for (const way of ["o", "d", "e"] as const) {
    expect(out[way].status, `${label} (${way}): exit status ${native.stderr}`).toBe(out.n.status);
    expect(out[way].log, `${label} (${way}): hooks`).toBe(out.n.log);
    expect(out[way].refs, `${label} (${way}): refs`).toBe(out.n.refs);
  }
  // the pusher's side: signing program input (bar the date) and stderr, ours against native
  for (const way of ["o", "e"] as const) {
    const dated = (s: string) => s.replace(/^(pusher .*) \d+ [-+]\d{4}$/gm, "$1 <date>");
    const nonces = (s: string) => s.replace(/^nonce \d+-[0-9a-f]{40}$/gm, "nonce <nonce>");
    const url = (s: string) => s.replace(/^pushee .*$/gm, "pushee <url>");
    expect(url(nonces(dated(out[way].gpgLog))), `${label} (${way}): gpg`).toBe(
      url(nonces(dated(way === "o" ? out.n.gpgLog : out.d.gpgLog))),
    );
  }
  expect(out.o.stderr, `${label}: stderr`).toEqual(out.n.stderr);
  return out;
}

describeGit("signed pushes (t5534-push-signed.sh)", () => {
  let gpg: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "push-signed-"));
    gpg = fakeGpg();
    git(root, "init", "-q", join(root, "host"));
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const host = await openOurs(root, hostEnvironment(), undefined, "host");
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        const hooks = remoteHookSession(host.workingCopy, opened);
        return servedRepositoryOf(opened, hooks ? { hooks } : {});
      },
    });
    daemon = await startTcpServer((duplex) =>
      serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }),
    );
  });

  afterAll(async () => {
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const seeded = () => ({ "receive.certNonceSeed": "sekrit", "gpg.program": gpg });

  // t5534-push-signed.sh: "unsigned push does not send push certificate"
  it("an unsigned push sends no certificate", async () => {
    const f = fixture(seeded(), { "gpg.program": gpg });
    const out = await pushFourWays(f, ["main", "ff", "+noff"]);
    expect(out.n.log).not.toContain("GIT_PUSH_CERT");
    expect(out.n.gpgLog).toBe("");
  });

  // t5534-push-signed.sh: "talking with a receiver without push certificate support"
  it("a receiver without push certificate support", async () => {
    const f = fixture({ "gpg.program": gpg }, { "gpg.program": gpg });
    // --signed dies before anything is sent; if-asked warns and pushes unsigned
    const refused = await pushFourWays(f, ["--signed", "main", "ff"]);
    expect(refused.n.status).toBe(128);
    const g = fixture({ "gpg.program": gpg }, { "gpg.program": gpg });
    const unsigned = await pushFourWays(g, ["--signed=if-asked", "main", "ff", "+noff"]);
    expect(unsigned.n.status).toBe(0);
    expect(unsigned.n.log).not.toContain("GIT_PUSH_CERT");
  });

  // t5534-push-signed.sh: "push --signed fails with a receiver without push certificate support"
  it("push.gpgSign=true and if-asked against such a receiver", async () => {
    const f = fixture({ "gpg.program": gpg }, { "gpg.program": gpg, "push.gpgSign": "true" });
    expect((await pushFourWays(f, ["main", "ff"])).n.status).toBe(128);
    const g = fixture({ "gpg.program": gpg }, { "gpg.program": gpg, "push.gpgSign": "if-asked" });
    expect((await pushFourWays(g, ["main", "ff"])).n.status).toBe(0);
  });

  // t5534-push-signed.sh: "no certificate for a signed push with no update"
  it("no certificate for a signed push with no update", async () => {
    const f = fixture(seeded(), { "gpg.program": gpg });
    const out = await pushFourWays(f, ["--signed", "main"]);
    expect(out.n.gpgLog).toBe("");
    expect(out.n.log).toBe("");
  });

  // t5534-push-signed.sh: "signed push sends push certificate"
  it("a signed push sends its certificate to the hooks", async () => {
    const f = fixture(seeded(), { "gpg.program": gpg });
    const out = await pushFourWays(f, ["--signed", "main", "ff", "+noff", ":gone"]);
    expect(out.n.status).toBe(0);
    expect(out.n.log).toContain("GIT_PUSH_CERT_SIGNER=C O Mitter <committer@example.com>");
    expect(out.n.log).toContain("GIT_PUSH_CERT_KEY=13B6F51ECDDE430D");
    expect(out.n.log).toContain("GIT_PUSH_CERT_STATUS=G");
    expect(out.n.log).toContain("GIT_PUSH_CERT_NONCE_STATUS=OK");
    expect(out.n.log).toContain("nonce told");
    // the update hook is told nothing of it
    expect(out.n.log).toMatch(/== update \[refs\/heads\/ff\][^\n]*\n== /);
  });

  // t5534-push-signed.sh: "fail without key and heed user.signingkey"
  it("push.gpgSign and user.signingKey name the pusher", async () => {
    const f = fixture(seeded(), {
      "gpg.program": gpg,
      "push.gpgSign": "true",
      "user.signingKey": "13B6F51ECDDE430D",
    });
    const out = await pushFourWays(f, ["ff"]);
    expect(out.n.log).toContain("pusher 13B6F51ECDDE430D <date>");
  });

  // not ported from t5534: push options in the certificate (send-pack.c's generate_push_cert)
  it("push options are signed with the certificate", async () => {
    const f = fixture(
      { ...seeded(), "receive.advertisePushOptions": "true" },
      { "gpg.program": gpg },
    );
    const out = await pushFourWays(f, [
      "--signed",
      "--push-option=asdf",
      "--push-option=more structured text",
      "ff",
    ]);
    expect(out.n.log).toContain("push-option asdf\npush-option more structured text\n");
  });

  // t5534-push-signed.sh: "failed atomic push does not execute GPG"
  it("a failed atomic push does not sign", async () => {
    const f = fixture(seeded(), { "gpg.program": gpg });
    const out = await pushFourWays(f, ["--signed", "--atomic", "ff", "noff"]);
    expect(out.n.status).toBe(1);
    expect(out.n.gpgLog).toBe("");
  });

  // not ported from t5534: a failing signing program (gpg-interface.c's sign_buffer_gpg)
  it("a signing failure dies before anything is sent", async () => {
    const f = fixture(seeded(), { "gpg.program": gpg });
    for (const way of WAYS) writeFileSync(join(f.dirs[way], "src.gpg-fail"), "");
    const out = await pushFourWays(f, ["--signed", "ff"]);
    expect(out.n.status).toBe(128);
    expect(out.n.log).toBe("");
  });

  // t5534-push-signed.sh: "ssh signed push sends push certificate"
  itSsh("an ssh-signed push: the key's fingerprint as the pusher", async () => {
    const key = join(root, "ssh-key");
    if (!existsSync(key)) {
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "pusher", "-f", key]);
      const pub = readFileSync(`${key}.pub`, "latin1").trim().split(" ");
      writeFileSync(join(root, "allowed-signers"), `committer@example.com ${pub[0]} ${pub[1]}\n`);
    }
    const f = fixture(
      {
        "receive.certNonceSeed": "sekrit",
        "gpg.format": "ssh",
        "gpg.ssh.allowedSignersFile": join(root, "allowed-signers"),
      },
      { "gpg.format": "ssh", "user.signingKey": key },
    );
    const out = await pushFourWays(f, ["--signed", "ff", "+noff"]);
    expect(out.n.log).toContain("GIT_PUSH_CERT_STATUS=G");
    expect(out.n.log).toContain("GIT_PUSH_CERT_SIGNER=committer@example.com");
    expect(out.n.log).toMatch(/GIT_PUSH_CERT_KEY=SHA256:/);
    expect(out.n.log).toMatch(/pusher SHA256:\S+ <date>/);
  });
});

/** A pkt-line of `text` (its bytes as given: latin-1 here). */
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;

/** A fixed signature block (the fake gpg verifies anything). */
const SIGNATURE =
  "-----BEGIN PGP SIGNATURE-----\nVersion: GnuPG v1\n\niQEcBAABAgAGBQJVeGg5AAoJEPfTicJkUdPkUggH/RKAeI9/i/LduuiqrL/SSdIa\n=t2Vz\n-----END PGP SIGNATURE-----\n";

/**
 * A request carrying a certificate: `push-cert\0<caps>`, the certificate's lines,
 * `push-cert-end`, a flush, then `after` (push options and their flush).
 */
function certRequest(certificate: string, caps: string, after = "") {
  const lines = certificate.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return `${pkt(`push-cert\0${caps}`)}${lines.map(pkt).join("")}${pkt("push-cert-end\n")}0000${after}`;
}

describeGit("push certificates as receive-pack reads them (JGit PushCertificateParserTest)", () => {
  let gpg: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "push-cert-raw-"));
    gpg = fakeGpg();
    git(root, "init", "-q", join(root, "host"));
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const host = await openOurs(root, hostEnvironment(), undefined, "host");
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        const hooks = remoteHookSession(host.workingCopy, opened);
        return servedRepositoryOf(opened, hooks ? { hooks } : {});
      },
    });
    daemon = await startTcpServer((duplex) =>
      serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }),
    );
  });

  afterAll(async () => {
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Native `git receive-pack` fed `request`: its stdout's report lines and its stderr. */
  function nativeReceive(dir: string, request: string, stateless = false) {
    const r = spawnSync("git", ["receive-pack", ...(stateless ? ["--stateless-rpc"] : []), "."], {
      cwd: dir,
      env: env(),
      input: Buffer.from(request, "latin1"),
    });
    return {
      status: r.status,
      out: reportOf(r.stdout.toString("latin1")),
      err: r.stderr.toString(),
    };
  }

  /** Ours over git:// fed the same request after the daemon's request line. */
  async function oursReceive(path: string, request: string) {
    const duplex = await openTcpSocket("127.0.0.1", daemon.port);
    const head = pkt(`git-receive-pack /${path}\0host=127.0.0.1\0`);
    const chunks: Uint8Array[] = [];
    const reading = (async () => {
      for await (const chunk of duplex) chunks.push(chunk);
    })();
    // the advertisement first, as receive-pack writes it before reading
    await duplex.write(Buffer.from(head + request, "latin1"));
    await duplex.end?.();
    await reading;
    return reportOf(Buffer.concat(chunks).toString("latin1"));
  }

  /** The pkt-lines after the advertisement's flush (the report), as text. */
  function reportOf(stream: string): string[] {
    const lines: string[] = [];
    let at = 0;
    let flushes = 0;
    while (at + 4 <= stream.length) {
      const len = Number.parseInt(stream.slice(at, at + 4), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) {
        flushes++;
        at += 4;
        continue;
      }
      if (flushes >= 1) lines.push(stream.slice(at + 4, at + len).replace(/\n$/, ""));
      at += len;
    }
    return lines;
  }

  /** A bare repository pair (native, ours) holding `gone` and `keep` at one commit. */
  function pair(config: Record<string, string>) {
    const k = `r${counter++}`;
    const base = join(root, k);
    mkdirSync(base, { recursive: true });
    git(base, "init", "-q", "-b", "main", "src");
    putFile(join(base, "src"), "a.t", "a\n");
    git(join(base, "src"), "add", "a.t");
    git(join(base, "src"), "commit", "-qm", "a");
    git(join(base, "src"), "branch", "gone");
    git(join(base, "src"), "branch", "keep");
    git(base, "clone", "-q", "--bare", "--no-local", "src", "n");
    for (const [key, value] of Object.entries(config)) git(join(base, "n"), "config", key, value);
    for (const name of ["pre-receive", "post-receive"]) {
      writeFileSync(join(base, "n", "hooks", name), RECEIVE_HOOK);
      chmodSync(join(base, "n", "hooks", name), 0o755);
    }
    cpSync(join(base, "n"), join(base, "o"), { recursive: true });
    const oid = git(join(base, "n"), "rev-parse", "gone");
    return { k, base, oid };
  }

  const CAPS = "report-status side-band-64k-not agent=test";

  /** JGit's certificate (PushCertificateParserTest.INPUT) with `nonce` and `options`. */
  function jgitCertificate(oid: string, nonce: string | undefined, options: string[] = []) {
    return [
      "certificate version 0.1\n",
      "pusher Dave Borowitz <dborowitz@google.com> 1433954361 -0700\n",
      "pushee git://localhost:1234/repo.git\n",
      ...(nonce === undefined ? [] : [`nonce ${nonce}\n`]),
      ...options.map((o) => `push-option ${o}\n`),
      "\n",
      `${oid} ${"0".repeat(40)} refs/heads/gone\n`,
      SIGNATURE,
    ].join("");
  }

  async function twin(config: Record<string, string>, request: (oid: string) => string) {
    const p = pair({ "gpg.program": gpg, ...config });
    const native = nativeReceive(join(p.base, "n"), request(p.oid));
    const ours = await oursReceive(`${p.k}/o`, request(p.oid));
    expect(ours, "report").toEqual(native.out);
    const log = (d: string) =>
      existsSync(join(p.base, d, "hooks.log"))
        ? readFileSync(join(p.base, d, "hooks.log"), "latin1")
        : "";
    expect(log("o"), "hooks").toBe(log("n"));
    const refs = (d: string) => git(join(p.base, d), "for-each-ref", "--format=%(refname)");
    expect(refs("o"), "refs").toBe(refs("n"));
    return { native, log: log("n") };
  }

  it("a certificate with no nonce advertised is UNSOLICITED", async () => {
    const r = await twin({}, (oid) =>
      certRequest(jgitCertificate(oid, "1433954361-bde756572d665bba81d8"), CAPS),
    );
    // no nonce advertised: the hooks are told neither the nonce nor its status
    expect(r.log).toContain("GIT_PUSH_CERT_STATUS=G");
    expect(r.log).not.toContain("NONCE");
  });

  it("a certificate without a nonce is MISSING", async () => {
    const r = await twin({ "receive.certNonceSeed": "sekrit" }, (oid) =>
      certRequest(jgitCertificate(oid, undefined), CAPS),
    );
    expect(r.log).toContain("GIT_PUSH_CERT_NONCE_STATUS=MISSING");
  });

  it("another nonce is BAD", async () => {
    const r = await twin({ "receive.certNonceSeed": "sekrit" }, (oid) =>
      certRequest(jgitCertificate(oid, "1433954361-bde756572d665bba81d8"), CAPS),
    );
    expect(r.log).toContain("GIT_PUSH_CERT_NONCE_STATUS=BAD");
  });

  // t5534-push-signed.sh: "inconsistent push options in signed push not allowed"
  it("push options that differ from the certificate's refuse every command", async () => {
    const opts = `${pkt("asdf\n")}${pkt("more\n")}0000`;
    await twin(
      { "receive.certNonceSeed": "sekrit", "receive.advertisePushOptions": "true" },
      (oid) =>
        certRequest(
          jgitCertificate(oid, undefined, ["asdf", "other"]),
          `${CAPS} push-options`,
          opts,
        ),
    );
    // ... and the same options pass
    await twin(
      { "receive.certNonceSeed": "sekrit", "receive.advertisePushOptions": "true" },
      (oid) =>
        certRequest(
          jgitCertificate(oid, undefined, ["asdf", "more"]),
          `${CAPS} push-options`,
          opts,
        ),
    );
  });

  it("unsigned commands beside a certificate, a certificate without an empty line", async () => {
    // git's "got both push certificate and unsigned commands" never fires: both are queued
    await twin(
      {},
      (oid) =>
        `${pkt(`${oid} ${"0".repeat(40)} refs/heads/keep\0${CAPS}\n`)}${certRequest(jgitCertificate(oid, undefined), "")}`,
    );
    const malformed = await twin({}, () =>
      certRequest("certificate version 0.1\npusher x 1 +0000\n", CAPS),
    );
    expect(malformed.native.err).toContain("malformed push certificate");
  });

  it("a certificate without a signature: receive-pack dies at its first hook", async () => {
    const r = await twin({ "receive.certNonceSeed": "sekrit" }, (oid) =>
      certRequest(jgitCertificate(oid, undefined).slice(0, -SIGNATURE.length), CAPS),
    );
    expect(r.native.err).toContain("fatal: bad/incompatible signature ''");
  });

  it("nonces: native receive-pack's advertised nonce, and a stale one over --stateless-rpc", async () => {
    const p = pair({ "receive.certNonceSeed": "sekrit" });
    const ad = spawnSync("git", ["receive-pack", "."], {
      cwd: join(p.base, "n"),
      env: env(),
      input: "",
    });
    const advertised = /push-cert=(\d+)-([0-9a-f]{40})/.exec(ad.stdout.toString("latin1"));
    expect(advertised).not.toBeNull();
    const stamp = Number(advertised?.[1]);
    expect(pushCertNonce("sekrit", ".", stamp)).toBe(`${advertised?.[1]}-${advertised?.[2]}`);
    // a SHA-256 repository's nonce: the HMAC in SHA-256, all 64 digits
    git(root, "init", "-q", "--bare", "--object-format=sha256", join(p.base, "s256"));
    git(join(p.base, "s256"), "config", "receive.certNonceSeed", "sekrit");
    const ad256 = spawnSync("git", ["receive-pack", "."], {
      cwd: join(p.base, "s256"),
      env: env(),
      input: "",
    });
    const nonce256 = /push-cert=(\d+)-([0-9a-f]+)/.exec(ad256.stdout.toString("latin1"));
    expect(nonce256?.[2]).toHaveLength(64);
    expect(pushCertNonce("sekrit", ".", Number(nonce256?.[1]), SHA256_OBJECT_FORMAT)).toBe(
      `${nonce256?.[1]}-${nonce256?.[2]}`,
    );
    // send-pack's reject_invalid_nonce
    expect(isValidPushCertNonce(`${stamp}-abc/+=_.`)).toBe(true);
    expect(isValidPushCertNonce("1\n\npush-option x")).toBe(false);
    expect(isValidPushCertNonce("x".repeat(256))).toBe(false);
    // a nonce of another receive-pack (same seed and directory), 100 seconds old: git's HMAC
    // check passes and the slop is reported, as ours computes it
    const old = pushCertNonce("sekrit", ".", stamp - 100);
    const native = nativeReceive(
      join(p.base, "n"),
      certRequest(jgitCertificate(p.oid, old), CAPS),
      true,
    );
    expect(native.status).toBe(0);
    const log = readFileSync(join(p.base, "n", "hooks.log"), "latin1");
    expect(log).toContain("GIT_PUSH_CERT_NONCE_STATUS=SLOP");
    const slop = Number(/GIT_PUSH_CERT_NONCE_SLOP=(\d+)/.exec(log)?.[1]);
    const ours = checkPushCertNonce({
      payload: jgitCertificate(p.oid, old).slice(0, -SIGNATURE.length),
      advertised: pushCertNonce("sekrit", ".", stamp - 100 + slop),
      seed: "sekrit",
      dir: ".",
      stateless: true,
    });
    expect(ours).toEqual({
      status: "SLOP",
      nonce: pushCertNonce("sekrit", ".", stamp - 100 + slop),
      slop,
    });
    // within receive.certNonceSlop it is OK, and the hooks are told the client's nonce
    expect(
      checkPushCertNonce({
        payload: jgitCertificate(p.oid, old).slice(0, -SIGNATURE.length),
        advertised: pushCertNonce("sekrit", ".", stamp),
        seed: "sekrit",
        dir: ".",
        stateless: true,
        slopLimit: 1000,
      }),
    ).toEqual({ status: "OK", nonce: old });
  });
});
