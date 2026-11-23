/**
 * What the gc native-twin tests share: a scenario is built with native git in `<case>/src`
 * (a repository `repo`, with whatever lies beside it: linked worktrees, alternates, a
 * remote), copied with `cp -a` into `<case>/native` and `<case>/ours` (absolute paths in
 * worktree and alternates files rewritten, their times kept), then native `git gc <args>`
 * runs in one copy and our `git.gc()` in the other, and the two repositories are compared
 * whole (see {@link GcSnapshot}). Pack bytes are never compared: the two sides may choose other
 * deltas, so pack names differ too; packs are compared by kind and content.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { expect } from "vitest";
import type { GarbageCollectCommand, GCCommandResult } from "../src/commands/gc-command.js";
import { Git } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

export { nativeIs25x };

/** "Now" of the whole run, in seconds: fixtures are dated relative to it. */
export const NOW = Math.floor(Date.now() / 1000);
export const DAY = 86400;

/**
 * The environment of every native git call: `nativeGitEnv` (no background maintenance,
 * `gc.auto=0`), with commits dated `NOW - 3 days` unless a scenario dates them itself, so
 * reflog entries are younger than every expiry unless the scenario says otherwise.
 */
export function gcEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const date = `${NOW - 3 * DAY} +0000`;
  return {
    ...nativeGitEnv(home),
    // a newer git run as the oracle (a git 3.0 build) keeps the files backend
    ...(process.env.GIT_DEFAULT_REF_FORMAT
      ? { GIT_DEFAULT_REF_FORMAT: process.env.GIT_DEFAULT_REF_FORMAT }
      : {}),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    ...extra,
  };
}

/**
 * `GIT_DIR` for a bare repository at `cwd`: git 3.0 (`safe.bareRepository=explicit`) refuses
 * to discover one.
 */
export function bareEnv(cwd: string): Record<string, string> {
  return !existsSync(join(cwd, ".git")) &&
    existsSync(join(cwd, "HEAD")) &&
    existsSync(join(cwd, "objects"))
    ? { GIT_DIR: cwd }
    : {};
}

/** A scenario's native git: `run` dies on a failure, `out` returns stdout. */
export class NativeRepo {
  constructor(
    readonly home: string,
    readonly dir: string,
    private env: Record<string, string> = {},
  ) {}

