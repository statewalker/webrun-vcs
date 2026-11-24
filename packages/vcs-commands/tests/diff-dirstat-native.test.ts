/**
 * `--dirstat` and `diff.dirstat` against native git (statewalker-root#342), on t4047's
 * repository: nine files changed, copied, moved and rearranged under their own directories.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiffTextOptions } from "../src/index.js";
import { repo, Scratch, sh, twin } from "./diff-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const scratch = new Scratch("diff-dirstat-");
afterAll(() => scratch.cleanup());

/** Ten lines `<prefix> line #<n>`, with the first changed or the first two swapped */
const text = (prefix: string, how: "same" | "changed" | "swapped" = "same", first = prefix) => {
  const lines = Array.from({ length: 10 }, (_, i) => `${prefix} line #${i}`);
  if (how === "changed") lines[0] = `${first} line #0`;
  if (how === "swapped") [lines[0], lines[1]] = [lines[1] as string, lines[0] as string];
  return `${lines.join("\n")}\n`;
};
const write = (path: string, content: string) =>
  `mkdir -p "$(dirname '${path}')" && printf '%s' '${content}' >'${path}'\n`;

/** t4047's setup */
const SETUP = [
  write("unchanged/text", text("unchanged      ")),
  write("changed/text", text("changed        ")),
  write("rearranged/text", text("rearranged     ")),
  write("src/copy/unchanged/text", text("copy  unchanged")),
  write("src/copy/changed/text", text("copy    changed")),
  write("src/copy/rearranged/text", text("copy rearranged")),
  write("src/move/unchanged/text", text("move  unchanged")),
  write("src/move/changed/text", text("move    changed")),
  write("src/move/rearranged/text", text("move rearranged")),
  'git add . && commit -m "initial"\n',
  write("changed/text", text("changed        ", "changed", "CHANGED XXXXXXX")),
  write("rearranged/text", text("rearranged     ", "swapped")),
  write("dst/copy/unchanged/text", text("copy  unchanged")),
  write("dst/copy/changed/text", text("copy    changed", "changed", "copy XXXCHANGED")),
  write("dst/copy/rearranged/text", text("copy rearranged", "swapped")),
  write("dst/move/unchanged/text", text("move  unchanged")),
  write("dst/move/changed/text", text("move    changed", "changed", "move XXXCHANGED")),
  write("dst/move/rearranged/text", text("move rearranged", "swapped")),
  "git add . && git rm -q -r src/move/unchanged src/move/changed src/move/rearranged\n",
  'commit -m "changes" && git config diff.renames false\n',
].join("");

let dir = "";
beforeAll(() => {
  if (nativeGitAvailable()) dir = repo(scratch, SETUP);
});

/** The three renames t4047 runs each case with: none, `-M`, `-C -C` */
const RENAMES: Array<[string[], DiffTextOptions]> = [
  [[], {}],
  [["-M"], { findRenames: true }],
  [["-C", "-C"], { findCopies: true, findCopiesHarder: true }],
];

/** Runs `git diff <flags> HEAD^..HEAD` with each rename mode, under `config` */
async function dirstatTwins(
  cases: Array<[string[], string | undefined]>,
  config?: string,
): Promise<string[]> {
  sh(
    scratch,
    dir,
    config ? `git config diff.dirstat '${config}'` : "git config --unset diff.dirstat || true",
  );
  const out: string[] = [];
  for (const [flags, dirstat] of cases) {
    for (const [renameFlags, options] of RENAMES) {
      await twin(
        scratch,
        out,
        dir,
        ["diff", ...flags, ...renameFlags, "HEAD^..HEAD"],
        (d) =>
          d
            .setOldTree("HEAD^")
            .setNewTree("HEAD")
            .setOptions({ ...options, ...(dirstat !== undefined ? { dirstat } : {}) }),
        "dirstat",
      );
    }
  }
  sh(scratch, dir, "git config --unset diff.dirstat || true");
  return out;
}

