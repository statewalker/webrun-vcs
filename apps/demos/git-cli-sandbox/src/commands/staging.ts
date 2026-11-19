/**
 * Staging commands - add, status, rm
 */

import { isSymbolicRef, type SymbolicRef } from "@statewalker/vcs-core";
import { bold, colorize, colors, dim, fatal, requireRepository, success } from "../shared.js";

/**
 * Run add command - Stage files
 */
export async function runAdd(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let update = false;
  const patterns: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-u" || arg === "--update") {
      update = true;
    } else if (!arg.startsWith("-")) {
      patterns.push(arg);
    }
  }

  if (patterns.length === 0) {
    fatal("Nothing specified, nothing added.");
  }

  try {
    const cmd = ctx.git.add();

    for (const pattern of patterns) {
      cmd.addFilepattern(pattern);
    }

    if (update) {
      cmd.setUpdate(true);
    }

    await cmd.call();
    console.log(success(`Staged files matching: ${patterns.join(", ")}`));
  } finally {
    await ctx.history.close();
  }
}

/**
 * Run status command - Show working tree status
 */
export async function runStatus(_args: string[]): Promise<void> {
  const ctx = await requireRepository();

  try {
    const status = await ctx.git.status().call();

    // Get current branch
    const headRef = await ctx.history.refs.resolve("HEAD");
    let branchName = "HEAD";
    if (headRef && isSymbolicRef(headRef)) {
      branchName = (headRef as SymbolicRef).target.replace("refs/heads/", "");
    }

    console.log(`On branch ${bold(branchName)}`);

    // Check if clean
    if (status.isClean()) {
      console.log(dim("\nnothing to commit, working tree clean"));
      return;
    }

    // Staged changes
    const staged: Array<{ file: string; type: string }> = [];
    for (const f of status.added) {
      staged.push({ file: f, type: "new file" });
    }
    for (const f of status.changed) {
      staged.push({ file: f, type: "modified" });
    }
    for (const f of status.removed) {
      staged.push({ file: f, type: "deleted" });
    }

    if (staged.length > 0) {
      console.log(`\n${bold("Changes to be committed:")}`);
      console.log(dim('  (use "vcs-git reset HEAD <file>..." to unstage)\n'));
      for (const { file, type } of staged) {
        console.log(colorize(`\t${type}:   ${file}`, colors.green));
      }
    }

    // Conflicts
    if (status.conflicting.size > 0) {
      console.log(`\n${bold("Unmerged paths:")}`);
      console.log(dim('  (fix conflicts and run "vcs-git add <file>...")\n'));
      for (const file of status.conflicting) {
        console.log(colorize(`\tboth modified:   ${file}`, colors.red));
      }
    }

    console.log();
  } finally {
    await ctx.history.close();
  }
}

/**
 * Run rm command - Remove files from index
 */
export async function runRm(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let cached = false;
  let recursive = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cached") {
      cached = true;
    } else if (arg === "-r") {
      recursive = true;
    } else if (!arg.startsWith("-")) {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    fatal("No files specified.");
  }

  try {
    const cmd = ctx.git.rm();

    for (const file of files) {
      cmd.addFilepattern(file);
    }

    if (cached) {
      cmd.setCached(true);
    }
    cmd.setRecursive(recursive);

    await cmd.call();
    console.log(success(`Removed: ${files.join(", ")}`));
  } finally {
    await ctx.history.close();
  }
}