  /** Runs native git in `cwd` (default the repository), returning stdout. */
  git(
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
  ) {
    const r = spawnSync("git", args, {
      cwd: options.cwd ?? this.dir,
      env: gcEnv(this.home, { ...bareEnv(options.cwd ?? this.dir), ...this.env, ...options.env }),
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${r.status}): ${r.stderr.toString()}${r.stdout.toString()}`,
      );
    }
    return r.stdout.toString("latin1").trim();
  }

  /** Writes a file of the worktree (or of `cwd`). */
  put(path: string, content: string, cwd = this.dir) {
    const at = join(cwd, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, content);
  }

  /** Commits `files` (path to content) with `message`, at `date` (seconds) when given. */
  commit(message: string, files: Record<string, string> = {}, date?: number, cwd = this.dir) {
    for (const [p, c] of Object.entries(files)) this.put(p, c, cwd);
    this.git(["add", "-A"], { cwd });
    const env: Record<string, string> =
      date === undefined
        ? {}
        : { GIT_AUTHOR_DATE: `${date} +0000`, GIT_COMMITTER_DATE: `${date} +0000` };
    this.git(["commit", "-q", "--allow-empty", "-m", message], { cwd, env });
    return this.git(["rev-parse", "HEAD"], { cwd });
  }

  /** Writes a blob, returning its id. */
  blob(content: string) {
    return this.git(["hash-object", "-w", "--stdin"], { input: content });
  }

  /** The repository's git directory (`.git`, or the repository itself when bare). */
  get gitDir() {
    return existsSync(join(this.dir, ".git")) ? join(this.dir, ".git") : this.dir;
  }

  /** Dates a loose object's file `days` ago. */
  age(id: string, days: number) {
    const path = join(this.gitDir, "objects", id.slice(0, 2), id.slice(2));
    const t = NOW - days * DAY;
    utimesSync(path, t, t);
  }

  /** Dates every loose object `days` ago. */
  ageAllLoose(days: number) {
    for (const id of looseObjects(this.gitDir)) this.age(id, days);
  }

  /** Dates every pack file (`pack-*.*`) `days` ago. */
  agePacks(days: number) {
    const dir = join(this.gitDir, "objects", "pack");
    const t = NOW - days * DAY;
    for (const name of existsSync(dir) ? readdirSync(dir) : []) utimesSync(join(dir, name), t, t);
  }
}

/** The loose object ids of a git directory, sorted. */
export function looseObjects(gitDir: string): string[] {
  const out: string[] = [];
  const objects = join(gitDir, "objects");
  for (const fan of readdirSync(objects)) {
    if (!/^[0-9a-f]{2}$/.test(fan)) continue;
    for (const name of readdirSync(join(objects, fan)))
      if (/^[0-9a-f]{38}$/.test(name)) out.push(fan + name);
  }
  return out.sort();
}

/**
 * Copies `<case>/src` to `<case>/<name>`, keeping every time, and points the absolute paths
 * of linked worktrees (`gitdir`, a worktree's `.git` file) and alternates at the copy.
 */
export function copyTwin(caseDir: string, name: string): string {
  const src = join(caseDir, "src");
  const dst = join(caseDir, name);
  execFileSync("cp", ["-a", src, dst]);
  const rewrite = (path: string) => {
    const st = statSync(path);
    const text = readFileSync(path, "latin1");
    if (!text.includes(src)) return;
    writeFileSync(path, text.split(`${src}/`).join(`${dst}/`), "latin1");
    utimesSync(path, st.atime, st.mtime);
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "objects" && existsSync(join(path, "info"))) {
          const alt = join(path, "info", "alternates");
          if (existsSync(alt)) rewrite(alt);
          continue;
        }
        walk(path);
      } else if (entry.isFile() && (entry.name === ".git" || entry.name === "gitdir")) {
        rewrite(path);
      }
    }
  };
  walk(dst);
  return dst;
}

/** The pack files of a git directory, grouped by pack. */
interface PackState {
  kind: "cruft" | "promisor" | "keep" | "pack";
  /** the object ids, sorted (with their `.mtimes` time for a cruft pack: `id@time`) */
  ids: string[];
  /** the other files beside the `.pack` and `.idx` */
  files: string[];
  /** `.keep`/`.promisor` content */
  extra?: Record<string, string>;
}

/** Everything compared between the twins. */
export interface GcSnapshot {
  loose: string[];
  packs: PackState[];
  packedRefs: string | null;
  looseRefs: Record<string, string>;
  reflogs: Record<string, string>;
  worktrees: Record<string, string>;
  rrCache: string[];
  shallow: string | null;
  commitGraph: string[];
  multiPackIndex: string[];
  infoFiles: string[];
  other: string[];
}

/** git's `.mtimes`: "MTME", version, hash id, then one big-endian time per idx position. */
function readMtimes(path: string, count: number): number[] {
  const bytes = readFileSync(path);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(bytes.readUInt32BE(12 + 4 * i));
  return out;
}

/** The ids of a pack index, in idx order (`git show-index`). */
function packIds(idx: string): string[] {
  const text = execFileSync("git", ["show-index"], { input: readFileSync(idx) }).toString();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[1] as string);
}

function filesUnder(
  dir: string,
  rel = "",
  out: Record<string, string> = {},
  skip = (_: string) => false,
) {
  const at = join(dir, rel);
  if (!existsSync(at)) return out;
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip(path)) continue;
    if (entry.isDirectory()) filesUnder(dir, path, out, skip);
    else out[path] = readFileSync(join(dir, path), "latin1");
  }
  return out;
}

/**
 * The state of a repository after gc. `expiration` names the times a cruft pack gives
 * objects only reachable from younger unreachable ones (git's `--cruft-expiration`, "now"
 * minus the grace period at the time each gc ran): those come out as `EXPIRATION`.
 * `previousGc` names the times the twin's previous gc ran: a cruft pack gives an unreachable
 * object it finds in a pack that pack's mtime (pack-objects.c, `p->mtime`), so an object a
 * previous gc packed carries the time that gc wrote its pack, which differs between the twins
 * (each gc runs at its own time): those come out as `PREVIOUS_GC`.
 */
export function gcSnapshot(
  gitDir: string,
  twinDir: string,
  expiration?: { from: number; to: number },
  previousGc?: { from: number; to: number },
): GcSnapshot {
  const packDir = join(gitDir, "objects", "pack");
  const names = existsSync(packDir) ? readdirSync(packDir).sort() : [];
  const packs: PackState[] = [];
  const other: string[] = [];
  const multiPackIndex: string[] = [];
  for (const name of names) {
    if (name.startsWith("multi-pack-index")) {
      multiPackIndex.push(name.replace(/[0-9a-f]{40}/, "<id>"));
      continue;
    }
    const m = /^pack-([0-9a-f]{40})\.(\w+)$/.exec(name);
    if (!m) {
      other.push(`pack/${name}`);
      continue;
    }
    if (m[2] !== "idx") continue;
    const base = join(packDir, `pack-${m[1]}`);
    const ids = packIds(`${base}.idx`);
    const exts = names
      .filter((n) => n.startsWith(`pack-${m[1]}.`))
      .map((n) => n.slice(`pack-${m[1]}.`.length))
      .filter((e) => e !== "idx" && e !== "pack")
      .sort();
    if (!existsSync(`${base}.pack`)) exts.push("<no .pack>");
    const kind = exts.includes("mtimes")
      ? "cruft"
      : exts.includes("promisor")
        ? "promisor"
        : exts.includes("keep")
          ? "keep"
          : "pack";
    let listed = ids;
    if (kind === "cruft") {
      const times = readMtimes(`${base}.mtimes`, ids.length);
      listed = ids.map((id, i) => {
        const t = times[i] as number;
        const exp = expiration && t >= expiration.from - 2 && t <= expiration.to + 2;
        // a file's mtime comes from the kernel's coarse clock, which may lag Date.now()
        const prev = previousGc && t >= previousGc.from - 1 && t <= previousGc.to;
        return `${id}@${exp ? "EXPIRATION" : prev ? "PREVIOUS_GC" : t}`;
      });
    }
    const extra: Record<string, string> = {};
    for (const e of ["keep", "promisor"])
      if (exts.includes(e)) extra[e] = readFileSync(`${base}.${e}`, "latin1");
    packs.push({
      kind,
      ids: [...listed].sort(),
      files: exts,
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  }
  // .pack files without an .idx
  for (const name of names) {
    const m = /^pack-([0-9a-f]{40})\.pack$/.exec(name);
    if (m && !names.includes(`pack-${m[1]}.idx`)) other.push(`pack/${name} (no .idx)`);
  }
  packs.sort((a, b) => `${a.kind} ${a.ids[0]}`.localeCompare(`${b.kind} ${b.ids[0]}`));

  const read = (p: string) => (existsSync(p) ? readFileSync(p, "latin1") : null);
  const graphs = join(gitDir, "objects", "info");
  const commitGraph: string[] = [];
  // the commit-graph's bytes (its trailer included) are compared: same commits, same data
  const digest = (p: string) => createHash("sha1").update(readFileSync(p)).digest("hex");
  if (existsSync(join(graphs, "commit-graph")))
    commitGraph.push(`commit-graph ${digest(join(graphs, "commit-graph"))}`);
  if (existsSync(join(graphs, "commit-graphs")))
    for (const n of readdirSync(join(graphs, "commit-graphs")))
      commitGraph.push(`commit-graphs/${n.replace(/[0-9a-f]{40}/, "<id>")}`);
  // update-server-info: info/refs whole, objects/info/packs as a set of lines (git orders
  // new packs by their addresses in memory)
  const infoFiles: string[] = [];
  const infoRefs = read(join(gitDir, "info", "refs"));
  if (infoRefs !== null) infoFiles.push(`info/refs:\n${infoRefs}`);
  const infoPacks = read(join(gitDir, "objects", "info", "packs"));
  if (infoPacks !== null)
    infoFiles.push(
      `objects/info/packs: ${infoPacks.split("\n").filter((l) => l.startsWith("P ")).length} packs, ${infoPacks.endsWith("\n\n") ? "terminated" : "unterminated"}`,
    );
  // the worktrees' administrative files (an index's bytes hold stat data: names only)
  const worktrees = filesUnder(join(gitDir, "worktrees"));
  for (const k of Object.keys(worktrees)) {
    if (k.endsWith("/index")) worktrees[k] = "<index>";
    else worktrees[k] = (worktrees[k] as string).split(twinDir).join("<twin>");
  }
  const rr = join(gitDir, "rr-cache");
  const rrCache = existsSync(rr) ? Object.keys(filesUnder(rr)).sort() : [];
  if (existsSync(rr)) rrCache.unshift("<rr-cache>");
  for (const n of existsSync(rr) ? readdirSync(rr) : [])
    if (statSync(join(rr, n)).isDirectory()) rrCache.push(`${n}/`);
  rrCache.sort();
  // temporaries: objects/tmp_*, objects/<fan-out>/tmp_obj_* (pack/tmp_* are listed above)
  const objectsDir = join(gitDir, "objects");
  for (const n of readdirSync(objectsDir)) {
    if (n.startsWith("tmp_")) other.push(`objects/${n}`);
    else if (/^[0-9a-f]{2}$/.test(n))
      for (const m of readdirSync(join(objectsDir, n)))
        if (!/^[0-9a-f]{38}$/.test(m)) other.push(`objects/${n}/${m}`);
  }
  for (const n of ["gc.pid", "gc.log", "packed-refs.lock", "shallow.lock"])
    if (existsSync(join(gitDir, n))) other.push(n);
  return {
    loose: looseObjects(gitDir),
    packs,
    packedRefs: read(join(gitDir, "packed-refs")),
    looseRefs: filesUnder(join(gitDir, "refs")),
    reflogs: filesUnder(join(gitDir, "logs")),
    worktrees,
    rrCache,
    shallow: read(join(gitDir, "shallow")),
    commitGraph,
    multiPackIndex,
    infoFiles,
    other: other.sort(),
  };
}

/**
 * git's documented reflog expiry defaults, given to native gc on its command line: git 2.56.x
 * swapped them in `REFLOG_EXPIRE_OPTIONS_INIT` (30 days total, 90 unreachable), so without them
 * the twins would compare that release's bug. A repository's own `gc.reflogExpire*` must not be
 * set in such twins (the command line wins).
 */
export const REFLOG_EXPIRY_DEFAULTS = [
  "-c",
  "gc.reflogExpire=90.days.ago",
  "-c",
  "gc.reflogExpireUnreachable=30.days.ago",
];

/** Native git's result in a twin: exit code, stderr. */
export function nativeGc(
  home: string,
  repo: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stderr: string } {
  const r = spawnSync("git", [...REFLOG_EXPIRY_DEFAULTS, "gc", ...args], {
    cwd: repo,
    env: gcEnv(home, { ...bareEnv(repo), ...env }),
  });
  return { status: r.status, stderr: r.stderr.toString("latin1") };
}

/** Our `Git` over a twin (FilesApi rooted at the twin, the repository at `repo`). */
export async function openOursGc(
  home: string,
  twinDir: string,
  repo = "repo",
  env: Record<string, string> = {},
): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: twinDir });
  const bare = !existsSync(join(twinDir, repo, ".git"));
  const gitDir = bare ? repo : `${repo}/.git`;
  const fullEnv = gcEnv(home, env);
  const environment = createNodeGitHostEnvironment({
    env: fullEnv,
    hookRunner: createNodeHookRunner({
      env: fullEnv,
      compatibility: nativeIs25x ? "2.56" : "2.43",
    }),
  });
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  if (bare) return Git.fromWorktreeAdmin(await worktrees.openAdmin());
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** git's fsck --strict over a repository: its exit code and output. */
export function fsck(home: string, repo: string): { status: number | null; out: string } {
  const r = spawnSync("git", ["fsck", "--strict", "--no-progress", "--no-dangling"], {
    cwd: repo,
    env: gcEnv(home, bareEnv(repo)),
  });
  return { status: r.status, out: r.stdout.toString() + r.stderr.toString() };
}

/** Whether `git commit-graph verify` and bitmaps check out in a repository. */
export function verifyAuxiliaries(home: string, repo: string, gitDir: string): string[] {
  const problems: string[] = [];
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: repo, env: gcEnv(home, bareEnv(repo)) });
  const info = join(gitDir, "objects", "info");
  if (existsSync(join(info, "commit-graph")) || existsSync(join(info, "commit-graphs"))) {
    const r = run(["commit-graph", "verify", "--no-progress"]);
    if (r.status !== 0) problems.push(`commit-graph verify: ${r.stderr.toString()}`);
  }
  const packDir = join(gitDir, "objects", "pack");
  if (existsSync(packDir) && readdirSync(packDir).some((n) => n.endsWith(".bitmap"))) {
    const head = run(["rev-parse", "--verify", "-q", "HEAD"]).stdout.toString().trim();
    if (head) {
      const r = run(["rev-list", "--test-bitmap", head]);
      if (r.status !== 0) problems.push(`test-bitmap: ${r.stderr.toString()}`);
    }
  }
  return problems;
}

/** Options of one twin run. */
export interface TwinRun {
  /** native `git gc` arguments */
  args?: string[];
  /** our command, configured as the arguments say */
  ours?: (gc: GarbageCollectCommand) => GarbageCollectCommand;
  /** more environment for both (native's and ours) */
  env?: Record<string, string>;
  /** the repository within the twin (default `repo`) */
  repo?: string;
  /** the grace period git's cruft expiration uses (seconds, default two weeks) */
  graceSeconds?: number;
  /** compare the twins a second time after another gc on each (default true) */
  twice?: boolean;
  /** what to leave out of the comparison (a version difference noted by the scenario) */
  normalize?: (s: GcSnapshot) => GcSnapshot;
  /** ours may fail fsck --strict: the scenario's repository is broken on purpose */
  allowFsckFailure?: boolean;
}

/** The result of a twin run: both snapshots after the first gc, and our command's result. */
export interface TwinResult {
  native: GcSnapshot;
  ours: GcSnapshot;
  result: GCCommandResult;
  nativeStderr: string;
  twins: { native: string; ours: string };
}

/**
 * Runs gc in both twins of `<caseDir>/src` and compares them, then (unless `twice: false`) a
 * second gc in each, compared again. Returns the first round's snapshots.
 */
export async function gcTwins(
  home: string,
  caseDir: string,
  run: TwinRun = {},
): Promise<TwinResult> {
  const native = copyTwin(caseDir, "native");
  const ours = copyTwin(caseDir, "ours");
  const repo = run.repo ?? "repo";
  const grace = run.graceSeconds ?? 14 * DAY;
  const normalize = run.normalize ?? ((s: GcSnapshot) => s);
  const gitDirOf = (twin: string) =>
    existsSync(join(twin, repo, ".git")) ? join(twin, repo, ".git") : join(twin, repo);

  // when each twin's previous gc ran (native's from t0 to t1, ours from t1 to t2)
  let previous:
    | { native: { from: number; to: number }; ours: { from: number; to: number } }
    | undefined;
  const round = async (n: number) => {
    const t0 = Math.floor(Date.now() / 1000);
    const theirs = nativeGc(home, join(native, repo), run.args ?? [], run.env);
    const t1 = Math.floor(Date.now() / 1000);
    expect(theirs.status, `native gc: ${theirs.stderr}`).toBe(0);
    const git = await openOursGc(home, ours, repo, run.env);
    const cmd = git.gc();
    const result = await (run.ours ? run.ours(cmd) : cmd).call();
    const t2 = Math.floor(Date.now() / 1000);
    const a = normalize(
      gcSnapshot(gitDirOf(native), native, { from: t0 - grace, to: t1 - grace }, previous?.native),
    );
    const b = normalize(
      gcSnapshot(gitDirOf(ours), ours, { from: t1 - grace, to: t2 - grace }, previous?.ours),
    );
    previous = { native: { from: t0, to: t1 }, ours: { from: t1, to: t2 } };
    if (process.env.GC_TWIN_DEBUG) console.log(JSON.stringify({ n, native: a, result }, null, 1));
    expect(b, `round ${n}`).toEqual(a);
    // native fsck --strict finds in ours what it finds in its own result
    const ok = fsck(home, join(ours, repo));
    const theirsOk = fsck(home, join(native, repo));
    expect(ok.out.split(ours).join("<twin>"), `fsck --strict of ours, round ${n}`).toBe(
      theirsOk.out.split(native).join("<twin>"),
    );
    if (!run.allowFsckFailure) expect(ok.status).toBe(0);
    // commit-graph verify and test-bitmap answer for ours as for native's result
    const aux = (twin: string) =>
      verifyAuxiliaries(home, join(twin, repo), gitDirOf(twin)).map((l) =>
        l.split(twin).join("<twin>"),
      );
    expect(aux(ours), `round ${n}`).toEqual(aux(native));
    return { a, b, result, stderr: theirs.stderr };
  };
  const first = await round(1);
  if (run.twice ?? true) await round(2);
  return {
    native: first.a,
    ours: first.b,
    result: first.result,
    nativeStderr: first.stderr,
    twins: { native, ours },
  };
}

/** A scenario directory `<root>/<name>` with an empty `src`; returns the case directory. */
export function newCase(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

/** `git init` of `<case>/src/repo` (bare when asked) with the default branch `main`. */
export function initRepo(home: string, caseDir: string, bare = false, name = "repo"): NativeRepo {
  const dir = join(caseDir, "src", name);
  const r = new NativeRepo(home, join(caseDir, "src"));
  r.git(["init", "-q", "-b", "main", ...(bare ? ["--bare"] : []), name]);
  return new NativeRepo(home, dir);
}

/** A loose blob whose id starts with `17` (git's gc --auto estimate counts `objects/17`). */
export function seventeenBlobs(count: number, salt = ""): string[] {
  const out: string[] = [];
  for (let n = 0; out.length < count; n++) {
    const content = `blob ${salt}${n}\n`;
    const id = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest("hex");
    if (id.startsWith("17")) out.push(content);
  }
  return out;
}

/** Whether a path exists, a dangling symbolic link included. */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export { cpSync };

/** Where a snapshot holds `id`: "loose", a pack kind ("pack", "cruft", ...), or undefined. */
export function holds(s: GcSnapshot, id: string): string | undefined {
  if (s.loose.includes(id)) return "loose";
  for (const p of s.packs) if (p.ids.some((x) => x === id || x.startsWith(`${id}@`))) return p.kind;
  return undefined;
}
