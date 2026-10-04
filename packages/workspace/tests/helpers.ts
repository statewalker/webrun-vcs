import { createHash } from "node:crypto";
import type { ContentStore } from "@statewalker/webrun-content-store";
import { createContentStore } from "@statewalker/webrun-content-store";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { memBlobStore } from "@statewalker/webrun-storage";
import type { ByteStream, FilesApi, GitRemote, Repository, WorkspaceEvent } from "../src/index.js";

/** SHA-256 hex over a byte stream — a plausible injected `hashContent`. */
export async function sha256(input: ByteStream): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of input) h.update(chunk);
  return h.digest("hex");
}

/** Build an in-memory tree from a { path: content } record. */
export function tree(files: Record<string, string | Uint8Array> = {}): MemFilesApi {
  return new MemFilesApi({ initialFiles: files });
}

/** Snapshot every file path + content hash (for correspondence / mutation checks). */
export async function fingerprint(files: FilesApi): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const info of files.list("/", { recursive: true })) {
    if (info.kind === "file") out[info.path] = await sha256(files.read(info.path));
  }
  return out;
}

/** A mem large-object store. */
export function memContentStore(): ContentStore {
  return createContentStore({
    chunks: memBlobStore(),
    manifests: memBlobStore(),
    hashContent: sha256,
  });
}

async function* one(bytes: Uint8Array): ByteStream {
  yield bytes;
}

/** Store bytes and return the object id. */
export async function putObject(store: ContentStore, text: string): Promise<string> {
  const d = await store.put(one(new TextEncoder().encode(text)));
  return d.id;
}

/** Drain a workflow into an array of events. */
export async function drain(events: AsyncIterable<WorkspaceEvent>): Promise<WorkspaceEvent[]> {
  const out: WorkspaceEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * A thin fake conforming to the structural {@link Repository} — spies commit /
 * checkout calls. `dirty` drives `hasChanges` and whether a commit `changed`.
 */
export class FakeRepository implements Repository {
  commits: string[] = [];
  commitCalls = 0;
  checkoutCalls: string[] = [];
  dirty = true;
  private n = 0;

  async manifest(): Promise<string> {
    return `wt-${this.commits.length}`;
  }
  async head(): Promise<string | undefined> {
    return this.commits.at(-1);
  }
  async hasChanges(): Promise<boolean> {
    return this.dirty;
  }
  async commit(_opts: { message?: string }): Promise<{ commit: string; changed: boolean }> {
    this.commitCalls++;
    if (!this.dirty) return { commit: this.commits.at(-1) ?? "empty", changed: false };
    const id = `commit-${++this.n}`;
    this.commits.push(id);
    this.dirty = false;
    return { commit: id, changed: true };
  }
  async checkout(commit: string): Promise<void> {
    this.checkoutCalls.push(commit);
  }
}

/**
 * A thin fake conforming to the structural {@link GitRemote} — spies pushes and
 * can be told to fail its next `failNext` pushes (to test resume).
 */
export class FakeGitRemote implements GitRemote {
  pushCalls: string[][] = [];
  pushed: string | undefined;
  failNext = 0;
  objects?: ContentStore;

  constructor(
    private repo: FakeRepository,
    objects?: ContentStore,
  ) {
    this.objects = objects;
  }

  async push(refspecs: string[]): Promise<{ commit: string }> {
    this.pushCalls.push(refspecs);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("push failed");
    }
    const commit = await this.repo.head();
    this.pushed = commit;
    return { commit: commit ?? "none" };
  }
}
