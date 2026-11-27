/**
 * `git mktag` against native git (builtin/mktag.c over fsck.c's `fsck_tag_standalone`): every
 * tag input of t3800-mktag.sh read by native git in one copy of a fixture and by ours in
 * another, strict and `--no-strict`, with `fsck.<msg-id>` config; the exit status, stdout and
 * stderr must be equal, and a tag ours writes must be the object native git wrote.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MktagFailedError } from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let native: string;
let ours: string;
let head: string;
let headParent: string;
let tree: string;
let blob: string;
let compatibility: "2.43" | "2.56";

function run(cwd: string, args: string[], input: string) {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function oursMktag(input: string, strict: boolean) {
  const git = await openOurs(ours);
  const cmd = git.mktag().setInput(input).setCompatibility(compatibility);
  if (!strict) cmd.setStrict(false);
  try {
    const r = await cmd.call();
    return { status: 0, stdout: `${r.id}\n`, stderr: r.messages.map((w) => `${w}\n`).join("") };
  } catch (e) {
    if (!(e instanceof MktagFailedError)) throw e;
    return { status: e.exitCode, stdout: "", stderr: `${e.message}\n` };
  }
}

async function compare(input: string, strict = true, config: string[] = []) {
  const args = strict ? ["mktag"] : ["mktag", "--no-strict"];
  const keys = config.map((pair) => pair.slice(0, pair.indexOf("=")));
  for (const dir of [native, ours]) {
    for (const pair of config) gitOk(root, dir, "config", ...pair.split("=", 2));
  }
  let expected: ReturnType<typeof run>;
  try {
    expected = run(native, args, input);
    const actual = await oursMktag(input, strict);
    expect(actual).toEqual(expected);
  } finally {
    for (const dir of [native, ours])
      for (const key of keys) gitOk(root, dir, "config", "--unset", key);
  }
  if (expected.status === 0) {
    // the object ours wrote is native git's
    const id = expected.stdout.trim();
    expect(gitOk(root, ours, "cat-file", "-t", id).trim()).toBe("tag");
  }
  return expected;
}

/** check_verify_failure: strict fails; with `--no-strict` it passes or fails as native git. */
async function failure(input: string) {
  expect((await compare(input)).status).not.toBe(0);
  await compare(input, false);
}

