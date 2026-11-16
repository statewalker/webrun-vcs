/**
 * Content merges by the `merge` attribute and `merge.renormalize`, against native git: the
 * builtin `text`, `binary` and `union` drivers, `-merge`, `conflict-marker-size`,
 * `merge.default`, a driver of ours (a callback, where git runs `merge.<driver>.driver`),
 * and merges where one side only changed line endings (`merge.renormalize`, `-X
 * renormalize`). Twins built apart (`buildHistory`); merge and cherry-pick compared with
 * snapshot / normalizeState and merge-ort's output lines.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMergeDriver, type Git, installMergeDrivers, MergeStatus } from "../src/index.js";
import {
  git,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  ortLines,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

interface Run {
  op?: "merge" | "cherry-pick";
  /** `-X renormalize` */
  renormalize?: boolean;
  /** Set up ours (merge drivers) */
  setup?: (repo: Git) => void;
}

async function compare(history: History, run: Run = {}): Promise<void> {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildHistory(root, native, history);
  buildHistory(root, ours, history);
  const repo = await openOurs(ours);
  run.setup?.(repo);
  let output: string[];
  let expected: { stdout: string; stderr: string };
  if ((run.op ?? "merge") === "merge") {
    expected = git(
      root,
      native,
      "merge",
      ...(run.renormalize ? ["-X", "renormalize"] : []),
      "side",
    );
    const command = repo
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT);
    if (run.renormalize) command.setRenormalize(true);
    const result = await command.call();
    expect(result.status).not.toBe(MergeStatus.FAILED);
    output = result.output ?? [];
  } else {
    expected = git(root, native, "cherry-pick", "side");
    const result = await repo.cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
    output = result.output ?? [];
  }
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  expect(output.filter((l) => ortLines(l).length > 0)).toEqual(ortLines(expected.stdout));
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
}

/** Both sides edit line 5 of a.txt (a conflict for the text driver). */
const conflicting = (attributes: string, config?: Record<string, string>): History => ({
  base: { ".gitattributes": attributes, "a.txt": text(), "b.md": text() },
  main: { "a.txt": text({ 5: "main", 9: "m" }), "b.md": text({ 5: "main" }) },
  side: { "a.txt": text({ 5: "side", 1: "s" }), "b.md": text({ 5: "side" }) },
  ...(config ? { config } : {}),
});

const crlf = (s: string) => s.replaceAll("\n", "\r\n");

describeGit("merge attributes and renormalization against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-attrs-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const op of ["merge", "cherry-pick"] as const) {
    it(`${op}: merge=union keeps both sides' lines`, async () => {
      await compare(conflicting("*.txt merge=union\n"), { op });
    });

    it(`${op}: merge=binary and -merge keep ours, with git's binary warning`, async () => {
      await compare(conflicting("*.txt merge=binary\n"), { op });
      await compare(conflicting("*.txt -merge\n"), { op });
    });

    it(`${op}: merge (set) is the text driver; conflict-marker-size lengthens markers`, async () => {
      await compare(conflicting("*.txt merge\n*.md conflict-marker-size=12\n"), { op });
    });

    it(`${op}: merge.default names the driver of paths without the attribute`, async () => {
      await compare(conflicting("*.md text\n", { "merge.default": "union" }), { op });
    });
  }

  it("a registered driver (git's merge.<driver>.driver) merges its paths", async () => {
    // native git runs the command; ours the callback doing the same
    await compare(conflicting("*.txt merge=theirs\n", { "merge.theirs.driver": "cat %B > %A" }), {
      setup: (repo) =>
        installMergeDrivers(repo.workingCopy, {
          theirs: createMergeDriver(async ({ theirs }) => ({ content: theirs, conflict: false })),
        }),
    });
    await compare(conflicting("*.txt merge=fails\n", { "merge.fails.driver": "exit 1" }), {
      setup: (repo) =>
        installMergeDrivers(repo.workingCopy, {
          fails: createMergeDriver(async ({ ours }) => ({ content: ours, conflict: true })),
        }),
    });
  });

  const renormalized = (config?: Record<string, string>): History => ({
    base: { "a.txt": crlf(text()), "d.txt": crlf(text()) },
    // main declares the files text and stores them with LF
    main: { ".gitattributes": "*.txt text\n", "a.txt": text(), "d.txt": text() },
    // side edits one line (still CRLF) and deletes d.txt
    side: { "a.txt": crlf(text({ 3: "side" })), "d.txt": null },
    ...(config ? { config } : {}),
  });

  it("without renormalization a change of line endings conflicts", async () => {
    await compare(renormalized());
  });

  it("merge.renormalize: line endings alone are no change", async () => {
    await compare(renormalized({ "merge.renormalize": "true" }));
    await compare(renormalized({ "merge.renormalize": "true" }), { op: "cherry-pick" });
  });

  it("-X renormalize", async () => {
    await compare(renormalized(), { renormalize: true });
  });
});
