/**
 * SHA-1 collision detection (sha1dc) against native git, with the SHAttered PDF of git's
 * t0013-sha1dc.sh (`tests/fixtures/t0013/shattered-1.pdf`, git's `t/t0013/shattered-1.pdf`).
 *
 * The raw hash of the PDF is what t0013 checks, through `test-tool sha1`, which only a git built
 * from source has: set `$GIT_TEST_TOOL` to its `t/helper/test-tool` (the git 3.0 oracle workflow
 * does). Without it ours is checked against t0013's own expectations alone. The PDF stored as a
 * blob is no attack (the object header shifts the colliding blocks off their alignment): native
 * git and ours both store it and commit it under the same ids, with any git on `PATH`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import {
  createSha1,
  createSha1Unsafe,
  Sha1CollisionError,
  sha1Of,
} from "@statewalker/vcs-utils/hash/hasher";
import { computeObjectId } from "@statewalker/vcs-utils/pack";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git, native, plumbingEnv } from "./plumbing-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const PDF_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "t0013",
  "shattered-1.pdf",
);
const PDF = new Uint8Array(readFileSync(PDF_PATH));
const SHATTERED_ID = "38762cf7f55934b34d179ae6a4c80cadccbb7f0a";

/** git's `test-tool`, when one built with sha1dc is given (`test-tool sha1-is-sha1dc`). */
function testTool(): string | undefined {
  const tool = process.env.GIT_TEST_TOOL;
  if (!tool) return undefined;
  return spawnSync(tool, ["sha1-is-sha1dc"]).status === 0 ? tool : undefined;
}

/** What ours does as `test-tool sha1` (`git_SHA1DCFinal`): the id, or git's death. */
function oursSha1(hash: () => Uint8Array): { status: number; out: string; err: string } {
  try {
    return { status: 0, out: `${Buffer.from(hash()).toString("hex")}\n`, err: "" };
  } catch (error) {
    if (!(error instanceof Sha1CollisionError)) throw error;
    return { status: 128, out: "", err: `fatal: ${error.message}\n` };
  }
}

describe("t0013-sha1dc.sh", () => {
  it('t0013-sha1dc.sh: "test-sha1 detects shattered pdf"', () => {
    const ours = oursSha1(() => createSha1().update(PDF).digest());
    // t0013: test_must_fail, test_grep collision err, test_grep <id> err
    expect(ours.status).not.toBe(0);
    expect(ours.err).toContain("collision");
    expect(ours.err).toContain(SHATTERED_ID);
    const tool = testTool();
    if (tool) {
      const r = spawnSync(tool, ["sha1"], { input: PDF, encoding: "latin1" });
      expect({ status: r.status, out: r.stdout, err: r.stderr }).toEqual(ours);
    } else {
      expect(ours.err).toBe(
        `fatal: SHA-1 appears to be part of a collision attack: ${SHATTERED_ID}\n`,
      );
    }
  });

  it("detects the attack however the bytes are fed, and in one-shot hashes (t0013's input)", () => {
    for (const step of [1, 63, 64, 100, 4096]) {
      const ours = oursSha1(() => {
        const h = createSha1();
        for (let at = 0; at < PDF.length; at += step) h.update(PDF.subarray(at, at + step));
        return h.digest();
      });
      expect(ours.err).toContain(SHATTERED_ID);
    }
    expect(oursSha1(() => sha1Of(PDF.subarray(0, 10), PDF.subarray(10))).err).toContain(
      SHATTERED_ID,
    );
    expect(oursSha1(() => SHA1_OBJECT_FORMAT.hashObject(new Uint8Array(0), PDF)).err).toContain(
      SHATTERED_ID,
    );
  });

  it("the unsafe hash of checksums detects nothing (git's unsafe_init_fn without sha1dc)", () => {
    expect(Buffer.from(createSha1Unsafe().update(PDF).digest()).toString("hex")).toBe(SHATTERED_ID);
    expect(
      Buffer.from(SHA1_OBJECT_FORMAT.createUnsafeHasher().update(PDF).digest()).toString("hex"),
    ).toBe(SHATTERED_ID);
  });
});

describeGit("the SHAttered PDF as a blob, against native git (t0013's input)", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sha1dc-native-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const tool = testTool();
  it.skipIf(!tool)("test-tool sha1 of the raw PDF prefix: both die with the same id", () => {
    // the first 320 bytes hold the two colliding blocks: still an attack, another id
    const prefix = PDF.subarray(0, 320);
    const r = spawnSync(tool as string, ["sha1"], { input: prefix, encoding: "latin1" });
    const ours = oursSha1(() => createSha1().update(prefix).digest());
    expect({ status: r.status, out: r.stdout, err: r.stderr }).toEqual(ours);
    expect(ours.status).toBe(128);
  });

  it("hash-object, add and commit store it under native git's ids", async () => {
    const env = plumbingEnv(root);
    const theirs = join(root, "theirs");
    const ours = join(root, "ours");
    for (const dir of [theirs, ours]) {
      mkdirSync(dir, { recursive: true });
      git(root, dir, ["init", "-q", "-b", "main"]);
      copyFileSync(PDF_PATH, join(dir, "shattered-1.pdf"));
    }
    const nativeId = git(root, theirs, ["hash-object", "shattered-1.pdf"]).trim();
    expect(await computeObjectId("blob", PDF)).toBe(nativeId);
    git(root, theirs, ["add", "shattered-1.pdf"]);
    git(root, theirs, ["commit", "-q", "-m", "pdf"]);

    const files = createNodeFilesApi({ rootDir: ours });
    const environment = createNodeGitHostEnvironment({ env });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    const g = Git.fromWorkingCopy(await worktrees.openCurrent());
    await g.add().addFilepattern("shattered-1.pdf").call();
    await g.commit().setMessage("pdf").call();

    for (const rev of ["HEAD:shattered-1.pdf", "HEAD^{tree}", "HEAD"]) {
      expect(git(root, ours, ["rev-parse", rev])).toBe(git(root, theirs, ["rev-parse", rev]));
    }
    expect(git(root, ours, ["rev-parse", "HEAD:shattered-1.pdf"]).trim()).toBe(nativeId);
    expect(native(root, ours, ["fsck", "--strict"]).status).toBe(0);
  });
});
