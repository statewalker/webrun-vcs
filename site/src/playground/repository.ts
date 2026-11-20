// The playground's repository: an in-memory working copy behind a few verbs the page calls.
// Every verb is one or two porcelain commands; the page only renders what they return.
import { Git } from "@statewalker/vcs-commands";
import { MergeStatus } from "@statewalker/vcs-commands/results";
import { createMemoryHistory, type History } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
  type Worktree,
} from "@statewalker/vcs-working-tree";

export interface LogEntry {
  id: string;
  message: string;
  parents: string[];
  author: string;
}

export interface Snapshot {
  branch: string;
  branches: string[];
  files: string[];
  status: { path: string; state: string }[];
  log: LogEntry[];
}

const AUTHOR = { name: "You", email: "you@example.com" };

export class PlaygroundRepository {
  private constructor(
    readonly history: History,
    readonly worktree: Worktree,
    readonly git: Git,
  ) {}

  static async create(): Promise<PlaygroundRepository> {
    const history = createMemoryHistory();
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");
    const staging = createMemoryGitStaging();
    const checkout = createMemoryCheckout({ staging });
    const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
    const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));
    const repo = new PlaygroundRepository(history, worktree, git);
    await repo.write("README.md", "# Playground\n\nEdit me, then commit.\n");
    await repo.write("src/hello.ts", 'export const hello = "world";\n');
    await repo.commitAll("Initial commit");
    return repo;
  }

  async write(path: string, text: string): Promise<void> {
    await this.worktree.writeContent(path, new TextEncoder().encode(text));
  }

  async read(path: string): Promise<string> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.worktree.readContent(path)) parts.push(chunk);
    return new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    await this.worktree.remove(path);
  }

  /** git add -A && git commit -m <message> */
  async commitAll(message: string): Promise<string> {
    await this.git.add().addFilepattern(".").call();
    await this.git.add().addFilepattern(".").setUpdate(true).call();
    const commit = await this.git
      .commit()
      .setMessage(message)
      .setAuthor(AUTHOR.name, AUTHOR.email)
      .setCommitter(AUTHOR.name, AUTHOR.email)
      .call();
    return commit.id;
  }

  /** git checkout -b <name> */
  async createBranch(name: string): Promise<void> {
    await this.git.checkout().setName(name).setCreateBranch(true).call();
  }

  /** git checkout <name> */
  async switchTo(name: string): Promise<void> {
    await this.git.checkout().setName(name).call();
  }

  /** git merge <name>: the status, and the conflicting paths if any. */
  async merge(name: string): Promise<{ status: string; conflicts: string[] }> {
    const result = await this.git.merge().include(name).setMessage(`Merge branch '${name}'`).call();
    const conflicts =
      result.status === MergeStatus.CONFLICTING ? [...(result.conflicts ?? [])] : [];
    return { status: String(result.status), conflicts };
  }

  async snapshot(): Promise<Snapshot> {
    const head = await this.history.refs.get("HEAD");
    const target = head && "target" in head ? String(head.target) : "";
    const branch = target.replace(/^refs\/heads\//, "") || "(detached)";
    const branches = (await this.git.branchList().call()).map((ref) =>
      ref.name.replace(/^refs\/heads\//, ""),
    );
    const files: string[] = [];
    for await (const entry of this.worktree.walk()) if (!entry.isDirectory) files.push(entry.path);
    files.sort();

    const s = await this.git.status().call();
    const status: Snapshot["status"] = [];
    const add = (set: Iterable<string>, state: string) => {
      for (const path of set) status.push({ path, state });
    };
    add(s.added, "new, staged");
    add(s.changed, "changed, staged");
    add(s.removed, "deleted, staged");
    add(s.modified, "modified");
    add(s.missing, "deleted");
    add(s.untracked, "untracked");
    add(s.conflicting, "conflict");

    const log: LogEntry[] = [];
    try {
      for await (const c of await this.git.log().setMaxCount(30).call()) {
        log.push({
          id: c.id,
          message: c.message.trim(),
          parents: c.parents,
          author: c.author.name,
        });
      }
    } catch {
      // An unborn branch has no log.
    }
    return { branch, branches, files, status, log };
  }
}
