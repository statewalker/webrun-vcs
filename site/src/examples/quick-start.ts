import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";
import type { Output } from "./output";

export default async function quickStart(out: Output) {
  // History: the object store and the refs. HEAD points at an unborn `main`.
  const history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");

  // The working copy: an index (staging), a checkout and a worktree, all in memory.
  const staging = createMemoryGitStaging();
  const checkout = createMemoryCheckout({ staging });
  const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
  const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));

  const write = (path: string, text: string) =>
    worktree.writeContent(path, new TextEncoder().encode(text));

  // First commit: two files.
  await write("README.md", "# Hello\n");
  await write("src/index.ts", 'export const greeting = "hello";\n');
  await git.add().addFilepattern(".").call();
  const first = await git
    .commit()
    .setMessage("Initial commit")
    .setAuthor("Ada", "ada@example.com")
    .setCommitter("Ada", "ada@example.com")
    .call();
  out.log(`[main ${first.id.slice(0, 7)}] Initial commit`);

  // Change a file: status sees it, then a second commit.
  await write("README.md", "# Hello\n\nA repository that lives in this tab.\n");
  const status = await git.status().call();
  out.log(`modified: ${[...status.modified].join(", ")}`);
  await git.add().addFilepattern("README.md").call();
  const second = await git
    .commit()
    .setMessage("Describe the project")
    .setAuthor("Ada", "ada@example.com")
    .setCommitter("Ada", "ada@example.com")
    .call();
  out.log(`[main ${second.id.slice(0, 7)}] Describe the project`);

  // git log --oneline
  out.log("");
  out.log("$ git log --oneline");
  for await (const commit of await git.log().call()) {
    out.log(`${commit.id.slice(0, 7)} ${commit.message.trim()}`);
  }
  out.log("");
  out.log(`clean: ${(await git.status().call()).isClean()}`);
  git.close();
}
