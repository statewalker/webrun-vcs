/**
 * `git format-rev` (builtin/name-rev.c's cmd_format_rev, experimental), native twins:
 * t6120-describe.sh's format-rev tests run by native git and by ours on the same repository,
 * git as the oracle (stdout bytes, stderr, exit status). Runs against the git on PATH and
 * `$GIT3`, each skipped when it has no `format-rev` (2.43).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type NativeGit,
  NativeShell,
  nativeGits,
  type Outcome,
  openOursAt,
  outcomeOf,
} from "./repo-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

for (const native of nativeGits()) describeFormatRev(native);

function describeFormatRev(native: NativeGit) {
  describe.runIf(process.platform !== "win32")(
    `git format-rev, native twins (${native.label})`,
    () => {
      let root: string;
      let shell: NativeShell;
      let repo: string;
      let available = false;

      beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "format-rev-native-"));
        shell = new NativeShell(native, root);
        // t6120-describe.sh: "setup: format-rev"
        repo = join(shell.home, "repo-format");
        shell.ok(shell.home, "init", "-q", "--object-format=sha1", repo);
        available = shell.hasFormatRev(repo);
        for (const name of [
          "first",
          "second",
          "third",
          "fourth",
          "fifth",
          "sixth",
          "seventh",
          "eighth",
        ])
          shell.commit(repo, name);
      });
      afterAll(async () => {
        await removeTempDir(root);
      }, CLEANUP_TIMEOUT);

      /** `git format-rev <argv>` with `input` on stdin, native and ours. */
      async function formatRev(argv: string[], input: string): Promise<Outcome> {
        const nativeOut = shell.run(repo, ["format-rev", ...argv], { input });
        const git = await openOursAt(shell.home, repo);
        const ours = await outcomeOf(() => {
          const command = git.formatRev().setInput(input);
          for (const arg of argv) {
            if (arg.startsWith("--format=")) command.setFormat(arg.slice(9));
            else if (arg.startsWith("--stdin-mode=")) command.setStdinMode(arg.slice(13));
            else if (arg.startsWith("--notes=")) command.addNotes(arg.slice(8));
            else if (arg === "--no-notes") command.clearNotes();
            else if (arg === "-z") command.setNul();
            else if (arg === "--null-input") command.setNullInput(true);
            else if (arg === "--no-null-input") command.setNullInput(false);
            else if (arg === "--null-output") command.setNullOutput(true);
            else if (arg === "--no-null-output") command.setNullOutput(false);
            else throw new Error(`unmapped ${arg}`);
          }
          return command.callOutput();
        });
        expect(ours).toEqual(nativeOut);
        return nativeOut;
      }

      const rev = (name: string) => shell.ok(repo, "rev-parse", name).trim();

      it("t6120-describe.sh: 'format-rev --stdin-mode=revs'", async ({ skip }) => {
        if (!available) skip();
        const out = await formatRev(["--stdin-mode=revs", "--format=%s"], "HEAD\nHEAD~\nHEAD~3\n");
        expect(out.stdout).toBe("eighth\nseventh\nfifth\n");
        await formatRev(["--stdin-mode=rev", "--format=format:%h %an"], "HEAD\nfirst");
      });

      it("t6120-describe.sh: 'format-rev --stdin-mode=text from rev-list same as log'", async ({
        skip,
      }) => {
        if (!available) skip();
        const list = shell.ok(repo, "rev-list", "HEAD");
        const out = await formatRev(["--stdin-mode=text", "--format=reference"], list);
        expect(out.stdout).toBe(shell.ok(repo, "log", "--format=reference"));
      });

      it("t6120-describe.sh: 'format-rev --stdin-mode=text with running text and tree oid'", async ({
        skip,
      }) => {
        if (!available) skip();
        const input =
          `We thought we fixed this in ${rev("fifth")}.\n` +
          `But look at this tree: ${rev("HEAD^{tree}")}.\n` +
          `Not an id: ${rev("HEAD")}0 nor x${rev("HEAD").slice(1)}\n`;
        await formatRev(["--stdin-mode=text", "--format=reference"], input);
        await formatRev(["--stdin-mode=text", "--format=tformat:%s"], input);
      });

      it("t6120-describe.sh: 'format-rev with %N (note)'", async ({ skip }) => {
        if (!available) skip();
        shell.ok(repo, "notes", "add", "-m", "Make a note");
        try {
          const out = await formatRev(
            ["--stdin-mode=revs", "--format=tformat:%N"],
            "HEAD\nHEAD~\n",
          );
          expect(out.stdout).toBe("Make a note\n\n\n");
        } finally {
          shell.ok(repo, "notes", "remove");
        }
      });

      it("t6120-describe.sh: 'format-rev --notes<ref> (custom notes ref)'", async ({ skip }) => {
        if (!available) skip();
        shell.ok(repo, "notes", "add", "-m", "default");
        shell.ok(repo, "notes", "--ref=word", "add", "-m", "custom");
        try {
          const one = await formatRev(
            ["--stdin-mode=revs", "--format=tformat:%N", "--notes=word"],
            "HEAD\n",
          );
          expect(one.stdout).toBe("custom\n\n");
          const all = await formatRev(
            ["--stdin-mode=revs", "--format=tformat:%N", "--notes=*"],
            "HEAD\n",
          );
          expect(all.stdout).toBe("default\ncustom\n\n");
          await formatRev(
            ["--stdin-mode=revs", "--format=tformat:%N", "--notes=word", "--no-notes"],
            "HEAD\n",
          );
        } finally {
          shell.ok(repo, "notes", "remove");
          shell.ok(repo, "notes", "--ref=word", "remove");
        }
      });

      it("t6120-describe.sh: 'format-rev --stdin-mode=revs on annotated tag peels to commit'", async ({
        skip,
      }) => {
        if (!available) skip();
        shell.ok(repo, "tag", "-a", "-m", "new version", "version");
        try {
          const out = await formatRev(["--stdin-mode=revs", "--format=%s"], "version\n");
          expect(out.stdout).toBe("eighth\n");
        } finally {
          shell.ok(repo, "tag", "-d", "version");
        }
      });

      it("t6120-describe.sh: 'format-rev --stdin-mode=revs lookup failures'", async ({ skip }) => {
        if (!available) skip();
        const tree = rev("eighth^{tree}");
        shell.ok(repo, "tag", "-a", "-mmessage", "tag-to-tree", tree);
        try {
          const out = await formatRev(
            ["--stdin-mode=revs", "--format=%s"],
            `not-valid\n${EMPTY_BLOB}\n${tree}\n${rev("tag-to-tree")}\n`,
          );
          expect(out.stdout).toBe("");
        } finally {
          shell.ok(repo, "tag", "-d", "tag-to-tree");
        }
      });

      it("t6120-describe.sh: 'format-rev -z --stdin-mode=text with object name lookup failures'", async ({
        skip,
      }) => {
        if (!available) skip();
        await formatRev(
          ["--stdin-mode=text", "--format=%s", "-z"],
          `${rev("HEAD")}\0${rev("HEAD^{tree}")}\0${EMPTY_BLOB}\0`,
        );
      });

      it("t6120-describe.sh: 'format-rev -z --stdin-mode=$mode'", async ({ skip }) => {
        if (!available) skip();
        const lf = shell.ok(repo, "rev-list", "HEAD");
        const nul = shell.ok(repo, "rev-list", "-z", "HEAD");
        for (const mode of ["revs", "text"]) {
          await formatRev([`--stdin-mode=${mode}`, "--format=%s", "-z"], nul);
          // t6120-describe.sh: "format-rev -z --no-null-input --no-null-output --stdin-mode=$mode"
          await formatRev(
            [`--stdin-mode=${mode}`, "--format=%s", "-z", "--no-null-input", "--no-null-output"],
            lf,
          );
          // t6120-describe.sh: "format-rev ---null-input --stdin-mode=$mode"
          await formatRev([`--stdin-mode=${mode}`, "--format=%s", "--null-input"], nul);
          // t6120-describe.sh: "format-rev --null-output --stdin-mode=$mode"
          await formatRev([`--stdin-mode=${mode}`, "--format=%s", "--null-output"], lf);
          // t6120-describe.sh: "format-rev -z --stdin-mode=$mode with multi-line output"
          await formatRev([`--stdin-mode=${mode}`, "--format=%s%n%h", "-z"], nul);
        }
      });

      it("format-rev's builtin formats print pretty_print_commit without the commit line", async ({
        skip,
      }) => {
        if (!available) skip();
        // a history with a merge, a body with a tab and a "From " line, and non-ASCII text
        const dir = join(shell.home, "repo-builtin");
        shell.ok(shell.home, "init", "-q", "--object-format=sha1", dir);
        shell.commit(dir, "base");
        shell.ok(dir, "checkout", "-q", "-b", "side");
        shell.commit(dir, "side");
        shell.ok(dir, "checkout", "-q", "-");
        shell.commit(dir, "main");
        shell.tick();
        shell.ok(dir, "merge", "-q", "--no-ff", "-m", "Merge side\n\n\tindented body", "side");
        shell.tick();
        shell.ok(
          dir,
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "Subject\n\nFrom here\nCaf\u00e9 body",
        );
        shell.tick();
        shell.ok(dir, "commit", "-q", "--allow-empty", "-m", "only a subject");
        // format-rev's fresh rev_info reads no log.* settings and its builtin formats map no
        // idents, whatever the configuration and .mailmap say
        shell.ok(dir, "config", "log.date", "relative");
        shell.ok(dir, "config", "log.mailmap", "true");
        shell.ok(dir, "config", "log.abbrevCommit", "true");
        writeFileSync(
          join(dir, ".mailmap"),
          `Mapped Name <mapped@example.com> <${shell.ok(dir, "log", "-1", "--format=%ae").trim()}>\n`,
        );
        const revs = "HEAD\nHEAD~1\nHEAD~2\nHEAD~2^2\n";
        const list = shell.ok(dir, "rev-list", "HEAD");
        const previous = repo;
        repo = dir;
        try {
          for (const format of [
            "oneline",
            "medium",
            "short",
            "full",
            "fuller",
            "raw",
            "email",
            "mboxrd",
          ]) {
            const out = await formatRev(["--stdin-mode=revs", `--format=${format}`], revs);
            expect(out.status).toBe(0);
            expect(out.stdout).not.toMatch(/^commit /m);
            await formatRev(["--stdin-mode=text", `--format=${format}`], list);
            await formatRev(
              ["--stdin-mode=revs", `--format=${format}`, "-z"],
              revs.replace(/\n/g, "\0"),
            );
          }
          // a pretty.<name> alias naming a builtin format
          shell.ok(dir, "config", "pretty.mine", "fuller");
          await formatRev(["--stdin-mode=revs", "--format=mine"], revs);
        } finally {
          repo = previous;
        }
      });

      it("format-rev's required options and bad modes", async ({ skip }) => {
        if (!available) skip();
        await formatRev(["--stdin-mode=revs"], "HEAD\n");
        await formatRev(["--format=%s"], "HEAD\n");
        await formatRev(["--stdin-mode=bogus", "--format=%s"], "HEAD\n");
      });
    },
  );
}
