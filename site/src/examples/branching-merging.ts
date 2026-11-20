import { Git } from "@statewalker/vcs-commands";
import { MergeStatus } from "@statewalker/vcs-commands/results";
import { createMemoryHistory, isSymbolicRef } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";
import type { Output } from "./output";

export default async function branchingMerging(out: Output) {
  const history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  const staging = createMemoryGitStaging();
  const checkout = createMemoryCheckout({ staging });
  const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
  const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = (path: string, text: string) => worktree.writeContent(path, encoder.encode(text));
  const read = async (path: string) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
    return decoder.decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
  };
  const commit = async (message: string) => {
    await git.add().addFilepattern(".").call();
    const c = await git.commit().setMessage(message).setAuthor("Ada", "ada@example.com").call();
    const head = await history.refs.get("HEAD");
    const branch = head && isSymbolicRef(head) ? head.target.replace("refs/heads/", "") : "HEAD";
    out.log(`[${branch} ${c.id.slice(0, 7)}] ${message}`);
  };

  // A shared starting point on main.
  await write("notes.md", "# Notes\n\n- first idea\n");
  await commit("Start the notes");

  // git checkout -b feature: work on a branch.
  await git.checkout().setName("feature").setCreateBranch(true).call();
  await write("feature.md", "A feature, built on its own branch.\n");
  await commit("Add the feature");

  // Back on main, a change to another file: the branches diverge.
  await git.checkout().setName("main").call();
  out.log(`on main, feature.md exists: ${await worktree.exists("feature.md")}`);
  await write("notes.md", "# Notes\n\n- first idea\n- second idea\n");
  await commit("Add a second idea");

  // git merge feature: a three-way merge creates a merge commit.
  const result = await git.merge().include("feature").setMessage("Merge branch 'feature'").call();
  out.log("");
  out.log(`$ git merge feature  →  ${result.status}`);
  if (result.status === MergeStatus.CONFLICTING) out.log(`conflicts: ${result.conflicts}`);

  // git log --graph, drawn from each commit's parents.
  out.log("");
  out.log("$ git log --oneline (with parents)");
  for await (const c of await git.log().call()) {
    const parents = c.parents.map((p) => p.slice(0, 7)).join(" + ") || "root";
    out.log(`* ${c.id.slice(0, 7)} ${c.message.trim().padEnd(26)} parents: ${parents}`);
  }

  out.log("");
  out.log("Both changes are in the merged tree:");
  out.log(`  notes.md   → ${(await read("notes.md")).trim().split("\n").at(-1)}`);
  out.log(`  feature.md → ${(await read("feature.md")).trim()}`);
  git.close();
}
