/**
 * Step 01: Understanding Loose Objects
 *
 * This step demonstrates how Git stores objects as individual files
 * in the .git/objects directory before garbage collection.
 *
 * Key concepts:
 * - Loose objects are stored as compressed files
 * - Files are named by their SHA-1 hash (first 2 chars = directory, rest = filename)
 * - Each object has a type (blob, tree, commit, tag) and content
 */

import { FileMode } from "@statewalker/vcs-core";
import { decompressBlock } from "@statewalker/vcs-utils";
import { readFile } from "@statewalker/vcs-utils/files";
import {
  cleanupRepo,
  countLooseObjects,
  createAuthor,
  createFileHistory,
  createFilesApi,
  GIT_DIR,
  log,
  logInfo,
  logSection,
  logSuccess,
  looseObjectPath,
  shortId,
  state,
  storeBlob,
} from "../shared/index.js";

export async function run(): Promise<void> {
  logSection("Step 01: Understanding Loose Objects");

  // Clean up and create fresh history
  await cleanupRepo();
  const files = createFilesApi();
  const history = await createFileHistory({
    files,
    gitDir: GIT_DIR,
    create: true,
    defaultBranch: "main",
  });

  state.history = history;

  log("Creating content to demonstrate loose object storage...\n");

  // Create some files
  const readmeContent = "# Internal Storage Example\n\nDemonstrating low-level Git storage.";
  const configContent = "version = 1\nformat = loose";

  // Store blobs (these become loose objects)
  const readmeId = await storeBlob(history, readmeContent);
  const configId = await storeBlob(history, configContent);

  state.objectIds.push(readmeId, configId);

  log("Created blobs:");
  logInfo("  README.md", shortId(readmeId));
  logInfo("  config.txt", shortId(configId));

  // Create tree (another loose object)
  const treeId = await history.trees.store([
    { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
    { mode: FileMode.REGULAR_FILE, name: "config.txt", id: configId },
  ]);
  state.objectIds.push(treeId);

  log("\nCreated tree:");
  logInfo("  Tree ID", shortId(treeId));

  // Create commit (another loose object)
  const author = createAuthor();
  const commitId = await history.commits.store({
    tree: treeId,
    parents: [],
    author,
    committer: author,
    message: "Initial commit\n\nAdded README and config files.",
  });
  state.objectIds.push(commitId);
  state.commits.push({ id: commitId, message: "Initial commit" });

  await history.refs.set("refs/heads/main", commitId);
  await history.refs.setSymbolic("HEAD", "refs/heads/main");

  log("\nCreated commit:");
  logInfo("  Commit ID", shortId(commitId));

  // Examine loose object storage
  log("\n--- Examining Loose Object Storage ---\n");

  const { count, objects } = await countLooseObjects();
  logInfo("Total loose objects", count);

  log("\nLoose object locations:");
  for (const objId of objects) {
    const prefix = objId.substring(0, 2);
    const suffix = objId.substring(2);
    log(`  .git/objects/${prefix}/${suffix}`);
  }

  // Read and decode a loose object to show its structure
  log("\n--- Loose Object Format ---\n");

  const blobPath = looseObjectPath(readmeId);

  try {
    const compressedData = await readFile(files, blobPath);
    const decompressed = await decompressBlock(compressedData);

    // Find null byte that separates header from content
    let nullIndex = 0;
    for (let i = 0; i < decompressed.length; i++) {
      if (decompressed[i] === 0) {
        nullIndex = i;
        break;
      }
    }

    const header = new TextDecoder().decode(decompressed.subarray(0, nullIndex));
    const content = new TextDecoder().decode(decompressed.subarray(nullIndex + 1));

    log(`Object ${shortId(readmeId)} structure:`);
    logInfo("  Compressed size", `${compressedData.length} bytes`);
    logInfo("  Decompressed size", `${decompressed.length} bytes`);
    logInfo("  Header", header);
    log(`  Content preview: "${content.substring(0, 50)}..."`);
  } catch (error) {
    log(`  Could not read loose object: ${error}`);
  }

  // Summary
  log("\n--- Key Takeaways ---\n");
  log("1. Each Git object is stored as a separate zlib-compressed file");
  log("2. The filename is the SHA-1 hash of the content");
  log("3. Object format: 'type size\\0content'");
  log("4. Loose objects are inefficient for many small objects");
  log("5. GC packs loose objects into pack files for efficiency");

  logSuccess("\nLoose object demonstration complete!");
}
