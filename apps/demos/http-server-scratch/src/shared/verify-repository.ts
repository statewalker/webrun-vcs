/**
 * Repository verification through the VCS library.
 *
 * Replaces the native `git fsck`, `git log`, `git status`, `git branch` and
 * `git ls-tree` calls the demo used to make: the repository is opened with
 * `createGitFilesBackend()` (loose objects and packs, as git lays them out)
 * and read back through the library, so verification runs wherever FilesApi
 * does.
 */

import { FileMode, type FilesApi, type GitObjects, type History } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { collect } from "@statewalker/vcs-utils";

/** Gitlink (submodule) entries point to commits of another repository. */
const GITLINK = 0o160000;

/** A repository opened read-only for verification. */
export interface VerifiedRepository {
  history: History;
  objects: GitObjects;
  close(): Promise<void>;
}

/**
 * Open an existing repository with the library's git-compatible file backend.
 *
 * @param files FilesApi rooted at the repository (working tree, or the bare repository)
 * @param gitDir Path of the git directory inside `files` (".git", or "." for bare)
 */
export async function openRepositoryForVerification(
  files: FilesApi,
  gitDir: string,
): Promise<VerifiedRepository> {
  const { history, objects } = await createGitFilesBackend({ files, gitDir, create: false });
  await history.initialize();
  return { history, objects, close: () => history.close() };
}

/** Result of an integrity check (the library's counterpart of `git fsck --full`). */
export interface IntegrityReport {
  /** Number of reachable objects read and re-hashed */
  checked: number;
  /** Reachable objects per type */
  byType: Record<string, number>;
  /** Referenced objects that are not stored */
  missing: string[];
  /** Objects whose content could not be read or does not hash to their id */
  corrupt: Array<{ id: string; error: string }>;
}

/**
 * Walk every object reachable from the refs (and HEAD), read it with hash
 * verification, and report missing or corrupt objects.
 */
export async function checkIntegrity(repo: VerifiedRepository): Promise<IntegrityReport> {
  const { history, objects } = repo;
  const report: IntegrityReport = { checked: 0, byType: {}, missing: [], corrupt: [] };

  const queue: string[] = [];
  const head = await history.refs.resolve("HEAD");
  if (head?.objectId) queue.push(head.objectId);
  for await (const entry of history.refs.list()) {
    const resolved = await history.refs.resolve(entry.name);
    if (resolved?.objectId) queue.push(resolved.objectId);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);

    const obj = await objects.get(id, { verify: true });
    if (!obj) {
      report.missing.push(id);
      continue;
    }
    try {
      // Reading to the end re-hashes the content and throws on a mismatch.
      await collect(obj.content);
    } catch (error) {
      report.corrupt.push({ id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    report.checked++;
    report.byType[obj.type] = (report.byType[obj.type] ?? 0) + 1;

    if (obj.type === "commit") {
      const commit = await history.commits.load(id);
      if (commit) queue.push(commit.tree, ...commit.parents);
    } else if (obj.type === "tree") {
      const tree = await history.trees.load(id);
      if (tree) {
        for await (const entry of tree) {
          if (entry.mode !== GITLINK) queue.push(entry.id);
        }
      }
    } else if (obj.type === "tag") {
      const tag = await history.tags.load(id);
      if (tag) queue.push(tag.object);
    }
  }

  return report;
}

/** Format an integrity report as one line. */
export function formatIntegrityReport(report: IntegrityReport): string {
  const types = Object.entries(report.byType)
    .map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`)
    .join(", ");
  return `${report.checked} objects verified (${types || "none"})`;
}

/** Whether an integrity report found no problem. */
export function isIntact(report: IntegrityReport): boolean {
  return report.missing.length === 0 && report.corrupt.length === 0;
}

/** The library's counterpart of `git log -1 --format="%H %s" <ref>`. */
export async function describeCommit(
  history: History,
  ref: string,
): Promise<{ id: string; subject: string } | undefined> {
  const resolved = await history.refs.resolve(ref);
  if (!resolved?.objectId) return undefined;
  const commit = await history.commits.load(resolved.objectId);
  if (!commit) return undefined;
  const subject = commit.message.split("\n", 1)[0];
  return { id: resolved.objectId, subject };
}

/** The library's counterpart of `git branch`: local branch names. */
export async function listBranches(history: History): Promise<string[]> {
  const branches: string[] = [];
  for await (const entry of history.refs.list("refs/heads/")) {
    branches.push(entry.name.slice("refs/heads/".length));
  }
  return branches.sort();
}

/** The library's counterpart of `git ls-tree --name-only <ref>`. */
export async function listTreeNames(history: History, ref: string): Promise<string[]> {
  const resolved = await history.refs.resolve(ref);
  if (!resolved?.objectId) return [];
  const commit = await history.commits.load(resolved.objectId);
  if (!commit) return [];
  const tree = await history.trees.load(commit.tree);
  const names: string[] = [];
  if (tree) {
    for await (const entry of tree) names.push(entry.name);
  }
  return names;
}

/**
 * The library's counterpart of `git status --short` against HEAD, without the
 * index: compares the working tree files in `files` with the HEAD tree.
 * Returns lines like "M  path", "D  path" and "?? path".
 */
export async function worktreeStatus(
  history: History,
  files: FilesApi,
  gitDir = ".git",
): Promise<string[]> {
  const head = await history.refs.resolve("HEAD");
  if (!head?.objectId) return [];
  const commit = await history.commits.load(head.objectId);
  if (!commit) return [];

  const lines: string[] = [];
  const gitDirName = gitDir.replace(/^\/+/, "");

  async function compare(treeId: string, dir: string): Promise<void> {
    const tracked = new Set<string>();
    const tree = await history.trees.load(treeId);
    if (tree) {
      for await (const entry of tree) {
        tracked.add(entry.name);
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.mode === GITLINK) continue;
        if (entry.mode === FileMode.TREE) {
          await compare(entry.id, path);
          continue;
        }
        const stat = await files.stats(path);
        if (stat?.kind !== "file") {
          lines.push(`D  ${path}`);
          continue;
        }
        const blob = await history.blobs.load(entry.id);
        const expected = blob ? await collect(blob) : new Uint8Array(0);
        const actual = await collect(files.read(path));
        if (!sameBytes(expected, actual)) lines.push(`M  ${path}`);
      }
    }
    for await (const info of files.list(dir || "/")) {
      if (!dir && info.name === gitDirName) continue;
      if (!tracked.has(info.name)) {
        const path = dir ? `${dir}/${info.name}` : info.name;
        lines.push(`?? ${path}${info.kind === "directory" ? "/" : ""}`);
      }
    }
  }

  await compare(commit.tree, "");
  return lines;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
