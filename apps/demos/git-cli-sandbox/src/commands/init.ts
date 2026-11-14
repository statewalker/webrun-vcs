/**
 * Init command - Create a new Git repository
 */

import { joinPath } from "@statewalker/vcs-utils/files";
import { createDirFilesApi, fatal, info, initRepository, resolvePath, success } from "../shared.js";

/**
 * Parse init command arguments
 */
function parseArgs(args: string[]): { directory: string; bare: boolean } {
  let directory = ".";
  let bare = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bare") {
      bare = true;
    } else if (!arg.startsWith("-")) {
      directory = arg;
    }
  }

  return { directory, bare };
}

/**
 * Run init command
 */
export async function runInit(args: string[]): Promise<void> {
  const { directory, bare } = parseArgs(args);

  const absDir = resolvePath(process.cwd(), directory);
  const dirFiles = createDirFilesApi(absDir);

  // Create directory if it doesn't exist
  await dirFiles.mkdir("/");

  // Check if already a repository
  const gitDir = joinPath(absDir, bare ? "." : ".git");
  if (await dirFiles.exists(".git")) {
    fatal(`Reinitialized existing Git repository in ${gitDir}/`);
  }

  const ctx = await initRepository(absDir, { bare });

  if (bare) {
    console.log(success(`Initialized empty Git repository in ${absDir}/`));
  } else {
    console.log(success(`Initialized empty Git repository in ${gitDir}/`));
  }

  // Show hint for first-time users
  console.log(info("\nNext steps:"));
  console.log("  Create files and add them with: vcs-git add <file>");
  console.log('  Commit changes with: vcs-git commit -m "Initial commit"');

  await ctx.history.close();
}
