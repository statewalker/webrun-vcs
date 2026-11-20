import { Git } from "@statewalker/vcs-commands";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import JSZip from "jszip";
import type { Output } from "./output";

export default async function gitDirectory(out: Output) {
  // Any FilesApi works: the Node filesystem, OPFS, S3, SQLite... Here, memory in this tab.
  const files = new MemFilesApi() as unknown as FilesApi;

  // `git init`: HEAD, config, objects/ and refs/ under .git, then a working copy over the folder.
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", create: true });
  await history.initialize();
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history });
  const git = Git.fromWorkingCopy(await worktrees.openCurrent());

  const write = (path: string, text: string) => files.write(path, [new TextEncoder().encode(text)]);

  await write("README.md", "# Made in a browser tab\n");
  await write("src/app.ts", 'console.log("hello from a tab");\n');
  await git.add().addFilepattern(".").call();
  await git.commit().setMessage("Initial commit").setAuthor("Ada", "ada@example.com").call();

  await write(
    "README.md",
    "# Made in a browser tab\n\nOpen it with git: git log, git status, git fsck.\n",
  );
  await git.add().addFilepattern(".").call();
  await git.commit().setMessage("Say how to open it").setAuthor("Ada", "ada@example.com").call();
  await git.tag().setName("v1.0").call();

  // What was written: a standard .git directory, file by file.
  out.log("$ find . -type f");
  const zip = new JSZip();
  for await (const entry of files.list("", { recursive: true })) {
    if (entry.kind !== "file") continue;
    const bytes = await readAll(files, entry.path);
    zip.file(entry.path.replace(/^\//, ""), bytes);
    out.log(`${entry.path.replace(/^\//, "").padEnd(58)} ${String(bytes.length).padStart(5)} B`);
  }

  out.log("");
  out.log("$ git log --oneline");
  for await (const c of await git.log().call()) out.log(`${c.id.slice(0, 7)} ${c.message.trim()}`);

  // The same bytes as a zip: unzip it and run real git in the folder.
  const bytes = await zip.generateAsync({ type: "uint8array" });
  out.download("repository.zip", bytes, "application/zip");
  out.log("");
  out.log(`repository.zip: ${bytes.length} bytes. Unzip it, then: git log --stat && git fsck`);
  git.close();
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of files.read(path)) parts.push(chunk);
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}
