/**
 * Test support: `git archive` and `git get-tar-commit-id` command lines run through native
 * git and through ours (`ArchiveCommand`, `getTarCommitId`), with the archive bytes, stderr
 * and the exit status compared. Deflated members (zip entries, `tgz`) come from different
 * zlib builds (pako here, the system's in git), so compressed archives are compared with
 * their compressed streams inflated (see {@link normalizeZip}, {@link normalizeTgz}).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { Git, GitApiError, getTarCommitId } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitEnv } from "./shortlog-native-support.js";

export type ArchiveOutcome = { status: number; out: Buffer; err: string };

/** The environment both twins run in (UTC: zip's DOS times are local times). */
export function archiveEnv(home: string, extra: Record<string, string> = {}) {
  return { ...gitEnv(home), TZ: "UTC", ...extra };
}

/** `git [-C <cwd>] [-c <config>]... archive <args>` by native git in `dir`. */
export function nativeArchive(
  home: string,
  dir: string,
  args: string[],
  options: { cwd?: string; config?: string[]; env?: Record<string, string> } = {},
): ArchiveOutcome {
  const output = outputOf(args);
  const r = spawnSync(
    "git",
    [
      ...(options.cwd ? ["-C", options.cwd] : []),
      ...(options.config ?? []).flatMap((c) => ["-c", c]),
      "archive",
      ...args,
    ],
    { cwd: dir, env: archiveEnv(home, options.env) },
  );
  let out = r.stdout;
  if (output !== undefined) {
    const file = join(dir, options.cwd ?? "", output);
    out = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    rmSync(file, { force: true });
  }
  return { status: r.status ?? -1, out, err: r.stderr.toString("latin1") };
}

function outputOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return undefined;
    if (a === "-o" || a === "--output") return args[i + 1];
    if (a.startsWith("--output=")) return a.slice(9);
  }
  return undefined;
}

/** Our repository in `dir`, with the test environment (bare when it has no `.git`). */
export async function openArchiveRepo(home: string, dir: string): Promise<Git> {
  const environment = createNodeGitHostEnvironment({ env: archiveEnv(home) });
  if (existsSync(join(dir, ".git"))) return openOurs(dir, environment);
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files, gitDir: "." });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".", history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** Runs a tar filter command through the shell, as git does. */
async function shellFilter(command: string, input: Uint8Array): Promise<Uint8Array> {
  const r = spawnSync("sh", ["-c", command], { input });
  if (r.status !== 0) throw new Error(`${command} failed`);
  return new Uint8Array(r.stdout);
}

/** `git archive <args>` through ours, git's command line mapped onto `ArchiveCommand`. */
export async function oursArchive(
  home: string,
  dir: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<ArchiveOutcome> {
  const git = await openArchiveRepo(home, dir);
  const cmd = git
    .archive()
    .setFilterRunner(shellFilter)
    .setLocalTimezone(() => 0);
  if (options.cwd) cmd.setCurrentDirectory(options.cwd);
  let list = false;
  let tree = false;
  let paths = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (paths || (tree && a !== "--")) {
        cmd.addPath(a);
        paths = true;
      } else if (a === "--") paths = tree;
      else if (a === "-l" || a === "--list") list = true;
      else if (a === "-v") cmd.setVerbose(true);
      else if (a === "--worktree-attributes") cmd.setWorktreeAttributes(true);
      else if (a.startsWith("--format=")) cmd.setFormat(a.slice(9));
      else if (a.startsWith("--prefix=")) cmd.setPrefix(a.slice(9));
      else if (a.startsWith("--mtime=")) cmd.setMtime(a.slice(8));
      else if (a.startsWith("--add-file=")) cmd.addFile(a.slice(11));
      else if (a.startsWith("--add-virtual-file=")) cmd.addVirtualFile(a.slice(19));
      else if (a.startsWith("--output=")) cmd.setOutputName(a.slice(9));
      else if (a === "-o") cmd.setOutputName(args[++i] as string);
      else if (/^-\d+$/.test(a)) cmd.setCompressionLevel(Number(a.slice(1)));
      else {
        cmd.setTree(a);
        tree = true;
      }
    }
    if (list) {
      const names = cmd.listFormats();
      return { status: 0, out: Buffer.from(names.map((n) => `${n}\n`).join("")), err: "" };
    }
    const out = await cmd.call();
    return { status: 0, out: Buffer.from(out), err: messages(cmd.getMessages()) };
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    return {
      status: e.exitCode,
      out: Buffer.alloc(0),
      err: `${messages(cmd.getMessages())}${e.message}\n`,
    };
  }
}

