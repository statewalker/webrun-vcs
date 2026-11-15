/**
 * Step 8: Stash
 *
 * Demonstrates stash operations for saving work in progress.
 */

import { addFileToStaging, getGit, printSection, printStep, shortId } from "../shared.js";

export async function step08Stash(): Promise<void> {
  printStep(8, "Stash");

  const { git, workingCopy, history } = await getGit();

  // Ensure we have a commit
  const head = await history.refs.resolve("HEAD");
  if (!head?.objectId) {
    await addFileToStaging(workingCopy, "README.md", "# Project");
    await git.commit().setMessage("Initial commit").call();
  }

  console.log("\nStash operations allow you to save work in progress.");
  console.log("This is useful when you need to switch branches but aren't ready to commit.");

  // List stashes (should be empty initially)
  console.log("\nListing stashes with git.stashList()...");
  const stashes1 = await git.stashList().call();
  console.log(`  Current stashes: ${stashes1.length}`);

  // Create a stash
  console.log("\nCreating a stash with git.stashCreate()...");
  await addFileToStaging(workingCopy, "work-in-progress.ts", "// WIP code");
  // stash needs to know what to save: here the staged tree is both the stash's index and
  // its files (an in-memory working copy has no separate files)
  const stagedTree = () => workingCopy.checkout.staging.writeTree(history.trees);
  const stashCommit = await git
    .stashCreate()
    .setWorkingTreeProvider({
      getIndexTree: stagedTree,
      getWorkingTree: stagedTree,
      hasLocalChanges: async () => true,
      resetHard: async () => {},
    })
    .setMessage("WIP: feature work")
    .call();

  if (stashCommit) {
    console.log(`  Stash created: ${shortId(stashCommit)}`);
  } else {
    console.log("  Stash created (staging-only mode)");
  }

  // List stashes again
  console.log("\nListing stashes after create...");
  const stashes2 = await git.stashList().call();
  console.log(`  Current stashes: ${stashes2.length}`);

  for (const stash of stashes2) {
    console.log(`    stash@{${stash.index}}: ${shortId(stash.commitId)}`);
  }

  // Stash operations summary
  console.log("\nStash commands available:");
  console.log("  git.stashCreate()  - Save work in progress");
  console.log("  git.stashList()    - List all stashes");
  console.log("  git.stashApply()   - Apply a stash");
  console.log("  git.stashDrop()    - Remove a stash");
  console.log("  git.stashPop()     - Apply and remove a stash");

  console.log("\nStep 8 completed!");
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  printSection("Step 8: Stash");
  step08Stash()
    .then(() => console.log("\nDone!"))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
