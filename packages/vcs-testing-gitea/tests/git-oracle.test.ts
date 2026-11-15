import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { push, fetch as transportFetch } from "@statewalker/vcs-transport";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type GiteaServer, startGitea } from "../src/index.js";
import {
  commitFiles,
  describeGitea,
  nativeCommits,
  nativeGit,
  nativeGitEnv,
  ourCommits,
  ourRepo,
  requireNativeTools,
  tempDirs,
} from "./helpers.js";

/**
 * G1 — git over smart HTTP against Gitea, with our vcs-transport client:
 * fetch (a clone, then an incremental fetch) of what native git pushed, and
 * a push that native git clones back and `fsck --strict` accepts. Gitea's
 * repositories are private, so credentials are exercised both ways.
 */
describeGitea("Gitea oracle · G1 git over smart HTTP", () => {
  const tmp = tempDirs();
  let gitea: GiteaServer;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    gitea = await startGitea();
    env = nativeGitEnv(tmp.make("gitea-home-"));
  });
  afterAll(async () => {
    await gitea?.stop();
    tmp.cleanup();
  });

  requireNativeTools();

  it("our fetch clones what native git pushed, then fetches only what is new", async () => {
    const repo = await gitea.createRepo("g1-fetch");
    const work = join(tmp.make(), "w");
    nativeGit(env, tmp.make(), ["init", "-q", "-b", "main", work]);
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(work, `f${i}.txt`), `file ${i}\n`);
      nativeGit(env, work, ["add", "-A"]);
      nativeGit(env, work, ["commit", "-q", "-m", `c${i}`]);
    }
    nativeGit(env, work, ["tag", "-a", "v1", "-m", "v1"]);
    nativeGit(env, work, ["push", "-q", repo.authenticatedUrl, "main", "v1"]);

    const ours = await ourRepo();
    try {
      const local = { repository: ours.facade, refStore: ours.refStore };
      // a private repository: no credentials, no refs
      await expect(transportFetch({ url: repo.cloneUrl, ...local })).rejects.toThrow(/\b401\b/);
      expect(await ours.refStore.get("refs/heads/main")).toBeUndefined();

      // every branch and tag under its own name (the transport's default refspecs)
      const first = await transportFetch({ url: repo.cloneUrl, fetchImpl: gitea.fetch, ...local });
      expect(first.refUpdates.every((u) => u.status === "new")).toBe(true);
      const tip = nativeGit(env, work, ["rev-parse", "HEAD"]).trim();
      expect(await ours.refStore.get("refs/heads/main")).toBe(tip);
      expect(await ours.refStore.get("refs/tags/v1")).toBe(
        nativeGit(env, work, ["rev-parse", "refs/tags/v1"]).trim(),
      );
      expect(await ourCommits(ours, tip)).toEqual(nativeCommits(env, work));
      const firstObjects = first.packObjects;
      expect(firstObjects).toBeGreaterThan(0);

      writeFileSync(join(work, "f4.txt"), "file 4\n");
      nativeGit(env, work, ["add", "-A"]);
      nativeGit(env, work, ["commit", "-q", "-m", "c4"]);
      nativeGit(env, work, ["push", "-q", repo.authenticatedUrl, "main"]);
      const second = await transportFetch({ url: repo.cloneUrl, fetchImpl: gitea.fetch, ...local });
      const tip2 = nativeGit(env, work, ["rev-parse", "HEAD"]).trim();
      expect(await ours.refStore.get("refs/heads/main")).toBe(tip2);
      expect(await ourCommits(ours, tip2)).toEqual(nativeCommits(env, work));
      expect(second.refUpdates.find((u) => u.localRef === "refs/heads/main")?.status).toBe(
        "fast-forward",
      );
      // incremental: haves were sent, and the pack holds the new commit, its tree and its new
      // blob only (git rev-list --objects old..new), not the whole history again
      expect(second.stats.haves).toBeGreaterThan(0);
      expect(second.packObjects).toBe(
        nativeGit(env, work, ["rev-list", "--objects", `${tip}..${tip2}`])
          .trim()
          .split("\n").length,
      );
      expect(second.packObjects).toBeLessThan(firstObjects);
    } finally {
      await ours.close();
    }
  });

  it("our push (token as password) is cloned natively and passes fsck --strict; no credentials is a 401", async () => {
    const repo = await gitea.createRepo("g1-push");
    const ours = await ourRepo();
    try {
      await commitFiles(ours, "ours 1", { "a.txt": "ours\n" });
      const tip = await commitFiles(ours, "ours 2", { "a.txt": "ours 2\n", "b.txt": "b\n" });
      const local = { repository: ours.facade, refStore: ours.refStore };
      const pushed = await push({
        url: repo.cloneUrl,
        ...local,
        refspecs: ["main"],
        auth: { username: gitea.user, password: gitea.token },
      });
      expect(pushed.ok, JSON.stringify(pushed.updates)).toBe(true);
      expect(pushed.updates.map((u) => u.summary)).toEqual(["[new branch]"]);

      const clone = join(tmp.make(), "c");
      nativeGit(env, tmp.make(), ["clone", "-q", repo.authenticatedUrl, clone]);
      expect(nativeGit(env, clone, ["rev-parse", "HEAD"]).trim()).toBe(tip);
      expect(nativeCommits(env, clone)).toEqual(await ourCommits(ours, tip));
      nativeGit(env, clone, ["fsck", "--strict"]);

      // a fast-forward on top of what is there
      const tip2 = await commitFiles(ours, "ours 3", { "a.txt": "ours 3\n", "b.txt": "b\n" });
      const again = await push({
        url: repo.cloneUrl,
        ...local,
        refspecs: ["refs/heads/main:refs/heads/main"],
        auth: { username: gitea.user, password: gitea.password },
      });
      expect(again.ok, JSON.stringify(again.updates)).toBe(true);
      expect(again.updates[0]?.summary).toBe(`${tip.slice(0, 7)}..${tip2.slice(0, 7)}`);
      nativeGit(env, clone, ["pull", "-q", "--ff-only"]);
      expect(nativeGit(env, clone, ["rev-parse", "HEAD"]).trim()).toBe(tip2);
      // thin against the remote tip: only the new commit, its tree and its changed blob
      expect(again.packObjects).toBe(
        nativeGit(env, clone, ["rev-list", "--objects", `${tip}..${tip2}`])
          .trim()
          .split("\n").length,
      );
      nativeGit(env, clone, ["fsck", "--strict"]);

      await expect(
        push({ url: repo.cloneUrl, ...local, refspecs: ["refs/heads/main:refs/heads/other"] }),
      ).rejects.toThrow(/\b401\b/);
      expect(nativeGit(env, clone, ["ls-remote", "origin"])).not.toContain("refs/heads/other");
    } finally {
      await ours.close();
    }
  });
});
