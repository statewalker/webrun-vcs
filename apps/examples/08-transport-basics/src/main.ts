/**
 * Example 08: Transport Basics
 *
 * This example demonstrates Git transport operations:
 * - Listing remote refs (ls-remote)
 * - Cloning a repository
 * - Fetching updates
 *
 * These operations use the Git HTTP smart protocol to communicate
 * with remote Git servers like GitHub.
 */

import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  fetch,
  lsRemote,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";

// Use a small public repository for demonstration
const REPO_URL = "https://github.com/octocat/Hello-World.git";

/**
 * Demonstrate ls-remote operation.
 *
 * ls-remote shows all refs in a remote repository without
 * downloading any objects. Useful for checking what branches
 * and tags exist.
 */
async function demonstrateLsRemote(): Promise<void> {
  console.log("=== ls-remote: List Remote Refs ===\n");

  const refs = await lsRemote(REPO_URL);

  console.log(`Repository: ${REPO_URL}`);
  console.log(`Found ${refs.size} refs:\n`);

  // Group refs by type
  const heads: Array<[string, string]> = [];
  const tags: Array<[string, string]> = [];
  const other: Array<[string, string]> = [];

  for (const [name, id] of refs) {
    if (name.startsWith("refs/heads/")) {
      heads.push([name.replace("refs/heads/", ""), id]);
    } else if (name.startsWith("refs/tags/")) {
      tags.push([name.replace("refs/tags/", ""), id]);
    } else {
      other.push([name, id]);
    }
  }

  if (heads.length > 0) {
    console.log("Branches:");
    for (const [name, id] of heads) {
      console.log(`  ${name.padEnd(30)} ${id.slice(0, 8)}`);
    }
    console.log();
  }

  if (tags.length > 0) {
    console.log("Tags:");
    for (const [name, id] of tags) {
      console.log(`  ${name.padEnd(30)} ${id.slice(0, 8)}`);
    }
    console.log();
  }

  if (other.length > 0) {
    console.log("Other:");
    for (const [name, id] of other) {
      console.log(`  ${name.padEnd(30)} ${id.slice(0, 8)}`);
    }
    console.log();
  }
}

/**
 * Demonstrate checking if a remote is accessible.
 *
 * Uses lsRemote() wrapped in try/catch — a successful lsRemote
 * implies the remote exists and is accessible.
 */
async function demonstrateCheckRemote(): Promise<void> {
  console.log("=== Verify Remote Access ===\n");

  // Check the public repository
  console.log(`Checking: ${REPO_URL}`);
  try {
    const refs = await lsRemote(REPO_URL);
    console.log(`  Accessible: true`);
    console.log(`  Refs found: ${refs.size}`);
    console.log(`  Empty: ${refs.size === 0}`);
  } catch (error) {
    console.log(`  Accessible: false`);
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
  }
  console.log();

  // Check a non-existent repository
  const nonExistentUrl = "https://github.com/nonexistent-user-12345/nonexistent-repo.git";
  console.log(`Checking: ${nonExistentUrl}`);
  try {
    await lsRemote(nonExistentUrl);
    console.log(`  Accessible: true`);
  } catch (error) {
    console.log(`  Accessible: false`);
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
  }
  console.log();
}

/**
 * Demonstrate listing remote refs in detail.
 *
 * lsRemote returns a Map of ref names to hex OIDs, giving
 * a snapshot of all branches, tags, and special refs.
 */
async function demonstrateRefListing(): Promise<void> {
  console.log("=== Detailed Ref Listing ===\n");

  const refs = await lsRemote(REPO_URL);

  console.log(`Repository: ${REPO_URL}`);
  console.log(`Total refs: ${refs.size}\n`);

  // Show all refs with full names
  for (const [name, id] of refs) {
    console.log(`  ${name.padEnd(40)} ${id.slice(0, 8)}`);
  }
  console.log();
}

/** A local repository in memory: where the clone and the fetch store what they receive. */
interface LocalRepository {
  repository: RepositoryFacade;
  refStore: RefStore;
}

