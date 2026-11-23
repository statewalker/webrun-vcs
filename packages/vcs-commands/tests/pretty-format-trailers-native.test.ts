/**
 * `%(trailers[:options])`, `%(describe[:options])`, `%S` and git 2.5x's `%(count)` and
 * `%(total)` against `git log -1 --format=<format>`: trailer blocks git finds (all
 * trailers, a git-generated one among other lines, continuation lines, comments, URLs,
 * configured separators and keys), the describe search over annotated, lightweight and
 * misnamed tags, and the source of the revision given. Each format is expanded by native
 * git and by formatCommitPretty, the bytes compared.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDescriber,
  formatCommitPretty,
  type PrettyFormatOptions,
  trailerConfigOf,
} from "../src/index.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;

const run = (dir: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("git", args, { cwd: dir, env: { ...nativeGitEnv(root), ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString("utf8");
};

/** git 2.5x expands `%(count)` and `%(total)` in log (2.43 keeps them as written). */
function hasCount(): boolean {
  const version = run(root, ["--version"]).match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 50);
}

const MESSAGES = [
  "Subject\n\nBody text.\n\nSigned-off-by: A U Thor <a@example.com>\nAcked-by: Bee <b@example.com>\n",
  "Folded\n\nbody\n\nKey: first\n  continued here\n\tand here\nOther-Key:   spaced value  \n",
  "Quarter\n\nfoo bar\nbaz qux\nSigned-off-by: A <a@example.com>\n",
  "Not trailers\n\nfoo bar\nbaz\nqux\nKey: x\n",
  "Cherry\n\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)\nsome text\nmore text\n",
  "Comments\n\nKey: v\n# a comment\nOther: w\n\n# trailing comment\n",
  "Scissors\n\nKey: v\n# ------------------------ >8 ------------------------\nNot: this\n",
  "Url\n\nhttp://example.com/x\nKey: v\n",
  "Key: title only\n",
  "Hash\n\nBug #42\nsign: someone\nS: short\nTicket: 7\n",
  "Spaces\n\nToken : value\n Key: indented\nKey:\n",
  "Two blocks\n\nKey: early\n\nmiddle paragraph\n\nLate: one\nLate: two\n",
  "Conflicts\n\nKey: v\n\nConflicts:\n\ta.txt\n",
  "Scissors junk\n\nKey: v\n# ------------------------ >8 ------------------------ junk\nmore text\n",
];

const TRAILER_FORMATS = [
  "%(trailers)",
  "%(trailers:only)",
  "%(trailers:unfold)",
  "%(trailers:only,unfold)",
  "%(trailers:key=Signed-off-by)",
  "%(trailers:key=signed-off-by:,valueonly)",
  "%(trailers:key=Key,key=Late,only=no)",
  "%(trailers:separator=%x2C )",
  "[%(trailers:keyonly)]",
  "%(trailers:key_value_separator=%x3D,separator=|)",
  "%(trailers:only=no,unfold=yes)",
  "%(trailers:only=false,separator=;)",
  "[%(trailers:valueonly,separator=%x2c)]",
  "%(trailers:bogus)|%(trailers:key)|%(trailers:only=maybe)",
  "x  %(trailers:only=0,separator=)",
];

