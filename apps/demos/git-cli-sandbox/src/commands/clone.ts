/**
 * Clone command - Clone a repository via HTTP
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileMode, type History, indexPack, writePackIndex } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileStagingStore } from "@statewalker/vcs-store-files";
import { clone as transportClone } from "@statewalker/vcs-transport";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { dim, fatal, info, success } from "../shared.js";

/**
 * Parse clone command arguments
 */
function parseArgs(args: string[]): {
  url: string;
  directory?: string;
  branch?: string;
  depth?: number;
  bare: boolean;
} {
  let url = "";
  let directory: string | undefined;
  let branch: string | undefined;
  let depth: number | undefined;
  let bare = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--branch" || arg === "-b") {
      branch = args[++i];
    } else if (arg === "--depth") {
      depth = parseInt(args[++i], 10);
    } else if (arg === "--bare") {
      bare = true;
    } else if (!arg.startsWith("-")) {
      if (!url) {
        url = arg;
      } else if (!directory) {
        directory = arg;
      }
    }
  }

  return { url, directory, branch, depth, bare };
}

/**
 * Extract repository name from URL
 */
function extractRepoName(url: string): string {
  // Remove trailing .git and slashes
  let name = url.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  // Get last path component
  name = name.split("/").pop() || "repository";
  return name;
}

/**
 * Convert Uint8Array to async iterable for files.write
 */
async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Concat multiple Uint8Arrays
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Gitlink mode for submodules
const GITLINK = 0o160000;

/**
 * Extract a tree to a directory
 */
async function extractTree(repository: History, treeId: string, dirPath: string): Promise<void> {
  const tree = await repository.trees.load(treeId);
  if (!tree) return;

  for await (const entry of tree) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.mode === FileMode.TREE) {
      await fs.mkdir(entryPath, { recursive: true });
      await extractTree(repository, entry.id, entryPath);
    } else if (entry.mode === GITLINK) {
    } else {
      const chunks: Uint8Array[] = [];
      const blob = await repository.blobs.load(entry.id);
      if (blob) {
        for await (const chunk of blob) {
          chunks.push(chunk);
        }
      }
      const content = concatBytes(...chunks);
      await fs.writeFile(entryPath, content);
    }
  }
}

/**
 * Run clone command
 */
export async function runClone(args: string[]): Promise<void> {
  const { url, directory, branch, depth, bare } = parseArgs(args);

  if (!url) {
    fatal("You must specify a repository to clone.");
  }

  // Determine target directory
  const targetDir = directory || extractRepoName(url);
  const absDir = path.resolve(process.cwd(), targetDir);

  // Check if directory exists and is not empty
  try {
    const entries = await fs.readdir(absDir);
    if (entries.length > 0) {
      fatal(`destination path '${targetDir}' already exists and is not an empty directory.`);
    }
  } catch {
    // Directory doesn't exist - good
  }

  console.log(info(`Cloning into '${targetDir}'...`));

  // Create target directory
  await fs.mkdir(absDir, { recursive: true });

  try {
    // Execute transport clone
    const cloneResult = await transportClone({
      url,
      branch,
      depth,
      bare,
      remoteName: "origin",
      onProgressMessage: (msg) => {
        const trimmed = msg.trim();
        if (trimmed) {
          process.stdout.write(`\r${dim(trimmed)}`.padEnd(80));
        }
      },
    });

    process.stdout.write(`${"\r".padEnd(80)}\r`);

    console.log(info(`remote: Enumerating objects: done.`));
    console.log(info(`remote: Total ${cloneResult.refs.size} refs.`));

    // Create repository structure
    const files = createNodeFilesApi({ rootDir: absDir });
    const gitDir = bare ? "." : ".git";

    const { history: repository } = await createGitFilesBackend({
      files,
      gitDir,
      create: true,
      defaultBranch: cloneResult.defaultBranch || "main",
    });
    await repository.initialize();

    // Store pack data
    if (cloneResult.packData.length > 0) {
      console.log(info(`Receiving objects: 100%`));

      const indexResult = await indexPack(cloneResult.packData);
      console.log(info(`Resolving deltas: ${indexResult.objectCount} objects`));

      // Write pack and index files
      const packChecksum = bytesToHex(indexResult.packChecksum);
      const packDir = `${gitDir}/objects/pack`;
      await files.mkdir(packDir);

      const packFileName = `pack-${packChecksum}.pack`;
      const idxFileName = `pack-${packChecksum}.idx`;
      const packPath = `${packDir}/${packFileName}`;
      const idxPath = `${packDir}/${idxFileName}`;

      // Write pack and index files (directly without temp files since atomic write isn't strictly required here)
      await files.write(packPath, toAsyncIterable(cloneResult.packData));

      const indexData = await writePackIndex(indexResult.entries, indexResult.packChecksum);
      await files.write(idxPath, toAsyncIterable(indexData));
    }

    // Set up refs
    const remoteName = "origin";
    for (const [refName, objectId] of cloneResult.refs) {
      await repository.refs.set(refName, bytesToHex(objectId));
    }

    // Create local branch from remote tracking
    const defaultBranch = cloneResult.defaultBranch || "main";
    const trackingRef = `refs/remotes/${remoteName}/${defaultBranch}`;
    const localRef = `refs/heads/${defaultBranch}`;

    const trackingValue = cloneResult.refs.get(trackingRef);
    if (trackingValue) {
      await repository.refs.set(localRef, bytesToHex(trackingValue));
    }

    // Set HEAD
    await repository.refs.setSymbolic("HEAD", localRef);

    // Store remote configuration (simplified - write to config file)
    const configContent = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = ${bare}
[remote "origin"]
\turl = ${url}
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "${defaultBranch}"]
\tremote = origin
\tmerge = refs/heads/${defaultBranch}
`;
    await files.write(`${gitDir}/config`, toAsyncIterable(new TextEncoder().encode(configContent)));

    // Checkout working tree and initialize index (if not bare)
    if (!bare) {
      const headRef = await repository.refs.resolve("HEAD");
      const headCommit = headRef?.objectId;
      if (headCommit) {
        const commit = await repository.commits.load(headCommit);
        if (commit) {
          await extractTree(repository, commit.tree, absDir);

          // Initialize index from HEAD tree
          const staging = new FileStagingStore(files, `${gitDir}/index`);
          await staging.readTree(repository.trees, commit.tree);
          await staging.write();

          console.log(info(`Checking out files: done.`));
        }
      }
    }

    await repository.close();

    console.log(success(`\nCloned repository to '${targetDir}'`));
    console.log(dim(`  Default branch: ${defaultBranch}`));
    console.log(dim(`  Remote URL: ${url}`));
  } catch (err) {
    // Clean up on failure
    try {
      await fs.rm(absDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