async function createLocalRepository(): Promise<LocalRepository> {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return {
    repository: createRepositoryFacade({ history }),
    refStore: createTransportRefStore(history.refs),
  };
}

/**
 * Demonstrate a clone: a fetch into an empty repository.
 *
 * Every branch lands under refs/remotes/origin/, tags under refs/tags/; the pack is
 * imported into the local object store as it arrives.
 */
async function demonstrateClone(local: LocalRepository): Promise<void> {
  console.log("=== clone: Download Repository ===\n");

  console.log(`Cloning: ${REPO_URL}`);
  console.log();

  const result = await fetch({
    url: REPO_URL,
    ...local,
    refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
    tags: "all",
    onProgress: (message) => {
      // Show raw server messages
      if (message) console.log(`  Server: ${message}`);
    },
  });

  console.log();
  console.log("Clone complete:");
  console.log(`  Protocol: v${result.protocolVersion}`);
  console.log(`  Default branch: ${result.defaultBranch}`);
  console.log(`  Objects received: ${result.packObjects}`);
  console.log(`  Pack size: ${formatBytes(result.packBytes)}`);
  console.log(`  Empty: ${result.isEmpty}`);
  console.log();

  console.log("Refs written:");
  for (const update of result.refUpdates) {
    console.log(`  ${update.summary.padEnd(18)} ${update.localRef}`);
  }
  console.log();
}

/**
 * Demonstrate an incremental fetch.
 *
 * The local refs are offered as "have" lines, so the server sends only what the clone
 * does not have yet (nothing, right after it).
 */
async function demonstrateFetch(local: LocalRepository): Promise<void> {
  console.log("=== fetch: Update from Remote ===\n");

  console.log(`Fetching from: ${REPO_URL}`);
  console.log("Using refspec: +refs/heads/*:refs/remotes/origin/*");
  console.log();

  const result = await fetch({
    url: REPO_URL,
    ...local,
    refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
  });

  console.log("Fetch complete:");
  console.log(`  Default branch: ${result.defaultBranch || "unknown"}`);
  console.log(`  Haves sent: ${result.stats.haves}`);
  console.log(`  Objects received: ${result.packObjects}`);
  console.log();

  for (const update of result.refUpdates) {
    console.log(`  ${update.summary.padEnd(18)} ${update.localRef}`);
  }
  console.log();
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Run a demonstration step with error handling.
 */
async function runStep(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    console.log(`[!] ${name} failed: ${error instanceof Error ? error.message : error}`);
    console.log("    (This may be a network or transport layer issue)\n");
    return false;
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║          Example 08: Transport Basics                          ║");
  console.log("║                                                                ║");
  console.log("║  Clone, fetch, and push operations using Git HTTP protocol    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  console.log("NOTE: This example requires network access to GitHub.\n");

  let successCount = 0;
  const totalSteps = 5;

  // 1. Check if repository is accessible
  if (await runStep("checkRemote", demonstrateCheckRemote)) successCount++;

  // 2. List remote refs
  if (await runStep("ls-remote", demonstrateLsRemote)) successCount++;

  // 3. Detailed ref listing
  if (await runStep("refListing", demonstrateRefListing)) successCount++;

  // 4. Clone the repository into memory
  const local = await createLocalRepository();
  if (await runStep("clone", () => demonstrateClone(local))) successCount++;

  // 5. Fetch updates into the same repository (incremental: haves from the local refs)
  if (await runStep("fetch", () => demonstrateFetch(local))) successCount++;

  console.log("═══════════════════════════════════════════════════════════════");
  if (successCount === totalSteps) {
    console.log("Example complete! All transport operations succeeded.");
  } else {
    console.log(`Example finished with ${successCount}/${totalSteps} operations successful.`);
    console.log("Some operations failed - this may indicate transport layer issues");
    console.log("or network connectivity problems.");
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Don't exit with error - the example demonstrates the API even if network fails
}

main();