const messages = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

/** `git get-tar-commit-id` of `archive` by native git and through ours. */
export function tarCommitIdTwins(
  home: string,
  archive: Buffer,
): { native: { status: number; out: string }; ours: { status: number; out: string } } {
  const r = spawnSync("git", ["get-tar-commit-id"], { input: archive, env: archiveEnv(home) });
  const native = { status: r.status ?? -1, out: r.stdout.toString("latin1") };
  try {
    const result = getTarCommitId(new Uint8Array(archive));
    return { native, ours: { status: result.exitCode, out: result.output } };
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    return { native, ours: { status: e.exitCode, out: "" } };
  }
}

/**
 * A zip archive's records with every deflated member inflated: each field of the local
 * headers, data descriptors, central directory and end record, but the compressed sizes and
 * the offsets that follow from them.
 */
export function normalizeZip(zip: Buffer): unknown {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return { invalid: zip.toString("hex") };
  const entries = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirOffset = zip.readUInt32LE(eocd + 16);
  const commentLength = zip.readUInt16LE(eocd + 20);
  const records: unknown[] = [];
  let at = dirOffset;
  for (let n = 0; n < entries; n++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const local = zip.readUInt32LE(at + 42);
    const method = zip.readUInt16LE(at + 10);
    const flags = zip.readUInt16LE(at + 8);
    const csize = zip.readUInt32LE(at + 20);
    const lNameLength = zip.readUInt16LE(local + 26);
    const lExtraLength = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + lNameLength + lExtraLength;
    const data = zip.subarray(dataStart, dataStart + csize);
    const content = method === 8 ? inflateRawSync(data) : data;
    const localHeader = Buffer.from(zip.subarray(local, dataStart));
    if (!(flags & 8)) localHeader.writeUInt32LE(0, 18); // compressed size
    const dirRecord = Buffer.from(zip.subarray(at, at + 46 + nameLength + extraLength));
    dirRecord.writeUInt32LE(0, 20);
    dirRecord.writeUInt32LE(0, 42);
    records.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString("latin1"),
      local: localHeader.toString("hex"),
      dir: dirRecord.toString("hex"),
      content: content.toString("hex"),
      descriptor:
        flags & 8
          ? zip
              .subarray(dataStart + csize, dataStart + csize + 16)
              .toString("hex")
              .slice(0, 16)
          : undefined,
    });
    at += 46 + nameLength + extraLength;
  }
  return {
    records,
    entries,
    dirSize,
    comment: zip.subarray(eocd + 22, eocd + 22 + commentLength).toString("latin1"),
  };
}

/** A gzip member's header (as written) and its content inflated. */
export function normalizeTgz(tgz: Buffer): { header: string; content: string } {
  return { header: tgz.subarray(0, 10).toString("hex"), content: gunzipSync(tgz).toString("hex") };
}

/** git's `test-tool genrandom <seed> <size>`: the same bytes for a seed. */
export function genrandom(seed: string, size: number): Buffer {
  let next = 0;
  for (const c of Buffer.from(seed)) next = (next * 11 + c) >>> 0;
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    next = (Math.imul(next, 1103515245) + 12345) >>> 0;
    out[i] = (next >>> 16) & 0xff;
  }
  return out;
}