describeGit("%(trailers), %(describe), %S, %(count) against git log --format, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pretty-trailers-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const [label, config] of [
    ["default config", {}],
    [
      "trailer.separators and keys, a comment string",
      {
        "trailer.separators": ":#",
        "trailer.sign.key": "Signed-off-by",
        "trailer.tick.key": "Ticket #",
        "core.commentChar": ";",
      },
    ],
  ] as const) {
    it(`trailers of every message, ${label}`, async () => {
      const dir = join(root, label.replace(/\W+/g, "-"));
      run(root, ["init", "-q", "-b", "main", dir]);
      for (const [key, value] of Object.entries(config)) run(dir, ["config", key, value]);
      for (const [i, message] of MESSAGES.entries()) {
        put(dir, `f${i}.txt`, `${i}\n`);
        run(dir, ["add", "-A"]);
        writeFileSync(join(root, "msg"), message);
        run(dir, ["commit", "-q", "--cleanup=verbatim", "-F", join(root, "msg")]);
      }
      const git = await openOurs(dir);
      const history = git.history;
      if (!history) throw new Error("no history");
      const trailers = trailerConfigOf(git.workingCopy);
      const ids = run(dir, ["rev-list", "--all"]).trim().split("\n");
      // git 2.43 reads `http://` as a trailer, keeps comment lines among them and adds `: ` after a configured key ending in a
      // separator; ours follows 2.5x
      const older = !hasCount();
      for (const id of ids) {
        const commit = await history.commits.load(id);
        if (!commit) throw new Error(`no commit ${id}`);
        if (older && /^(Url|Hash|Comments)\n/.test(commit.message)) continue;
        for (const format of TRAILER_FORMATS) {
          const native = run(dir, ["log", "-1", `--format=${format}`, id]);
          const ours = await formatCommitPretty(format, commit, id, { trailers });
          expect(`${ours}\n`, `${format} of ${JSON.stringify(commit.message)}`).toBe(native);
        }
      }
    });
  }

  it("%(describe) of every commit, %S of the revision given, %(count) and %(total)", async () => {
    const dir = join(root, "describe");
    run(root, ["init", "-q", "-b", "main", dir]);
    let n = 0;
    const commit = (branch?: string) => {
      if (branch) run(dir, ["checkout", "-q", branch]);
      put(dir, `c${n}.txt`, `${n}\n`);
      run(dir, ["add", "-A"]);
      // each a second apart: the search's queue is by commit date
      const date = `${1112911993 + n * 60} +0000`;
      run(dir, ["commit", "-q", "-m", `commit ${n++}`], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
    };
    commit();
    run(dir, ["tag", "-a", "-m", "first", "v1.0"]);
    commit();
    run(dir, ["tag", "light"]);
    commit();
    run(dir, ["checkout", "-q", "-b", "side"]);
    commit();
    run(dir, ["tag", "-a", "-m", "side", "side-1"]);
    commit();
    commit("main");
    run(dir, ["tag", "-a", "-m", "two", "v2.0"]);
    // a tag object named v9 under another ref name: "externally known as"
    run(dir, ["tag", "-a", "-m", "nine", "v9"]);
    const nine = run(dir, ["rev-parse", "v9"]).trim();
    run(dir, ["update-ref", "refs/tags/renamed", nine]);
    run(dir, ["tag", "-d", "v9"]);
    commit();
    run(dir, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    commit();

    const git = await openOurs(dir);
    const history = git.history;
    if (!history) throw new Error("no history");
    const abbrev = new Map<string, string>();
    const describer = createDescriber({
      refs: history.refs,
      tags: history.tags,
      commits: history.commits,
      abbreviate: async (id, length) => {
        const key = `${id}:${length}`;
        let short = abbrev.get(key);
        if (!short) {
          short =
            length === 0
              ? id
              : run(dir, [
                  "rev-parse",
                  length === undefined ? "--short" : `--short=${length}`,
                  id,
                ]).trim();
          abbrev.set(key, short);
        }
        return short;
      },
    });
    const formats = [
      "%(describe)",
      "%(describe:tags)",
      "%(describe:tags=no)",
      "%(describe:abbrev=0)",
      "%(describe:abbrev=12,tags)",
      "%(describe:match=v*)",
      "%(describe:match=side*,match=v1*)",
      "%(describe:exclude=v2*,tags=yes)",
      "%(describe:abbrev=x)|%(describe:bogus)|%(describe:match=)",
    ];
    const ids = run(dir, ["rev-list", "--all"]).trim().split("\n");
    const counted = hasCount();
    for (const id of ids) {
      const c = await history.commits.load(id);
      if (!c) throw new Error(`no commit ${id}`);
      for (const format of formats) {
        const native = run(dir, ["log", "-1", `--format=${format}`, id]);
        const ours = await formatCommitPretty(format, c, id, { describe: describer });
        expect(`${ours}\n`, `${format} of ${id}`).toBe(native);
      }
      // the source is the revision as given
      const options: PrettyFormatOptions = { source: id, count: { nr: 0, total: 0 } };
      const native = run(dir, ["log", "-1", "--format=[%S]%(count)/%(total)", id]);
      if (counted) {
        expect(`${await formatCommitPretty("[%S]%(count)/%(total)", c, id, options)}\n`).toBe(
          native,
        );
      } else {
        expect(native).toBe(`[${id}]%(count)/%(total)\n`);
      }
    }
    const tip = await history.commits.load(ids[0] as string);
    if (!tip) throw new Error("no tip");
    expect(await formatCommitPretty("%S|%h", tip, ids[0] as string, { source: "main" })).toBe(
      `${run(dir, ["log", "-1", "--format=%S|", "main"]).trim()}${ids[0]}`,
    );
  });
});
