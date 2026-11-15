/**
 * Deltas written by encodeGitDelta are git's format: native git indexes a
 * pack carrying them (OFS and REF) and reads the objects back.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, oidOf } from "@statewalker/vcs-testing";
import { createGitDeltaIndex, encodeGitDelta } from "@statewalker/vcs-utils/diff";
import { afterAll, describe, expect, it } from "vitest";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 26 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function text(n: number, seed: number): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`line ${i} of file ${seed}: ${"x".repeat(i % 40)}`);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

describe("encodeGitDelta and native git", () => {
  it("git index-pack accepts OFS and REF deltas we encode, and cat-file reads the targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-interop-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "--bare"]);
    const base = text(2000, 1);
    const edited = new TextEncoder().encode(
      `${new TextDecoder().decode(base).replace("line 700 of", "LINE 700 OF")}appended\n`,
    );
    const edited2 = new TextEncoder().encode(
      new TextDecoder().decode(edited).replace("line 5 ", "l5 "),
    );
    const d1 = encodeGitDelta(createGitDeltaIndex(base), edited) as Uint8Array;
    const d2 = encodeGitDelta(createGitDeltaIndex(edited), edited2) as Uint8Array;
    expect(d1.length).toBeLessThan(base.length / 10);
    const pack = buildPack([
      { kind: 3, data: base },
      { kind: 6, baseIdx: 0, data: d1 }, // OFS_DELTA
      { kind: 7, baseOid: oidOf("blob", edited), data: d2 }, // REF_DELTA on the OFS one
    ]);
    const packPath = join(dir, "test.pack");
    writeFileSync(packPath, pack);
    git(dir, ["index-pack", "-o", join(dir, "test.idx"), packPath]);
    const listed = git(dir, ["verify-pack", "-v", join(dir, "test.idx")]).toString();
    for (const data of [base, edited, edited2]) expect(listed).toContain(oidOf("blob", data));
    // installed into the repository, the objects read back byte for byte
    execFileSync("git", ["index-pack", "--stdin"], { cwd: dir, env: GIT_ENV, input: pack });
    expect(git(dir, ["cat-file", "blob", oidOf("blob", edited2)])).toEqual(Buffer.from(edited2));
  });
});
