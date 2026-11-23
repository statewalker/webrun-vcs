/**
 * The submodule model (submodule-config.c, submodule.c): `.gitmodules` parsing with git's
 * precedence and checks, `relative_url` with t0060-path-utils.sh's cases, active state and
 * git directories.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Gitmodules, relativeUrl, SubmoduleModel, upPathOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

describe("relative_url (t0060-path-utils.sh)", () => {
  const pwd = "/tmp/t0060";
  // up_path, remote_url, url, expected
  const cases: [string | undefined, string, string, string][] = [
    ["../", "../foo", "../submodule", "../../submodule"],
    ["../", "../foo/bar", "../submodule", "../../foo/submodule"],
    ["../", "../foo/submodule", "../submodule", "../../foo/submodule"],
    ["../", "./foo", "../submodule", "../submodule"],
    ["../", "./foo/bar", "../submodule", "../foo/submodule"],
    ["../../../", "../foo/bar", "../sub/a/b/c", "../../../../foo/sub/a/b/c"],
    ["../", `${pwd}/addtest`, "../repo", `${pwd}/repo`],
    ["../", "foo/bar", "../submodule", "../foo/submodule"],
    ["../", "foo", "../submodule", "../submodule"],
    [undefined, "../foo/bar", "../sub/a/b/c", "../foo/sub/a/b/c"],
    [undefined, "../foo/bar", "../sub/a/b/c/", "../foo/sub/a/b/c"],
    [undefined, "../foo/bar/", "../sub/a/b/c", "../foo/sub/a/b/c"],
    [undefined, "../foo/bar", "../submodule", "../foo/submodule"],
    [undefined, "../foo/submodule", "../submodule", "../foo/submodule"],
    [undefined, "../foo", "../submodule", "../submodule"],
    [undefined, "./foo/bar", "../submodule", "foo/submodule"],
    [undefined, "./foo", "../submodule", "submodule"],
    [undefined, "//somewhere else/repo", "../subrepo", "//somewhere else/subrepo"],
    [undefined, "//somewhere else/repo", "../../subrepo", "//subrepo"],
    [undefined, "//somewhere else/repo", "../../../subrepo", "/subrepo"],
    [undefined, "//somewhere else/repo", "../../../../subrepo", "subrepo"],
    [
      undefined,
      `${pwd}/subsuper_update_r`,
      "../subsubsuper_update_r",
      `${pwd}/subsubsuper_update_r`,
    ],
    [undefined, `${pwd}/.`, "../.", `${pwd}/.`],
    [undefined, pwd, "./.", `${pwd}/.`],
    [undefined, pwd, "./å äö", `${pwd}/å äö`],
    [undefined, `${pwd}/home2/../remote`, "../bundle1", `${pwd}/home2/../bundle1`],
    [undefined, `${pwd}/submodule_update_repo`, "./.", `${pwd}/submodule_update_repo/.`],
    [undefined, "file:///tmp/repo", "../subrepo", "file:///tmp/subrepo"],
    [undefined, "foo/bar", "../submodule", "foo/submodule"],
    [undefined, "foo", "../submodule", "submodule"],
    [undefined, "helper:://hostname/repo", "../subrepo", "helper:://hostname/subrepo"],
    [undefined, "helper:://hostname/repo", "../../subrepo", "helper:://subrepo"],
    [undefined, "helper:://hostname/repo", "../../../subrepo", "helper::/subrepo"],
    [undefined, "helper:://hostname/repo", "../../../../subrepo", "helper::subrepo"],
    [undefined, "helper:://hostname/repo", "../../../../../subrepo", "helper:subrepo"],
    [undefined, "helper:://hostname/repo", "../../../../../../subrepo", ".:subrepo"],
    [undefined, "ssh://hostname/repo", "../subrepo", "ssh://hostname/subrepo"],
    [undefined, "ssh://hostname/repo", "../../subrepo", "ssh://subrepo"],
    [undefined, "ssh://hostname/repo", "../../../subrepo", "ssh:/subrepo"],
    [undefined, "ssh://hostname/repo", "../../../../subrepo", "ssh:subrepo"],
    [undefined, "ssh://hostname/repo", "../../../../../subrepo", ".:subrepo"],
    [undefined, "ssh://hostname:22/repo", "../subrepo", "ssh://hostname:22/subrepo"],
    [undefined, "user@host:path/to/repo", "../subrepo", "user@host:path/to/subrepo"],
    [undefined, "user@host:repo", "../subrepo", "user@host:subrepo"],
    [undefined, "user@host:repo", "../../subrepo", ".:subrepo"],
  ];
  for (const [up, remote, url, expected] of cases) {
    it(`${up ?? "(null)"} ${remote} ${url} => ${expected}`, () => {
      expect(relativeUrl(remote, url, up)).toBe(expected);
    });
  }

  it("dies where no component is left to strip, and keeps absolute URLs", () => {
    expect(() => relativeUrl("foo", "../../x")).toThrow("cannot strip one component off url");
    expect(relativeUrl("https://h/a", "/abs/x")).toBe("/abs/x");
    expect(relativeUrl("https://h/a", "https://other/x")).toBe("https://other/x");
    expect(upPathOf("a/b/c")).toBe("../../../");
    expect(upPathOf("a/b/")).toBe("../../");
  });
});

describe("Gitmodules.parse (submodule-config.c parse_config)", () => {
  it("lets the last value win, moves a path, warns on suspicious entries", async () => {
    const g = await Gitmodules.parse(
      [
        '[submodule "a"]',
        "\tpath = p1",
        "\turl = u1",
        "\tpath = p2",
        "\turl = u2",
        "\tignore = bogus",
        "\tupdate = rebase",
        "\tfetchRecurseSubmodules = on-demand",
        "\tshallow",
        '[submodule "../x"]',
        "\tpath = p3",
        '[submodule "b"]',
        "\tpath = -opt",
        "\tbranch = dev",
        "",
      ].join("\n"),
    );
    expect(g.byPath("p1")).toBeUndefined();
    expect(g.byPath("p2")).toEqual({
      name: "a",
      path: "p2",
      url: "u2",
      update: { type: "rebase" },
      fetchRecurseSubmodules: "on-demand",
      shallow: true,
    });
    expect(g.byName("b")).toEqual({ name: "b", branch: "dev" });
    expect(g.warnings).toEqual([
      "warning: Invalid parameter 'bogus' for config option 'submodule.a.ignore'",
      "warning: ignoring suspicious submodule name: ../x",
      "warning: ignoring 'submodule.b.path' which may be interpreted as a command-line option: -opt",
    ]);
  });

  it("keeps the first value of a commit's .gitmodules, with git's warning", async () => {
    const g = await Gitmodules.parse('[submodule "a"]\n\turl = one\n\turl = two\n', {
      commit: "c0ffee",
    });
    expect(g.byName("a")?.url).toBe("one");
    expect(g.warnings).toEqual([
      "warning: c0ffee:.gitmodules, multiple configurations found for 'submodule.a.url'. Skipping second one!",
    ]);
  });

  it("dies as git does", async () => {
    await expect(Gitmodules.parse('[submodule "a"]\n\tupdate = !rm -rf x\n')).rejects.toThrow(
      "fatal: invalid value for 'submodule.a.update'",
    );
    await expect(Gitmodules.parse('[submodule "a"]\n\tpath\n')).rejects.toThrow(
      "error: missing value for 'submodule.a.path'",
    );
    await expect(Gitmodules.parse('[submodule "a"\n')).rejects.toThrow(
      "fatal: bad config line 2 in file .gitmodules",
    );
    await expect(
      Gitmodules.parse('[submodule "a"]\n\tfetchRecurseSubmodules = sometimes\n'),
    ).rejects.toThrow("fatal: bad submodule.a.fetchrecursesubmodules argument: sometimes");
  });
});

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

describeGit("SubmoduleModel over a repository", () => {
  it("reads the worktree's .gitmodules, else the index's, else HEAD's, or a commit's", async () => {
    const root = mkdtempSync(join(tmpdir(), "submodule-model-"));
    try {
      const dir = join(root, "r");
      const sh = (script: string) =>
        execFileSync("bash", ["-euc", script], { cwd: root, env: testEnv(root) }).toString();
      sh(`git init -q -b main r; cd r
printf '[submodule "s"]\\n\\tpath = s\\n\\turl = ../one\\n' > .gitmodules
git add .gitmodules; git commit -qm one
printf '[submodule "s"]\\n\\tpath = s\\n\\turl = ../two\\n' > .gitmodules
git add .gitmodules
printf '[submodule "s"]\\n\\tpath = s\\n\\turl = ../three\\n' > .gitmodules
git config submodule.active 's*'
git config submodule.s.gitdir .git/modules/custom`);
      const head = sh("git -C r rev-parse HEAD").trim();
      const load = async (commit?: string) =>
        SubmoduleModel.load((await openOurs(dir)).workingCopy, commit ? { commit } : {});
      let model = await load();
      expect(model.source).toEqual({ kind: "worktree" });
      expect(model.fromPath("s")?.url).toBe("../three");
      expect(model.isActive("s")).toBe(true);
      expect(model.isActive("t")).toBe(false);
      expect(await model.gitDirOf("s")).toBe(".git/modules/s");
      rmSync(join(dir, ".gitmodules"));
      model = await load();
      expect(model.source.kind).toBe("index");
      expect(model.fromPath("s")?.url).toBe("../two");
      sh("git -C r rm -q --cached .gitmodules");
      model = await load();
      expect(model.source.kind).toBe("head");
      expect(model.fromPath("s")?.url).toBe("../one");
      model = await load(head);
      expect(model.source).toMatchObject({ kind: "commit", commit: head });
      expect(model.url("s")).toBe("../one");
      sh("cd r; git config submodule.s.url /registered; git config submodule.s.active false");
      model = await load();
      expect(model.url("s")).toBe("/registered");
      expect(model.isActive("s")).toBe(false);
      sh(
        "cd r; git config core.repositoryformatversion 1; git config extensions.submodulePathConfig true",
      );
      model = await load();
      expect(await model.gitDirOf("s")).toBe(".git/modules/custom");
      // validate_submodule_encoded_git_dir: a gitdir outside `modules/`, or nested, is refused
      sh("cd r; git config -f .git/config submodule.s.gitdir .git/modules/a/b");
      model = await load();
      await expect(model.gitDirOf("s")).rejects.toThrow(
        "fatal: refusing to create/use '.git/modules/a/b' in another submodule's  git dir.",
      );
      await expect(model.gitDirOf("other")).rejects.toThrow(
        "the 'submodule.other.gitdir' config does not exist",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
