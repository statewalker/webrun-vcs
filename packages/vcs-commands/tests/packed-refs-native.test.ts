/**
 * packed-refs as native git writes it (packed-backend.c write_with_updates): the
 * `# pack-refs with: peeled fully-peeled sorted ` header and a `^<id>` line after each
 * annotated tag (a tag of a tag peeled to the commit), byte for byte, after `pack-refs
 * --all`, a deletion of a packed branch, and a rewrite of a packed-refs an older writer left
 * with the "sorted" trait only (its tags peeled again, as git 2.43 does: 2.5x copies them as
 * read under a header claiming them peeled).
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
import { gitOut, putFile, testEnv } from "./status-native-support.js";

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

  // git 2.43 peels again the entries the file's traits leave unsettled; git 2.5x copies them
  // as read under its full header, which then claims a peel it never wrote (show-ref -d and
  // upload-pack stop showing `v1^{}`): ours peels them, as 2.43
  it("a packed-refs with the sorted trait only: its tags peeled again", async () => {
    const dir = repo();
    git(dir, ["pack-refs", "--all"]);
    const full = packedRefs(dir);
    writeFileSync(join(dir, ".git/packed-refs"), legacyOf(full), "latin1");
    const [theirs, mine] = twins(dir);
    git(theirs, ["update-ref", "-d", "refs/heads/gone"]);
    await (await ours(mine)).branchDelete().setBranchNames("gone").setForce(true).call();
    expect(packedRefs(mine)).toBe(withoutRef(full, "refs/heads/gone"));
    if (!nativeIs25x) expect(packedRefs(mine)).toBe(packedRefs(theirs));
  });
});

/** `text` as an older writer (our own earlier pack-refs) left it: "sorted" only, no peel lines. */
const legacyOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("^"))
    .join("\n")
    .replace(/^# pack-refs with: .*\n/, "# pack-refs with: sorted \n");

/** packed-refs `text` without the line of `name` (and its peel line). */
function withoutRef(text: string, name: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.endsWith(` ${name}`));
  if (at < 0) return text;
  lines.splice(at, lines[at + 1]?.startsWith("^") ? 2 : 1);
  return lines.join("\n");
}

const peeledTags = (dir: string) =>
  git(dir, ["show-ref", "-d", "--tags"])
    .split("\n")
    .filter((line) => line.endsWith("^{}"))
    .map((line) => line.slice(41));

describeGit("packed-refs: a rewrite never claims a peel it did not write", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "packed-refs-traits-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a sorted-only packed-refs rewritten by ours still peels its tags for native git", async () => {
    const dir = repo();
    git(dir, ["pack-refs", "--all"]);
    const before = peeledTags(dir);
    expect(before).toEqual(["refs/tags/v1^{}", "refs/tags/v1-nested^{}"]);
    writeFileSync(join(dir, ".git/packed-refs"), legacyOf(packedRefs(dir)), "latin1");
    await (await ours(dir)).branchDelete().setBranchNames("gone").setForce(true).call();
    expect(packedRefs(dir)).toMatch(/^# pack-refs with: peeled fully-peeled sorted \n/);
    expect(peeledTags(dir)).toEqual(before);
  });

  it("a peeled-only packed-refs (as JGit writes it): annotated tags outside refs/tags/ peeled", async () => {
    const dir = repo();
    const tag = git(dir, ["rev-parse", "refs/tags/v1"]).trim();
    const commit = git(dir, ["rev-parse", "refs/tags/v1^{}"]).trim();
    git(dir, ["update-ref", "refs/keep/v1", tag]);
    git(dir, ["pack-refs", "--all"]);
    // the `peeled` trait settles refs/tags/ only: refs/keep/v1 has no peel line
    const jgit = withoutRef(packedRefs(dir), "refs/keep/v1")
      .replace(/^# pack-refs with: .*\n/, "# pack-refs with: peeled \n")
      .replace(/\n(?=[0-9a-f]{40} refs\/tags\/)/, `\n${tag} refs/keep/v1\n`);
    writeFileSync(join(dir, ".git/packed-refs"), jgit, "latin1");
    await (await ours(dir)).branchDelete().setBranchNames("gone").setForce(true).call();
    expect(packedRefs(dir)).toMatch(/^# pack-refs with: peeled fully-peeled sorted \n/);
    expect(packedRefs(dir)).toContain(`${tag} refs/keep/v1\n^${commit}\n`);
    expect(git(dir, ["show-ref", "-d", "refs/keep/v1"])).toContain(`${commit} refs/keep/v1^{}`);
    expect(peeledTags(dir)).toEqual(["refs/tags/v1^{}", "refs/tags/v1-nested^{}"]);
  });

  it("a tag of a missing commit: peeled to the missing id, as git 2.43", async () => {
    const dir = repo();
    const ghost = "1234567890123456789012345678901234567890";
    const tag = execFileSync("git", ["hash-object", "-t", "tag", "-w", "--literally", "--stdin"], {
      cwd: dir,
      env: testEnv(root),
      input: `object ${ghost}\ntype commit\ntag ghost\ntagger T <t@example.com> 0 +0000\n\nghost\n`,
    })
      .toString()
      .trim();
    git(dir, ["pack-refs", "--all"]);
    const packed = packedRefs(dir).replace(
      /\n(?=[0-9a-f]{40} refs\/tags\/light\n)/,
      `\n${tag} refs/tags/ghost\n`,
    );
    writeFileSync(join(dir, ".git/packed-refs"), legacyOf(packed), "latin1");
    const [theirs, mine] = twins(dir);
    git(theirs, ["update-ref", "-d", "refs/heads/gone"]);
    await (await ours(mine)).branchDelete().setBranchNames("gone").setForce(true).call();
    expect(packedRefs(mine)).toContain(`${tag} refs/tags/ghost\n^${ghost}\n`);
    if (!nativeIs25x) expect(packedRefs(mine)).toBe(packedRefs(theirs));
  });
});
