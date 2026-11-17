/**
 * Step 6: Checkout Branches
 *
 * Demonstrates switching branches with checkout.
 */

import { isSymbolicRef } from "@statewalker/vcs-core";
import {
  addFileToStaging,
  getGit,
  printSection,
  printStep,
  resetState,
  shortId,
} from "../shared.js";

export async function step06CheckoutBranches(): Promise<void> {
  printStep(6, "Checkout Branches");

  await resetState();
  const { git, workingCopy, history } = await getGit();

  // Create initial state
  console.log("\n--- Setting up branches ---");

  await addFileToStaging(workingCopy, "README.md", "# Checkout Demo");
  await addFileToStaging(workingCopy, "main.ts", "// Main branch content");
  await git.commit().setMessage("Initial commit on main").call();
  console.log("  Created initial commit on main");

  // Create feature branch
  await git.branchCreate().setName("feature").call();
  console.log("  Created 'feature' branch");

  // Add commit on main
  await addFileToStaging(workingCopy, "main-only.ts", "// Only on main");
  await git.commit().setMessage("Add main-only file").call();
  console.log("  Added commit on main");

  // Show current state
  const currentHeadRef = await history.refs.get("HEAD");
  const currentHeadResolved = await history.refs.resolve("HEAD");
  const currentHeadTarget =
    currentHeadRef && isSymbolicRef(currentHeadRef) ? currentHeadRef.target : undefined;
  console.log(
    `\n  Current HEAD: ${currentHeadTarget} (${shortId(currentHeadResolved?.objectId || "")})`,
  );

  // Method 1: git.checkout() for branch switching
  console.log("\n--- Method 1: git.checkout() ---");
  console.log(`
  // Switch to existing branch
  await git.checkout().setName("feature").call();

  // Create and switch to new branch
  await git.checkout()
    .setName("new-feature")
    .setCreateBranch(true)
    .call();
  `);

  // Method 2: Low-level branch switching
  console.log("\n--- Method 2: Low-level switching ---");

  console.log("  Switching to 'feature' branch...");

  // Step 1: Update HEAD symbolic ref
  await history.refs.setSymbolic("HEAD", "refs/heads/feature");
  console.log("    Updated HEAD -> refs/heads/feature");

  // Step 2: Update staging to match branch
  const featureRef = await history.refs.resolve("refs/heads/feature");
  if (featureRef?.objectId) {
    const commit = await history.commits.load(featureRef.objectId);
    if (commit) {
      await workingCopy.checkout.staging.readTree(history.trees, commit.tree);
      console.log(`    Updated staging to tree ${shortId(commit.tree)}`);
    }
  }

  // Verify switch
  const newHeadRef = await history.refs.get("HEAD");
  const newHeadTarget = newHeadRef && isSymbolicRef(newHeadRef) ? newHeadRef.target : undefined;
  console.log(`\n  Now on: ${newHeadTarget}`);

  // Show staging contents
  console.log("\n  Staging area (feature branch):");
  for await (const entry of workingCopy.checkout.staging.entries()) {
    console.log(`    ${entry.path}`);
  }

  // Switch back to main
  console.log("\n--- Switching back to main ---");

  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  const mainRef = await history.refs.resolve("refs/heads/main");
  if (mainRef?.objectId) {
    const commit = await history.commits.load(mainRef.objectId);
    if (commit) {
      await workingCopy.checkout.staging.readTree(history.trees, commit.tree);
    }
  }

  console.log("  Staging area (main branch):");
  for await (const entry of workingCopy.checkout.staging.entries()) {
    console.log(`    ${entry.path}`);
  }

  // Explain what changes during checkout
  console.log("\n--- What happens during branch checkout ---");
  console.log(`
  1. HEAD is updated:
     - Points to new branch ref (symbolic)
     - Or directly to commit (detached)

  2. Staging area is updated:
     - Reads tree from target commit
     - Replaces current staging entries

  3. Working tree is updated:
     - Files are written to match staging
     - (In our in-memory demo, we don't have real files)

  Important:
     - Uncommitted changes may block checkout
     - Or may be carried forward if compatible
  `);

  // Create and checkout new branch
  console.log("\n--- Create and checkout new branch ---");

  // Using low-level API
  const currentMainRef = await history.refs.resolve("refs/heads/main");
  if (currentMainRef?.objectId) {
    // Create new branch at current commit
    await history.refs.set("refs/heads/develop", currentMainRef.objectId);
    console.log("  Created 'develop' branch");

    // Switch to it
    await history.refs.setSymbolic("HEAD", "refs/heads/develop");
    console.log("  Switched to 'develop'");
  }

  // List all branches
  console.log("\n  All branches:");
  const branches = await git.branchList().call();
  for (const branch of branches) {
    const isCurrent = branch.name === "refs/heads/develop";
    console.log(`    ${isCurrent ? "* " : "  "}${branch.name.replace("refs/heads/", "")}`);
  }

  console.log("\n--- Checkout API ---");
  console.log(`
  High-level:
    git.checkout()
      .setName(branchName)         // Branch to checkout
      .setCreateBranch(true)       // Create (-b; refused if it exists)
      // .setForceCreateBranch(true) // Create, or reset if it exists (-B)
      .setStartPoint(commitId)     // Starting point for new branch
      .call()

  Low-level:
    history.refs.setSymbolic("HEAD", "refs/heads/branch")
    workingCopy.checkout.staging.readTree(history.trees, treeId)
  `);

  console.log("\nStep 6 completed!");
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  printSection("Step 6: Checkout Branches");
  step06CheckoutBranches()
    .then(() => console.log("\nDone!"))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
