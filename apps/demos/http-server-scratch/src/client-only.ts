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

import {
  FileMode,
  type FilesApi,
  indexPack,
  joinPath,
  writePackIndex,
} from "@statewalker/vcs-core";
import { clone, type PushObject, push } from "@statewalker/vcs-transport";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

import {
  atomicWriteFile,
  concatBytes,
  createAuthor,
  createFileHistory,
  ensureDirectory,
  ensureDirFiles,
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
      const { commitId } = await makeChanges(history, files);

      // Step 3: Push
      printStep(3, "Pushing changes");
      await pushChanges(history, url, commitId);
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

  // Perform clone
  const cloneResult = await clone({
    url,
    onProgressMessage: (msg) => {
      if (msg.trim()) {
        printInfo(`  ${msg.trim()}`);
      }
    },
  });

  printInfo(`Received ${cloneResult.bytesReceived} bytes`);
  printInfo(`Default branch: ${cloneResult.defaultBranch}`);
  printInfo(`Refs received: ${cloneResult.refs.size}`);

  // Create local repository
  const history = await createFileHistory({
    files,
    gitDir: ".git",
    create: true,
    defaultBranch: cloneResult.defaultBranch,
  });

  // Process pack data
  if (cloneResult.packData.length > 0) {
    printInfo("Processing pack data...");

    const indexResult = await indexPack(cloneResult.packData);
    printInfo(`Pack contains ${indexResult.objectCount} objects`);

    const packChecksum = bytesToHex(indexResult.packChecksum);
    const packDir = ".git/objects/pack";
    await ensureDirFiles(files, packDir);

    const packPath = `${packDir}/pack-${packChecksum}.pack`;
    const idxPath = `${packDir}/pack-${packChecksum}.idx`;

    await atomicWriteFile(files, packPath, cloneResult.packData);
    const indexData = await writePackIndex(indexResult.entries, indexResult.packChecksum);
    await atomicWriteFile(files, idxPath, indexData);
  }

  // Set up refs
  for (const [refName, objectId] of cloneResult.refs) {
    await history.refs.set(refName, bytesToHex(objectId));
  }

  // Set up local main branch
  const mainRef = cloneResult.refs.get(`refs/remotes/origin/${cloneResult.defaultBranch}`);
  if (mainRef) {
    await history.refs.set(`refs/heads/${cloneResult.defaultBranch}`, bytesToHex(mainRef));
  }

  await history.refs.setSymbolic("HEAD", `refs/heads/${cloneResult.defaultBranch}`);

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
async function pushChanges(history: FileHistory, url: string, commitId: string): Promise<void> {
  printInfo(`Pushing to: ${url}`);

  // Get current branch
  const headRef = await history.refs.get("HEAD");
  if (!headRef || !("target" in headRef) || !headRef.target) {
    throw new Error("HEAD is not on a branch");
  }

  const branchName = headRef.target.replace("refs/heads/", "");
  const refspec = `refs/heads/${branchName}:refs/heads/${branchName}`;

  printInfo(`Pushing branch: ${branchName}`);

  // Collect objects to push
  const objects = await collectObjectsForPush(history, commitId);
  printInfo(`Objects to push: ${objects.length}`);

  // Push
  const result = await push({
    url,
    refspecs: [refspec],
    force: true,
    getLocalRef: async (refName: string) => {
      const ref = await history.refs.resolve(refName);
      return ref?.objectId;
    },
    getObjectsToPush: async function* () {
      for (const obj of objects) {
        yield obj;
      }
    },
    onProgressMessage: (msg) => {
      if (msg.trim()) {
        printInfo(`  ${msg.trim()}`);
      }
    },
  });

  if (result.ok) {
    printSuccess("Push successful!");
    printInfo(`Bytes sent: ${result.bytesSent}`);
  } else {
    throw new Error(`Push failed: ${result.unpackStatus}`);
  }
}

/**
 * Collect objects needed for push.
 */
async function collectObjectsForPush(
  history: FileHistory,
  commitId: string,
): Promise<PushObject[]> {
  const objects: PushObject[] = [];
  const seen = new Set<string>();

  const typeStringToCode: Record<string, number> = {
    commit: 1,
    tree: 2,
    blob: 3,
    tag: 4,
  };

  async function collectObject(id: string): Promise<void> {
    if (seen.has(id)) return;
    seen.add(id);

    const obj = await history.objects.get(id);
    if (!obj) throw new Error(`Object not found: ${id}`);
    const typeCode = typeStringToCode[obj.type];

    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.content) {
      chunks.push(chunk);
    }
    const content = concatBytes(...chunks);

    objects.push({ id, type: typeCode, content });
  }

  async function collectTree(treeId: string): Promise<void> {
    await collectObject(treeId);

    const entries = await history.trees.load(treeId);
    if (entries) {
      for await (const entry of entries) {
        if (entry.mode === FileMode.TREE) {
          await collectTree(entry.id);
        } else {
          await collectObject(entry.id);
        }
      }
    }
  }

  await collectObject(commitId);

  const commit = await history.commits.load(commitId);
  if (commit) {
    await collectTree(commit.tree);
  }

  return objects;
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
