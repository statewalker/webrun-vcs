import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chown, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { copyVerified, ensureGiteaBinary, type GiteaBinaryOptions } from "./binary.js";
import {
  type GiteaLaunch,
  giteaAppIni,
  giteaCommand,
  giteaCreateAdminArgs,
  giteaEnv,
} from "./config.js";
import { GITEA_VERSION, giteaRelease } from "./release.js";

const run = promisify(execFile);

export interface GiteaRepo {
  name: string;
  /** `http://127.0.0.1:<port>/<user>/<name>.git` */
  cloneUrl: string;
  /** The LFS endpoint, `<cloneUrl>/info/lfs` */
  lfsUrl: string;
  /** The clone URL with the admin's credentials in it, for native git */
  authenticatedUrl: string;
}

export interface GiteaServer {
  version: string;
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  user: string;
  password: string;
  /** An API token of the admin (scopes: write:repository, write:user) */
  token: string;
  /** `Basic …` for the admin */
  authorization: string;
  /** `fetch` that adds the admin's Basic credentials unless the request has an authorization */
  fetch: typeof fetch;
  /** A new empty repository of the admin, private unless asked otherwise */
  createRepo(name: string, opts?: { private?: boolean }): Promise<GiteaRepo>;
  /** Gitea's private work directory (mode 0700) */
  workDir: string;
  /** The process group of `gitea web` (runuser's, as root) */
  pid?: number;
  /** Stops Gitea (SIGTERM to its process group, SIGKILL after 10 s) and removes its work directory */
  stop(): Promise<void>;
}

export interface StartGiteaOptions extends GiteaBinaryOptions {
  /**
   * A binary to use instead of {@link ensureGiteaBinary}'s cached one. Like
   * that one, it is copied into the private work directory and must hash to
   * the release's SHA-256.
   */
  bin?: string;
  /** How long one attempt waits for Gitea to answer (default 60 s) */
  startTimeoutMs?: number;
  /**
   * The time all attempts together may take, the binary aside (default
   * 240 s, below the oracle's 600 s hook timeout with the 300 s download)
   */
  totalStartTimeoutMs?: number;
  /** Start attempts, each on a new free port (default 3) */
  attempts?: number;
  /** The first attempt's port (later attempts take free ones); default: a free one */
  port?: number;
  /** Log level (default `Warn`) */
  logLevel?: string;
}

/**
 * Work directories of this process's Gitea instances (and their process
 * groups). If the process exits, or is ended by SIGTERM, SIGINT or SIGHUP,
 * without stopping them, the groups are killed and the directories removed;
 * a signal is then raised again so the process still ends as it would have.
 */
const live = new Map<string, { pid?: number }>();
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
let hooksInstalled = false;

function cleanupAllSync() {
  for (const [work, { pid }] of live) {
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
  live.clear();
}

function onSignal(signal: NodeJS.Signals) {
  cleanupAllSync();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.kill(process.pid, signal);
}

function register(work: string): { pid?: number } {
  const entry: { pid?: number } = {};
  live.set(work, entry);
  if (!hooksInstalled) {
    hooksInstalled = true;
    process.once("exit", cleanupAllSync);
    for (const s of SIGNALS) process.on(s, onSignal);
  }
  return entry;
}

/** A port free on 127.0.0.1 right now (the start retries if it is taken before Gitea binds it). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid);
  if ((await stat(path)).isDirectory())
    for (const e of await readdir(path)) await chownTree(join(path, e), uid, gid);
}

/** SIGTERM to the whole process group (runuser and Gitea), SIGKILL if it outlives `ms`. */
async function stopGroup(proc: ChildProcess, ms = 10_000): Promise<void> {
  const pid = proc.pid;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (pid) process.kill(-pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(true), ms);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    kill("SIGKILL");
    await exited;
  }
}

/**
 * Gitea on a free port of 127.0.0.1, with an admin user, its API token and a
 * fresh SQLite database in a temporary work directory. A start that fails
 * (say, the port was taken meanwhile) is retried on another port; the last
 * failure is thrown, with the tail of Gitea's log.
 *
 * Gitea refuses to run as root. A root process (a container or sandbox) runs
 * it as `nobody` through `runuser`, with the work directory chowned to it;
 * an ordinary user (CI) runs it directly.
 */
