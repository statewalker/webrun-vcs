/**
 * HTTP Git Server Demo - Client Only Mode
 *
 * Demonstrates using VCS transport to interact with a Git HTTP server.
 * Works with both VCS-based servers and standard Git HTTP servers.
 *
 * Usage:
 *   pnpm client http://localhost:8080/repo.git          # Clone from URL
 *   pnpm client http://localhost:8080/repo.git --push   # Clone and push
 *
 * This demonstrates:
 * - Cloning via HTTP using VCS transport
 * - Making local changes with VCS
 * - Pushing changes back to the server
 */

import { FileMode, type FilesApi, joinPath } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  push,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

import {
  concatBytes,
  createAuthor,
  createFileHistory,
  ensureDirectory,
  exportPack,
  type FileHistory,
  getHead,
  printError,
  printInfo,
  printSection,
  printStep,
  printSuccess,
  resolvePath,
  shortId,
} from "./shared/index.js";

// Initialize compression

const textEncoder = new TextEncoder();

// Parse command line arguments
function parseArgs(): { url: string; shouldPush: boolean; localDir: string } {
  const args = process.argv.slice(2);
  let url = "";
  let shouldPush = false;
  let localDir = resolvePath(process.cwd(), "cloned-repo");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--push") {
      shouldPush = true;
    } else if (args[i] === "--dir" && args[i + 1]) {
      localDir = resolvePath(process.cwd(), args[i + 1]);
      i++;
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  return { url, shouldPush, localDir };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { url, shouldPush, localDir } = parseArgs();

  if (!url) {
    console.log("Usage: pnpm client <url> [--push] [--dir <path>]");
    console.log("");
    console.log("Examples:");
    console.log("  pnpm client http://localhost:8080/repo.git");
    console.log("  pnpm client http://localhost:8080/repo.git --push");
    console.log("  pnpm client http://github.com/user/repo.git --dir ./my-clone");
    process.exit(1);
  }

  printSection("HTTP Git Client Demo");
  console.log("Using VCS transport to interact with a Git HTTP server.\n");

  let history: FileHistory | null = null;

  try {
    // Step 1: Clone
    printStep(1, "Cloning repository");
    const files = createNodeFilesApi({ rootDir: localDir });
    history = await cloneRepository(url, localDir, files);

    if (shouldPush) {
      // Step 2: Make changes
      printStep(2, "Creating changes");
      await makeChanges(history, files);

      // Step 3: Push
      printStep(3, "Pushing changes");
      await pushChanges(history, url);
    }

    printSection("SUCCESS!");
    console.log(`\nRepository cloned to: ${localDir}`);
    if (shouldPush) {
      console.log("Changes pushed successfully!");
    }
  } catch (error) {
    printError(`Error: ${error instanceof Error ? error.message : error}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    if (history) {
      await history.close();
    }
  }
}

/**
 * Clone a repository using VCS transport.
 */
async function cloneRepository(
  url: string,
  localDir: string,
  files: FilesApi,
): Promise<FileHistory> {
  printInfo(`Cloning from: ${url}`);
  printInfo(`Destination: ${localDir}`);

  // Clean up and create directory
  await emptyDirectory(localDir);
  await ensureDirectory(files, ".git");

  // Create local repository
  const history = await createFileHistory({ files, gitDir: ".git", create: true });

  // Clone: a fetch into the empty repository (the pack is imported as it arrives)
  const result = await transportFetch({
    url,
    repository: createRepositoryFacade({ history }),
    refStore: createTransportRefStore(history.refs),
    refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
    tags: "all",
    onProgress: (msg) => {
      if (msg) printInfo(`  ${msg}`);
    },
  });

  const defaultBranch = (result.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, "");
  printInfo(`Received ${result.packBytes} bytes (${result.packObjects} objects)`);
  printInfo(`Default branch: ${defaultBranch}`);
  for (const update of result.refUpdates) printInfo(`  ${update.summary} ${update.localRef}`);

  // Set up local main branch
  const tracking = await history.refs.resolve(`refs/remotes/origin/${defaultBranch}`);
  if (tracking?.objectId) {
    await history.refs.set(`refs/heads/${defaultBranch}`, tracking.objectId);
  }

  await history.refs.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);

  // Checkout working tree
  await checkoutHead(history, files);

  printSuccess(`Repository cloned successfully`);

  return history;
}

/**
 * Checkout HEAD to working tree.
 */
async function checkoutHead(history: FileHistory, files: FilesApi): Promise<void> {
  const headCommit = await getHead(history);
  if (!headCommit) {
    printInfo("Empty repository - no checkout needed");
    return;
  }

  const commit = await history.commits.load(headCommit);
  if (!commit) {
    throw new Error(`Commit ${headCommit} not found`);
  }
  await extractTree(history, files, commit.tree, "/");
}

/**
 * Extract a tree to a directory.
 */
async function extractTree(
  history: FileHistory,
  files: FilesApi,
  treeId: string,
  dirPath: string,
): Promise<void> {
  const entries = await history.trees.load(treeId);
  if (!entries) {
    throw new Error(`Tree ${treeId} not found`);
  }

  for await (const entry of entries) {
    const entryPath = joinPath(dirPath, entry.name);

    if (entry.mode === FileMode.TREE) {
      await ensureDirectory(files, entryPath);
      await extractTree(history, files, entry.id, entryPath);
    } else {
      const content = await history.blobs.load(entry.id);
      if (!content) {
        throw new Error(`Blob ${entry.id} not found`);
      }

      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const data = concatBytes(...chunks);
      await files.write(entryPath, [data]);
    }
  }
}

/**
 * Make changes to the repository.
 */
async function makeChanges(
  history: FileHistory,
  files: FilesApi,
): Promise<{ newTreeId: string; commitId: string }> {
  const headCommit = await getHead(history);
  if (!headCommit) {
    throw new Error("Cannot push to empty repository");
  }

  const commit = await history.commits.load(headCommit);
  if (!commit) {
    throw new Error(`Commit ${headCommit} not found`);
  }

  // Get existing tree entries
  const existingEntries: Array<{ mode: number; name: string; id: string }> = [];
  const entries = await history.trees.load(commit.tree);
  if (entries) {
    for await (const entry of entries) {
      existingEntries.push({
        mode: entry.mode,
        name: entry.name,
        id: entry.id,
      });
    }
  }

  // Create a new file
  const newFileContent = `# Client Demo

This file was created by the VCS client demo.

Timestamp: ${new Date().toISOString()}
`;

  const newBlobId = await history.blobs.store([textEncoder.encode(newFileContent)]);
  printInfo(`Created blob: ${shortId(newBlobId)}`);

  // Create new tree
  const newEntries = [
    ...existingEntries.filter((e) => e.name !== "CLIENT-DEMO.md"),
    { mode: FileMode.REGULAR_FILE, name: "CLIENT-DEMO.md", id: newBlobId },
  ];

  const newTreeId = await history.trees.store(newEntries);
  printInfo(`Created tree: ${shortId(newTreeId)}`);

  // Write file to working directory
  await files.write("CLIENT-DEMO.md", [textEncoder.encode(newFileContent)]);

  // Create commit
  const author = createAuthor();
  const commitId = await history.commits.store({
    tree: newTreeId,
    parents: [headCommit],
    author,
    committer: author,
    message: "Add CLIENT-DEMO.md via VCS client",
  });
  printInfo(`Created commit: ${shortId(commitId)}`);

  // Update HEAD
  const headRef = await history.refs.get("HEAD");
  if (headRef && "target" in headRef && headRef.target) {
    await history.refs.set(headRef.target, commitId);
  }

  printSuccess("Changes created successfully");

  return { newTreeId, commitId };
}

/**
 * Push changes to remote.
 */
async function pushChanges(history: FileHistory, url: string): Promise<void> {
  printInfo(`Pushing to: ${url}`);

  // Get current branch
  const headRef = await history.refs.get("HEAD");
  if (!headRef || !("target" in headRef) || !headRef.target) {
    throw new Error("HEAD is not on a branch");
  }

  const branchName = headRef.target.replace("refs/heads/", "");
  const refspec = `refs/heads/${branchName}:refs/heads/${branchName}`;

  printInfo(`Pushing branch: ${branchName}`);

  // Push
  const result = await push({
    url,
    refspecs: [refspec],
    force: true,
    getLocalRef: async (refName: string) => {
      const ref = await history.refs.resolve(refName);
      return ref?.objectId;
    },
    // the objects the remote lacks, streamed as a pack (listObjects + writePack)
    exportPack: (wants, exclude, options) => exportPack(history.objects, wants, exclude, options),
    onProgressMessage: (msg) => {
      if (msg.trim()) {
        printInfo(`  ${msg.trim()}`);
      }
    },
  });

  if (result.ok) {
    printSuccess("Push successful!");
    printInfo(`Bytes sent: ${result.bytesSent}`);
    printInfo(`Objects sent: ${result.objectCount}`);
  } else {
    throw new Error(`Push failed: ${result.unpackStatus}`);
  }
}

// Run main
main();

/**
 * Remove everything in `dir` (a FilesApi rooted at "/" rejects every path, so
 * the directory's own FilesApi removes its entries instead of its parent's).
 */
async function emptyDirectory(dir: string): Promise<void> {
  const files = createNodeFilesApi({ rootDir: dir });
  const names: string[] = [];
  for await (const entry of files.list("/")) names.push(entry.name);
  for (const name of names) await files.remove(name);
}
