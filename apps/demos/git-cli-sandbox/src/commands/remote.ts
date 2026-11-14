/**
 * Remote commands - remote, fetch, pull, push
 */

import { MergeStatus } from "@statewalker/vcs-commands";
import { type ListedObject, listObjects, writePack } from "@statewalker/vcs-core";
import { push as transportPush } from "@statewalker/vcs-transport";
import {
  type CliContext,
  dim,
  error,
  fatal,
  info,
  requireRepository,
  shortId,
  success,
  warning,
} from "../shared.js";

/**
 * Run remote command
 */
export async function runRemote(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let verbose = false;
  let subcommand = "";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      if (!subcommand && ["add", "remove", "set-url"].includes(arg)) {
        subcommand = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  try {
    switch (subcommand) {
      case "add": {
        if (positional.length < 2) {
          fatal("usage: vcs-git remote add <name> <url>");
        }
        const [name, url] = positional;
        await ctx.git.remoteAdd().setName(name).setUri(url).call();
        console.log(success(`Added remote '${name}' -> ${url}`));
        break;
      }

      case "remove": {
        if (positional.length < 1) {
          fatal("usage: vcs-git remote remove <name>");
        }
        const name = positional[0];
        await ctx.git.remoteRemove().setRemoteName(name).call();
        console.log(success(`Removed remote '${name}'`));
        break;
      }

      case "set-url": {
        if (positional.length < 2) {
          fatal("usage: vcs-git remote set-url <name> <url>");
        }
        const [name, url] = positional;
        await ctx.git.remoteSetUrl().setRemoteName(name).setRemoteUri(url).call();
        console.log(success(`Updated remote '${name}' -> ${url}`));
        break;
      }

      default: {
        // List remotes
        const remotes = await ctx.git.remoteList().call();

        if (remotes.length === 0) {
          console.log(dim("No remotes configured"));
          return;
        }

        for (const remote of remotes) {
          if (verbose) {
            console.log(`${remote.name}\t${remote.urls[0] || ""} (fetch)`);
            console.log(`${remote.name}\t${remote.urls[0] || ""} (push)`);
          } else {
            console.log(remote.name);
          }
        }
      }
    }
  } finally {
    await ctx.history.close();
  }
}

/**
 * Run fetch command
 */
export async function runFetch(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let remoteName = "origin";
  let _all = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      _all = true;
    } else if (!arg.startsWith("-")) {
      remoteName = arg;
    }
  }

  try {
    console.log(info(`Fetching from '${remoteName}'...`));

    const cmd = ctx.git.fetch().setRemote(remoteName);

    const result = await cmd.call();

    // Store any received pack data
    if (result.bytesReceived > 0) {
      console.log(info(`Received ${result.bytesReceived} bytes`));
    }

    // Show updated refs
    if (result.trackingRefUpdates && result.trackingRefUpdates.length > 0) {
      for (const update of result.trackingRefUpdates) {
        const shortOld = update.oldObjectId ? shortId(update.oldObjectId) : "0000000";
        const shortNew = shortId(update.newObjectId);
        console.log(` ${shortOld}..${shortNew}  ${update.localRef}`);
      }
    }

    console.log(success("Fetch complete"));
  } finally {
    await ctx.history.close();
  }
}

/**
 * Run pull command
 */