export async function startGitea(opts: StartGiteaOptions = {}): Promise<GiteaServer> {
  const release = opts.release ?? giteaRelease();
  const bin = opts.bin ?? (await ensureGiteaBinary({ ...opts, release }));
  const deadline = Date.now() + (opts.totalStartTimeoutMs ?? 240_000);
  let last: unknown;
  for (let attempt = 0; attempt < (opts.attempts ?? 3) && Date.now() < deadline; attempt++) {
    try {
      const port = attempt === 0 && opts.port ? opts.port : await freePort();
      return await startOnce(bin, release.sha256, deadline, port, opts);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("gitea: no time left to start");
}

/** A password for one instance: hex, so it never reads as a command-line flag. */
const newPassword = () => randomBytes(16).toString("hex");

async function startOnce(
  bin: string,
  sha256: string,
  deadline: number,
  port: number,
  opts: StartGiteaOptions,
): Promise<GiteaServer> {
  // mode 0700: app.ini, the database and the binary are this instance's alone
  const work = await mkdtemp(join(tmpdir(), "gitea-work-"));
  const entry = register(work);
  const remaining = () => Math.max(1, deadline - Date.now());
  let proc: ChildProcess | undefined;
  let log = "";
  try {
    // Gitea runs from its own copy, hashed again: the bytes that run are the bytes checked.
    const exe = join(work, "gitea");
    await copyVerified(bin, exe, sha256);
    const conf = join(work, "custom", "conf");
    await mkdir(conf, { recursive: true, mode: 0o700 });
    const asRoot = process.getuid?.() === 0;
    const runUser = asRoot ? "nobody" : (await run("id", ["-un"])).stdout.trim();
    const appIni = join(conf, "app.ini");
    await writeFile(
      appIni,
      giteaAppIni({ workDir: work, port, runUser, logLevel: opts.logLevel }),
      {
        mode: 0o600,
      },
    );
    if (asRoot) {
      // the work directory stays 0700, owned by the user Gitea runs as
      const uid = Number((await run("id", ["-u", runUser])).stdout);
      const gid = Number((await run("id", ["-g", runUser])).stdout);
      await chownTree(work, uid, gid);
    }
    const launch: GiteaLaunch = { bin: exe, workDir: work, runAs: asRoot ? runUser : undefined };
    const env = giteaEnv(work, process.env.PATH);
    const gitea = async (args: string[]) => {
      const c = giteaCommand(launch, args);
      try {
        const timeout = Math.min(120_000, remaining());
        return (await run(c.command, c.args, { cwd: work, env, timeout })).stdout;
      } catch (e) {
        const err = e as Error & { stderr?: string; stdout?: string };
        throw new Error(
          `gitea ${args.slice(0, 2).join(" ")} failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
        );
      }
    };

    await gitea(["migrate", "-c", appIni]);
    const user = "oracle";
    const password = newPassword();
    await gitea(
      giteaCreateAdminArgs(appIni, { name: user, password, email: "oracle@example.com" }),
    );
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

    const c = giteaCommand(launch, ["web", "-c", appIni]);
    // its own process group: a stop reaches Gitea itself, not only runuser
    const web = spawn(c.command, c.args, {
      cwd: work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    proc = web;
    entry.pid = web.pid;
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    web.stdout?.on("data", keep);
    web.stderr?.on("data", keep);
    const exited = () => web.exitCode !== null || web.signalCode !== null;

    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = Math.min(Date.now() + (opts.startTimeoutMs ?? 60_000), deadline);
    for (;;) {
      let answered = false;
      try {
        const r = await fetch(`${baseUrl}/api/v1/version`);
        answered = r.ok && (await r.text()).includes(`"version":"${GITEA_VERSION}"`);
      } catch {}
      // a Gitea that could not bind the port exits: whatever answered is someone else's
      if (exited())
        throw new Error(`gitea exited (${web.exitCode ?? web.signalCode}) on port ${port}`);
      if (answered) {
        // ours, not another instance on a port taken meanwhile: only ours knows this password
        const who = await fetch(`${baseUrl}/api/v1/user`, { headers: { authorization } });
        const body = (await who.json().catch(() => ({}))) as { login?: string };
        if (who.status !== 200 || body.login !== user)
          throw new Error(`another server answers on port ${port} (HTTP ${who.status})`);
        if (exited()) throw new Error(`gitea exited on port ${port}`);
        break;
      }
      if (Date.now() > ready) throw new Error(`gitea did not answer on port ${port}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const authed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
      if (req.headers.has("authorization")) return fetch(req);
      const headers = new Headers(req.headers);
      headers.set("authorization", authorization);
      return fetch(new Request(req, { headers, duplex: "half" } as RequestInit));
    }) as typeof fetch;

    const api = async (path: string, body: unknown, expected = 201) => {
      const r = await authed(`${baseUrl}/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (r.status !== expected) throw new Error(`gitea: POST ${path}: HTTP ${r.status} ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const created = await api(`/users/${user}/tokens`, {
      name: "oracle",
      scopes: ["write:repository", "write:user"],
    });
    const token = String(created.sha1 ?? "");
    if (!token) throw new Error("gitea: the token answer has no sha1");

    let stopped = false;
    return {
      version: GITEA_VERSION,
      baseUrl,
      user,
      password,
      token,
      authorization,
      fetch: authed,
      workDir: work,
      pid: web.pid,
      async createRepo(name, o = {}) {
        await api("/user/repos", { name, private: o.private ?? true, default_branch: "main" });
        const cloneUrl = `${baseUrl}/${user}/${name}.git`;
        return {
          name,
          cloneUrl,
          lfsUrl: `${cloneUrl}/info/lfs`,
          authenticatedUrl: cloneUrl.replace(
            "http://",
            `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@`,
          ),
        };
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await stopGroup(web);
        await rm(work, { recursive: true, force: true, maxRetries: 5 });
        live.delete(work);
      },
    };
  } catch (e) {
    if (proc) await stopGroup(proc, 5000);
    await rm(work, { recursive: true, force: true, maxRetries: 5 });
    live.delete(work);
    const tail = log.trim() ? `\n--- gitea log ---\n${log.trim()}` : "";
    throw new Error(`${(e as Error).message}${tail}`, { cause: e });
  }
}
