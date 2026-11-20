/**
 * packed-refs as native git writes it (packed-backend.c write_with_updates): the
 * `# pack-refs with: peeled fully-peeled sorted ` header and a `^<id>` line after each
 * annotated tag (a tag of a tag peeled to the commit), byte for byte, after `pack-refs
 * --all`, a deletion of a packed branch, and a rewrite of a packed-refs an older writer left
 * with the "sorted" trait only (copied as read, as git 2.5x does).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** main and topic, a lightweight tag, an annotated tag and a tag of that tag, all loose. */
function repo(): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["branch", "topic"]);
  git(dir, ["branch", "gone"]);
  git(dir, ["tag", "light"]);
  git(dir, ["tag", "-a", "-m", "annotated", "v1"]);
  git(dir, ["tag", "-a", "-m", "nested", "v1-nested", "v1"]);
  return dir;
}

/** Two copies of `dir`: native's and ours. */
function twins(dir: string): [string, string] {
  const copies = ["native", "ours"].map((suffix) => {
    const copy = `${dir}-${suffix}`;
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    return copy;
  });
  return copies as [string, string];
}

const packedRefs = (dir: string) => readFileSync(join(dir, ".git/packed-refs"), "latin1");

async function ours(dir: string): Promise<Git> {
  return openOurs(dir);
}

describeGit("packed-refs: written as native git writes it", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "packed-refs-native-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pack-refs --all: git's header and the peel lines of annotated tags", async () => {
    const [theirs, mine] = twins(repo());
    git(theirs, ["pack-refs", "--all"]);
    await (await ours(mine)).packRefs().setAll(true).call();
    expect(packedRefs(mine)).toBe(packedRefs(theirs));
    expect(packedRefs(mine)).toMatch(/^# pack-refs with: peeled fully-peeled sorted \n/);
    expect(packedRefs(mine)).toMatch(/refs\/tags\/v1-nested\n\^[0-9a-f]{40}\n/);
  });

  it("branch -D of a packed branch: packed-refs rewritten as git rewrites it", async () => {
    const dir = repo();
    git(dir, ["pack-refs", "--all"]);
    git(dir, ["branch", "loose"]);
    const [theirs, mine] = twins(dir);
    git(theirs, ["branch", "-D", "gone"]);
    await (await ours(mine)).branchDelete().setBranchNames("gone").setForce(true).call();
    expect(packedRefs(mine)).toBe(packedRefs(theirs));
  });

  // git 2.5x copies the entries it read as they are (no peel line where the file had none),
  // under its full header; git 2.43 peels them again
  it.skipIf(!nativeIs25x)(
    "a packed-refs with the sorted trait only: its entries copied as read (2.5x)",
    async () => {
      const dir = repo();
      git(dir, ["pack-refs", "--all"]);
      // as an older writer left it: no peeled traits, no peel lines
      const legacy = packedRefs(dir)
        .split("\n")
        .filter((line) => !line.startsWith("^"))
        .join("\n")
        .replace(/^# pack-refs with: .*\n/, "# pack-refs with: sorted \n");
      writeFileSync(join(dir, ".git/packed-refs"), legacy, "latin1");
      const [theirs, mine] = twins(dir);
      git(theirs, ["update-ref", "-d", "refs/heads/gone"]);
      await (await ours(mine)).branchDelete().setBranchNames("gone").setForce(true).call();
      expect(packedRefs(mine)).toBe(packedRefs(theirs));
      expect(packedRefs(mine)).toMatch(/^# pack-refs with: peeled fully-peeled sorted \n/);
    },
  );
});
