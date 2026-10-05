import { exec as execCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

/**
 * Check if git is available.
 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await exec("git --version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a git command.
 */
export async function execGit(
  cwd: string,
  args: string[],
  options?: { env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string }> {
  // Build command string with proper escaping
  const command = ["git", ...args].map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");

  const result = await exec(command, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options?.env },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Initialize a git repository.
 */
export async function initGitRepo(dir: string): Promise<void> {
  await execGit(dir, ["init"]);
  await execGit(dir, ["config", "user.email", "test@test.com"]);
  await execGit(dir, ["config", "user.name", "Test User"]);
}

/**
 * Create a commit in native git.
 */
export async function gitCommit(
  dir: string,
  message: string,
  files?: Record<string, string>,
): Promise<string> {
  // Create files
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    await execGit(dir, ["add", "."]);
  }

  // Commit
  await execGit(dir, ["commit", "--allow-empty", "-m", message]);

  // Get commit hash
  const { stdout } = await execGit(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Compare our implementation with native git.
 */
export async function compareWithGit(
  ourValue: unknown,
  gitCommand: string[],
  cwd: string,
): Promise<{ matches: boolean; gitOutput: string; ourOutput: string }> {
  const { stdout } = await execGit(cwd, gitCommand);
  const ourOutput = String(ourValue);
  return {
    matches: stdout.trim() === ourOutput.trim(),
    gitOutput: stdout.trim(),
    ourOutput: ourOutput.trim(),
  };
}

/**
 * Skip test if git is not available.
 */
export function skipIfNoGit(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (!(await isGitAvailable())) {
      console.log("Skipping: git not available");
      return;
    }
    await fn();
  };
}
