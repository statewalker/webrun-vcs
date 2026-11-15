import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureGiteaBinary, type GiteaBinaryOptions } from "./binary.js";
import {
  type GiteaLaunch,
  giteaAppIni,
  giteaCommand,
  giteaCreateAdminArgs,
  giteaEnv,
} from "./config.js";
import { GITEA_VERSION } from "./release.js";

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
  /** Stops Gitea (SIGTERM to its process group, SIGKILL after 10 s) and removes its work directory */
  stop(): Promise<void>;
}

export interface StartGiteaOptions extends GiteaBinaryOptions {
  /** An already verified binary; skips {@link ensureGiteaBinary} */
  bin?: string;
  /** How long to wait for Gitea to answer (default 60 s) */
  startTimeoutMs?: number;
  /** Start attempts, each on a new free port (default 3) */
  attempts?: number;
  /** Log level (default `Warn`) */
  logLevel?: string;
}

/** Process groups still running, killed when this process exits without stopping them. */
const running = new Set<number>();
let exitHookInstalled = false;
function track(pid: number) {
  running.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const p of running) {
      try {
        process.kill(-p, "SIGKILL");
      } catch {}
    }
  });
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
  if (proc.exitCode !== null || proc.signalCode !== null) {
    if (pid) running.delete(pid);
    return;
  }
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
  if (pid) running.delete(pid);
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
  const bin = opts.bin ?? (await ensureGiteaBinary(opts));
  let last: unknown;
  for (let attempt = 0; attempt < (opts.attempts ?? 3); attempt++) {
    try {
      return await startOnce(bin, opts);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function startOnce(bin: string, opts: StartGiteaOptions): Promise<GiteaServer> {
  const port = await freePort();
  const work = await mkdtemp(join(tmpdir(), "gitea-work-"));
  let proc: ChildProcess | undefined;
  let log = "";
  try {
    const conf = join(work, "custom", "conf");
    await mkdir(conf, { recursive: true });
    const asRoot = process.getuid?.() === 0;
    const runUser = asRoot ? "nobody" : (await run("id", ["-un"])).stdout.trim();
    const appIni = join(conf, "app.ini");
    await writeFile(appIni, giteaAppIni({ workDir: work, port, runUser, logLevel: opts.logLevel }));
    let exe = bin;
    if (asRoot) {
      // The cache may sit where `nobody` cannot reach (a private directory of
      // root): then Gitea runs from a copy in its own work directory.
      const reachable = await run("runuser", ["-u", runUser, "--", "test", "-x", bin]).then(
        () => true,
        () => false,
      );
      if (!reachable) {
        exe = join(work, "gitea");
        await copyFile(bin, exe);
        await chmod(exe, 0o755);
      }
      const uid = Number((await run("id", ["-u", runUser])).stdout);
      const gid = Number((await run("id", ["-g", runUser])).stdout);
      await chmod(work, 0o755);
      await chownTree(work, uid, gid);
    }
    const launch: GiteaLaunch = { bin: exe, workDir: work, runAs: asRoot ? runUser : undefined };
    const env = giteaEnv(work, process.env.PATH);
    const gitea = async (args: string[]) => {
      const c = giteaCommand(launch, args);
      try {
        return (await run(c.command, c.args, { cwd: work, env, timeout: 120_000 })).stdout;
      } catch (e) {
        const err = e as Error & { stderr?: string; stdout?: string };
        throw new Error(
          `gitea ${args.slice(0, 2).join(" ")} failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
        );
      }
    };

    await gitea(["migrate", "-c", appIni]);
    const user = "oracle";
    const password = "oracle-pass-1";
    await gitea(
      giteaCreateAdminArgs(appIni, { name: user, password, email: "oracle@example.com" }),
    );

    const c = giteaCommand(launch, ["web", "-c", appIni]);
    // its own process group: a stop reaches Gitea itself, not only runuser
    const web = spawn(c.command, c.args, {
      cwd: work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    proc = web;
    if (web.pid) track(web.pid);
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    web.stdout?.on("data", keep);
    web.stderr?.on("data", keep);

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
    for (;;) {
      try {
        // Gitea's own answer, not another server that took the port
        const r = await fetch(`${baseUrl}/api/v1/version`);
        if (r.ok && (await r.text()).includes(`"version":"${GITEA_VERSION}"`)) break;
      } catch {}
      if (web.exitCode !== null || web.signalCode !== null)
        throw new Error(`gitea exited (${web.exitCode ?? web.signalCode}) on port ${port}`);
      if (Date.now() > deadline) throw new Error(`gitea did not answer on port ${port}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
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
      },
    };
  } catch (e) {
    if (proc) await stopGroup(proc, 5000);
    await rm(work, { recursive: true, force: true, maxRetries: 5 });
    const tail = log.trim() ? `\n--- gitea log ---\n${log.trim()}` : "";
    throw new Error(`${(e as Error).message}${tail}`, { cause: e });
  }
}
