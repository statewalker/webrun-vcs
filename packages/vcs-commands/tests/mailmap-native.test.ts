/**
 * `git check-mailmap` and the mailmap's sources as `git shortlog` reads them, against native
 * git, the scenarios taken from git's t4203-mailmap.sh: contacts as arguments and on stdin,
 * bare addresses (2.47+; 2.43 refuses them), `.mailmap`, `mailmap.file`, `mailmap.blob`
 * (a missing one, one that is no blob, one without a final newline, `HEAD:.mailmap` by
 * default in a bare repository), name entries after email entries, case, and the complex
 * mapping. Run with the system git (2.43) and with 2.56.1 first on `PATH`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GitApiError } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  Fixture,
  gitEnv,
  native,
  nativeCompatibility,
  type Outcome,
  openRepo,
  oursCheckMailmap,
  oursShortlog,
} from "./shortlog-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let repo: Fixture;

async function shortlog(args: string[], dir = repo.dir, stdin?: string): Promise<Outcome> {
  const n = native(root, dir, "shortlog", args, stdin ?? "");
  const o = await oursShortlog(dir, args, stdin);
  expect(o).toEqual(n);
  return n;
}

async function checkMailmap(args: string[], stdin = ""): Promise<Outcome> {
  const n = native(root, repo.dir, "check-mailmap", args, stdin);
  const o = await oursCheckMailmap(repo.dir, args, stdin);
  expect(o).toEqual(n);
  return n;
}

/** `test_when_finished "rm .mailmap"` and friends: config and files undone after `body`. */
async function withMailmap(
  files: Record<string, string>,
  config: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) repo.put(path, text);
  for (const [key, value] of Object.entries(config)) repo.git(["config", key, value]);
  try {
    await body();
  } finally {
    for (const path of Object.keys(files)) rmSync(join(repo.dir, path), { force: true });
    for (const key of Object.keys(config)) repo.git(["config", "--unset", key]);
  }
}

const AUTHOR = "A U Thor <author@example.com>";
const DEFAULT_MAP = "Repo Guy <author@example.com>\n";