describeGit("diff --dirstat", () => {
  it('t4047-diff-dirstat.sh: "vanilla --dirstat", "explicit defaults: --dirstat=changes,noncumulative,3", "later options override earlier options:"', async () => {
    expect(
      await dirstatTwins([
        [[], undefined],
        [["--dirstat=changes,noncumulative,3"], "changes,noncumulative,3"],
        [
          ["--dirstat=files,10,cumulative,changes,noncumulative,3"],
          "files,10,cumulative,changes,noncumulative,3",
        ],
      ]),
    ).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "non-defaults in config overridden by explicit defaults on command line"', async () => {
    expect(
      await dirstatTwins(
        [[["--dirstat=changes,noncumulative,3"], "changes,noncumulative,3"]],
        "files,cumulative,50",
      ),
    ).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat=0", "--dirstat=0 --cumulative", "--dirstat=0,cumulative"', async () => {
    expect(
      await dirstatTwins([
        [["--dirstat=0"], "0"],
        [["--dirstat=0", "--cumulative"], "0,cumulative"],
        [["--dirstat=0,cumulative"], "0,cumulative"],
      ]),
    ).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "diff.dirstat=0", "diff.dirstat=0,cumulative", "diff.dirstat=0 & --dirstat=cumulative"', async () => {
    const out = [
      ...(await dirstatTwins([[[], undefined]], "0")),
      ...(await dirstatTwins([[[], undefined]], "0,cumulative")),
      ...(await dirstatTwins([[["--dirstat=cumulative"], "cumulative"]], "0")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat-by-file", "--dirstat=files", "diff.dirstat=files"', async () => {
    const out = [
      ...(await dirstatTwins([
        [["--dirstat-by-file"], "files"],
        [["--dirstat=files"], "files"],
      ])),
      ...(await dirstatTwins([[[], undefined]], "files")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat-by-file=10", "--dirstat=files,10", "diff.dirstat=10,files"', async () => {
    const out = [
      ...(await dirstatTwins([
        [["--dirstat-by-file=10"], "files,10"],
        [["--dirstat=files,10"], "files,10"],
      ])),
      ...(await dirstatTwins([[[], undefined]], "10,files")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat-by-file --cumulative", "--dirstat=files,cumulative", "diff.dirstat=cumulative,files"', async () => {
    const out = [
      ...(await dirstatTwins([
        [["--dirstat-by-file", "--cumulative"], "files,cumulative"],
        [["--dirstat=files,cumulative"], "files,cumulative"],
      ])),
      ...(await dirstatTwins([[[], undefined]], "cumulative,files")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat=files,cumulative,10", "diff.dirstat=10,cumulative,files"', async () => {
    const out = [
      ...(await dirstatTwins([[["--dirstat=files,cumulative,10"], "files,cumulative,10"]])),
      ...(await dirstatTwins([[[], undefined]], "10,cumulative,files")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat=files,cumulative,16.7", "diff.dirstat=16.70,cumulative,files", "--dirstat=files,cumulative,27.2", "--dirstat=files,cumulative,27.09"', async () => {
    const out = [
      ...(await dirstatTwins([
        [["--dirstat=files,cumulative,16.7"], "files,cumulative,16.7"],
        [["--dirstat=files,cumulative,27.2"], "files,cumulative,27.2"],
        [["--dirstat=files,cumulative,27.09"], "files,cumulative,27.09"],
      ])),
      ...(await dirstatTwins([[[], undefined]], "16.70,cumulative,files")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat=lines", "diff.dirstat=lines", "--dirstat=lines,0", "diff.dirstat=0,lines"', async () => {
    const out = [
      ...(await dirstatTwins([
        [["--dirstat=lines"], "lines"],
        [["--dirstat=lines,0"], "lines,0"],
      ])),
      ...(await dirstatTwins([[[], undefined]], "lines")),
      ...(await dirstatTwins([[[], undefined]], "0,lines")),
    ];
    expect(out).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--dirstat=future_param,lines,0 should fail loudly", "--dirstat=dummy1,cumulative,2dummy should report both unrecognized parameters"', async () => {
    expect(
      await dirstatTwins([
        [["--dirstat=future_param,lines,0"], "future_param,lines,0"],
        [["--dirstat=dummy1,cumulative,2dummy"], "dummy1,cumulative,2dummy"],
        [["--dirstat=files,1.x"], "files,1.x"],
      ]),
    ).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "diff.dirstat=future_param,0,lines should warn, but still work"', async () => {
    expect(await dirstatTwins([[[], undefined]], "future_param,0,lines")).toEqual([]);
  });

  it('t4047-diff-dirstat.sh: "--shortstat --dirstat should output only one dirstat"', async () => {
    const out: string[] = [];
    for (const params of ["changes", "lines", "files"]) {
      for (const format of ["shortstat", "stat", "patch", "numstat", "summary"] as const) {
        // the dirstat with the second format, in diff_flush's order
        await twin(
          scratch,
          out,
          dir,
          [
            "diff",
            `--dirstat=${params}`,
            ...(format === "patch" ? ["-p"] : []),
            "-M",
            "HEAD^..HEAD",
          ],
          (d) => {
            d.setOldTree("HEAD^")
              .setNewTree("HEAD")
              .setOptions({ dirstat: params, findRenames: true });
            d.callBytes = async () =>
              (await d.callFormats(["dirstat", format])).bytes ?? new Uint8Array(0);
            return d;
          },
          format,
        );
      }
    }
    expect(out).toEqual([]);
  });
});