describeGit("git mktag against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mktag-native-"));
    const fixture = join(root, "fixture");
    gitOk(root, root, "init", "-q", "-b", "main", fixture);
    for (const name of ["A", "B"]) {
      put(fixture, `${name}.t`, `${name}\n`);
      gitOk(root, fixture, "add", ".");
      gitOk(root, fixture, "commit", "-q", "-m", name);
    }
    head = gitOk(root, fixture, "rev-parse", "HEAD").trim();
    headParent = gitOk(root, fixture, "rev-parse", "HEAD~").trim();
    tree = gitOk(root, fixture, "rev-parse", "HEAD^{tree}").trim();
    blob = gitOk(root, fixture, "rev-parse", "HEAD:B.t").trim();
    native = join(root, "native");
    ours = join(root, "ours");
    execFileSync("cp", ["-a", fixture, native]);
    execFileSync("cp", ["-a", fixture, ours]);
    const version = gitOk(root, root, "--version");
    compatibility = /git version 2\.(\d+)/.exec(version)?.[1] === "43" ? "2.43" : "2.56";
  });

  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t3800-mktag.sh: "basic usage"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: Tag object length check"', async () => {
    await failure("too short for a tag\n");
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"object\\" line label check"', async () => {
    await failure(`xxxxxx ${head}\ntype tag\ntag mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"object\\" line check"', async () => {
    const bad = head.replace(/[0-9a-f]/g, "z");
    await failure(`object ${bad}\ntype tag\ntag mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"type\\" line label check"', async () => {
    await failure(`object ${head}\nxxxx tag\ntag mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"type\\" line eol check"', async () => {
    await failure(`object ${head}\ntype tagsssssssssssssssssssssssssssssss`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"tag\\" line label check #1"', async () => {
    await failure(`object ${head}\ntype tag\nxxx mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"tag\\" line label check #2"', async () => {
    await failure(`object ${head}\ntype taggggggggggggggggggggggggggggggg\ntag\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"type\\" line type-name length check"', async () => {
    await failure(`object ${head}\ntype taggggggggggggggggggggggggggggggg\ntag mytag\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: verify object (hash/type) check -- correct type, nonexisting object"', async () => {
    await failure(
      "object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\ntype tag\ntag mytag\ntagger . <> 0 +0000\n",
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: verify object (hash/type) check -- made-up type, valid object"', async () => {
    await failure(`object ${head}\ntype tagggg\ntag mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: verify object (hash/type) check -- mismatched type, valid object"', async () => {
    await failure(`object ${head}\ntype tree\ntag mytag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: verify tag-name check"', async () => {
    await failure(`object ${head}\ntype commit\ntag my\ttag\ntagger . <> 0 +0000\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"tagger\\" line label check #1"', async () => {
    await failure(`object ${head}\ntype commit\ntag mytag\n\nThis is filler\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: \\"tagger\\" line label check #2"', async () => {
    await failure(`object ${head}\ntype commit\ntag mytag\ntagger\n\nThis is filler\n`);
  });

  it('t3800-mktag.sh: "allow missing tag author name"', async () => {
    await compare(`object ${head}\ntype commit\ntag mytag\ntagger  <> 0 +0000\n\nThis is filler\n`);
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: disallow malformed tagger"', async () => {
    await failure(`object ${head}\ntype commit\ntag mytag\ntagger T A Gger <\n > 0 +0000\n\n`);
  });

  it('t3800-mktag.sh: "allow empty tag email"', async () => {
    await compare(`object ${head}\ntype commit\ntag mytag\ntagger T A Gger <> 0 +0000\n\n`);
  });

  it('t3800-mktag.sh: "allow spaces in tag email like fsck"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tag ger@example.com> 0 +0000\n\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: disallow missing tag timestamp"', async () => {
    await failure(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com>  \n\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: detect invalid tag timestamp1"', async () => {
    await failure(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> Tue Mar 25 15:47:44 2008\n\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: detect invalid tag timestamp2"', async () => {
    await failure(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 2008-03-31T12:20:15-0500\n\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: detect invalid tag timezone1"', async () => {
    await failure(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 GMT\n\n`,
    );
  });

  it('t3800-mktag.sh: "fail with [--[no-]strict]: detect invalid tag timezone2"', async () => {
    await failure(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 +  30\n\n`,
    );
  });

  it('t3800-mktag.sh: "allow invalid tag timezone"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -1430\n\n`,
    );
  });

  it('t3800-mktag.sh: "invalid header entry config & fsck"', async () => {
    const input = `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\nthis line should not be here\n\n`;
    await failure(input);
    for (const type of ["error", "warn", "ignore"]) {
      await compare(input, true, [`fsck.extraHeaderEntry=${type}`]);
      await compare(input, false, [`fsck.extraHeaderEntry=${type}`]);
    }
  });

  it('t3800-mktag.sh: "allow extra newlines at start of body"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\n\n\nthis line comes after an extra newline\n`,
    );
  });

  it('t3800-mktag.sh: "allow a blank line before an empty body (1)"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\n\n`,
    );
  });

  it('t3800-mktag.sh: "allow no blank line before an empty body (2)"', async () => {
    await compare(
      `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\n`,
    );
  });

  it("a gpgsig header after the tagger (2.5x skips it, 2.43 counts an extra header)", async () => {
    const input = `object ${head}\ntype commit\ntag mytag\ntagger T A Gger <tagger@example.com> 1206478233 -0500\ngpgsig -----BEGIN SSH SIGNATURE-----\n x\n -----END SSH SIGNATURE-----\n\nsigned\n`;
    await compare(input);
    await compare(input, false);
  });

  it('t3800-mktag.sh: "tag to a commit replaced by another commit"', async () => {
    for (const dir of [native, ours]) {
      gitOk(root, dir, "replace", headParent, head);
      gitOk(root, dir, "replace", "-f", tree, blob);
    }
    try {
      await compare(`object ${headParent}\ntype commit\ntag mytag\ntagger . <> 0 +0000\n`);
      // t3800-mktag.sh: "fail with [--[no-]strict]: verify object (hash/type) check -- mismatched type, valid object"
      await failure(`object ${tree}\ntype tree\ntag mytag\ntagger . <> 0 +0000\n`);
    } finally {
      for (const dir of [native, ours]) gitOk(root, dir, "replace", "-d", headParent, tree);
    }
  });
});
