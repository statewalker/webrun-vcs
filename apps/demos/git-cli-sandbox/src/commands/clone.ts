/**
 * Clone command - Clone a repository via HTTP
 */

import { FileMode, type FilesApi, type History } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileStagingStore } from "@statewalker/vcs-store-files";
import {
  createRepositoryFacade,
  createTransportRefStore,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";
import { joinPath } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createDirFilesApi, dim, fatal, info, resolvePath, success } from "../shared.js";

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
async function extractTree(
  repository: History,
  files: FilesApi,
  treeId: string,
  dirPath: string,
): Promise<void> {
  const tree = await repository.trees.load(treeId);
  if (!tree) return;

  for await (const entry of tree) {
    const entryPath = joinPath(dirPath, entry.name);

    if (entry.mode === FileMode.TREE) {
      await files.mkdir(entryPath);
      await extractTree(repository, files, entry.id, entryPath);
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
      await files.write(entryPath, [content]);
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
  const absDir = resolvePath(process.cwd(), targetDir);
  const dirFiles = createDirFilesApi(absDir);

  // Check if directory exists and is not empty
  for await (const _entry of dirFiles.list("/")) {
    fatal(`destination path '${targetDir}' already exists and is not an empty directory.`);
  }

  console.log(info(`Cloning into '${targetDir}'...`));

  // Create target directory
  await dirFiles.mkdir("/");

  try {
    // Create repository structure
    const files = createNodeFilesApi({ rootDir: absDir });
    const gitDir = bare ? "." : ".git";

    const { history: repository } = await createGitFilesBackend({
      files,
      gitDir,
      create: true,
      defaultBranch: branch || "main",
    });
    await repository.initialize();

    // Clone: a fetch into the empty repository (the pack is stored as it arrives)
    const remoteName = "origin";
    const heads = branch ? `refs/heads/${branch}` : "refs/heads/*";
    const tracking = bare
      ? heads
      : branch
        ? `refs/remotes/${remoteName}/${branch}`
        : `refs/remotes/${remoteName}/*`;
    const result = await transportFetch({
      url,
      repository: createRepositoryFacade({ history: repository }),
      refStore: createTransportRefStore(repository.refs),
      refspecs: [`+${heads}:${tracking}`],
      tags: branch || depth ? "auto" : "all",
      depth,
      onProgress: (msg) => {
        if (msg) process.stdout.write(`\r${dim(msg)}`.padEnd(80));
      },
    });

    process.stdout.write(`${"\r".padEnd(80)}\r`);

    console.log(info(`remote: Enumerating objects: done.`));
    console.log(info(`Receiving objects: 100% (${result.packObjects})`));

    // Create local branch from remote tracking
    const defaultBranch = branch || result.defaultBranch?.replace(/^refs\/heads\//, "") || "main";
    const localRef = `refs/heads/${defaultBranch}`;
    if (!bare) {
      const trackingValue = await repository.refs.resolve(
        `refs/remotes/${remoteName}/${defaultBranch}`,
      );
      if (trackingValue?.objectId) {
        await repository.refs.set(localRef, trackingValue.objectId);
      }
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
          await extractTree(repository, files, commit.tree, "/");

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
      // Empty it through its own FilesApi (one rooted at "/" rejects every path).
      const dirFiles = createDirFilesApi(absDir);
      const names: string[] = [];
      for await (const entry of dirFiles.list("/")) names.push(entry.name);
      for (const name of names) await dirFiles.remove(name);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
