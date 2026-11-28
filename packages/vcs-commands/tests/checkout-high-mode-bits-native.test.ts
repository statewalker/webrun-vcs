/**
 * statewalker/webrun-vcs#273: a FilesApi `write` keeps an existing file's setuid, setgid and
 * sticky bits, but git's checkout_entry unlinks a worktree file and creates it afresh, so a
 * checkout or `reset --hard` never carries those bits onto new content (a setuid-root binary
 * of a commit's bytes otherwise, when the checkout runs as root). Native git decides: the same
 * repository twice, the bits set in both, native git switching one and ours the other.
 */

import { chmodSync, cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, ResetMode } from "../src/index.js";
import { gitOk, openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let base = "";
let n = 0;

/** The bits set on the tracked files before the switch, each case in its own pair of twins. */
const cases: { name: string; run: number; data: number }[] = [
  { name: "setuid", run: 0o4755, data: 0o4644 },
  { name: "setgid", run: 0o2755, data: 0o2644 },
  { name: "sticky", run: 0o1755, data: 0o1644 },
];

const steps: { name: string; native: string[]; ours: (g: Git) => Promise<unknown> }[] = [
  {
    name: "checkout",
    native: ["checkout", "-q", "next"],
    ours: (g) => g.checkout().setName("next").call(),
  },
  {
    name: "reset --hard",
    native: ["reset", "-q", "--hard", "next"],
    ours: (g) => g.reset().setRef("next").setMode(ResetMode.HARD).call(),
  },
];

function state(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["run", "data"]) {
    const path = join(dir, name);
    out[name] = `${(statSync(path).mode & 0o7777).toString(8)} ${readFileSync(path, "utf8")}`;
  }
  return out;
}

describeGit("worktree writes never carry setuid, setgid or sticky bits (#273)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-high-bits-"));
    base = join(root, "base");
    gitOk(root, root, "init", "-q", "-b", "main", base);
    writeFileSync(join(base, "run"), "#!/bin/sh\necho one\n");
    chmodSync(join(base, "run"), 0o755);
    writeFileSync(join(base, "data"), "one\n");
    gitOk(root, base, "add", ".");
    gitOk(root, base, "commit", "-q", "-m", "one");
    gitOk(root, base, "checkout", "-q", "-b", "next");
    writeFileSync(join(base, "run"), "#!/bin/sh\necho two\n");
    writeFileSync(join(base, "data"), "two\n");
    gitOk(root, base, "commit", "-q", "-am", "two");
    gitOk(root, base, "checkout", "-q", "main");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  for (const step of steps) {
    for (const c of cases) {
      it(`${step.name} over ${c.name} files`, async () => {
        const twins = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
        n++;
        for (const dir of Object.values(twins)) {
          cpSync(base, dir, { recursive: true });
          chmodSync(join(dir, "run"), c.run);
          chmodSync(join(dir, "data"), c.data);
          gitOk(root, dir, "update-index", "-q", "--refresh");
        }
        gitOk(root, twins.native, ...step.native);
        await step.ours(await openOurs(twins.ours));
        expect(state(twins.ours)).toEqual(state(twins.native));
        expect(state(twins.native).run).toMatch(/^755 /);
      });
    }
  }
});