export async function runPull(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let remoteName = "origin";
  let branchName: string | undefined;
  let rebase = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rebase" || arg === "-r") {
      rebase = true;
    } else if (!arg.startsWith("-")) {
      if (remoteName === "origin" && !branchName) {
        remoteName = arg;
      } else {
        branchName = arg;
      }
    }
  }

  // Get current branch if not specified
  if (!branchName) {
    branchName = await ctx.workingCopy.getCurrentBranch();
  }

  try {
    console.log(info(`Pulling from '${remoteName}'...`));

    const cmd = ctx.git.pull().setRemote(remoteName);

    if (branchName) {
      cmd.setRemoteBranchName(branchName);
    }

    if (rebase) {
      cmd.setRebase(true);
    }

    const result = await cmd.call();

    if (result.mergeResult) {
      const mergeStatus = result.mergeResult.status;
      if (mergeStatus === MergeStatus.ALREADY_UP_TO_DATE) {
        console.log("Already up to date.");
      } else if (mergeStatus === MergeStatus.FAST_FORWARD) {
        console.log("Fast-forward");
        console.log(success("Pull complete"));
      } else if (mergeStatus === MergeStatus.MERGED) {
        console.log(success("Pull complete (merge)"));
      } else if (mergeStatus === MergeStatus.CONFLICTING) {
        console.log(warning("Automatic merge failed; fix conflicts and commit."));
      }
    } else {
      console.log(success("Pull complete"));
    }
  } finally {
    await ctx.history.close();
  }
}

/**
 * The pack a push sends: what `wants` reach and the remote's refs do not, streamed
 */
async function* exportPack(
  ctx: CliContext,
  wants: Iterable<string>,
  exclude: Iterable<string>,
): AsyncGenerator<Uint8Array> {
  const listed: ListedObject[] = [];
  for await (const o of listObjects(ctx.objects, { wants, haves: exclude })) listed.push(o);
  yield* writePack(ctx.objects, listed, { deltaSearch: true });
}

/**
 * Run push command
 */
export async function runPush(args: string[]): Promise<void> {
  const ctx = await requireRepository();

  let remoteName = "origin";
  let branchName: string | undefined;
  let force = false;
  let _setUpstream = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-f" || arg === "--force") {
      force = true;
    } else if (arg === "-u" || arg === "--set-upstream") {
      _setUpstream = true;
    } else if (!arg.startsWith("-")) {
      if (remoteName === "origin" && !branchName) {
        remoteName = arg;
      } else {
        branchName = arg;
      }
    }
  }

  // Get current branch if not specified
  if (!branchName) {
    branchName = await ctx.workingCopy.getCurrentBranch();
  }

  if (!branchName) {
    await ctx.history.close();
    fatal("No branch specified and no current branch");
  }

  try {
    // Get remote URL
    const remotes = await ctx.git.remoteList().call();
    const remote = remotes.find((r) => r.name === remoteName);
    if (!remote || remote.urls.length === 0) {
      fatal(`Remote '${remoteName}' not found`);
    }

    const remoteUrl = remote.urls[0];
    console.log(info(`Pushing to '${remoteName}' (${remoteUrl})...`));

    // Get local ref
    const localRef = `refs/heads/${branchName}`;
    const localRefValue = await ctx.history.refs.resolve(localRef);
    if (!localRefValue || !localRefValue.objectId) {
      fatal(`Local branch '${branchName}' not found`);
    }

    const commitId = localRefValue.objectId;
    console.log(dim(`  Commit: ${shortId(commitId)}`));

    // Execute push
    const result = await transportPush({
      url: remoteUrl,
      refspecs: [`${localRef}:${localRef}`],
      force,
      getLocalRef: async (refName: string) => {
        const ref = await ctx.history.refs.resolve(refName);
        return ref?.objectId;
      },
      exportPack: (wants, exclude) => exportPack(ctx, wants, exclude),
      onProgressMessage: (msg) => {
        const trimmed = msg.trim();
        if (trimmed) {
          process.stdout.write(`\r${dim(trimmed)}`.padEnd(60));
        }
      },
    });

    process.stdout.write(`${"\r".padEnd(60)}\r`);

    if (result.ok) {
      console.log(` * [new branch]      ${branchName} -> ${branchName}`);
      console.log(success(`Push complete`));
      console.log(dim(`  Bytes sent: ${result.bytesSent}`));
      console.log(dim(`  Objects sent: ${result.objectCount}`));
    } else {
      console.log(error(`Push failed: ${result.unpackStatus}`));
      for (const [ref, status] of result.updates) {
        if (!status.ok) {
          console.log(error(`  ${ref}: ${status.message}`));
        }
      }
    }
  } finally {
    await ctx.history.close();
  }
}
