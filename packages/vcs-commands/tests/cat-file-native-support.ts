/**
 * Test-only: native twins of `git cat-file`. Each twin runs `git cat-file <argv>` on a
 * repository and maps the same argv onto our CatFileCommand; stdout is compared as bytes,
 * with stderr and the exit status.
 */

import { spawnSync } from "node:child_process";

import type { CatFileCommand, Git } from "../src/index.js";
import { compatibilityOf, type Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

/** What one side printed. */
export interface ByteOutcome {
  status: number;
  stdout: Buffer;
  stderr: string;
}

/** `git cat-file <argv>` mapped onto our CatFileCommand (`input` as its stdin). */
export function catFileArgs(
  git: Git,
  argv: string[],
  input: string | Uint8Array | undefined,
  compatibility: "2.43" | "2.56",
): CatFileCommand {
  const command = git.catFile().setCompatibility(compatibility);
  const rest: string[] = [];
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const [opt, value] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (opt) {
      case "-t":
        command.setMode("type");
        break;
      case "-s":
        command.setMode("size");
        break;
      case "-e":
        command.setMode("exists");
        break;
      case "-p":
        command.setMode("pretty");
        break;
      case "--batch":
        command.setBatch("contents", value);
        break;
      case "--batch-check":
        command.setBatch("info", value);
        break;
      case "--batch-command":
        command.setBatch("command", value);
        break;
      case "--buffer":
        command.setBuffer(true);
        break;
      case "--no-buffer":
        command.setBuffer(false);
        break;
      case "-z":
        command.setNulInput(true);
        break;
      case "-Z":
        command.setNulTerminated(true);
        break;
      case "--batch-all-objects":
        command.setBatchAllObjects(true);
        break;
      case "--unordered":
        command.setUnordered(true);
        break;
      case "--use-mailmap":
      case "--mailmap":
        command.setUseMailmap(true);
        break;
      default:
        rest.push(arg);
    }
  }
  if (rest.length === 2) command.setType(rest[0] as string).setObject(rest[1] as string);
  else if (rest.length === 1) command.setObject(rest[0] as string);
  if (input !== undefined) command.setStdin(input);
  return command;
}

/** `git cat-file <argv>` in `dir`, native and ours (`input` on stdin). */
export async function catFileTwin(
  shell: Shell,
  dir: string,
  argv: string[],
  input?: string | Uint8Array,
  /** Opens ours (default: `openOurs(dir)`; alternates outside `dir` need a wider root) */
  open: () => Promise<Git> = () => openOurs(dir),
): Promise<{ native: ByteOutcome; ours: ByteOutcome }> {
  const r = spawnSync("git", ["cat-file", ...argv], {
    cwd: dir,
    env: { ...nativeGitEnv(shell.home), ...shell.dates() },
    input: input ?? "",
    maxBuffer: 1 << 28,
  });
  const native = {
    status: r.status ?? 1,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr?.toString() ?? "",
  };
  const git = await open();
  const out = await catFileArgs(git, argv, input, compatibilityOf(shell)).callOutput();
  const ours = { status: out.exitCode, stdout: Buffer.from(out.stdout), stderr: out.stderr };
  return { native, ours };
}