describeGit("git check-mailmap and mailmap sources, native (t4203-mailmap)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mailmap-native-"));
    const dir = join(root, "repo");
    mkdirSync(dir);
    repo = new Fixture(root, dir);
    // t4203-mailmap.sh: "setup commits and contacts file"
    repo.git(["init", "-q", "-b", "main"]);
    repo.commit("initial", "one", "one");
    repo.put("one", "one\ntwo\n");
    repo.git(["add", "one"]);
    repo.git(["commit", "-q", "-m", "second", "--author", "nick1 <bugs@company.xx>"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t4203-mailmap.sh: "check-mailmap no arguments"', async () => {
    const n = await checkMailmap([]);
    expect(n.status).toBe(128);
  });

  it('t4203-mailmap.sh: "check-mailmap arguments", "check-mailmap --stdin"', async () => {
    await checkMailmap([AUTHOR, "nick1 <bugs@company.xx>"]);
    await checkMailmap(["--stdin"], `${AUTHOR}\nnick1 <bugs@company.xx>\n`);
  });

  it('t4203-mailmap.sh: "check-mailmap --stdin arguments: no mapping"', async () => {
    await checkMailmap(
      ["--stdin", "Internal Guy <bugs@company.xy>"],
      `${AUTHOR}\nnick1 <bugs@company.xx>\n`,
    );
  });

  it('t4203-mailmap.sh: "check-mailmap --stdin arguments: mapping"', async () => {
    await withMailmap({ ".mailmap": "New Name <author@example.com>\n" }, {}, async () => {
      await checkMailmap(["--stdin"], "Old Name <author@example.com>\n");
      await checkMailmap(
        ["--stdin", "Another Old Name <author@example.com>"],
        "Old Name <author@example.com>\n",
      );
    });
  });

  it('t4203-mailmap.sh: "check-mailmap simple address: mapping", "check-mailmap --stdin simple address: mapping"', async () => {
    await withMailmap({ ".mailmap": "New Name <author@example.com>\n" }, {}, async () => {
      await checkMailmap(["author@example.com"]);
      await checkMailmap(["--stdin"], "author@example.com\n");
    });
  });

  it('t4203-mailmap.sh: "check-mailmap simple address: no mapping", "check-mailmap --stdin simple address: no mapping"', async () => {
    await checkMailmap(["bugs@company.xx"]);
    await checkMailmap(["--stdin"], "bugs@company.xx\n");
    // 2.43 dies at the first bare address, after printing what came before
    await checkMailmap([AUTHOR, "bugs@company.xx", "nick1 <bugs@company.xx>"]);
  });

  it('t4203-mailmap.sh: "check-mailmap name and address: mapping"', async () => {
    await withMailmap(
      { ".mailmap": "Bug Reports <bugs-new@company.xx> Bugs <bugs@company.xx>\n" },
      {},
      async () => {
        await checkMailmap(["bugs@company.xx"]);
        await checkMailmap(["Bugs <bugs@company.xx>"]);
      },
    );
  });

  it("check-mailmap --mailmap-file and --mailmap-blob (git 2.47+)", async () => {
    if (nativeCompatibility() === "2.43") return;
    repo.put("extra.map", "Extra Guy <bugs@company.xx>\n");
    const blob = repo.git(["hash-object", "-w", "extra.map"]).trim();
    await checkMailmap(["--mailmap-file=extra.map", "nick1 <bugs@company.xx>"]);
    await checkMailmap([`--mailmap-blob=${blob}`, "nick1 <bugs@company.xx>"]);
    await checkMailmap(["--mailmap-blob=HEAD:", "nick1 <bugs@company.xx>"]);
    rmSync(join(repo.dir, "extra.map"));
  });

  it('t4203-mailmap.sh: "No mailmap", "test default .mailmap"', async () => {
    await shortlog(["HEAD"]);
    await withMailmap({ ".mailmap": DEFAULT_MAP }, {}, () => shortlog(["HEAD"]).then(() => {}));
  });

  it('t4203-mailmap.sh: "mailmap.file set", "mailmap.file override", "mailmap.file non-existent"', async () => {
    await withMailmap(
      { ".mailmap": DEFAULT_MAP, "internal.map": "Internal Guy <bugs@company.xx>\n" },
      { "mailmap.file": "internal.map" },
      () => shortlog(["HEAD"]).then(() => {}),
    );
    await withMailmap(
      {
        "internal.map": "Internal Guy <bugs@company.xx>\nExternal Guy <author@example.com>\n",
      },
      { "mailmap.file": "internal.map" },
      () => shortlog(["HEAD"]).then(() => {}),
    );
    await withMailmap({ ".mailmap": DEFAULT_MAP }, {}, () => shortlog(["HEAD"]).then(() => {}));
  });

  it('t4203-mailmap.sh: "name entry after email entry", "name entry after email entry, case-insensitive"', async () => {
    for (const map of [
      "<bugs@company.xy> <bugs@company.xx>\nInternal Guy <bugs@company.xx>\n",
      "<bugs@company.xy> <bugs@company.xx>\nInternal Guy <BUGS@Company.xx>\n",
      "NiCk <BuGs@CoMpAnY.Xy> NICK1 <BUGS@COMPANY.XX>\n",
    ]) {
      await withMailmap(
        { ".mailmap": DEFAULT_MAP, "internal.map": map },
        { "mailmap.file": "internal.map" },
        () => shortlog(["HEAD"]).then(() => {}),
      );
    }
  });

  describe("mailmap.blob", () => {
    beforeAll(() => {
      // t4203-mailmap.sh: "setup mailmap blob tests"
      repo.git(["checkout", "-q", "-b", "map"]);
      repo.put("just-bugs", "Blob Guy <bugs@company.xx>\n");
      repo.put("both", "Blob Guy <author@example.com>\nBlob Guy <bugs@company.xx>\n");
      repo.put("no-newline", "Tricky Guy <author@example.com>");
      repo.git(["add", "just-bugs", "both", "no-newline"]);
      repo.git(["commit", "-q", "-m", "my mailmaps"]);
      repo.git(["checkout", "-q", "main"]);
    });

    it('t4203-mailmap.sh: "mailmap.blob set", "mailmap.blob overrides .mailmap"', async () => {
      for (const blob of ["map:just-bugs", "map:both"])
        await withMailmap({ ".mailmap": DEFAULT_MAP }, { "mailmap.blob": blob }, () =>
          shortlog(["HEAD"]).then(() => {}),
        );
    });

    it('t4203-mailmap.sh: "mailmap.file overrides mailmap.blob"', async () => {
      await withMailmap(
        { "internal.map": "Internal Guy <author@example.com>\n" },
        { "mailmap.blob": "map:both", "mailmap.file": "internal.map" },
        () => shortlog(["HEAD"]).then(() => {}),
      );
    });

    it('t4203-mailmap.sh: "mailmap.file can be missing", "mailmap.blob can be missing"', async () => {
      await withMailmap({ ".mailmap": DEFAULT_MAP }, { "mailmap.file": "nonexistent" }, () =>
        shortlog(["HEAD"]).then(() => {}),
      );
      await withMailmap({ ".mailmap": DEFAULT_MAP }, { "mailmap.blob": "map:nonexistent" }, () =>
        shortlog(["HEAD"]).then(() => {}),
      );
    });

    it('t4203-mailmap.sh: "mailmap.blob might be the wrong type"', async () => {
      await withMailmap({ ".mailmap": DEFAULT_MAP }, { "mailmap.blob": "HEAD:" }, async () => {
        const n = await shortlog(["HEAD"]);
        expect(n.err).toContain("mailmap is not a blob");
      });
    });

    it('t4203-mailmap.sh: "mailmap.blob might be the wrong type": git log and git commit --author print its error as git does', async () => {
      await withMailmap({}, { "mailmap.blob": "HEAD:" }, async () => {
        const cases: { args: string[]; pretty?: string; mailmap?: boolean; author?: string }[] = [
          { args: [] },
          { args: ["--format=%an"], pretty: "tformat:%an" },
          { args: ["--format=%aN"], pretty: "tformat:%aN" },
          { args: ["--format=%aN%n%cE"], pretty: "tformat:%aN%n%cE" },
          { args: ["--no-mailmap"], mailmap: false },
          { args: ["--no-mailmap", "--format=%cL"], pretty: "tformat:%cL", mailmap: false },
          { args: ["--oneline"], pretty: "oneline" },
          { args: ["--author=nick"], author: "nick" },
          { args: ["--author=nobody", "--format=%aN"], author: "nobody", pretty: "tformat:%aN" },
        ];
        for (const c of cases) {
          const r = spawnSync("git", ["log", ...c.args, "HEAD"], {
            cwd: repo.dir,
            env: gitEnv(root),
            encoding: "utf8",
          });
          const git = await openRepo(repo.dir);
          const revs = git.revList().addArgument("HEAD");
          if (c.author) revs.addAuthor(c.author);
          if (c.mailmap === false) revs.setUseMailmap(false);
          const out = await revs.callLogText({
            ...(c.pretty ? { pretty: c.pretty } : {}),
            ...(c.pretty === "oneline" ? { oneline: true, pretty: undefined } : {}),
          });
          const err = revs
            .getWarnings()
            .map((l) => `${l}\n`)
            .join("");
          expect({ args: c.args, out, err }).toEqual({
            args: c.args,
            out: r.stdout,
            err: r.stderr,
          });
        }
        // find_author_by_nickname: its walk's read, then pretty.c's for the match
        for (const author of ["nick", "nobody"]) {
          const mine = join(root, `commit-ours-${author}`);
          const theirs = join(root, `commit-native-${author}`);
          execFileSync("cp", ["-a", repo.dir, mine]);
          execFileSync("cp", ["-a", repo.dir, theirs]);
          const r = spawnSync(
            "git",
            ["commit", "-q", "--allow-empty", "-m", "x", `--author=${author}`],
            { cwd: theirs, env: gitEnv(root), encoding: "utf8" },
          );
          const git = await openRepo(mine);
          const commit = git.commit().setAllowEmpty(true).setMessage("x").setAuthor(author);
          const status = await commit.call().then(
            () => 0,
            (e: GitApiError) => e.exitCode,
          );
          const err = commit
            .getWarnings()
            .map((l) => `${l}\n`)
            .join("");
          expect({ author, status, err }).toEqual({
            author,
            status: r.status,
            err: r.stderr
              .split("\n")
              .filter((l) => l.startsWith("error:"))
              .map((l) => `${l}\n`)
              .join(""),
          });
          rmSync(mine, { recursive: true, force: true });
          rmSync(theirs, { recursive: true, force: true });
        }
      });
    });

    it('t4203-mailmap.sh: "mailmap.blob can handle blobs without trailing newline"', async () => {
      await withMailmap({}, { "mailmap.blob": "map:no-newline" }, () =>
        shortlog(["HEAD"]).then(() => {}),
      );
    });
  });

  it('t4203-mailmap.sh: "mailmap.blob defaults to off in non-bare repo", "mailmap.blob defaults to HEAD:.mailmap in bare repo"', async () => {
    const nonBare = join(root, "non-bare");
    mkdirSync(nonBare);
    const nb = new Fixture(root, nonBare);
    nb.git(["init", "-q", "-b", "main"]);
    nb.commit("one", ".mailmap", "Fake Name <author@example.com>");
    await shortlog(["-ns", "HEAD"], nonBare);
    rmSync(join(nonBare, ".mailmap"));
    await shortlog(["-ns", "HEAD"], nonBare);
    nb.git(["clone", "-q", "--bare", nonBare, join(root, "bare")]);
    await shortlog(["-ns", "HEAD"], join(root, "bare"));
  });

  it('t4203-mailmap.sh: "single-character name", "preserve canonical email case"', async () => {
    await withMailmap({ ".mailmap": "A <author@example.com>\n" }, {}, () =>
      shortlog(["-es", "HEAD"]).then(() => {}),
    );
    await withMailmap({ ".mailmap": "<AUTHOR@example.com> <author@example.com>\n" }, {}, () =>
      shortlog(["-es", "HEAD"]).then(() => {}),
    );
  });

  it('t4203-mailmap.sh: "Shortlog output (complex mapping)"', async () => {
    const map = [
      "Committed <committer@example.com>",
      "<cto@company.xx> <cto@coompany.xx>",
      "Some Dude <some@dude.xx>         nick1 <bugs@company.xx>",
      "Other Author <other@author.xx>   nick2 <bugs@company.xx>",
      "Other Author <other@author.xx>         <nick2@company.xx>",
      "Santa Claus <santa.claus@northpole.xx> <me@company.xx>",
      "",
    ].join("\n");
    const add = (message: string, author: string) => {
      repo.put("one", `${repo.git(["show", "HEAD:one"])}${message}\n`);
      repo.git(["add", "one"]);
      repo.git(["commit", "-q", "-m", message, "--author", author]);
    };
    add("third", "nick2 <bugs@company.xx>");
    add("fourth", "nick2 <nick2@company.xx>");
    add("fifth", "santa <me@company.xx>");
    add("sixth", "claus <me@company.xx>");
    add("seventh", "CTO <cto@coompany.xx>");
    await withMailmap({ "complex.map": map }, { "mailmap.file": "complex.map" }, async () => {
      await shortlog(["-e", "HEAD"]);
      await shortlog(["-c", "-e", "HEAD"]);
      await shortlog(["-sn", "HEAD"]);
      await checkMailmap(["nick2 <bugs@company.xx>", "x <me@company.xx>", "CTO <cto@coompany.xx>"]);
    });
  });

  it('t4203-mailmap.sh: "shortlog on stdin respects mailmap from repo"', async () => {
    const log = repo.git(["log", "-1", "--author=CTO"]);
    await withMailmap({ ".mailmap": "New <new@example.com> <cto@coompany.xx>\n" }, {}, () =>
      shortlog(["-s"], repo.dir, log).then(() => {}),
    );
  });
});
